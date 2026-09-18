import { prisma } from "@/lib/prisma";

import { layCauHinhShop } from "./cau-hinh-shop";
import { gopKetQua, KIEM_TRA_TIMEOUT_MS, type DongKiemTra, type KetQuaKiemTra } from "./kiem-tra-types";

/**
 * Probe Pancake POS: gọi ĐÚNG đường mà `pancake-nightly` dùng (GET orders, `page_size=1`)
 * cho từng shop — khóa qua được probe này thì lượt đồng bộ đêm cũng qua.
 *
 * Đọc body dạng TEXT + soi cờ bằng regex, KHÔNG `JSON.parse` — cùng kỷ luật với đường ingest
 * (int64 của Pancake bị JS làm tròn); probe chỉ cần biết "thành công hay không", không cần data.
 */

const PANCAKE_BASE = "https://pos.pages.fm/api/v1";

const CAC_SHOP = [
  { nhan: "Shop Kho Tổng", vai: "kho", key: "pancakeApiKeyKho" },
  { nhan: "Shop Shopee", vai: "shopee", key: "pancakeApiKeyShopee" },
  { nhan: "Shop TikTok", vai: "tiktok", key: "pancakeApiKeyTiktok" },
] as const;

async function kiemTraMotShop(nhan: string, shopId: string, apiKey: string): Promise<DongKiemTra> {
  const url =
    `${PANCAKE_BASE}/shops/${shopId}/orders?api_key=${encodeURIComponent(apiKey)}` +
    `&page_size=1&page_number=1`;
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(KIEM_TRA_TIMEOUT_MS) });
    text = await res.text();
  } catch {
    return { nhan, ok: false, chiTiet: "Không kết nối được tới Pancake (mạng hoặc Pancake đang lỗi)." };
  }
  // 401/403 = khóa sai/bị thu hồi. Pancake cũng có thể trả 200 kèm `"success":false`.
  if (res.status === 401 || res.status === 403) {
    return { nhan, ok: false, chiTiet: "Pancake từ chối khóa này — kiểm tra lại API key (hoặc key đã bị thu hồi)." };
  }
  if (!res.ok) {
    return { nhan, ok: false, chiTiet: `Pancake trả lỗi HTTP ${res.status} — thử lại sau ít phút.` };
  }
  if (!/"success":\s*true/.test(text)) {
    return { nhan, ok: false, chiTiet: "Pancake không xác nhận thành công — kiểm tra lại API key có đúng của shop này không." };
  }
  return { nhan, ok: true, chiTiet: "Khóa dùng được." };
}

export async function kiemTraPancake(): Promise<KetQuaKiemTra> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: CAC_SHOP.map((s) => s.key) } },
  });
  const theoKey = new Map(rows.map((r) => [r.key, r.value]));

  // Shop id từ cấu hình `Setting` — thiếu thì trả kết quả kiểm tra ĐỎ thay vì văng lỗi:
  // nút "Kiểm tra kết nối" chính là chỗ người dùng phát hiện mình chưa điền shop ID.
  let shopIdTheoVai: Record<(typeof CAC_SHOP)[number]["vai"], string>;
  try {
    const ch = await layCauHinhShop();
    shopIdTheoVai = { kho: ch.kho, shopee: ch.shopee, tiktok: ch.tiktok };
  } catch (err) {
    return gopKetQua(
      CAC_SHOP.map((s) => ({
        nhan: s.nhan,
        ok: false,
        chiTiet: err instanceof Error ? err.message : "Chưa cấu hình shop ID Pancake.",
      }))
    );
  }

  // 3 shop probe SONG SONG — tuần tự là 3×timeout khi Pancake sập, người dùng ngồi chờ 36s.
  const dong = await Promise.all(
    CAC_SHOP.map((s) => {
      const apiKey = theoKey.get(s.key) ?? "";
      if (!apiKey) {
        return Promise.resolve<DongKiemTra>({ nhan: s.nhan, ok: false, chiTiet: "Chưa lưu API key cho shop này." });
      }
      return kiemTraMotShop(s.nhan, shopIdTheoVai[s.vai], apiKey);
    })
  );
  return gopKetQua(dong);
}
