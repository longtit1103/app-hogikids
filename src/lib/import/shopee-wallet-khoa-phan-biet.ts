import { createHash } from "node:crypto";

import type { ParsedWalletRow } from "./shopee-wallet-xlsx";

/**
 * Khoá idempotent của dòng ví Shopee + luật phân biệt dòng VA CHẠM khoá trong cùng một file.
 *
 * Khoá gốc `txnTime|type|orderCode|amount` (Bronze `idExpr` stream `shopee/wallet`, `streams.ts`) cố ý
 * KHÔNG chứa số dư ví (điều chỉnh back-date dịch số dư mọi dòng sau ⇒ khoá đổi ⇒ đếm 2 lần). Cái giá:
 * hai giao dịch THẬT khác nhau có thể trùng khoá — ca thật file 01/01: 2 điều chỉnh phí ship cùng giây,
 * cùng −1.620, cột "Mã đơn hàng" = "-", mã đơn chỉ nằm trong cột "Chi tiết". Trước bản vá cổng
 * `DUPLICATE_KEY` chặn cả file (đúng luật nhưng oan).
 *
 * 🔴 HẬU TỐ LÀ ĐỊNH DANH LƯU VĨNH VIỄN: `khoaPhu` nằm trong `externalId` Bronze (append-only) lẫn Silver.
 * Đổi BẤT KỲ chi tiết nào của `hauToPhanBiet` (regex, chuẩn hoá, hàm băm, độ dài, cách nối mã) ⇒ nhập
 * lại một file đã land ra khoá MỚI trong khi khoá cũ còn nguyên ⇒ ĐẾM 2 LẦN đúng các dòng đó, mà không
 * cổng nào kêu (checksum/số dư chỉ soi trong file). Test vàng `tests/shopee-wallet-khoa-trung-oan.test.ts`
 * ghim cứng giá trị là hàng rào; muốn đổi luật thì phải kèm script chuyển khoá Bronze/Silver.
 *
 * Luật — hậu tố tính THEO TỪNG DÒNG, độc lập với các dòng khác trong nhóm:
 *  1. `f(dòng)` = mã đơn Shopee trích từ "Chi tiết" (nhiều mã ⇒ nối `+` theo thứ tự xuất hiện, mã lặp
 *     tính một lần); không có mã ⇒ `ct:` + 16 hex đầu sha256 của "Chi tiết" đã chuẩn hoá; Chi tiết rỗng
 *     (hoặc file thiếu cột) ⇒ không có `f`.
 *  2. Trong nhóm dòng cùng khoá gốc: có dòng thiếu `f`, hoặc hai dòng cùng `f` ⇒ KHÔNG phân biệt được
 *     ⇒ vẫn báo trùng để chặn.
 *  3. Dòng có `f` NHỎ NHẤT (so code-unit) giữ khoá gốc + payload thường (KHÔNG thêm field); các dòng còn
 *     lại mang field `khoaPhu = f` ⇒ khoá `…|<f>`.
 *
 * Vì sao `f` theo DÒNG (không chọn kiểu hậu tố theo cả nhóm): `f` của một giao dịch không đổi dù file
 * chứa cả nhóm hay chỉ một phần ⇒ mỗi giao dịch chỉ có thể mang khoá gốc hoặc `…|f(chính nó)` ⇒ hợp tập
 * khoá qua mọi file ≤ số giao dịch thật (+ ô khoá gốc dùng chung). Chọn theo nhóm thì nhóm {X,Y có mã,
 * Z không mã} cho khoá băm khi file đủ 3 nhưng khoá mã đơn khi file chỉ X,Y ⇒ thừa dòng.
 *
 * Vì sao một dòng GIỮ khoá gốc (thay vì cả nhóm mang hậu tố): khoá gốc là một "ô" do đúng một dòng
 * của nhóm chiếm — dòng nào chiếm thì bản payload mới nhất đè lên (`latestPayloads` DISTINCT ON), số
 * dòng và tổng tiền nhóm không đổi (cùng khoá gốc ⇒ cùng số tiền). Cả nhóm đổi sang hậu tố thì mọi dòng
 * đã land bằng khoá gốc trước đó (file chỉ chứa một dòng của nhóm) thành dòng mồ côi ⇒ ĐẾM 2 LẦN.
 *
 * Dòng không va chạm KHÔNG bị đụng tới: khoá + payload (nên cả `payloadHash` Bronze) y hệt trước bản vá.
 */

/** Mã đơn Shopee: 6 số ngày (YYMMDD) + 8 ký tự chữ-số in hoa, vd `260121KK741DX4`. */
const MA_DON_SHOPEE_RE = /(?<![0-9A-Z])\d{6}[0-9A-Z]{8}(?![0-9A-Z])/g;

export type KhoaViInput = Pick<ParsedWalletRow, "txnTime" | "type" | "orderCode" | "amount" | "khoaPhu">;

/**
 * Gương JS của `idExpr` Bronze — PHẢI ra đúng chuỗi Postgres dựng (test tích hợp so hai bên).
 * `khoaPhu` vắng ⇒ đúng khoá gốc 4 thành phần như trước bản vá.
 */
export function khoaViShopee(row: KhoaViInput): string {
  const goc = `${row.txnTime}|${row.type}|${row.orderCode ?? "-"}|${row.amount}`;
  return row.khoaPhu === undefined ? goc : `${goc}|${row.khoaPhu}`;
}

/** Chuẩn hoá ô "Chi tiết": NFC + gộp khoảng trắng + trim — để khác biệt trình bày không đổi hậu tố. */
export function chuanHoaChiTiet(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Hậu tố phân biệt `f` của MỘT dòng từ Chi tiết ĐÃ chuẩn hoá (`chuanHoaChiTiet`); "" nếu Chi tiết rỗng.
 * 🔴 Giá trị lưu vĩnh viễn — xem chú thích đầu file trước khi sửa.
 */
export function hauToPhanBiet(chiTiet: string): string {
  if (chiTiet === "") return "";
  const ma = chiTiet.match(MA_DON_SHOPEE_RE) ?? [];
  if (ma.length > 0) return [...new Set(ma)].join("+");
  return `ct:${createHash("sha256").update(chiTiet, "utf8").digest("hex").slice(0, 16)}`;
}

export type KetQuaPhanBiet = {
  /** Khoá vẫn trùng sau khi đã thử phân biệt — action từ chối import. */
  duplicateKeys: string[];
  /** Mỗi nhóm đã phân biệt được ⇒ một cảnh báo (không chặn) để chủ shop biết. */
  warnings: string[];
};

/**
 * Gán `khoaPhu` cho dòng va chạm (SỬA TẠI CHỖ `rows`). `chiTiet[i]` = Chi tiết chuẩn hoá của `rows[i]`,
 * `lines[i]` = số dòng trong file (chỉ để viết cảnh báo).
 */
export function ganKhoaPhanBiet(rows: ParsedWalletRow[], chiTiet: string[], lines: number[]): KetQuaPhanBiet {
  const nhom = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = khoaViShopee({ ...r, khoaPhu: undefined });
    const ds = nhom.get(k);
    if (ds) ds.push(i);
    else nhom.set(k, [i]);
  });

  const dup = new Set<string>();
  const warnings: string[] = [];

  for (const [khoaGoc, idx] of nhom) {
    if (idx.length < 2) continue;
    const thuTu = idx.map((i) => ({ i, f: hauToPhanBiet(chiTiet[i]) }));
    if (thuTu.some(({ f }) => f === "") || new Set(thuTu.map(({ f }) => f)).size !== thuTu.length) {
      dup.add(khoaGoc);
      continue;
    }
    // Sắp theo `f` (so code-unit, KHÔNG localeCompare — tất định mọi máy/locale).
    thuTu.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
    for (const { i, f } of thuTu.slice(1)) rows[i].khoaPhu = f;
    warnings.push(
      `Dòng ${thuTu.map(({ i }) => lines[i]).join(", ")}: cùng khoá ${khoaGoc} — là ${idx.length} giao dịch ` +
        `khác nhau, phân biệt bằng cột "Chi tiết" (${thuTu.map(({ f }) => f).join(" / ")})`,
    );
  }

  // Lưới cuối: khoá SAU khi gán phải đôi một khác nhau (vd khoá có hậu tố đụng khoá gốc của dòng khác
  // có mã đơn chứa "|"). Trùng ⇒ chặn như cũ, không để Bronze/Silver gộp thầm.
  const thay = new Set<string>();
  for (const r of rows) {
    const k = khoaViShopee(r);
    if (thay.has(k)) dup.add(k);
    else thay.add(k);
  }

  return { duplicateKeys: [...dup], warnings };
}
