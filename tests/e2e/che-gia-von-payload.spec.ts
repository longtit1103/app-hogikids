import { expect, test } from "./fixture-cho-trang-stream-xong";

import { dangNhapVoi } from "./dang-nhap-voi-tai-khoan";
import { CHUOI_DO_GIA_VON, GIA_VON_DO, SKU_DO_GIA_VON, TEN_SP_DO_GIA_VON, seedDoGiaVon } from "./fixture-gia-von-do";
import { testPrisma } from "./ingest-raw";
import { dangNhap } from "./mobile-helpers";
import { taoTaiKhoanStaff } from "./tao-tai-khoan-staff";

/**
 * Che giá vốn ở PAYLOAD, không chỉ ở giao diện: người thiếu `gia-von-loi-nhuan:xem` tải HTML thô và
 * luồng RSC (`RSC: 1` — thứ Next gửi khi điều hướng phía client) của các trang có dữ liệu giá vốn;
 * con số dò `7331117` không được xuất hiện ở bất kỳ dạng nào. Giá vốn dò chỉ nằm ở
 * `Variant.costPrice`, nên có nó trong phản hồi nghĩa là giá vốn đã lọt qua ranh giới server.
 *
 * Mỗi lượt xét cả dạng thô (`7331117` — RSC/JSON) lẫn dạng đã định dạng tiền (`7.331.117` — HTML do
 * `formatVnd`): kiểm mỗi dạng thô sẽ bỏ lọt chính chỗ render ra màn hình.
 */

const EMAIL_XEM = "xem@hogikids.test";
const MAT_KHAU = "Xem-Password-123!";
const CHUOI_DINH_DANG = "7.331.117";
/**
 * DB e2e sống qua nhiều lượt và nhiều spec ghi sản phẩm/đơn, nên dòng dò không chắc nằm ở trang đầu của
 * danh sách. Mỗi trang kiểm CẢ bản thường lẫn bản lọc theo mã (`?q=`) — bản lọc bắt buộc render ra dòng
 * dò (`phaiCo`), nếu không phép "không chứa giá vốn" xanh vì dòng chưa từng được vẽ.
 */
const URL_KIEM: { url: string; phaiCo?: string }[] = [
  { url: "/" },
  { url: "/san-pham" },
  { url: `/san-pham?q=${SKU_DO_GIA_VON}`, phaiCo: SKU_DO_GIA_VON },
  { url: "/ton-kho" },
  { url: `/ton-kho?q=${SKU_DO_GIA_VON}`, phaiCo: SKU_DO_GIA_VON },
  { url: "/don-hang" },
  { url: "/don-hang?q=DO-GIA-VON-01", phaiCo: "DO-GIA-VON-01" },
];

test.beforeAll(async () => {
  const prisma = testPrisma();
  try {
    await seedDoGiaVon(prisma);
    await taoTaiKhoanStaff(prisma, {
      email: EMAIL_XEM,
      matKhau: MAT_KHAU,
      quyen: ["tong-quan:xem", "san-pham:xem", "don-hang:xem", "ton-kho:xem"],
    });
  } finally {
    await prisma.$disconnect();
  }
});

test.afterAll(async () => {
  const prisma = testPrisma();
  try {
    await prisma.user.deleteMany({ where: { email: EMAIL_XEM } });
  } finally {
    await prisma.$disconnect();
  }
});

test("tiền kiểm: sentinel chỉ nằm ở đúng 1 giá vốn, không ở SKU/tên/giá bán/đơn", async () => {
  const prisma = testPrisma();
  try {
    expect(await prisma.variant.count({ where: { costPrice: GIA_VON_DO } })).toBe(1);
    expect(
      await prisma.variant.count({
        where: { OR: [{ sku: { contains: CHUOI_DO_GIA_VON } }, { label: { contains: CHUOI_DO_GIA_VON } }] },
      }),
    ).toBe(0);
    expect(await prisma.product.count({ where: { name: { contains: CHUOI_DO_GIA_VON } } })).toBe(0);
    expect(await prisma.variant.count({ where: { OR: [{ sellPrice: GIA_VON_DO }, { stock: GIA_VON_DO }] } })).toBe(0);
    expect(await prisma.orderItem.count({ where: { OR: [{ quantity: GIA_VON_DO }, { unitPrice: GIA_VON_DO }] } })).toBe(0);
    expect(await prisma.order.count({ where: { itemsTotal: GIA_VON_DO } })).toBe(0);
    // Dữ liệu dò đủ để các trang render ra nó: 1 biến thể đúng SKU/tên, 1 đơn hợp lệ dùng SKU đó.
    expect(await prisma.variant.count({ where: { sku: SKU_DO_GIA_VON, product: { name: TEN_SP_DO_GIA_VON } } })).toBe(1);
    expect(
      await prisma.orderItem.count({ where: { sku: SKU_DO_GIA_VON, order: { status: { notIn: ["RETURNED", "CANCELLED"] } } } }),
    ).toBeGreaterThanOrEqual(1);
  } finally {
    await prisma.$disconnect();
  }
});

test.describe("người không có quyền giá vốn", () => {
  test("HTML và luồng RSC của 4 trang đều 200 và không chứa số giá vốn", async ({ page }) => {
    await dangNhapVoi(page, EMAIL_XEM, MAT_KHAU);

    for (const { url, phaiCo } of URL_KIEM) {
      for (const [ten, headers, duongDan] of [
        ["HTML", undefined, url],
        // Next đẩy 307 sang `?_rsc` (giá trị băm của các header router, rỗng khi chỉ có `RSC: 1`) nếu thiếu — router phía client luôn
        // gửi kèm nên spec cũng gửi, để đo đúng thứ người dùng thật nhận.
        ["RSC", { RSC: "1" }, `${url}${url.includes("?") ? "&" : "?"}_rsc`],
      ] as const) {
        // maxRedirects: 0 + khẳng định 200 TRƯỚC: bị đẩy sang /khong-co-quyen hay /dang-nhap thì phản
        // hồi rỗng dữ liệu và phép "không chứa" xanh vô nghĩa.
        const res = await page.request.get(duongDan, { maxRedirects: 0, headers });
        expect(res.status(), `${ten} ${url} phải 200, không redirect (Location: ${res.headers()["location"]})`).toBe(200);
        const noiDung = await res.text();
        expect(noiDung.length, `${ten} ${url} không được rỗng`).toBeGreaterThan(500);
        if (phaiCo) expect(noiDung, `${ten} ${url} phải render dòng dò`).toContain(phaiCo);
        expect(noiDung, `${ten} ${url} lộ giá vốn dạng thô`).not.toContain(CHUOI_DO_GIA_VON);
        expect(noiDung, `${ten} ${url} lộ giá vốn dạng định dạng tiền`).not.toContain(CHUOI_DINH_DANG);
      }
    }
  });
});

test.describe("đối chứng chủ shop — phép dò có bắt được giá vốn", () => {
  test("/san-pham và /ton-kho CÓ giá vốn (HTML định dạng hoặc payload thô)", async ({ page }) => {
    await dangNhap(page);
    for (const url of [`/san-pham?q=${SKU_DO_GIA_VON}`, `/ton-kho?q=${SKU_DO_GIA_VON}`]) {
      const res = await page.request.get(url, { maxRedirects: 0 });
      expect(res.status(), `${url} phải 200`).toBe(200);
      const html = await res.text();
      // SKU/tên/giá bán không chứa sentinel ⇒ có mặt nó chỉ có thể đến từ giá vốn. Thiếu ⇒ fixture hoặc
      // render sai và toàn bộ spec "không chứa" bên trên xanh giả.
      expect(
        html.includes(CHUOI_DO_GIA_VON) || html.includes(CHUOI_DINH_DANG),
        `${url} của chủ shop phải có giá vốn dò`,
      ).toBe(true);
    }
  });
});
