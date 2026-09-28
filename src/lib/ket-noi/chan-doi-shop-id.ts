import { BRONZE_STREAMS, type VaiShop } from "@/lib/bronze/streams";
import { prisma } from "@/lib/prisma";

import { KEY_SHOP_ID, KEY_WAREHOUSE_KHO_TONG } from "./cau-hinh-shop";

/**
 * Lưới chặn ĐỔI shop ID khi kho thô đã có dữ liệu mang id cũ.
 *
 * Vì sao phải chặn: Bronze là append-only — dòng cũ giữ nguyên `shopId` cũ vĩnh viễn. Đổi id
 * trong cấu hình xong thì transform/rebuild lọc theo id MỚI đọc ra 0 dòng: Variant không được
 * làm mới, COGS về 0, đối soát im — tất cả ÂM THẦM (red-team 21/08). Đường di trú dữ liệu sang
 * id mới chưa có (ngoài scope v1) nên thà từ chối to tiếng còn hơn hỏng lặng.
 *
 * Ô shop ID vẫn điền được thoải mái khi kho thô CHƯA có gì (bản clone mới setup, hoặc sửa lại
 * giá trị gõ nhầm trước lần đồng bộ đầu tiên).
 */

const KEY_SHOP_ID_HOP_LE = new Set<string>(Object.values(KEY_SHOP_ID));

/** key Setting → vai — đảo của KEY_SHOP_ID, để tra vai của key đang bị đổi. */
const VAI_THEO_KEY = Object.fromEntries(
  Object.entries(KEY_SHOP_ID).map(([vai, key]) => [key, vai as VaiShop])
) as Record<string, VaiShop>;

/**
 * Danh sách bảng Bronze phải soi cho một vai — DỰNG TỪ REGISTRY thay vì liệt kê tay: mọi stream
 * mà vai đó nằm trong whitelist đều từng land vào bảng của stream (review 21/08: bản liệt kê tay
 * đầu tiên sót ví Shopee — shop mới chỉ có dữ liệu ví đổi id vẫn lọt). Cộng thêm hộp thư webhook
 * cho 3 vai Pancake (bảng đó không nằm trong registry stream).
 */
function bangBronzeChoVai(vai: VaiShop): string[] {
  const bang = new Set<string>();
  for (const def of Object.values(BRONZE_STREAMS)) {
    if (def.shops !== null && def.shops.includes(vai)) bang.add(def.table);
  }
  if (vai !== "tiktokShop") bang.add("RawPancakeWebhookEvent");
  return [...bang];
}

async function demDongBronzeMangId(vai: VaiShop, shopId: string): Promise<number> {
  let tong = 0;
  for (const bang of bangBronzeChoVai(vai)) {
    // Tên bảng là HẰNG từ registry (không bao giờ từ input) — nội suy vào SQL an toàn.
    const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "${bang}" WHERE "shopId" = $1`,
      shopId
    );
    tong += Number(row?.n ?? 0);
  }
  return tong;
}

/** uuid dạng 8-4-4-4-12 hex — warehouse id Pancake. Gõ sai 1 ký tự là tồn realtime tắt câm. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kiểm các cặp [key, giá trị mới] sắp ghi. Trả message lỗi (chặn cả lượt lưu) hoặc `null` nếu
 * sạch. Chỉ soi key shop ID + warehouse — key khác (API key, token…) đi qua tự do.
 */
export async function chanDoiShopIdKhiCoDuLieu(canGhi: Array<[string, string]>): Promise<string | null> {
  const ghiTheoKey = new Map(canGhi);

  const loiWarehouse = ghiTheoKey.get(KEY_WAREHOUSE_KHO_TONG);
  if (loiWarehouse !== undefined && !UUID_RE.test(loiWarehouse)) {
    return `Warehouse ID "${loiWarehouse}" không hợp lệ — phải là uuid (copy nguyên từ Pancake).`;
  }

  for (const [key, giaTriMoi] of canGhi) {
    if (!KEY_SHOP_ID_HOP_LE.has(key)) continue;

    if (!/^\d+$/.test(giaTriMoi)) {
      return `Shop ID "${giaTriMoi}" không hợp lệ — chỉ gồm chữ số (copy nguyên id từ Pancake/TikTok Shop).`;
    }

    const dongCu = await prisma.setting.findUnique({ where: { key } });
    const giaTriCu = dongCu?.value.trim() ?? "";
    if (!giaTriCu || giaTriCu === giaTriMoi) continue; // điền mới / không đổi — cho qua

    const soDong = await demDongBronzeMangId(VAI_THEO_KEY[key], giaTriCu);
    if (soDong > 0) {
      return (
        `Không đổi được ${key}: kho thô đang giữ ${soDong.toLocaleString("vi-VN")} dòng dữ liệu của shop id cũ ` +
        `"${giaTriCu}" — đổi id sẽ làm toàn bộ số đó thành mồ côi (giá vốn/doanh thu thiếu ÂM THẦM). ` +
        `Nếu thật sự cần đổi, liên hệ dev để di trú dữ liệu trước.`
      );
    }
  }

  // 3 shop Pancake là 3 shop KHÁC NHAU — cùng một id cho 2 vai (dán nhầm) thì catalog/giá vốn
  // đọc từ shop bán, COGS sai câm mà không lưới nào phía sau bắt được. Kiểm trên giá trị SAU khi
  // ghi (Setting hiện tại đè bởi canGhi). CHỈ khi lượt lưu có đụng shop id: lượt lưu API key/token
  // không tạo ra cặp trùng mới được — khỏi tốn 4 truy vấn cho mọi lần bấm Lưu.
  if (!canGhi.some(([k]) => KEY_SHOP_ID_HOP_LE.has(k))) return null;
  const sauKhiGhi = new Map<VaiShop, string>();
  for (const [vai, key] of Object.entries(KEY_SHOP_ID) as Array<[VaiShop, string]>) {
    const v = (ghiTheoKey.get(key) ?? (await prisma.setting.findUnique({ where: { key } }))?.value ?? "").trim();
    if (v) sauKhiGhi.set(vai, v);
  }
  const daThay = new Map<string, VaiShop>();
  for (const [vai, v] of sauKhiGhi) {
    const truoc = daThay.get(v);
    if (truoc) {
      return `Shop ID "${v}" đang được dùng cho cả "${truoc}" lẫn "${vai}" — mỗi vai phải là một shop khác nhau.`;
    }
    daThay.set(v, vai);
  }

  return null;
}
