/**
 * Danh mục "Khóa kết nối nguồn dữ liệu" — nguồn sự thật DUY NHẤT cho cả server action
 * (validate key nào được ghi) lẫn UI trang Cài đặt (vẽ ô nhập nào).
 *
 * Key ở đây là key trong bảng `Setting` mà các workflow n8n đọc trực tiếp (xem
 * `n8n/huong-dan-cai-dat-workflows.md`, bảng "Nhóm key") — n8n tự thấy giá trị mới
 * ở lượt chạy kế tiếp, KHÔNG phải nạp lại workflow.
 *
 * CỐ Ý KHÔNG có `n8nAppUrl`/`n8nIngestSecret`: đó là khóa hạ tầng, gõ sai 1 ký tự là
 * toàn bộ đồng bộ đứng im — để dev quản qua DB. Token OAuth (`metaAdsAccessToken`,
 * `tiktokShop*Token*`) cũng KHÔNG nằm đây: chúng đi qua kho token riêng
 * (`/api/ingest/*-token` + luồng "Đổi & lưu token Meta"), không sửa tay từng ô.
 */

export type NguonKetNoiId = "pancake" | "meta" | "tiktok-shop" | "tiktok-business";

export type TruongKhoa = {
  /** Key trong bảng `Setting`. */
  key: string;
  /** Nhãn hiển thị cho người không rành kỹ thuật. */
  nhan: string;
  /** true = chỉ-ghi: đọc ra chỉ trả đuôi 4 ký tự, không bao giờ trả giá trị đầy đủ. */
  biMat: boolean;
  /** Một dòng giải thích ngắn dưới ô nhập. */
  goiY?: string;
};

export type NguonKetNoi = {
  id: NguonKetNoiId;
  ten: string;
  moTa: string;
  truong: TruongKhoa[];
};

export const DS_NGUON_KET_NOI: NguonKetNoi[] = [
  {
    id: "pancake",
    ten: "Pancake POS",
    moTa:
      "Nguồn đơn hàng, sản phẩm, tồn kho — mỗi shop một cặp Shop ID + API key (Cài đặt shop → Ứng dụng trong Pancake). " +
      "Shop ID điền MỘT LẦN lúc setup; app lẫn workflow n8n đều đọc từ đây.",
    truong: [
      { key: "pancakeShopIdKho", nhan: "Shop ID — Kho Tổng", biMat: false, goiY: "Id shop Pancake giữ tồn kho + giá vốn. Đổi sau khi đã có dữ liệu sẽ bị chặn." },
      { key: "pancakeApiKeyKho", nhan: "API key — shop Kho Tổng", biMat: true, goiY: "API key của shop Kho Tổng." },
      { key: "pancakeShopIdShopee", nhan: "Shop ID — Shopee", biMat: false, goiY: "Id shop Pancake nhận đơn Shopee." },
      { key: "pancakeApiKeyShopee", nhan: "API key — shop Shopee", biMat: true, goiY: "API key của shop Shopee." },
      { key: "pancakeShopIdTiktok", nhan: "Shop ID — TikTok", biMat: false, goiY: "Id shop Pancake nhận đơn TikTok." },
      { key: "pancakeApiKeyTiktok", nhan: "API key — shop TikTok", biMat: true, goiY: "API key của shop TikTok." },
      { key: "pancakeWarehouseIdKhoTong", nhan: "Warehouse ID — Kho Tổng", biMat: false, goiY: "Id kho hàng (uuid) của shop Kho Tổng — cần cho tồn kho realtime qua webhook; thiếu thì lượt API đêm vẫn vá tồn." },
    ],
  },
  {
    id: "meta",
    ten: "Meta Ads (Facebook)",
    moTa: "Chi tiêu quảng cáo Facebook. App ID + App Secret + Ad Account điền MỘT LẦN; token thay ~60 ngày/lần ở khối bên dưới.",
    truong: [
      { key: "metaAdsAppId", nhan: "App ID", biMat: false, goiY: "Số App ID của ứng dụng Facebook (developers.facebook.com)." },
      { key: "metaAdsAppSecret", nhan: "App Secret", biMat: true, goiY: "Trong trang ứng dụng Facebook → Cài đặt → Thông tin cơ bản." },
      { key: "metaAdsAccountId", nhan: "Ad Account ID", biMat: false, goiY: "Dạng act_<số> — tài khoản quảng cáo mà workflow n8n kéo chi tiêu." },
    ],
  },
  {
    id: "tiktok-shop",
    ten: "TikTok Shop",
    moTa: "Phí sàn + tiền về TikTok. Bốn giá trị này hầu như không đổi; token thì máy tự gia hạn (đến 2123).",
    truong: [
      { key: "tiktokShopAppKey", nhan: "App Key", biMat: false },
      { key: "tiktokShopAppSecret", nhan: "App Secret", biMat: true },
      { key: "tiktokShopCipher", nhan: "Shop Cipher", biMat: true, goiY: "Mã ủy quyền shop — lấy khi cấp quyền app trên TikTok Shop Partner." },
      { key: "tiktokShopShopId", nhan: "Shop ID", biMat: false, goiY: "Id shop trên TikTok Shop (KHÁC id shop TikTok trong Pancake)." },
    ],
  },
  {
    id: "tiktok-business",
    ten: "TikTok Ads (Business)",
    moTa: "Chi tiêu quảng cáo TikTok. Token dài hạn của TikTok Business API.",
    truong: [
      { key: "tiktokBusinessAppId", nhan: "App ID", biMat: false, goiY: "Id ứng dụng trên TikTok for Business (đi cặp với App Secret bên dưới)." },
      { key: "tiktokBusinessAppSecret", nhan: "App Secret", biMat: true },
      { key: "tiktokBusinessToken", nhan: "Access Token", biMat: true },
    ],
  },
];

/** Tra nguồn theo id — trả `undefined` cho id lạ (action dùng để chặn input bịa). */
export function timNguonKetNoi(id: string): NguonKetNoi | undefined {
  return DS_NGUON_KET_NOI.find((n) => n.id === id);
}

/** Mọi key bí mật trong danh mục — test dùng để khóa "không lộ secret ra UI". */
export const KEY_BI_MAT_KET_NOI = DS_NGUON_KET_NOI.flatMap((n) =>
  n.truong.filter((t) => t.biMat).map((t) => t.key),
);
