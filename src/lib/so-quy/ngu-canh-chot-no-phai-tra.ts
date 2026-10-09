/**
 * Ngữ cảnh nợ phải trả cho thẻ / form CHỐT SỐ DƯ — THUẦN, không Prisma (form chốt là client component, import
 * được file này mà không kéo `prisma` vào bundle trình duyệt). Dùng lại ở `doi-chieu-so-du-chot.ts`.
 */

/**
 * Ngữ cảnh nợ phải trả của THÁNG đang chốt. `sauBatNoPhaiTra`: mốc bật ≤ cuối tháng — từ mốc đó ads trả thẻ
 * không còn trừ sổ ngay ngày chạy (nợ thẻ nằm ngoài quỹ), nên câu "trừ dư nợ thẻ khỏi số dư" SAI và phải
 * bỏ. `coHoSoViAds`: có ví quảng cáo trả trước — tiền nạp ví đã rời ngân hàng, quên ghi lần nạp thì sổ
 * NHIỀU hơn tiền thật đúng bằng số đó.
 */
export type NguCanhChot = { sauBatNoPhaiTra: boolean; coHoSoViAds: boolean };
export const NGU_CANH_CHOT_CU: NguCanhChot = { sauBatNoPhaiTra: false, coHoSoViAds: false };

/** Gợi ý cho chênh ÂM khi có ví quảng cáo trả trước — KHÔNG bảo cộng ví vào ô ngân hàng (ô đó luôn số thật). */
export const CAU_VI_ADS_TRA_TRUOC =
  "Có ví quảng cáo trả trước: kiểm lần nạp ví chưa ghi \"Nạp ví quảng cáo\" ở Sổ quỹ (tiền đã rời ngân hàng mà sổ chưa trừ) — KHÔNG cộng số dư ví vào ô ngân hàng.";

