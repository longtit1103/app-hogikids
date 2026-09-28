/**
 * BIÊN NGÀY DUY NHẤT của một dòng chi tiêu quảng cáo: `[2000-01-01, hôm nay giờ VN]`.
 *
 * Dùng CHUNG cho mọi đường ghi chi tiêu ads vào sổ: cửa FILE (`import/ads-csv.ts`) và cửa MÁY
 * (`prepareAdsExpenseRow` — `/api/ingest/ads` n8n đẩy mỗi đêm + lượt dựng lại từ kho thô). Hai cửa
 * từng đi hai luật khác nhau: file đã kẹp biên, còn máy chỉ kiểm khuôn `YYYY-MM-DD` ⇒ một lượt n8n
 * tính ngày hỏng (`1970-01-01`, `2126-…`) ghi thẳng `Expense` ở một năm mà KHÔNG range báo cáo nào
 * phủ: tiền vào sổ mà không ai thấy.
 *
 * Biên trên = HÔM NAY giờ VN (khớp đường nhập tay `ngay-ghi-tay-schema.ts`). An toàn với cửa máy vì
 * tài khoản quảng cáo Meta + TikTok đều neo `Asia/Ho_Chi_Minh` và workflow n8n chốt `until` ở hôm qua.
 */
export const NGAY_CHI_TIEU_ADS_SOM_NHAT = "2000-01-01";

/**
 * Khoá ngày "hôm nay" theo giờ VN.
 *
 * VN = UTC+7 CỐ ĐỊNH (không có DST) nên cộng 7 giờ rồi lấy phần ngày của ISO là đúng biên ngày VN —
 * bất biến #3, không lệ thuộc TZ của máy chạy test/CI.
 */
export function khoaNgayVnHomNay(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Khoá `YYYY-MM-DD` có nằm trong biên hợp lý của chi tiêu ads không.
 *
 * ⚠️ PHẢI kiểm KHUÔN trước khi so chuỗi: so chuỗi chỉ tương đương so thứ tự ngày khi năm đúng 4 chữ
 * số. Năm 5-6 chữ số cho kết quả NGƯỢC — `"20107-01-29"` đứng giữa `"2000-01-01"` và `"2026-09-18"`
 * vì ký tự thứ ba `'1'` nằm giữa `'0'` và `'2'` ⇒ lọt cổng (ca đo thật ở `ads-csv.ts`).
 *
 * Và phải kiểm ngày CÓ THẬT trên lịch: khuôn cho lọt `2026-02-30` / `2025-13-45`. JS tự quy đổi
 * `2026-02-30` thành 02/03 nhưng `dateKey` vẫn mang "02-30" ⇒ cổng "ngày đã ghi đè bằng file" so
 * theo `dateKey` bỏ lỡ ⇒ chi phí ngày đó đếm 2 lần; còn `2025-13-45` thành Invalid Date và Prisma nổ
 * giữa transaction, kéo đổ cả lô.
 */
export function laNgayChiTieuAdsHopLy(khoa: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(khoa)) return false;
  const [y, m, d] = khoa.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) return false;
  return khoa >= NGAY_CHI_TIEU_ADS_SOM_NHAT && khoa <= khoaNgayVnHomNay();
}
