import { expect, test } from "./fixture-cho-trang-stream-xong";

import { dangNhapVoi } from "./dang-nhap-voi-tai-khoan";
import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";
import { taoTaiKhoanStaff } from "./tao-tai-khoan-staff";

/**
 * Smoke nút "Sửa số tiền (trước ngày bật)" ở Sổ chi phí, sau khi đã bật theo dõi nợ phải trả:
 *   - chủ shop thấy nút trên dòng chi phí tay ngày < M (ngày liền trước mốc) và mở được modal sửa;
 *   - nhân sự có quyền sửa chi phí thấy CÙNG dòng nhưng KHÔNG có nút (lối này chỉ dành cho chủ shop).
 * Chỉ kiểm hiện/ẩn lối vào + modal mở được — KHÔNG bấm Lưu, không ghi điều chỉnh mở sổ.
 *
 * Trạng thái "đã bật" dựng tối thiểu: chỉ ghi `Setting.noPhaiTraTuNgay` = đầu tháng hiện tại (giờ VN) — nút
 * và modal chỉ cần mốc M, không cần thẻ / ví / bước xác nhận. Công tắc này đổi công thức Sổ quỹ của CẢ DB e2e
 * ⇒ `afterAll` BẮT BUỘC gỡ lại (spec khác chạy sau giả định chưa bật), nhưng CHỈ khi chính spec này ghi nó.
 *
 * Dọn theo dấu riêng của spec (mô tả chi phí + email nhân sự); lượt trước chết giữa chừng thì `beforeAll`
 * nhận ra rác của mình (còn dòng chi phí mang dấu) và gỡ cả mốc đó. Mốc do spec KHÁC ghi ⇒ LOCAL `test.skip`
 * kèm lý do; trên CI (`process.env.CI`) thì NÉM lỗi — CI xanh mà spec không chạy là lưới giả.
 */
const DAU_SPEC = "E2E sua tien truoc moc";
const KEY_MOC = "noPhaiTraTuNgay";
const SO_TIEN = 1_234_000;
const EMAIL_NHAN_SU = "staff-sua-tien-truoc-moc@hogikids.test";
const MAT_KHAU_NHAN_SU = "Staff-Password-123!";
const TEN_NUT = "Sửa số tiền (trước ngày bật)";

/**
 * Không có DB e2e riêng thì e2e rơi về `TEST_DATABASE_URL` (DB của Vitest) — spec này bật công tắc đổi công
 * thức Sổ quỹ của cả DB ⇒ chỉ chạy trên DB e2e riêng. Ngoại lệ CI: mỗi job một Postgres tạm.
 */
const THIEU_DB_E2E = !process.env.TEST_DATABASE_URL_E2E?.trim() && !process.env.CI;

/** Ngày hôm nay theo giờ VN (`yyyy-MM-dd`) — độc lập múi giờ của tiến trình test. */
function homNayVn(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
}

/** Mốc M = ngày 1 của tháng hiện tại (VN) và ngày liền trước nó (M−1), cả hai dạng `yyyy-MM-dd`. */
function mocVaNgayTruocMoc(): { moc: string; truocMoc: string } {
  const [nam, thang] = homNayVn().split("-").map(Number);
  const moc = `${nam}-${String(thang).padStart(2, "0")}-01`;
  // Ngày 0 của tháng = ngày cuối tháng trước; dựng bằng UTC để không lệch theo múi giờ máy.
  const truocMoc = new Date(Date.UTC(nam, thang - 1, 0)).toISOString().slice(0, 10);
  return { moc, truocMoc };
}

/** Gỡ chi phí + nhân sự của spec. Mốc `Setting` KHÔNG gỡ ở đây — chỉ gỡ khi biết chắc do spec ghi. */
async function donRacCuaSpec(): Promise<void> {
  const prisma = testPrisma();
  try {
    await prisma.expense.deleteMany({ where: { description: { startsWith: DAU_SPEC } } });
    await prisma.user.deleteMany({ where: { email: EMAIL_NHAN_SU } });
  } finally {
    await prisma.$disconnect();
  }
}

let lyDoBoQua: string | null = null;
let specDaGhiMoc = false;

test.describe("Sửa số tiền trước mốc — hiện nút theo quyền", () => {
  test.skip(THIEU_DB_E2E, "TEST_DATABASE_URL_E2E trống — spec bật công tắc Sổ quỹ của cả DB, không chạy trên DB Vitest");

  test.beforeAll(async () => {
    if (THIEU_DB_E2E) return;
    const { moc, truocMoc } = mocVaNgayTruocMoc();
    const prisma = testPrisma();
    try {
      // Rác lượt trước của CHÍNH spec: còn dòng chi phí mang dấu ⇒ mốc còn lại cũng là của spec.
      const racLuotTruoc = (await prisma.expense.count({ where: { description: { startsWith: DAU_SPEC } } })) > 0;
      if (racLuotTruoc) await prisma.setting.deleteMany({ where: { key: KEY_MOC } });
      await donRacCuaSpec();

      const mocCoSan = await prisma.setting.findUnique({ where: { key: KEY_MOC }, select: { value: true } });
      if (mocCoSan !== null && mocCoSan.value.trim() !== "") {
        lyDoBoQua = `DB e2e đã có mốc nợ phải trả (${mocCoSan.value}) do spec khác ghi — không đè lên`;
        // CI: không được bỏ qua — ném để job đỏ kèm lý do (local giữ skip, DB e2e local tích luỹ dữ liệu tay).
        if (process.env.CI) throw new Error(`Spec sửa số tiền trước mốc không chạy được trên CI: ${lyDoBoQua}`);
        return;
      }

      await prisma.setting.upsert({ where: { key: KEY_MOC }, create: { key: KEY_MOC, value: moc }, update: { value: moc } });
      specDaGhiMoc = true;
      // Dòng đủ tư cách: chi phí tay, danh mục thường, không thẻ / refId, ngày M−1 (00:00 giờ VN).
      await prisma.expense.create({
        data: {
          date: new Date(`${truocMoc}T00:00:00+07:00`),
          categoryId: "fixed",
          description: DAU_SPEC,
          amount: SO_TIEN,
          source: "MANUAL",
          cardId: null,
          refId: null,
        },
      });
      await taoTaiKhoanStaff(prisma, {
        email: EMAIL_NHAN_SU,
        matKhau: MAT_KHAU_NHAN_SU,
        quyen: ["chi-phi:sua"],
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  test.afterAll(async () => {
    if (THIEU_DB_E2E) return;
    await donRacCuaSpec();
    if (!specDaGhiMoc) return;
    const prisma = testPrisma();
    try {
      await prisma.setting.deleteMany({ where: { key: KEY_MOC } });
    } finally {
      await prisma.$disconnect();
    }
  });

  /** Sổ chi phí với khoảng ngày [M−1, hôm nay] và lọc đúng dòng của spec. */
  function duongDanSoChiPhi(): string {
    const { truocMoc } = mocVaNgayTruocMoc();
    return `/tai-chinh?tab=so-chi-phi&tu=${truocMoc}&den=${homNayVn()}&q=${encodeURIComponent(DAU_SPEC)}`;
  }

  test("chủ shop thấy nút sửa số tiền trước ngày bật và mở được modal", async ({ page }) => {
    test.skip(lyDoBoQua !== null, lyDoBoQua ?? "");
    await dangNhapVoi(page, TEST_USER_EMAIL, TEST_USER_PASSWORD);
    await expect(page).toHaveURL("/");

    await page.goto(duongDanSoChiPhi());
    const dong = page.locator("tbody tr").filter({ hasText: DAU_SPEC });
    await expect(dong).toHaveCount(1);
    await expect(dong).toContainText("1.234.000");

    await dong.getByRole("button", { name: TEN_NUT }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByRole("heading", { name: TEN_NUT })).toBeVisible();
    await expect(modal.getByTestId("sua-tien-so-hien-tai")).toContainText("1.234.000");
    await expect(modal.getByLabel("Số tiền mới")).toBeVisible();
    await expect(modal.getByLabel("Lý do sửa")).toBeVisible();

    // Không lưu: đóng modal, dòng vẫn nguyên số tiền cũ.
    await modal.getByRole("button", { name: "Hủy" }).click();
    await expect(modal).toBeHidden();
    await expect(dong).toContainText("1.234.000");
  });

  test("nhân sự có quyền sửa chi phí thấy dòng nhưng không có nút sửa số tiền trước ngày bật", async ({ page }) => {
    test.skip(lyDoBoQua !== null, lyDoBoQua ?? "");
    await dangNhapVoi(page, EMAIL_NHAN_SU, MAT_KHAU_NHAN_SU);

    await page.goto(duongDanSoChiPhi());
    // Khẳng định dòng HIỆN — không thì "không thấy nút" xanh giả chỉ vì dòng không được tải.
    const dong = page.locator("tbody tr").filter({ hasText: DAU_SPEC });
    await expect(dong).toHaveCount(1);
    await expect(dong).toContainText("1.234.000");
    // Có quyền sửa thường (nút "Sửa") nhưng không có lối sửa số tiền trước mốc của chủ shop.
    await expect(dong.getByRole("button", { name: "Sửa", exact: true })).toBeVisible();
    await expect(dong.getByRole("button", { name: TEN_NUT })).toHaveCount(0);
  });
});
