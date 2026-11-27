import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mapHoaDonTiktok, type TruongHoaDonTho } from "@/lib/ingest/tiktok-ads-hoa-don-mapping";
import {
  DAU_BAM_OTHERS_TRU_SO_DU_DA_XAC_MINH,
  dauBamHoaDonOthers,
  laOthersTruSoDuDaXacMinh,
} from "@/lib/ingest/tiktok-hoa-don-others-tru-so-du-da-xac-minh";

import {
  BC,
  DONG_OTHERS,
  DONG_P8,
  ID_OTHERS,
  ID_P8,
  tapGiaTuOthers,
  truongTho,
} from "../helpers/hoa-don-tiktok-others-fixture";

/**
 * Phân loại THUẦN hoá đơn TikTok OTHERS trừ số dư đã xác minh: dấu băm cố định dạng chuẩn hoá, và mọi đổi khác payload
 * so với lúc xác minh ⇒ KHÔNG khớp (rơi về ERROR + backlog như dòng OTHERS thường).
 * Mọi id là id GIẢ; tập giả tính từ fixture bằng chính hàm băm.
 */

const TAP_GIA = new Set(tapGiaTuOthers([0, 1, 2, 3, 4, 5, 6, 7]));
const O1 = truongTho(DONG_OTHERS[0]);
const O2 = truongTho(DONG_OTHERS[1]);

// Số lượng + vân tay nội dung của tập THẬT: `tiktok-hoa-don-others-tap-dau-bam-that-chi-private.test.ts` (chỉ repo private —
// snapshot công khai mang tập RỖNG). Mọi ca dưới phải xanh với CẢ tập thật lẫn tập rỗng.
describe("hằng tập dấu băm (thật ở private, rỗng ở bản public)", () => {
  it("mọi phần tử (nếu có) là 64 hex thường", () => {
    for (const h of DAU_BAM_OTHERS_TRU_SO_DU_DA_XAC_MINH) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("id GIẢ của fixture không thuộc tập thật ⇒ các test ghim 'ngoài tập' vẫn chạy với hằng thật", () => {
    for (const h of TAP_GIA) expect(DAU_BAM_OTHERS_TRU_SO_DU_DA_XAC_MINH.has(h)).toBe(false);
    for (let i = 0; i < 8; i++) {
      expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[i], BC, truongTho(DONG_OTHERS[i]))).toBe(false);
    }
  });

  it("lưới tĩnh: file module không chứa chuỗi 19 chữ số nào (không id giao dịch thật trong repo)", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../src/lib/ingest/tiktok-hoa-don-others-tru-so-du-da-xac-minh.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\d{19}/);
  });
});

describe("dauBamHoaDonOthers — khoá dạng chuẩn hoá", () => {
  it("vectơ kiểm cố định (tính độc lập bằng `shasum -a 256` trên 13 dòng, không xuống dòng cuối)", () => {
    // tiktok-hoa-don-others-tru-so-du-v1 / 7000000000000000101 / 7000000000000000012 / 7000000000000000011 /
    // 2026-09-04 08:12:55 / UTC+07:00 / BILL_PAYMENT / CASH / OTHERS / (rỗng) / 260288 / 26029 / VND
    expect(dauBamHoaDonOthers(ID_OTHERS[0], BC, O1)).toBe(
      "5fb2b5027337f3121e60091acaf7252b3dfa7bdc7f2dc212d4214e859eb26142",
    );
  });

  it("trường ngoài danh sách băm (invoice_id, serial_number, payment_portfolio_id, transaction_id payload) không đổi băm", () => {
    const goc = dauBamHoaDonOthers(ID_OTHERS[0], BC, O1);
    expect(
      dauBamHoaDonOthers(ID_OTHERS[0], BC, {
        ...O1,
        invoice_id: "x",
        serial_number: "y",
        payment_portfolio_id: null,
        transaction_id: "z",
      }),
    ).toBe(goc);
  });
});

describe("laOthersTruSoDuDaXacMinh — trong tập", () => {
  it.each(ID_OTHERS.map((id, i) => [id, i] as const))("OTHERS %s trong tập giả ⇒ true", (id, i) => {
    expect(laOthersTruSoDuDaXacMinh(id, BC, truongTho(DONG_OTHERS[i]), TAP_GIA)).toBe(true);
  });

  it("payload thiếu bc_id ⇒ giải bằng shopId Bronze (cùng luật mapping) ⇒ vẫn khớp", () => {
    const { bc_id: _bo, ...khongBc } = O1;
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[0], BC, khongBc, TAP_GIA)).toBe(true);
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[0], "7000000000000000099", khongBc, TAP_GIA)).toBe(false);
  });
});

describe("laOthersTruSoDuDaXacMinh — id thuộc tập nhưng payload đổi ⇒ false (rơi về ERROR)", () => {
  const caDoi: ReadonlyArray<readonly [string, TruongHoaDonTho, TruongHoaDonTho]> = [
    ["amount có giá trị", O2, { ...O2, amount: "2580243" }],
    ["subtotal đổi", O2, { ...O2, subtotal: "2345676" }],
    ["tax_amount đổi", O2, { ...O2, tax_amount: "234569" }],
    ["create_time đổi 1 giây", O2, { ...O2, create_time: "2026-09-05 10:31:08" }],
    ["timezone đổi", O2, { ...O2, timezone: "UTC+00:00" }],
    ["account_id đổi", O2, { ...O2, account_id: "7000000000000000098" }],
    ["bc_id payload đổi", O2, { ...O2, bc_id: "7000000000000000097" }],
    ["transaction_type đổi", O2, { ...O2, transaction_type: "ADD_BALANCE" }],
    ["billing_type đổi", O2, { ...O2, billing_type: "CREDIT" }],
    ["currency đổi", O2, { ...O2, currency: "USD" }],
    ["currency vắng (mapping coi là VND, băm thì khác)", O2, { ...O2, currency: null }],
    ["subtotal dạng số thực 2345675.0", O2, { ...O2, subtotal: "2345675.0" }],
    ["subtotal có khoảng trắng (không trim)", O2, { ...O2, subtotal: " 2345675" }],
  ];

  it.each(caDoi)("%s ⇒ không thuộc tập (bc_id đi qua bước giải như mapping); mapping vẫn từ chối (⇒ skipped + ERROR)", (_ten, goc, doi) => {
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[1], BC, goc, TAP_GIA)).toBe(true);
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[1], BC, doi, TAP_GIA)).toBe(false);
    expect(mapHoaDonTiktok(ID_OTHERS[1], BC, doi).ok).toBe(false);
  });

  it("transaction_id (externalId) khác với payload y hệt ⇒ false", () => {
    expect(laOthersTruSoDuDaXacMinh("7000000000000000199", BC, O2, TAP_GIA)).toBe(false);
  });

  it("amount_type 'OTHERS ' / 'others' (không đúng chuỗi) ⇒ false", () => {
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[1], BC, { ...O2, amount_type: "OTHERS " }, TAP_GIA)).toBe(false);
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[1], BC, { ...O2, amount_type: "others" }, TAP_GIA)).toBe(false);
  });

  it("payload không phải object / thiếu bc_id lẫn shopId ⇒ false", () => {
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[0], BC, null, TAP_GIA)).toBe(false);
    const { bc_id: _bo, ...khongBc } = O1;
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[0], "  ", khongBc, TAP_GIA)).toBe(false);
  });
});

describe("dòng POSITIVE/NEGATIVE không bao giờ bị tập nuốt", () => {
  it("P8 POSITIVE hợp lệ ⇒ không thuộc tập (kể cả tập chứa băm của chính nó) và map bình thường", () => {
    const p8 = truongTho(DONG_P8);
    // Tập độc hại chứa băm của chính P8: cổng `amount_type === "OTHERS"` vẫn chặn.
    const tapDoc = new Set([...TAP_GIA, dauBamHoaDonOthers(ID_P8, BC, p8)]);
    expect(laOthersTruSoDuDaXacMinh(ID_P8, BC, p8, tapDoc)).toBe(false);
    const m = mapHoaDonTiktok(ID_P8, BC, p8);
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.hoaDon).toMatchObject({ amount: 2_348_016, amountType: "POSITIVE" });
  });

  it.each(["POSITIVE", "NEGATIVE"])("O1 đổi amount_type %s ⇒ băm khác tập (amount_type nằm trong băm)", (chieu) => {
    const doi = { ...O1, amount_type: chieu, amount: "286317" };
    expect(laOthersTruSoDuDaXacMinh(ID_OTHERS[0], BC, doi, TAP_GIA)).toBe(false);
    expect(TAP_GIA.has(dauBamHoaDonOthers(ID_OTHERS[0], BC, doi))).toBe(false);
    expect(mapHoaDonTiktok(ID_OTHERS[0], BC, doi).ok).toBe(true);
  });
});
