import { differenceInCalendarDays, startOfDay } from "date-fns";

/**
 * Công thức lãi SỔ TIẾT KIỆM có kỳ hạn, lãi cuối kỳ (spec §6.1–§6.4). THUẦN: không Prisma, không
 * React — để P&L và Sổ quỹ không bao giờ phải import Prisma qua ngả này.
 *
 * Quy ước 365 ngày/năm, LÀM TRÒN ĐÚNG MỘT LẦN (nửa lên) — cùng luật lãi vay (`lich-tra-no.ts`).
 * Số ra là ĐỀ XUẤT điền sẵn, chủ shop sửa được trước khi duyệt (quyết định #6): ngân hàng có thể
 * tính 360 ngày hoặc làm tròn khác.
 */

/** Mẫu số lãi ngày = 10.000 bp × 365 ngày; và hai lần mẫu, cho phép làm tròn nửa lên trên số nguyên. */
const MAU_LAI_NGAY = BigInt(3_650_000);
const HAI_LAN_MAU = BigInt(7_300_000);
const HAI = BigInt(2);

/**
 * Số ngày LỊCH giữa hai mốc, giờ VN. `startOfDay` TRƯỚC khi đếm: mốc mang giờ 07:00 mà không cắt là
 * lệch nguyên một ngày lãi.
 *
 * Có thể trả số ÂM — cố ý. Chỗ nào cần kẹp thì tự kẹp (xem `laiDonToiNay`); giấu dấu âm ở đây là
 * biến một ngày đáo hạn khai lùi thành "lãi 0" im lặng thay vì lộ ra.
 */
export function soNgayGiua(tu: Date, den: Date): number {
  return differenceInCalendarDays(startOfDay(den), startOfDay(tu));
}

/**
 * Lãi khi giữ trọn `soNgay` ngày = round(principal × annualRateBp × soNgay / (10.000 × 365)).
 *
 * `BigInt` cho tích trung gian là BẮT BUỘC, không phải trang trí: biên trần thật của app là
 * `principal` 2 tỷ × `annualRateBp` 10.000 (100%/năm) × `soNgay` 18.250 (kỳ hạn trần 600 tháng)
 * ≈ 3,65e17 — vượt `Number.MAX_SAFE_INTEGER` (9,0e15) 41 lần, tức tích tính bằng `number` là một số
 * ĐÃ LÀM TRÒN mà JS không báo gì. Lưới ở `tests/unit/tiet-kiem/cong-thuc-lai-tiet-kiem.test.ts` ghim
 * đúng một bộ số cho ra kết quả LỆCH 1 đồng giữa hai đường tính.
 *
 * Làm tròn nửa lên trên số nguyên: floor((2·tích + mẫu) / (2·mẫu)) — giống `laiTheoNgay`.
 * Viết `BigInt(...)` chứ không phải hằng `…n` vì `tsconfig.target` của dự án là ES2017.
 *
 * Ba tham số PHẢI là số nguyên (đều từ cột `Int` hoặc `differenceInCalendarDays`); truyền số lẻ vào
 * thì `BigInt()` ném `RangeError` — CỐ Ý ồn ào, thà đỏ còn hơn âm thầm ra số tiền sai.
 */
export function laiDuKien(principal: number, annualRateBp: number, soNgay: number): number {
  if (principal <= 0 || annualRateBp <= 0 || soNgay <= 0) return 0;
  const tich = BigInt(principal) * BigInt(annualRateBp) * BigInt(soNgay);
  return Number((tich * HAI + MAU_LAI_NGAY) / HAI_LAN_MAU);
}

/**
 * Lãi DỒN tới hôm nay — số THÔNG TIN cho bảng và thẻ đáo hạn (spec §6.4).
 *
 * TUYỆT ĐỐI không ghi vào `ThuNhap`, không vào P&L, không vào Sổ quỹ: tiền chưa về. Lãi chỉ vào sổ
 * TRỌN MỘT LẦN ở tháng tất toán (quyết định #9) — số này chỉ để chủ shop biết đang ăn bao nhiêu.
 *
 * Kẹp HAI đầu `[0, soNgay]`: chưa tới ngày gửi ⇒ 0 (không lãi âm); quá đáo hạn ⇒ dừng đúng
 * `laiDuKien` (ngân hàng không trả tiếp lãi kỳ hạn sau ngày đáo hạn theo lãi suất cũ).
 */
export function laiDonToiNay(p: {
  principal: number;
  annualRateBp: number;
  startDate: Date;
  maturityDate: Date;
  homNay: Date;
}): number {
  const soNgay = Math.max(0, soNgayGiua(p.startDate, p.maturityDate));
  const daGui = Math.min(Math.max(0, soNgayGiua(p.startDate, p.homNay)), soNgay);
  return laiDuKien(p.principal, p.annualRateBp, daGui);
}

/** `null` = KHÔNG hiện dòng chênh lệch (chưa gắn khoản vay, hoặc không đủ dữ liệu để so). */
export type ChenhLechLai = { chenhBp: number; chenhMoiNam: number; quyDoi: boolean } | null;

/** Khoản vay nguồn, rút gọn đúng bốn số cần để so lãi suất. `duNoGoc` = dư nợ gốc hiện tại. */
export type VayNguon = {
  kind: "TERM" | "OVERDRAFT" | "BULLET";
  annualRateBp: number;
  laiCoDinhMoiKy: number | null;
  duNoGoc: number;
};

/**
 * Chênh lệch "vay để gửi" — ƯỚC TÍNH THUẦN theo lãi suất năm (spec §6.3), KHÔNG quyết toán theo kỳ
 * trả nợ thật. Mọi chỗ hiển thị phải kèm chữ "ước tính".
 *
 * Ca khoản vay khai `laiCoDinhMoiKy` (đúng khoản chủ shop đang có: 1.121.096 đ/kỳ, KHÔNG khai
 * %/năm ⇒ `annualRateBp` = 0): quy đổi ngược ra %/năm hiệu dụng, thay vì ẩn dòng làm tính năng
 * chết. CHỈ quy đổi khi `kind = BULLET` — gốc giữ nguyên trọn kỳ nên phép chia đúng; vay trả gốc
 * đều thì dư nợ giảm dần, quy đổi kiểu này thổi phồng lãi suất.
 *
 * Không đủ dữ liệu (BULLET khai lãi cố định mà dư nợ ≤ 0) ⇒ `null`, KHÔNG hiện số sai.
 *
 * Tích `laiCoDinhMoiKy × 12 × 10.000` ≤ 2,4e14 và `principal × chenhBp` ≤ 2e13 — đều nằm gọn trong
 * 2^53 nên CỐ Ý không dùng `BigInt` ở đây (khác `laiDuKien`, chỗ đó tích chạm 3,6e17).
 */
export function chenhLechLaiSuat(
  so: { principal: number; annualRateBp: number },
  vay: VayNguon | null
): ChenhLechLai {
  if (vay === null) return null;

  const laiKhai = vay.kind === "BULLET" ? vay.laiCoDinhMoiKy : null;
  let bpVay: number;
  let quyDoi = false;
  if (laiKhai !== null) {
    if (vay.duNoGoc <= 0) return null;
    bpVay = Math.round((laiKhai * 12 * 10_000) / vay.duNoGoc);
    quyDoi = true;
  } else {
    bpVay = vay.annualRateBp;
  }

  const chenhBp = so.annualRateBp - bpVay;
  // `|| 0` dập `-0`: `Math.round(-0.4)` ra `-0`, mà `expect(x).toBe(0)` (Object.is) coi đó là khác 0.
  const chenhMoiNam = Math.round((so.principal * chenhBp) / 10_000) || 0;
  return { chenhBp, chenhMoiNam, quyDoi };
}
