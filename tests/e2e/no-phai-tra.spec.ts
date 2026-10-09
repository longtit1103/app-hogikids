import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";
import { format, startOfDay, startOfMonth, subDays } from "date-fns";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E "Nợ phải trả" — luồng ĐÃ BẬT trên DB e2e, mốc bật M = HÔM NAY:
 *   chuẩn bị (thêm thẻ, hồ sơ ví Shopee Ads) → xác nhận bật với số dư ngân hàng = quỹ app + nợ thẻ
 *   (chênh lệch giải thích hết) → Dòng tiền hiện dòng điều chỉnh mở sổ → trả thẻ → ghi nhận phiếu nhập
 *   vào sổ nợ → trả tiền hàng gộp → form chốt số dư KHÔNG còn câu "trừ nợ thẻ".
 *
 * Công tắc `Setting.noPhaiTraTuNgay` đổi công thức Sổ quỹ của CẢ DB e2e ⇒ `afterAll` BẮT BUỘC gỡ mốc +
 * mọi dữ liệu nợ phải trả vừa tạo (spec khác chạy sau theo thứ tự chữ cái giả định chưa bật). `beforeAll`
 * dọn y như vậy để lượt chạy trước chết giữa chừng không để lại rác.
 *
 * DB e2e tích luỹ dữ liệu từ spec khác ⇒ KHÔNG giả định số quỹ: đọc "Quỹ của app" ngay trên màn xác nhận
 * rồi suy số dư ngân hàng cần gõ. Thẻ khác (nếu spec khác tạo) được khai dư nợ 0, bỏ sao kê.
 *
 * Dọn theo PHẠM VI spec: chỉ xoá dữ liệu mang dấu `TIEN_TO` (tên thẻ, mô tả điều chỉnh "nợ thẻ <TEN_THE>", ghi
 * chú ví, mô tả mở sổ) hoặc id đã lưu (phiếu, mã yêu cầu ghi của các dòng tiền đó, neo mở sổ bước bật ghi cho
 * thẻ của spec khác — khôi phục neo cũ bị thay). KHÔNG `deleteMany` không phạm vi. Dữ liệu của spec khác làm
 * bước bật không chạy được (chốt số dư tháng này, mẫu định kỳ / chi phí Nhập hàng từ hôm nay, phiếu Y, thấu chi
 * còn nợ, ví/điều chỉnh/yêu cầu bật lạ) ⇒ LOCAL `test.skip` kèm lý do thay vì xoá hộ; trên CI (`process.env.CI`)
 * thì NÉM lỗi — CI xanh mà spec không chạy là lưới giả. DB e2e của CI mới tinh mỗi job và spec này chạy SAU
 * các spec trước nó theo chữ cái (1 worker) — rà 09/10: spec nào trước nó tạo dữ liệu chạm điều kiện trên đều tự
 * dọn (acceptance xoá chi phí Nhập hàng trong `finally`, chốt số dư dọn tháng này ở `afterAll`, mẫu định kỳ của
 * chi-phi/dinh-ky không phải Nhập hàng, thấu chi do so-quy-khoan-vay tạo chạy SAU). Spec trước để rác ⇒ CI đỏ
 * kèm lý do, sửa ở spec để rác chứ không nới ở đây.
 */
const TIEN_TO = "E2E no phai tra";
const TEN_THE = `${TIEN_TO} the`;
const MO_TA_MO_SO = `${TIEN_TO} — mo so`;
const PHIEU_UUID = "e2e0b5a1-0000-4000-8000-00000000a001";
const PHIEU_DISPLAY = 990_501;
const NO_THE = 5_000_000;
const KIND_CUTOVER = ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] as const;

/**
 * Không có DB e2e riêng thì e2e rơi về `TEST_DATABASE_URL` (DB của Vitest) — spec này bật công tắc đổi công
 * thức Sổ quỹ của cả DB ⇒ chỉ chạy trên DB e2e riêng. Ngoại lệ CI: mỗi job một Postgres tạm, không chung Vitest.
 */
const THIEU_DB_E2E = !process.env.TEST_DATABASE_URL_E2E?.trim() && !process.env.CI;

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

/**
 * Số tiền CUỐI CÙNG dạng "1.234.567 ₫" / "−1.234.567 ₫" trong chuỗi ⇒ số. Ô có nhãn kèm ngày ("Quỹ của app cuối
 * ngày 07/10/2026 100.600.000 ₫") — gom mọi chữ số sẽ dính cả ngày vào số tiền.
 */
function docTien(text: string): number {
  const cuoi = [...text.matchAll(/([-−]?)\s*(\d[\d.]*)\s*₫/g)].at(-1);
  if (cuoi === undefined) throw new Error(`Không thấy số tiền trong "${text}"`);
  const n = Number(cuoi[2].replace(/\./g, ""));
  return cuoi[1] === "" ? n : -n;
}

/** Gỡ mốc + dữ liệu nợ phải trả CỦA SPEC (và của lượt chạy trước chết giữa chừng) — chỉ theo dấu/id. */
async function donDep(): Promise<void> {
  const prisma = testPrisma();
  try {
    const the = await prisma.theTinDung.findMany({ where: { ten: { startsWith: TIEN_TO } }, select: { id: true } });
    const cardIds = the.map((t) => t.id);
    const phieu = await prisma.phieuNhapNo.findMany({ where: { refId: { endsWith: PHIEU_UUID } }, select: { id: true } });
    const phieuIds = phieu.map((p) => p.id);
    const dongCuaSpec = {
      OR: [
        { cardId: { in: cardIds } },
        { phieuNhapId: { in: phieuIds } },
        // Điều chỉnh mở sổ do spec bật: mô tả gợi ý "Mở sổ nợ phải trả …: nợ thẻ <TEN_THE>".
        { kind: { in: [...KIND_CUTOVER] }, description: { contains: TIEN_TO } },
        { description: MO_TA_MO_SO },
      ],
    };
    // Mã yêu cầu ghi (bước bật, trả tiền hàng…) đi theo dòng tiền của spec — lấy TRƯỚC khi xoá dòng.
    const yeuCauIds = (
      await prisma.cashMovement.findMany({ where: { ...dongCuaSpec, yeuCauId: { not: null } }, select: { yeuCauId: true } })
    ).flatMap((c) => (c.yeuCauId === null ? [] : [c.yeuCauId]));
    await prisma.cashMovement.deleteMany({ where: dongCuaSpec });
    await prisma.yeuCauGhi.deleteMany({ where: { id: { in: yeuCauIds } } });
    await prisma.kySaoKeThe.deleteMany({ where: { cardId: { in: cardIds } } });
    await prisma.ganNenTangThe.deleteMany({ where: { cardId: { in: cardIds } } });
    await prisma.theTinDung.deleteMany({ where: { id: { in: cardIds } } });
    await prisma.phieuNhapNo.deleteMany({ where: { id: { in: phieuIds } } });
    await prisma.rawPancakePurchase.deleteMany({ where: { externalId: PHIEU_UUID } });
    await prisma.viAdsTraTruoc.deleteMany({ where: { note: { startsWith: TIEN_TO }, movements: { none: {} } } });
    // Công tắc chỉ spec này bật trên DB e2e (spec khác chạy sau giả định chưa bật).
    await prisma.setting.deleteMany({ where: { key: "noPhaiTraTuNgay" } });
  } finally {
    await prisma.$disconnect();
  }
}

/** Dữ liệu của spec KHÁC làm bước bật không chạy được ⇒ lý do bỏ qua (null = chạy được). Gọi SAU `donDep`. */
async function lyDoKhongChayDuoc(): Promise<string | null> {
  const prisma = testPrisma();
  try {
    const dauThang = startOfMonth(new Date());
    const dauHomNay = startOfDay(new Date());
    const [cutoverLa, batLa, chot, mauNhap, nhapTuHomNay, phieuY, viLa, thauChi] = await Promise.all([
      prisma.cashMovement.count({ where: { kind: { in: [...KIND_CUTOVER] } } }),
      prisma.yeuCauGhi.count({ where: { loai: "XAC_NHAN_BAT" } }),
      prisma.soDuChotThang.count({ where: { thang: { gte: dauThang } } }),
      prisma.recurringExpense.count({ where: { categoryId: "purchase", active: true } }),
      prisma.expense.count({ where: { categoryId: "purchase", date: { gte: dauHomNay } } }),
      prisma.phieuNhapNo.count({ where: { lechDaGiaiThich: true } }),
      prisma.viAdsTraTruoc.count(),
      prisma.loan.findMany({
        where: { kind: "OVERDRAFT", closedAt: null },
        select: { duNoMoSo: true, movements: { where: { kind: { in: ["LOAN_IN", "LOAN_REPAY"] } }, select: { kind: true, amount: true } } },
      }),
    ]);
    const duNoThauChi = thauChi.reduce(
      (s, l) => s + l.duNoMoSo + l.movements.reduce((t, m) => t + (m.kind === "LOAN_IN" ? m.amount : -m.amount), 0),
      0
    );
    if (cutoverLa > 0 || batLa > 0) return "DB e2e đã có điều chỉnh mở sổ / yêu cầu bật không phải của spec — bước bật sẽ từ chối DA_BAT_ROI";
    if (chot > 0) return "DB e2e có chốt số dư tháng này (spec khác) — ngày bật hôm nay rơi vào tháng đã chốt";
    if (mauNhap > 0) return "DB e2e còn mẫu chi định kỳ Nhập hàng đang chạy (spec khác) — bước bật từ chối";
    if (nhapTuHomNay > 0) return "DB e2e có chi phí Nhập hàng từ hôm nay (spec khác) — bước bật từ chối CON_NHAP_HANG_SAU_M";
    if (phieuY > 0) return "DB e2e có phiếu nhập đã giải thích lệch (spec khác) — phần chưa giải thích sẽ khác 0";
    if (viLa > 0) return "DB e2e có hồ sơ ví Shopee Ads của spec khác — spec không tạo được ví của mình";
    if (duNoThauChi !== 0) return "DB e2e có thấu chi còn dư nợ (spec khác) — phần chưa giải thích sẽ khác 0";
    return null;
  } finally {
    await prisma.$disconnect();
  }
}

/** Neo mở sổ của thẻ spec KHÁC trước khi chạy — bước bật thay neo của MỌI thẻ đang mở; `afterAll` trả lại. */
let neoThePhuTruoc: Awaited<ReturnType<ReturnType<typeof testPrisma>["kySaoKeThe"]["findMany"]>> = [];
let lyDoBoQua: string | null = null;

test.describe("Nợ phải trả — bật một lần rồi dùng", () => {
  test.skip(THIEU_DB_E2E, "TEST_DATABASE_URL_E2E trống — spec bật công tắc Sổ quỹ của cả DB, không chạy trên DB Vitest");

  test.beforeAll(async () => {
    if (THIEU_DB_E2E) return;
    await donDep();
    lyDoBoQua = await lyDoKhongChayDuoc();
    // CI: không được bỏ qua — ném để job đỏ kèm lý do (local giữ skip, DB e2e local tích luỹ dữ liệu tay).
    if (lyDoBoQua !== null && process.env.CI) throw new Error(`Spec nợ phải trả không chạy được trên CI: ${lyDoBoQua}`);
    if (lyDoBoQua !== null) return;
    const prisma = testPrisma();
    try {
      neoThePhuTruoc = await prisma.kySaoKeThe.findMany({ where: { laNeoMoSo: true } });
      // Sổ quỹ đã mở trước hôm qua (quỹ cuối ngày trước mốc có nghĩa).
      await prisma.cashMovement.create({
        data: { date: subDays(new Date(), 3), kind: "CAPITAL_IN", amount: 100_000_000, description: MO_TA_MO_SO },
      });
      // Phiếu nhập Pancake (Bronze) còn hiệu lực — ghi nhận vào sổ nợ sau khi bật.
      await prisma.rawPancakePurchase.create({
        data: {
          shopId: SHOP_KHO,
          externalId: PHIEU_UUID,
          payloadHash: `e2e-npt-${Date.now()}`,
          payload: {
            id: PHIEU_UUID,
            created_type: "actual_purchase",
            // Naive = giờ UTC (bất biến múi giờ): 03:00 UTC = 10:00 VN hôm nay.
            inserted_at: `${format(new Date(), "yyyy-MM-dd")}T03:00:00`,
            display_id: PHIEU_DISPLAY,
            total_price: 8_000_000,
            total_quantity: 1,
            items: [{ quantity: 1, imported_price: 8_000_000 }],
            status: 1,
            note: null,
          },
          fetchedAt: new Date(),
        },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  test.afterAll(async () => {
    if (THIEU_DB_E2E) return;
    await donDep();
    if (lyDoBoQua !== null) return;
    // Neo bước bật vừa ghi cho thẻ spec khác ⇒ xoá, trả lại neo cũ bị thay (cùng id, cùng số).
    const prisma = testPrisma();
    try {
      const giu = neoThePhuTruoc.map((k) => k.id);
      await prisma.kySaoKeThe.deleteMany({ where: { laNeoMoSo: true, id: { notIn: giu } } });
      const conLai = new Set((await prisma.kySaoKeThe.findMany({ where: { id: { in: giu } }, select: { id: true } })).map((k) => k.id));
      const traLai = neoThePhuTruoc.filter((k) => !conLai.has(k.id));
      if (traLai.length > 0) await prisma.kySaoKeThe.createMany({ data: traLai });
    } finally {
      await prisma.$disconnect();
    }
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("chuẩn bị → bật → điều chỉnh mở sổ → trả thẻ → ghi nhận phiếu → trả gộp → chốt số dư", async ({ page }) => {
    test.skip(lyDoBoQua !== null, lyDoBoQua ?? "");
    const homNay = format(new Date(), "yyyy-MM-dd");

    // ① Chuẩn bị: thẻ + hồ sơ ví (chưa bật — hồ sơ không đổi quỹ).
    await page.goto(`/tai-chinh/no-phai-tra?tab=chuan-bi&m=${homNay}`);
    await expect(page.getByTestId("bat-checklist")).toBeVisible();
    await page.getByRole("button", { name: "+ Thêm thẻ" }).click();
    const formThe = page.getByRole("dialog");
    await formThe.getByLabel("Tên thẻ", { exact: true }).fill(TEN_THE);
    await formThe.getByLabel("Ngày chốt sao kê (1–31)").fill("25");
    await formThe.getByLabel("Ngày hạn trả (1–31)").fill("10");
    await formThe.getByRole("button", { name: "Lưu" }).click();
    await expect(formThe).toBeHidden();

    await page.getByRole("button", { name: "+ Thêm ví Shopee Ads" }).click();
    const formVi = page.getByRole("dialog");
    await formVi.getByLabel("Ngân hàng (chuyển khoản / thẻ ghi nợ)").check();
    await formVi.getByLabel("Ghi chú (tuỳ chọn)").fill(`${TIEN_TO} vi`);
    await formVi.getByRole("button", { name: "Lưu" }).click();
    await expect(formVi).toBeHidden();
    await expect(page.getByTestId("vi-ads-dong")).toHaveCount(1);

    // ② Xác nhận (M = hôm nay ⇒ tab mở).
    await page.getByRole("link", { name: "Xác nhận" }).click();
    await expect(page.getByRole("heading", { name: /Bước 1/ })).toBeVisible();
    const khoiThe = page.getByTestId("bat-khai-the");
    const soThe = await khoiThe.count();
    for (let i = 0; i < soThe; i += 1) {
      const k = khoiThe.nth(i);
      const laThe = (await k.innerText()).includes(TEN_THE);
      await k.getByLabel(/Khai kỳ sao kê gần nhất/).uncheck();
      await k.getByLabel(/^Dư nợ /).fill(laThe ? String(NO_THE) : "0");
    }
    await page.getByLabel("Số dư Ví Shopee Ads").fill("0");

    // Tính một lượt với ngân hàng 0 để ĐỌC quỹ app, rồi gõ ngân hàng = quỹ + nợ thẻ.
    await page.getByLabel("Số dư ngân hàng").fill("0");
    await page.getByRole("button", { name: "Tính chênh lệch" }).click();
    const quyApp = docTien(await page.getByTestId("bat-quy-app").innerText());
    await page.getByLabel("Số dư ngân hàng").fill(String(quyApp + NO_THE));
    await page.getByRole("button", { name: /Tính (lại )?chênh lệch/ }).click();
    // Chỉ một chữ số "0" trên cả dòng ⇒ chưa giải thích đúng 0 (không khớp nhầm "10.000 ₫").
    await expect(page.getByTestId("bat-dong-chua-giai-thich")).toHaveText(/^Chưa giải thích\D*0\D*$/);
    // Mô tả điều chỉnh nằm trong ô nhập (giá trị input không thuộc text của danh sách).
    const moTaDieuChinh = page.getByTestId("bat-danh-sach-dieu-chinh").getByLabel("Mô tả điều chỉnh");
    await expect(moTaDieuChinh).toHaveCount(1);
    await expect(moTaDieuChinh).toHaveValue(new RegExp(`nợ thẻ ${TEN_THE}$`));

    await page.getByLabel("Tôi đã kiểm số và hiểu đây là bước một lần").check();
    await page.getByRole("button", { name: "Xác nhận bật theo dõi nợ phải trả" }).click();
    await expect(page.getByTestId("no-phai-tra-da-bat")).toBeVisible();
    await expect(page.getByTestId("no-phai-tra-lich-su-dieu-chinh")).toContainText(TEN_THE);

    // ③ Dòng tiền: dòng điều chỉnh mở sổ (vào quỹ đúng nợ thẻ) hiện trong bảng ghi tay.
    await page.goto("/tai-chinh?tab=dong-tien");
    await expect(page.locator("#ghi-tay")).toContainText(`nợ thẻ ${TEN_THE}`);

    // ④ Trả thẻ 2tr.
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const formTien = page.getByRole("dialog");
    await pickSelectOption(page, "Chọn loại khoản", "Trả thẻ tín dụng");
    await pickSelectOption(page, "Chọn thẻ", TEN_THE);
    await formTien.getByPlaceholder("0").fill("2000000");
    await formTien.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã ghi Trả thẻ tín dụng/)).toBeVisible();

    // ⑤ Ghi nhận phiếu nhập vào sổ nợ (chỉ phiếu của spec).
    await page.goto("/tai-chinh/chi-phi-nhap-hang");
    const chon = page.getByRole("checkbox", { name: /^Chọn phiếu / });
    const soPhieu = await chon.count();
    for (let i = 0; i < soPhieu; i += 1) {
      const o = chon.nth(i);
      const laCuaSpec = (await o.getAttribute("aria-label")) === `Chọn phiếu #${PHIEU_DISPLAY}`;
      if ((await o.getAttribute("aria-checked")) === "true" ? !laCuaSpec : laCuaSpec) await o.click();
    }
    await page.getByRole("button", { name: "Ghi nhận 1 phiếu vào sổ nợ" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Ghi vào sổ nợ" }).click();
    await expect(page.getByText("Đã ghi nhận 1 phiếu vào sổ nợ.")).toBeVisible();

    // ⑥ Trả tiền hàng gộp 3tr vào đúng phiếu đó.
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.getByRole("button", { name: "Trả tiền hàng" }).click();
    const formTra = page.getByRole("dialog");
    await formTra.getByLabel("Tổng số tiền trả").fill("3000000");
    const oPhieu = formTra.getByRole("textbox", { name: /^Trả phiếu / });
    const soO = await oPhieu.count();
    for (let i = 0; i < soO; i += 1) {
      const o = oPhieu.nth(i);
      await o.fill((await o.getAttribute("aria-label")) === `Trả phiếu #${PHIEU_DISPLAY}` ? "3000000" : "0");
    }
    await formTra.getByRole("button", { name: "Ghi trả tiền hàng" }).click();
    await expect(formTra).toBeHidden();

    // ⑦ Chốt số dư tháng có mốc bật: KHÔNG còn câu "trừ nợ thẻ".
    const card = page.getByTestId("so-du-chot-card");
    await card.getByRole("button", { name: "Chốt số dư" }).click();
    const formChot = page.getByRole("dialog");
    await expect(formChot.getByTestId("so-du-chot-sau-bat-no-phai-tra")).toBeVisible();
    await expect(formChot.getByTestId("so-du-chot-nhac-the-tin-dung")).toHaveCount(0);
    await expect(formChot.getByTestId("so-du-chot-goi-y-vi-ads")).toBeVisible();
    await formChot.getByRole("button", { name: "Hủy" }).click();
  });
});
