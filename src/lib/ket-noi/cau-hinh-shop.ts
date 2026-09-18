import { prisma } from "@/lib/prisma";

import type { VaiShop } from "@/lib/bronze/streams";

/**
 * Cấu hình shop — nguồn DUY NHẤT cho mọi shop id lúc chạy (app + n8n cùng đọc bảng `Setting`,
 * n8n qua node Postgres nên hai phía không bao giờ lệch nhau về nơi tra cứu).
 *
 * Vì sao KHÔNG phải hằng trong code: repo public cho người ngoài clone — shop của họ có id khác.
 * Vì sao KHÔNG phải env: n8n không đọc env của app; hai nguồn sự thật là drift chờ sẵn.
 *
 * Thiếu key ⇒ THROW lỗi rõ, TUYỆT ĐỐI không fallback về id HogiKids cũ — fallback câm nghĩa là
 * bản clone chạy bằng shop của người khác mà không ai hay (Pancake chỉ trả 401 khó hiểu).
 */
export type CauHinhShop = {
  /** Shop Pancake Kho Tổng — master tồn kho + giá vốn (bất biến #5). */
  kho: string;
  /** Shop Pancake bán Shopee — đơn gốc doanh thu. */
  shopee: string;
  /** Shop Pancake bán TikTok — đơn gốc doanh thu. */
  tiktok: string;
  /**
   * Shop id của TikTok Shop OPEN API — hệ đánh số KHÁC HẲN id shop TikTok bên trong Pancake;
   * trộn nhầm sẽ làm dòng Bronze TikTok đội lốt dòng Pancake. `null` = nguồn tuỳ chọn này
   * chưa cấu hình (key `tiktokShopShopId` — cùng key mà workflow n8n tiktokshop-nightly đọc).
   */
  tiktokShop: string | null;
};

/** Key trong bảng `Setting` cho từng vai — dùng chung bởi catalog UI, setup script và module này. */
export const KEY_SHOP_ID = {
  kho: "pancakeShopIdKho",
  shopee: "pancakeShopIdShopee",
  tiktok: "pancakeShopIdTiktok",
  tiktokShop: "tiktokShopShopId",
} as const;

export const LOI_CHUA_CAU_HINH_SHOP =
  "Chưa cấu hình shop ID Pancake — chạy `npm run setup` hoặc điền ở /cai-dat (khối Khóa kết nối, nguồn Pancake POS).";

/**
 * Cache module-level TTL ngắn: đường ingest gọi mỗi request nhưng giá trị gần như bất biến.
 * KHÔNG cache vĩnh viễn — action lưu khóa gọi `xoaCacheCauHinhShop()` nhưng process khác
 * (route handler ở worker khác) chỉ có TTL làm đường mòn hết hạn.
 */
const TTL_CACHE_MS = 60_000;
let cache: { value: CauHinhShop; hetHanLuc: number } | null = null;
let cacheWarehouse: { value: string | null; hetHanLuc: number } | null = null;

export function xoaCacheCauHinhShop(): void {
  cache = null;
  cacheWarehouse = null;
}

/** Id Pancake/TikTok Shop đều là chuỗi SỐ. Trim trước khi so — thừa khoảng trắng là cả stream bị từ chối. */
function chuanHoaId(tho: string | undefined): string | null {
  const v = (tho ?? "").trim();
  return /^\d+$/.test(v) ? v : null;
}

/**
 * `boQuaCache: true` cho ĐƯỜNG GHI theo sự kiện (webhook): shopId đọc ra sẽ được GHI vào
 * `RawPancakeWebhookEvent`/Bronze — dùng bản cache 60s ngay sau khi user đổi id là tự tay sinh
 * dòng mồ côi mang id cũ (đúng thứ `chan-doi-shop-id.ts` sinh ra để chặn). Webhook chỉ vài trăm
 * sự kiện/ngày nên thêm 1 truy vấn khoá chính mỗi sự kiện là rẻ. Đường đọc/land theo trang giữ
 * cache: giá trị cũ chỉ gây TỪ CHỐI to tiếng, không ghi sai.
 */
export async function layCauHinhShop(opts?: { boQuaCache?: boolean }): Promise<CauHinhShop> {
  const bayGio = Date.now();
  if (!opts?.boQuaCache && cache && cache.hetHanLuc > bayGio) return cache.value;

  const keys = Object.values(KEY_SHOP_ID);
  const rows = await prisma.setting.findMany({ where: { key: { in: [...keys] } } });
  const theoKey = new Map(rows.map((r) => [r.key, r.value]));

  const kho = chuanHoaId(theoKey.get(KEY_SHOP_ID.kho));
  const shopee = chuanHoaId(theoKey.get(KEY_SHOP_ID.shopee));
  const tiktok = chuanHoaId(theoKey.get(KEY_SHOP_ID.tiktok));
  if (!kho || !shopee || !tiktok) {
    const thieu = [
      !kho ? KEY_SHOP_ID.kho : null,
      !shopee ? KEY_SHOP_ID.shopee : null,
      !tiktok ? KEY_SHOP_ID.tiktok : null,
    ].filter(Boolean);
    throw new Error(`${LOI_CHUA_CAU_HINH_SHOP} (thiếu/không hợp lệ: ${thieu.join(", ")})`);
  }

  // tiktokShop là nguồn TUỲ CHỌN: thiếu thì các stream `tiktok/*` báo lỗi lúc DÙNG (shopIdsChoVai),
  // còn đường Pancake vẫn phải chạy bình thường cho bản clone chưa bật TikTok Shop.
  const value: CauHinhShop = { kho, shopee, tiktok, tiktokShop: chuanHoaId(theoKey.get(KEY_SHOP_ID.tiktokShop)) };
  cache = { value, hetHanLuc: bayGio + TTL_CACHE_MS };
  return value;
}

/**
 * Resolve danh sách vai của một stream (`BRONZE_STREAMS[stream].shops`) thành shop id thật.
 * Gọi TRƯỚC khi mở transaction land (xem ghi chú ở `landRaw`) rồi truyền kết quả xuống.
 */
export async function shopIdsChoVai(
  vais: readonly VaiShop[],
  opts?: { boQuaCache?: boolean }
): Promise<string[]> {
  const ch = await layCauHinhShop(opts);
  return vais.map((vai) => {
    if (vai === "tiktokShop") {
      if (!ch.tiktokShop) {
        throw new Error(
          "Chưa cấu hình `tiktokShopShopId` (shop id TikTok Shop Open API — KHÁC id shop TikTok trong Pancake) — " +
            "điền ở /cai-dat, nguồn TikTok Shop."
        );
      }
      return ch.tiktokShop;
    }
    return ch[vai];
  });
}

/** Nhãn hiển thị theo shop id (panel /cai-dat) — dựng từ cấu hình, không hardcode id. */
export function tenShopTheoId(ch: CauHinhShop): Record<string, string> {
  return { [ch.kho]: "Kho Tổng", [ch.shopee]: "Shopee", [ch.tiktok]: "TikTok" };
}

export const KEY_WAREHOUSE_KHO_TONG = "pancakeWarehouseIdKhoTong";

/**
 * Warehouse id (uuid) của kho hàng DUY NHẤT thuộc shop Kho Tổng — guard tồn kho realtime
 * (`webhook-stock.ts`). Tách khỏi `CauHinhShop` vì shape khác (uuid, không phải chuỗi số) và là
 * cấu hình TUỲ CHỌN: thiếu thì webhook tồn kho bỏ qua CÓ KẾT CỤC (lượt nightly vẫn vá tồn từ
 * API), không chặn đường nào khác.
 */
export async function layWarehouseKhoTong(): Promise<string | null> {
  const bayGio = Date.now();
  if (cacheWarehouse && cacheWarehouse.hetHanLuc > bayGio) return cacheWarehouse.value;
  const row = await prisma.setting.findUnique({ where: { key: KEY_WAREHOUSE_KHO_TONG } });
  const value = row?.value.trim() || null;
  cacheWarehouse = { value, hetHanLuc: bayGio + TTL_CACHE_MS };
  return value;
}
