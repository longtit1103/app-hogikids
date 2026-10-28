import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FIELD_BAN_TRUC_TIEP, FIELD_MAPPING_DON, FIELD_TIEN_LONG } from "@/lib/ingest/webhook-processor";

/**
 * LƯỚI SINH TỪ MAPPING: mọi khoá payload mà `mapPancakeOrder` (và mọi hàm con nhận `raw`) đọc phải
 * nằm trong danh sách guard land webhook (`webhook-processor.ts`) — hoặc là ngoại lệ CÓ LÝ DO ở đây.
 *
 * Vì sao cần: guard chỉ nhường bản API khi sự kiện webhook vắng một khoá NẰM TRONG danh sách. Danh
 * sách chép tay từng thiếu đúng 6 khoá quyết định kênh bán trực tiếp + tiền đã thu tại quầy
 * (`received_at_shop`, `transfer_money`, `cash`, `charged_by_*`): webhook vắng chúng ⇒ đơn quầy về
 * `website`, `paidAtShop = 0`, Sổ quỹ hụt mà không tự lành. Thêm field vào mapping mà quên guard ⇒
 * test này đỏ ngay, không chờ ai soát tay.
 */

const NGUON_MAPPING = readFileSync(path.resolve(__dirname, "../../src/lib/ingest/pancake-mapping.ts"), "utf8");

/** Khoá mức 1 mapping đọc nhưng CỐ Ý không vào guard. Mỗi mục phải có lý do. */
const NGOAI_LE_CO_Y: Record<string, string> = {
  id: "khoá định danh đơn — guard tự rút `o->>'id'` để tìm bản API cùng đơn; vắng id thì không có bản nào để so",
};

/** Khoá LỒNG trong `advanced_platform_fee` mapping đọc nhưng CỐ Ý không vào `FIELD_TIEN_LONG`. */
const NGOAI_LE_LONG_CO_Y: Record<string, string> = {
  diff_shipping_fee:
    "chỉ vào vế tiền ship của luật suy voucher sàn từ cod (không ghi cột Silver nào); chưa đo webhook có mang " +
    "khoá này không — đo bằng `scripts/do-field-webhook-pancake.ts` trước khi đưa vào guard (đưa khi chưa đo " +
    "có thể nhường mọi webhook đơn sàn có phí ship chênh)",
};

/** Thân hàm `function ten(...) { ... }` trong nguồn — đếm ngoặc, đủ cho file mapping (không có `{` lẻ trong chuỗi). */
function thanHam(nguon: string, ten: string): string | null {
  const m = new RegExp(`function\\s+${ten}\\s*\\(`).exec(nguon);
  if (!m) return null;
  let i = m.index + m[0].length;
  for (let sau = 1; sau > 0; i++) {
    if (nguon[i] === "(") sau++;
    else if (nguon[i] === ")") sau--;
  }
  const mo = nguon.indexOf("{", i);
  let sau = 0;
  for (let j = mo; j < nguon.length; j++) {
    if (nguon[j] === "{") sau++;
    else if (nguon[j] === "}" && --sau === 0) return nguon.slice(mo, j + 1);
  }
  throw new Error(`không đóng được thân hàm ${ten}`);
}

/**
 * Đi từ `mapPancakeOrder` theo mọi lời gọi truyền THẲNG `raw` (`f(raw, …)`), gom khoá mức 1 (`raw.x`)
 * và khoá lồng `raw.advanced_platform_fee?.x`. Hàm nhận `raw` mà không định nghĩa trong file ⇒ ném,
 * vì lưới không đọc được nó (phải mở rộng lưới chứ không được lọt im lặng).
 */
function gomFieldMapping(): { mucMot: Set<string>; long: Set<string>; daDi: Set<string> } {
  const mucMot = new Set<string>();
  const long = new Set<string>();
  const daDi = new Set<string>();
  const hangDoi = ["mapPancakeOrder"];
  while (hangDoi.length > 0) {
    const ten = hangDoi.pop() as string;
    if (daDi.has(ten)) continue;
    const than = thanHam(NGUON_MAPPING, ten);
    if (than === null) throw new Error(`hàm ${ten} nhận \`raw\` nhưng không định nghĩa trong pancake-mapping.ts — mở rộng lưới`);
    daDi.add(ten);
    for (const [, k] of than.matchAll(/\braw\.(\w+)/g)) mucMot.add(k);
    for (const [, k] of than.matchAll(/\braw\.advanced_platform_fee\??\.(\w+)/g)) long.add(k);
    for (const [, f] of than.matchAll(/\b(\w+)\(\s*raw\s*[,)]/g)) hangDoi.push(f);
  }
  return { mucMot, long, daDi };
}

describe("guard webhook ⊇ field mapping đơn Pancake", () => {
  const { mucMot, long, daDi } = gomFieldMapping();

  it("lưới thật sự đi tới các hàm đọc kênh + tiền quầy (không mù vì đổi tên tham số)", () => {
    expect([...daDi]).toEqual(expect.arrayContaining(["mapPancakeOrder", "mapChannel", "tinhTienDaTraTaiShop"]));
    expect([...mucMot]).toEqual(expect.arrayContaining(["received_at_shop", "transfer_money", "status", "items"]));
  });

  it("mọi khoá mức 1 mapping đọc đều nằm trong guard hoặc ngoại lệ có lý do", () => {
    const guard = new Set([
      ...(FIELD_MAPPING_DON ?? []),
      ...(FIELD_TIEN_LONG ?? []),
      ...(FIELD_BAN_TRUC_TIEP ?? []),
      ...Object.keys(NGOAI_LE_CO_Y),
    ]);
    expect([...mucMot].filter((k) => !guard.has(k)).sort()).toEqual([]);
  });

  it("mọi khoá lồng trong advanced_platform_fee mapping đọc đều nằm trong FIELD_TIEN_LONG hoặc ngoại lệ", () => {
    const guard = new Set([...(FIELD_TIEN_LONG ?? []), ...Object.keys(NGOAI_LE_LONG_CO_Y)]);
    expect([...long].filter((k) => !guard.has(k)).sort()).toEqual([]);
  });

  it("ngoại lệ không mục: mỗi khoá ngoại lệ mapping VẪN đọc (thôi đọc thì gỡ khỏi danh sách)", () => {
    expect(Object.keys(NGOAI_LE_CO_Y).filter((k) => !mucMot.has(k))).toEqual([]);
    expect(Object.keys(NGOAI_LE_LONG_CO_Y).filter((k) => !long.has(k))).toEqual([]);
  });

  it("nhóm bán trực tiếp đúng 6 khoá kênh `direct` + tiền đã trả tại shop, tách rời nhóm soi mọi đơn", () => {
    expect([...(FIELD_BAN_TRUC_TIEP ?? [])].sort()).toEqual(
      ["cash", "charged_by_card", "charged_by_momo", "charged_by_qrpay", "received_at_shop", "transfer_money"],
    );
    // Lẫn vào FIELD_MAPPING_DON là soi cả đơn sàn ⇒ nhường mọi webhook Shopee/TikTok vắng các khoá này.
    expect((FIELD_BAN_TRUC_TIEP ?? []).filter((k) => (FIELD_MAPPING_DON ?? []).includes(k))).toEqual([]);
  });
});
