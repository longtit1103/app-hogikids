import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import {
  ghepDeXuat,
  rutBienTheTuPayload,
  type BienTheKho,
  type CheDoDoiChieu,
  type DeXuatGiaVon,
} from "./doi-chieu-gia-von";

/**
 * Đọc "app ↔ Bronze" rồi trả về danh sách biến thể đáng sửa giá vốn.
 *
 * Tách khỏi `scripts/doi-chieu-gia-von-pancake.ts` (2026-09-07) để CLI và màn duyệt trong app dùng
 * CHUNG một truy vấn. Hai bên tự viết truy vấn riêng là mở đường cho chúng lệch nhau — mà lệch ở
 * đây nghĩa là màn hình hứa một đằng, lượt ghi làm một nẻo, trên đúng con số tạo ra COGS.
 *
 * THUẦN ĐỌC: không ghi, không khoá. Bên gọi lo phần duyệt/ghi.
 */
export async function docDeXuatGiaVon(cheDo: CheDoDoiChieu): Promise<{
  deXuat: DeXuatGiaVon[];
  soBienTheApp: number;
  soBienTheKho: number;
  /** Biến thể app còn trống giá vốn mà Pancake CŨNG chưa khai ⇒ vẫn phải nhập tay ở màn Sản phẩm. */
  conPhaiNhapTay: number;
}> {
  const { kho: shopKho } = await layCauHinhShop();

  // Lấy hết rồi để `ghepDeXuat` lọc theo chế độ — một luật lọc, một chỗ.
  const bienTheApp = await prisma.variant.findMany({
    select: { id: true, pancakeId: true, sku: true, label: true, costPrice: true },
  });

  // Bản MỚI NHẤT mỗi sản phẩm trong Bronze shop KHO (cùng luật `DISTINCT ON` với transform).
  // Đọc payload qua Prisma (JSON.parse) AN TOÀN ở đây: products dùng uuid chuỗi, không có số
  // ≥16 chữ số — cùng căn cứ đã ghi ở `latestPayloads` (transform-raw-helpers.ts).
  const rawProducts = await prisma.$queryRawUnsafe<{ payload: unknown }[]>(
    `SELECT DISTINCT ON ("externalId") payload
       FROM "RawPancakeProduct" WHERE "shopId" = $1
       ORDER BY "externalId", "fetchedAt" DESC, "id" DESC`,
    shopKho,
  );
  const giaKho: BienTheKho[] = rawProducts.flatMap((r) => rutBienTheTuPayload(r.payload));

  const deXuat = ghepDeXuat(bienTheApp, giaKho, cheDo);
  const soTrong = bienTheApp.filter((v) => v.costPrice === 0).length;

  return {
    deXuat,
    soBienTheApp: bienTheApp.length,
    soBienTheKho: giaKho.length,
    conPhaiNhapTay: soTrong - deXuat.filter((d) => d.giaHienTai === 0).length,
  };
}

/**
 * Chỉ ĐẾM số biến thể lệch — dùng cho lượt đêm ghi mốc `Setting` và cho badge sidebar.
 *
 * Vẫn phải đọc trọn Bronze như trên (không có đường tắt: giá đề xuất là hàm của payload), nên
 * TUYỆT ĐỐI không gọi hàm này trong layout mỗi request — layout chỉ đọc con số đã chốt trong
 * `Setting`. Xem `trang-thai-lech-gia-von.ts`.
 */
export async function demLechGiaVon(cheDo: CheDoDoiChieu = "theo-pancake"): Promise<number> {
  const { deXuat } = await docDeXuatGiaVon(cheDo);
  return deXuat.length;
}
