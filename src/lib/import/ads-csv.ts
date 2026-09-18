import { normHeader, parseVnInt, readSheetRows } from "./xlsx-shared";

/**
 * Parser cho file CHI TIÊU ads xuất từ Meta Ads Manager / TikTok Ads.
 * Nhận .csv (UTF-8/UTF-16, có/không BOM) và .xlsx. KHÔNG dedupe, KHÔNG chạm DB
 * — chỉ chuẩn hoá từng dòng; dedupe + xung đột API nằm ở `ads-import.ts`.
 *
 * Ngày trả về được NEO `T00:00:00+07:00` (Asia/Ho_Chi_Minh) để 1 dòng file =
 * đúng 1 ngày VN, so khớp được với dòng ADS_API do ingest ghi (cùng cách neo).
 */

export type AdsPreset = "META" | "TIKTOK"; // adsSource tương ứng: "META" | "TIKTOK_ADS"
export type ParsedAdsRow = { date: Date; campaignName: string; amount: number };

/** Alias cột theo nguồn — file Ads Manager đổi tên cột theo thời gian nên để dạng danh sách. */
const COLUMN_ALIASES: Record<AdsPreset, { date: string[]; name: string[]; amount: string[] }> = {
  META: {
    date: ["Ngày", "Day", "Reporting starts"],
    name: ["Tên chiến dịch", "Campaign name"],
    amount: ["Số tiền đã chi tiêu (VND)", "Amount spent (VND)"],
  },
  TIKTOK: {
    date: ["Date"],
    name: ["Campaign name"],
    amount: ["Cost"],
  },
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Ngày (y, m, d) có THẬT trên lịch không.
 *
 * Bắt buộc phải kiểm TAY: `new Date("2026-02-31T00:00:00+07:00")` KHÔNG trả Invalid Date mà tự
 * quy đổi thành 03/03/2026 (đo bằng node 29/07). Nghĩa là một ô ngày gõ sai trong file sẽ lặng lẽ
 * ghi chi tiêu quảng cáo sang một ngày KHÁC — sai kỳ, sai cả tháng, mà không có một dòng lỗi nào.
 * Thà báo dòng lỗi cho chủ shop sửa file còn hơn tự đoán hộ.
 */
function laNgayCoThat(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  // Ngày 0 của tháng kế tiếp = ngày cuối cùng của tháng này (JS tự tính năm nhuận).
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Tìm chỉ số cột đầu tiên khớp một trong các alias (đã chuẩn hoá). -1 nếu không có. */
function findColumn(header: (string | number | Date)[], aliases: string[]): number {
  const normalized = header.map((h) => normHeader(String(h)));
  const wanted = aliases.map(normHeader);
  for (let i = 0; i < normalized.length; i++) {
    if (wanted.includes(normalized[i])) return i;
  }
  return -1;
}

/** Ngày sớm nhất một ô trong file ads được phép mang. Trước mốc này là lỗi đọc ô, không phải dữ liệu thật. */
const NGAY_SOM_NHAT = "2000-01-01";

/**
 * Khoá ngày "hôm nay" theo giờ VN.
 *
 * VN = UTC+7 CỐ ĐỊNH (không có DST) nên cộng 7 giờ rồi lấy phần ngày của ISO là đúng biên ngày VN —
 * bất biến #3, không lệ thuộc TZ của máy chạy test/CI.
 */
function khoaNgayVnHomNay(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Đọc ô ngày thô → "yyyy-MM-dd" (VN) hoặc null. Nhận Date (xlsx), serial số, hoặc chuỗi. */
function docKhoaNgay(value: unknown): string | null {
  if (value == null || value === "") return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }

  if (typeof value === "number") {
    // Serial Excel (epoch 1899-12-30) → ngày UTC (tránh lệ thuộc TZ máy chạy).
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  const s = String(value).trim();
  // ISO yyyy-mm-dd (Meta/TikTok xuất mặc định) — có thể kèm phần giờ, chỉ lấy ngày.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return laNgayCoThat(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  // dd/mm/yyyy (định dạng VN).
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return laNgayCoThat(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }
  return null;
}

/**
 * Chuẩn hoá ô ngày → "yyyy-MM-dd" (VN) trong khoảng [2000-01-01, hôm nay giờ VN], ngoài khoảng → null.
 *
 * Vì sao phải kẹp CẢ HAI biên: `docKhoaNgay` chỉ hỏi "ngày có thật trên lịch", không hỏi năm có hợp lý.
 * Một ô ngày lẫn số nhỏ (serial Excel 1 → 31/12/1899, serial 45 → 1900) hay năm gõ sai (serial 300000 →
 * năm 2721) vẫn ra ngày "có thật" ⇒ `createMany` ghi thẳng `Expense` source IMPORT ở một năm mà KHÔNG
 * range báo cáo nào phủ: tiền vào sổ mà không ai thấy, cũng không có dòng lỗi nào để chủ shop sửa file.
 * Biên trên khớp đường nhập tay (`ngay-ghi-tay-schema.ts` cũng chặn tương lai).
 *
 * ⚠️ PHẢI kiểm KHUÔN khoá trước khi so chuỗi. So chuỗi chỉ tương đương so thứ tự ngày khi năm đúng
 * 4 chữ số, mà `docKhoaNgay` KHÔNG pad phần năm (`pad2` chỉ áp cho tháng/ngày) — serial Excel lớn cho
 * ra năm 5-6 chữ số và khi đó so chuỗi cho kết quả NGƯỢC: `"20107-01-29"` (serial 6.650.000) đứng
 * giữa `"2000-01-01"` và `"2026-09-18"` vì ký tự thứ ba `'1'` nằm giữa `'0'` và `'2'` ⇒ lọt cổng, rồi
 * `new Date("20107-01-29T00:00:00+07:00")` thành Invalid Date và `vnDateKey` ném `RangeError` ra khỏi
 * server action ⇒ CẢ FILE bị từ chối kèm câu "không đọc được file" thay vì chỉ ra đúng dòng sai.
 * Đo thật: dải lọt là 6.610.891–6.705.853 và 72.354.541–73.304.171 — đúng tầm số tiền VND đời thường
 * (6,6 triệu · 72 triệu), tức ca "số tiền lạc sang cột ngày" mà cổng này sinh ra để bắt.
 */
function parseDateCell(value: unknown): string | null {
  const khoa = docKhoaNgay(value);
  if (khoa === null || !/^\d{4}-\d{2}-\d{2}$/.test(khoa)) return null;
  return khoa >= NGAY_SOM_NHAT && khoa <= khoaNgayVnHomNay() ? khoa : null;
}

/**
 * Parse file ads → dòng chuẩn hoá + danh sách lỗi (KHÔNG dedupe).
 * `line` = số dòng trong file (header = 1, dòng dữ liệu đầu = 2).
 * Dòng thiếu ngày/số tiền hoặc không parse được → đẩy vào `errors`, không chặn file.
 */
export function parseAdsFile(
  buf: ArrayBuffer,
  preset: AdsPreset
): { rows: ParsedAdsRow[]; errors: { line: number; reason: string }[] } {
  const rows: ParsedAdsRow[] = [];
  const errors: { line: number; reason: string }[] = [];

  const aoa = readSheetRows(buf);
  if (aoa.length === 0) {
    return { rows, errors: [{ line: 1, reason: "File rỗng hoặc không đọc được" }] };
  }

  const header = aoa[0];
  const aliases = COLUMN_ALIASES[preset];
  const dateCol = findColumn(header, aliases.date);
  const amountCol = findColumn(header, aliases.amount);
  const nameCol = findColumn(header, aliases.name);

  if (dateCol === -1 || amountCol === -1) {
    return {
      rows,
      errors: [{ line: 1, reason: "Không nhận ra cột ngày hoặc cột số tiền — cần file xuất từ Ads Manager" }],
    };
  }

  for (let i = 1; i < aoa.length; i++) {
    const line = i + 1; // dòng 1 = header
    const raw = aoa[i];
    // Bỏ qua (không báo lỗi) dòng hoàn toàn trống — hay gặp ở cuối file.
    const isBlank = raw.every((c) => c === "" || c == null);
    if (isBlank) continue;

    const dateStr = parseDateCell(raw[dateCol]);
    if (!dateStr) {
      errors.push({ line, reason: "Thiếu hoặc sai định dạng ngày" });
      continue;
    }
    const amount = parseVnInt(raw[amountCol]);
    if (amount === null) {
      errors.push({ line, reason: "Thiếu hoặc sai số tiền" });
      continue;
    }
    const campaignName = nameCol === -1 ? "" : String(raw[nameCol] ?? "").trim();
    rows.push({ date: new Date(`${dateStr}T00:00:00+07:00`), campaignName, amount });
  }

  return { rows, errors };
}
