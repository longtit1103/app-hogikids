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
 * Số SUY RA từ giá vốn dò trên đơn dò `DO-GIA-VON-01` (2 × 7.331.117, tiền hàng 240.000, không phí):
 * giá vốn đơn 14.662.234 và lãi đơn −14.422.234. Trang Đơn hàng tính lãi từng đơn ⇒ hai số này cũng
 * là giá vốn lọt ra ngoài, ở cả dạng thô lẫn dạng tiền.
 */
/** Mã sàn của đơn dò (= `pancakeId`, đơn Shopee) — hiện ở dòng phụ của ô Đơn. */
const MA_SAN_DON_DO = "E2E-DO-GIA-VON-DON";
const CHUOI_SUY_RA = ["14422234", "14.422.234", "14662234", "14.662.234"];
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
  // `phaiCo` là MÃ SÀN của đơn dò (chỉ có trong dòng đơn) — mã đơn thì ô tìm/chip "Tìm:" cũng chứa, phép
  // "phải render dòng dò" sẽ xanh cả khi danh sách rỗng.
  { url: "/don-hang?q=DO-GIA-VON-01", phaiCo: MA_SAN_DON_DO },
  // Gõ tay tham số cần giá vốn: chip `thieu_gv` + sắp theo lãi phải bị BỎ (đơn dò vẫn hiện) — giữ lại
  // thì tập đơn / thứ tự tự nó lộ giá vốn.
  { url: "/don-hang?q=DO-GIA-VON-01&loc=thieu_gv&sx=lai_thap", phaiCo: MA_SAN_DON_DO },
  { url: "/don-hang?ky=tat_ca&q=DO-GIA-VON-01", phaiCo: MA_SAN_DON_DO },
];

/** Không chứa giá vốn dò ở dạng nào (thô, định dạng tiền, số suy ra trên đơn dò). */
function khongLoGiaVon(noiDung: string, nhan: string): void {
  expect(noiDung, `${nhan} lộ giá vốn dạng thô`).not.toContain(CHUOI_DO_GIA_VON);
  expect(noiDung, `${nhan} lộ giá vốn dạng định dạng tiền`).not.toContain(CHUOI_DINH_DANG);
  for (const chuoi of CHUOI_SUY_RA) expect(noiDung, `${nhan} lộ số suy ra từ giá vốn (${chuoi})`).not.toContain(chuoi);
}

/** Id đơn dò — mở drawer `?don=` cần id thật. */
async function idDonDo(): Promise<string> {
  const prisma = testPrisma();
  try {
    return (await prisma.order.findFirstOrThrow({ where: { code: "DO-GIA-VON-01" }, select: { id: true } })).id;
  } finally {
    await prisma.$disconnect();
  }
}

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
        khongLoGiaVon(noiDung, `${ten} ${url}`);
      }
    }
  });

  test("drawer đơn dò (`?don=`) không chứa giá vốn hay lãi suy ra", async ({ page }) => {
    await dangNhapVoi(page, EMAIL_XEM, MAT_KHAU);
    const url = `/don-hang?q=DO-GIA-VON-01&don=${await idDonDo()}`;
    for (const [ten, headers, duongDan] of [
      ["HTML", undefined, url],
      ["RSC", { RSC: "1" }, `${url}&_rsc`],
    ] as const) {
      const res = await page.request.get(duongDan, { maxRedirects: 0, headers });
      expect(res.status(), `${ten} ${url} phải 200`).toBe(200);
      const noiDung = await res.text();
      // Drawer thật sự được dựng (SKU dò chỉ có trong bảng sản phẩm của drawer, không ở danh sách).
      expect(noiDung, `${ten} ${url} phải dựng drawer`).toContain(SKU_DO_GIA_VON);
      khongLoGiaVon(noiDung, `${ten} ${url}`);
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

  test("/don-hang của chủ shop CÓ lãi đơn dò; chip thiếu giá vốn CÓ hiệu lực", async ({ page }) => {
    await dangNhap(page);
    const res = await page.request.get("/don-hang?q=DO-GIA-VON-01", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    // Chứng minh phép dò bên trên bắt được lãi suy ra: chủ shop thấy đúng số đó (và đúng đơn dò).
    const html = await res.text();
    expect(html).toContain(MA_SAN_DON_DO);
    expect(html).toContain("14.422.234");

    // Giá vốn đơn dò ≠ 0 nên đơn không "thiếu giá vốn" ⇒ với chủ shop chip lọc mất đơn dò. Nhánh người
    // không quyền vẫn thấy đơn dò ở cùng URL ⇒ chip bị bỏ thật, không phải lọc vô tác dụng.
    const loc = await page.request.get("/don-hang?q=DO-GIA-VON-01&loc=thieu_gv", { maxRedirects: 0 });
    expect(loc.status()).toBe(200);
    expect(await loc.text()).not.toContain(MA_SAN_DON_DO);
  });
});
