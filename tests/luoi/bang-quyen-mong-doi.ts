import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

import type { HamBearer } from "./luat-route-ingest-va-file-khong-cong";

/**
 * BẢNG QUYỀN MONG ĐỢI — khai TƯỜNG MINH cổng đầu thân của MỌI Server Action, MỌI handler route có
 * cổng, MỌI page/layout dưới `src/app`. Lưới (`cong-bat-buoc.test.ts`) gập đối số THẬT của lời gọi cổng
 * từ mã nguồn rồi so với bảng: lệch ⇒ đỏ, export thiếu mục ⇒ đỏ, mục không còn export ⇒ đỏ.
 *
 * Lý do tồn tại: lưới "có cổng đầu thân" chỉ biết CÓ cổng — `congAction("don-hang:xem")` đứng trước
 * `prisma.loan.delete` vẫn qua. Bảng buộc mỗi action/trang mới khai quyền ở HAI chỗ (mã + bảng), để sai
 * module hay cổng không quyền là một thay đổi nhìn thấy được lúc review.
 *
 * Giá trị:
 * - `Quyen` / `Quyen[]` — `congAction`/`congRoute`/`yeuCauQuyenTrang` với quyền đó (mảng = ÍT NHẤT MỘT);
 * - `"CHU_SHOP"` — `congChuShopAction`/`congChuShopRoute`/`yeuCauChuShopTrang`;
 * - `"CHI_DANG_NHAP"` — cổng quyền KHÔNG truyền quyền (chỉ đòi phiên hợp lệ): chỉ hợp lệ khi bảng khai;
 * - `"KHONG_CONG"` — không cổng, PHẢI đồng thời nằm trong allowlist có lý do (`ALLOW_ACTION_KHONG_CONG` /
 *   `TRANG_KHONG_CONG` ở `cong-bat-buoc.test.ts`).
 *
 * Bảng ghi CỔNG ĐẦU THÂN. Kiểm quyền bổ sung bên trong thân (vd giá vốn ở export, quyền theo loại bản
 * ghi thùng rác, quyền Sổ quỹ khi dòng tiền gắn khoản vay) KHÔNG ghi ở đây — có test hành vi riêng.
 * Trang khoá `"<file>#default"` (tên component không mang nghĩa); route khoá `"<file>#<phương thức>"`.
 */
export type CongMongDoiCoKieu = Quyen | readonly Quyen[] | "CHU_SHOP" | "CHI_DANG_NHAP" | "KHONG_CONG";

const A = "src/lib/actions";

/** Ba quyền `sua` mở thùng rác — khớp `QUYEN_VAO_THUNG_RAC` (spec §1.4). */
const THUNG_RAC: readonly Quyen[] = ["chi-phi:sua", "tai-chinh-dong-tien:sua", "tai-chinh-so-quy:sua"];

export const BANG_QUYEN_MONG_DOI: Readonly<Record<string, CongMongDoiCoKieu>> = {
  // ── Phiên / tài khoản của chính mình ──
  [`${A}/auth.ts#login`]: "KHONG_CONG",
  [`${A}/auth.ts#logout`]: "KHONG_CONG",
  [`${A}/doi-mat-khau-lan-dau.ts#doiMatKhauLanDau`]: "KHONG_CONG",
  [`${A}/security.ts#changePassword`]: "CHI_DANG_NHAP",
  [`${A}/khoang-ngay.ts#luuLuaChonKhoangNgay`]: "CHI_DANG_NHAP",

  // ── Marketing ──
  [`${A}/ads-import.ts#previewAdsImport`]: "marketing:xem",
  [`${A}/ads-import.ts#importAdsExpenses`]: "marketing:sua",

  // ── Dòng tiền ──
  [`${A}/cash-movements.ts#createCashMovement`]: "tai-chinh-dong-tien:sua",
  [`${A}/cash-movements.ts#updateCashMovement`]: "tai-chinh-dong-tien:sua",
  [`${A}/cash-movements.ts#deleteCashMovement`]: "tai-chinh-dong-tien:sua",
  [`${A}/shopee-wallet-import.ts#previewShopeeWalletImport`]: "tai-chinh-dong-tien:xem",
  [`${A}/shopee-wallet-import.ts#importShopeeWallet`]: "tai-chinh-dong-tien:sua",
  [`${A}/so-du-chot-thang.ts#luuSoDuChotThang`]: "tai-chinh-dong-tien:sua",
  [`${A}/so-du-chot-thang.ts#xoaSoDuChotThang`]: "tai-chinh-dong-tien:sua",

  // ── Sổ quỹ: khoản vay, tiết kiệm, tất toán, quỹ tối thiểu ──
  [`${A}/khoan-vay.ts#taoKhoanVay`]: "tai-chinh-so-quy:sua",
  [`${A}/khoan-vay.ts#suaKhoanVay`]: "tai-chinh-so-quy:sua",
  [`${A}/khoan-vay.ts#xoaKhoanVay`]: "tai-chinh-so-quy:sua",
  [`${A}/khoan-vay.ts#tatToanKhoanVay`]: "tai-chinh-so-quy:sua",
  [`${A}/khoan-vay.ts#ghiKyTraNo`]: "tai-chinh-so-quy:sua",
  [`${A}/tat-toan-thau-chi.ts#tatToanThauChi`]: "tai-chinh-so-quy:sua",
  [`${A}/so-tiet-kiem.ts#taoSoTietKiem`]: "tai-chinh-so-quy:sua",
  [`${A}/so-tiet-kiem.ts#suaSoTietKiem`]: "tai-chinh-so-quy:sua",
  [`${A}/so-tiet-kiem.ts#xoaSoTietKiem`]: "tai-chinh-so-quy:sua",
  [`${A}/tat-toan-so-tiet-kiem.ts#tatToanSoTietKiem`]: "tai-chinh-so-quy:sua",
  [`${A}/tat-toan-so-tiet-kiem.ts#moLaiSoTietKiem`]: "tai-chinh-so-quy:sua",
  // Nợ phải trả — thẻ tín dụng (P4): hồ sơ theo quyền Sổ quỹ; chốt sao kê chỉ chủ shop (spec §5.7).
  [`${A}/the-tin-dung.ts#taoThe`]: "tai-chinh-so-quy:sua",
  [`${A}/the-tin-dung.ts#suaThe`]: "tai-chinh-so-quy:sua",
  [`${A}/the-tin-dung.ts#dongThe`]: "tai-chinh-so-quy:sua",
  [`${A}/the-tin-dung.ts#xoaThe`]: "tai-chinh-so-quy:sua",
  [`${A}/the-tin-dung.ts#ganNenTang`]: "tai-chinh-so-quy:sua",
  [`${A}/the-tin-dung.ts#xoaGanNenTang`]: "tai-chinh-so-quy:sua",
  [`${A}/chot-sao-ke.ts#chotSaoKe`]: "CHU_SHOP",
  [`${A}/uoc-tinh-sao-ke.ts#docUocTinhSaoKe`]: "CHU_SHOP",
  [`${A}/vi-ads.ts#taoViAds`]: "CHU_SHOP",
  [`${A}/vi-ads.ts#suaViAds`]: "CHU_SHOP",
  [`${A}/vi-ads.ts#xoaViAds`]: "CHU_SHOP",
  [`${A}/bat-no-phai-tra.ts#xacNhanBatNoPhaiTra`]: "CHU_SHOP",
  [`${A}/bat-no-phai-tra.ts#docChenhLechTaiM`]: "CHU_SHOP",
  [`${A}/so-quy-quy-toi-thieu.ts#datQuyToiThieu`]: "tai-chinh-so-quy:sua",

  // ── Chi phí ──
  [`${A}/expenses.ts#createExpense`]: "chi-phi:sua",
  [`${A}/expenses.ts#updateExpense`]: "chi-phi:sua",
  [`${A}/expenses.ts#deleteExpense`]: "chi-phi:sua",
  [`${A}/expenses.ts#batLaiDinhKy`]: "chi-phi:sua",
  [`${A}/expenses.ts#stopRecurring`]: "chi-phi:sua",
  [`${A}/chi-phi-nhap-hang.ts#ghiChiPhiNhapHang`]: "chi-phi:sua",

  // ── Thùng rác: cổng vào = ít nhất một quyền sửa; quyền theo loại bản ghi kiểm trong transaction ──
  [`${A}/thung-rac.ts#khoiPhucBanGhi`]: THUNG_RAC,
  [`${A}/thung-rac.ts#xoaVinhVienBanGhi`]: THUNG_RAC,

  // ── Sản phẩm: giá vốn + ngưỡng từng biến thể ──
  [`${A}/cost-price.ts#updateVariantCost`]: "san-pham:sua",
  [`${A}/cost-price.ts#updateVariantThreshold`]: "san-pham:sua",
  [`${A}/cost-price.ts#updateProductCost`]: "san-pham:sua",
  [`${A}/cost-price.ts#updateProductThreshold`]: "san-pham:sua",
  [`${A}/cost-price.ts#previewCostImport`]: "san-pham:sua",
  [`${A}/cost-price.ts#importCostPrices`]: "san-pham:sua",
  [`${A}/dong-bo-gia-von-pancake.ts#apGiaVonTheoPancake`]: "san-pham:sua",

  // ── Cài đặt ──
  [`${A}/settings-channels.ts#updateChannels`]: "cai-dat:sua",
  [`${A}/settings-channels.ts#countRecomputableOrders`]: "cai-dat:xem",
  [`${A}/settings-channels.ts#recomputeFeesInRange`]: "cai-dat:sua",
  [`${A}/settings-expense-categories.ts#createExpenseCategory`]: "cai-dat:sua",
  [`${A}/settings-expense-categories.ts#renameExpenseCategory`]: "cai-dat:sua",
  [`${A}/settings-expense-categories.ts#toggleExpenseCategoryHidden`]: "cai-dat:sua",
  [`${A}/settings-expense-categories.ts#deleteExpenseCategory`]: "cai-dat:sua",
  [`${A}/settings-low-stock.ts#updateDefaultLowStockThreshold`]: "cai-dat:sua",
  [`${A}/settings-shop-info.ts#updateShopInfo`]: "cai-dat:sua",
  [`${A}/sync.ts#getLatestSync`]: "cai-dat:xem",
  [`${A}/sync.ts#getTienDoDongBoNgay`]: "cai-dat:xem",
  [`${A}/sync.ts#triggerSyncNow`]: "cai-dat:sua",

  // ── Owner-only: dữ liệu, khoá kết nối, n8n, tài khoản ──
  [`${A}/data-admin.ts#deleteAllData`]: "CHU_SHOP",
  [`${A}/data-admin.ts#coDuLieuGiaoDich`]: "CHU_SHOP",
  [`${A}/data-admin.ts#demChiPhiKhongDungLai`]: "CHU_SHOP",
  [`${A}/data-admin.ts#demDonMoCoi`]: "CHU_SHOP",
  [`${A}/data-admin.ts#demAdsMoCoi`]: "CHU_SHOP",
  [`${A}/data-admin.ts#dungLaiTuKhoTho`]: "CHU_SHOP",
  [`${A}/n8n-ket-noi.ts#luuKetNoiN8n`]: "CHU_SHOP",
  [`${A}/n8n-ket-noi.ts#kiemTraKetNoiN8n`]: "CHU_SHOP",
  [`${A}/n8n-ket-noi.ts#caiWorkflowsN8n`]: "CHU_SHOP",
  [`${A}/settings-khoa-ket-noi.ts#luuKhoaKetNoi`]: "CHU_SHOP",
  [`${A}/settings-khoa-ket-noi.ts#kiemTraKetNoiNguon`]: "CHU_SHOP",
  [`${A}/settings-khoa-ket-noi.ts#doiVaLuuTokenMeta`]: "CHU_SHOP",
  [`${A}/tai-khoan.ts#taoTaiKhoan`]: "CHU_SHOP",
  [`${A}/tai-khoan.ts#suaQuyenTaiKhoan`]: "CHU_SHOP",
  [`${A}/tai-khoan.ts#khoaTaiKhoan`]: "CHU_SHOP",
  [`${A}/tai-khoan.ts#moKhoaTaiKhoan`]: "CHU_SHOP",
  [`${A}/tai-khoan.ts#xoaTaiKhoan`]: "CHU_SHOP",
  [`${A}/tai-khoan.ts#datLaiMatKhau`]: "CHU_SHOP",

  // Nợ phải trả — phiếu nhập (P3): hồ sơ + trả gộp thuộc Sổ quỹ; huỷ / "đã giải thích" chỉ chủ shop.
  [`${A}/phieu-nhap-no.ts#ghiNhanPhieuVaoSoNo`]: "tai-chinh-so-quy:sua",
  [`${A}/phieu-nhap-no.ts#capNhatTongPhieu`]: "tai-chinh-so-quy:sua",
  [`${A}/phieu-nhap-no.ts#capNhatDaTraTruoc`]: "tai-chinh-so-quy:sua",
  [`${A}/phieu-nhap-no.ts#danhDauHuyPhieu`]: "CHU_SHOP",
  [`${A}/phieu-nhap-no.ts#boQuaLechDaGiaiThich`]: "CHU_SHOP",
  [`${A}/phieu-nhap-no.ts#xoaPhieu`]: "tai-chinh-so-quy:sua",
  [`${A}/tra-tien-hang.ts#traTienHangGop`]: "tai-chinh-so-quy:sua",
  // Điều chỉnh mở sổ nợ (CUTOVER_*): chỉ chủ shop sửa số/mô tả.
  [`${A}/cash-movements.ts#suaDieuChinhChuyenDoi`]: "CHU_SHOP",

  // ── Route có cổng (spec §3.5, §4.3 — quyền ghép còn lại kiểm trong thân) ──
  "src/app/api/backup/route.ts#POST": "CHU_SHOP",
  "src/app/api/restore/route.ts#POST": "CHU_SHOP",
  "src/app/api/export/bao-cao/route.ts#GET": ["bao-cao:xem", "tai-chinh-loi-lo:xem"],
  "src/app/api/export/gia-von/route.ts#GET": "san-pham:xem",
  "src/app/api/export/so-quy/route.ts#GET": "tai-chinh-so-quy:xem",
  "src/app/api/export/ton-kho/route.ts#GET": "ton-kho:xem",

  // ── Trang / layout ──
  "src/app/layout.tsx#default": "KHONG_CONG",
  "src/app/(auth)/dang-nhap/page.tsx#default": "KHONG_CONG",
  "src/app/(auth)/doi-mat-khau-lan-dau/page.tsx#default": "KHONG_CONG",
  "src/app/(app)/chi-phi/page.tsx#default": "KHONG_CONG",
  "src/app/(app)/layout.tsx#default": "CHI_DANG_NHAP",
  "src/app/(app)/khong-co-quyen/page.tsx#default": "CHI_DANG_NHAP",
  "src/app/(app)/page.tsx#default": "tong-quan:xem",
  "src/app/(app)/bao-cao/page.tsx#default": "bao-cao:xem",
  "src/app/(app)/cai-dat/page.tsx#default": "cai-dat:xem",
  "src/app/(app)/don-hang/page.tsx#default": "don-hang:xem",
  "src/app/(app)/kenh/page.tsx#default": "kenh:xem",
  "src/app/(app)/kenh/[id]/page.tsx#default": "kenh:xem",
  "src/app/(app)/marketing/page.tsx#default": "marketing:xem",
  "src/app/(app)/san-pham/page.tsx#default": "san-pham:xem",
  "src/app/(app)/san-pham/dong-bo-gia-von/page.tsx#default": "san-pham:sua",
  "src/app/(app)/ton-kho/page.tsx#default": "ton-kho:xem",
  "src/app/(app)/tai-chinh/page.tsx#default": [
    "tai-chinh-loi-lo:xem",
    "tai-chinh-dong-tien:xem",
    "tai-chinh-so-quy:xem",
    "chi-phi:xem",
  ],
  "src/app/(app)/tai-chinh/chi-phi-nhap-hang/page.tsx#default": "chi-phi:xem",
  "src/app/(app)/tai-chinh/no-phai-tra/page.tsx#default": "CHU_SHOP",
  "src/app/(app)/tai-chinh/thung-rac/page.tsx#default": THUNG_RAC,
  "src/app/(app)/quan-tri/page.tsx#default": "CHU_SHOP",
  "src/app/(app)/quan-tri/nhat-ky/page.tsx#default": "CHU_SHOP",
};

/**
 * Route dưới `src/app/api/ingest/` (spec §3.5): không ngữ cảnh người ⇒ không qua ba cổng, mà câu đầu
 * TỪNG handler phải là hàm kiểm bearer đúng loại. `TOKEN_VAULT_SECRET` tách khỏi `INGEST_SECRET` từ
 * 21/09/2026 cho hai kho token (đọc/ghi secret nguồn ngoài).
 */
export const BEARER_ROUTE_INGEST: Readonly<Record<string, HamBearer>> = {
  "src/app/api/ingest/ads/route.ts#POST": "requireIngestSecret",
  "src/app/api/ingest/backup-log/route.ts#POST": "requireIngestSecret",
  "src/app/api/ingest/dem-gia-von/route.ts#POST": "requireIngestSecret",
  "src/app/api/ingest/raw/route.ts#POST": "requireIngestSecret",
  "src/app/api/ingest/reconcile-orders/route.ts#POST": "requireIngestSecret",
  "src/app/api/ingest/resync-products/route.ts#POST": "requireIngestSecret",
  "src/app/api/ingest/webhook/[shop]/route.ts#POST": "requireIngestSecret",
  "src/app/api/ingest/meta-token/route.ts#POST": "requireTokenVaultSecret",
  "src/app/api/ingest/meta-token/route.ts#GET": "requireTokenVaultSecret",
  "src/app/api/ingest/tiktok-token/route.ts#POST": "requireTokenVaultSecret",
  "src/app/api/ingest/tiktok-token/route.ts#GET": "requireTokenVaultSecret",
};

/**
 * Route CÔNG KHAI (spec §3.5) — liệt kê theo FILE, không theo tiền tố thư mục. Mỗi route chỉ được
 * import đúng các module khai ở đây (không chạm lớp dữ liệu).
 */
export const ROUTE_CONG_KHAI: Readonly<Record<string, { lyDo: string; nguonDuocPhep: readonly string[] }>> = {
  "src/app/api/uploads/[name]/route.ts": {
    lyDo: "Logo shop cố tình public-readable (next/image tải không kèm phiên); tên file PHẢI qua allowlist regex chống path traversal.",
    nguonDuocPhep: ["node:fs/promises", "node:path", "@/lib/branding/logo-file"],
  },
  "src/app/manifest.webmanifest/route.ts": {
    lyDo: "Manifest PWA tĩnh — trình duyệt tải không kèm phiên app.",
    nguonDuocPhep: [],
  },
  "src/app/pwa-icon/[size]/route.ts": {
    lyDo: "Icon PWA (logo + tên shop từ ShopProfile — không nhạy cảm) — trình duyệt/iOS tải khi cài app, không kèm phiên.",
    nguonDuocPhep: ["@/lib/branding/app-icon"],
  },
};
