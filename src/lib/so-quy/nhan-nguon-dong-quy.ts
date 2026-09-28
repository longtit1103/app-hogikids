import type { NguonDongQuy } from "@/lib/so-quy/dong-chay-so-quy-types";

/**
 * Nhãn tiếng Việt cho 8 nguồn tiền của Sổ quỹ dòng chạy (`NguonDongQuy`) — module THUẦN dùng chung
 * giữa bảng trên màn (`so-quy-dong-chay-table.tsx`) và sheet Excel xuất ra (`xuat-excel-so-quy.ts`).
 * Tách riêng khỏi hợp đồng `dong-chay-so-quy-types.ts` vì đó là phần trình bày, không phải dữ liệu.
 */
export const NGUON_LABEL: Record<NguonDongQuy, string> = {
  GHI_TAY: "Ghi tay",
  TIKTOK_VE_BANK: "TikTok về bank",
  SHOPEE_RUT_VI: "Shopee rút ví",
  CHI_PHI: "Chi phí",
  CHI_PHI_ADS_GOP: "Ads (gộp ngày)",
  ADS_TIKTOK_TRU_VI: "Ads TikTok — sàn trừ ví",
  THU_NHAP: "Thu nhập tài chính",
  BAN_TRUC_TIEP: "Bán trực tiếp",
};
