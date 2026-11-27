import type { TruongHoaDonTho } from "@/lib/ingest/tiktok-ads-hoa-don-mapping";
import { dauBamHoaDonOthers } from "@/lib/ingest/tiktok-hoa-don-others-tru-so-du-da-xac-minh";

/**
 * Fixture hoá đơn TikTok Business với id, ngày giờ và số tiền GIẢ (giữ đúng cấu trúc ca thật) — nguồn DUY NHẤT cho mọi
 * test hoá đơn OTHERS (trong tập lẫn ngoài tập: mapping, route ingest, dựng lại), để hai nhóm không trôi khác nhau:
 *  - N: lần nạp `ADD_BALANCE` 16.000.000 (trừ thẻ);
 *  - O1–O8: `BILL_PAYMENT|CASH|OTHERS`, `amount` JSON null, subtotal/tax là SỐ JSON nguyên (đúng hình dạng hồ sơ gốc);
 *    O2–O7 cùng subtotal, thuế VAT 10% làm tròn lệch 1 đồng ở O4/O7; Σ(subtotal + tax) O1–O8 = đúng N;
 *  - P8: nửa `POSITIVE` 2.348.016 của bill tách đôi (cùng invoice với O8; subtotal O8 + P8 = subtotal một bill O2–O7).
 * Id giả không thuộc tập dấu băm thật ⇒ tập giả trong test tính bằng chính `dauBamHoaDonOthers` trên fixture này.
 */

export const BC = "7000000000000000012"; // BC TikTok GIẢ
export const ADV = "7000000000000000011"; // advertiser TikTok GIẢ
export const PORTFOLIO = "7000000000000000003"; // payment portfolio GIẢ
export const STREAM_HOA_DON = "tiktokbusiness/invoice";
export const INVOICE_TACH_DOI = "7000000000000000208";
export const ID_NAP = "7000000000000000100";
export const ID_P8 = "7000000000000000109";
export const NAP = 16_000_000;
export const P8 = 2_348_016;

type Dong = Record<string, string | number | null>;

const vo = (r: Dong): Dong => ({
  account_id: ADV,
  bc_id: BC,
  billing_type: "CASH",
  currency: "VND",
  timezone: "UTC+07:00",
  payment_portfolio_id: PORTFOLIO,
  ...r,
});

export const DONG_NAP: Dong = vo({
  transaction_id: ID_NAP,
  transaction_type: "ADD_BALANCE",
  amount_type: "POSITIVE",
  amount: String(NAP),
  subtotal: "14545455",
  tax_amount: "1454545",
  invoice_id: "7000000000000000200",
  serial_number: "VNTT000000000001",
  create_time: "2026-09-02 19:47:12",
  payment_portfolio_id: null,
});

export const DONG_P8: Dong = vo({
  transaction_id: ID_P8,
  transaction_type: "BILL_PAYMENT",
  amount_type: "POSITIVE",
  amount: String(P8),
  subtotal: "2134560",
  tax_amount: "213456",
  invoice_id: INVOICE_TACH_DOI,
  serial_number: "VNTT000000000008",
  create_time: "2026-09-09 13:27:58",
});

/** [transaction_id, subtotal, tax_amount, invoice_id, serial_number, create_time] — 7 dòng thiếu invoice + 1 dòng tách đôi. */
const OTHERS: ReadonlyArray<readonly [string, number, number, string, string, string]> = [
  ["7000000000000000101", 260288, 26029, "", "-999", "2026-09-04 08:12:55"],
  ["7000000000000000102", 2345675, 234568, "", "-999", "2026-09-05 10:31:07"],
  ["7000000000000000103", 2345675, 234568, "", "-999", "2026-09-06 16:48:41"],
  ["7000000000000000104", 2345675, 234567, "", "-999", "2026-09-07 07:22:19"],
  ["7000000000000000105", 2345675, 234568, "", "-999", "2026-09-07 18:59:03"],
  ["7000000000000000106", 2345675, 234568, "", "-999", "2026-09-08 11:14:36"],
  ["7000000000000000107", 2345675, 234567, "", "-999", "2026-09-08 22:03:50"],
  ["7000000000000000108", 211115, 21112, INVOICE_TACH_DOI, "VNTT000000000008", "2026-09-09 13:27:44"],
];

export const ID_OTHERS: readonly string[] = OTHERS.map((d) => d[0]);

export const DONG_OTHERS: readonly Dong[] = OTHERS.map(([id, subtotal, tax, invoice, serial, luc]) =>
  vo({
    transaction_id: id,
    transaction_type: "BILL_PAYMENT",
    amount_type: "OTHERS",
    amount: null,
    subtotal,
    tax_amount: tax,
    invoice_id: invoice,
    serial_number: serial,
    create_time: luc,
  }),
);

/**
 * Bản đồ trường y như SQL transform rút (`v #>> '{}'`): số JSON nguyên ⇒ chuỗi thập phân, JSON null ⇒ null.
 * Chỉ dùng cho dòng không có số thực / int64 (fixture này) — đúng tương đương với đường Postgres.
 */
export const truongTho = (d: Dong): TruongHoaDonTho =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === null ? null : String(v)]));

/** Dấu băm (tập giả) của các dòng OTHERS chọn theo vị trí 0..7 — tính bằng CHÍNH hàm băm của module. */
export const tapGiaTuOthers = (viTri: readonly number[]): string[] =>
  viTri.map((i) => dauBamHoaDonOthers(ID_OTHERS[i], BC, truongTho(DONG_OTHERS[i])));

/** Trang TEXT THÔ y như TikTok trả (n8n gửi nguyên chuỗi, không parse). Không có int64 dạng số ⇒ stringify an toàn. */
export const trangHoaDon = (dong: readonly Dong[]) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[${dong.map((d) => JSON.stringify(d)).join(",")}],"page_info":{"total_page":1}}}`;
