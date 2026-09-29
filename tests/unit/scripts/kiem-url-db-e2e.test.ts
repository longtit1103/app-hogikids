import { describe, expect, it } from "vitest";

import { kiemUrlDbE2e, type KetQuaKiemUrl } from "../../../scripts/don-db-e2e";

/**
 * `kiemUrlDbE2e` — cổng kiểm TĨNH (không kết nối DB) của `scripts/don-db-e2e.ts` trước khi lệnh dọn
 * DB e2e được phép kết nối. Fail-closed: MỌI ca dưới đây phải bị TỪ CHỐI trừ đúng URL e2e hợp lệ.
 *
 * Mỗi `it` assert CẢ `lyDo` (không chỉ `ok===false`) — mutation-verify (bỏ từng điều kiện trong
 * `kiemUrlDbE2e`, chạy lại, phải thấy ĐÚNG `it` tương ứng đỏ, `git checkout --` hoàn nguyên) cần
 * từng nhánh có dấu vân tay câu chữ riêng, không lẫn vào nhánh khác đang tình cờ cũng từ chối.
 */

const URL_PROD = "postgresql://hogikids:matkhau@db-host:5432/postgres?schema=app";
const URL_E2E_HOP_LE = "postgresql://hogikids:matkhau@db-host:5432/hogikids_e2e_test?schema=app";

/** Rút `lyDo` từ kết quả từ chối — ném rõ nếu lỡ gọi trên kết quả `ok:true` (lỗi test, không phải SUT). */
function lyDoCua(r: KetQuaKiemUrl): string {
  if (r.ok) throw new Error("Mong `ok:false` nhưng nhận `ok:true` — test sai giả thiết.");
  return r.lyDo;
}

describe("kiemUrlDbE2e", () => {
  it("thiếu biến (undefined) ⇒ từ chối vì THIẾU, không lẫn với lỗi parse", () => {
    const r = kiemUrlDbE2e(undefined, URL_PROD);
    expect(r.ok).toBe(false);
    expect(lyDoCua(r)).toContain("Thiếu TEST_DATABASE_URL_E2E");
  });

  it("URL rác (không parse được) ⇒ từ chối vì URL không hợp lệ", () => {
    const r = kiemUrlDbE2e("khong-phai-url", URL_PROD);
    expect(r.ok).toBe(false);
    expect(lyDoCua(r)).toContain("không phải URL hợp lệ");
  });

  it("URL trỏ DB prod (postgres) ⇒ từ chối vì SAI TÊN database", () => {
    const r = kiemUrlDbE2e(URL_PROD, URL_PROD);
    expect(r.ok).toBe(false);
    expect(lyDoCua(r)).toContain('Database phải đúng "hogikids_e2e_test"');
  });

  it("URL trỏ hogikids_test ⇒ từ chối vì SAI TÊN database", () => {
    const r = kiemUrlDbE2e("postgresql://hogikids:matkhau@db-host:5432/hogikids_test?schema=app", URL_PROD);
    expect(r.ok).toBe(false);
    expect(lyDoCua(r)).toContain('Database phải đúng "hogikids_e2e_test"');
  });

  it("schema khác app ⇒ từ chối vì SAI schema", () => {
    const r = kiemUrlDbE2e("postgresql://hogikids:matkhau@db-host:5432/hogikids_e2e_test?schema=public", URL_PROD);
    expect(r.ok).toBe(false);
    expect(lyDoCua(r)).toContain('schema phải đúng "app"');
  });

  it("thiếu tham số schema ⇒ từ chối vì SAI schema (không có)", () => {
    const r = kiemUrlDbE2e("postgresql://hogikids:matkhau@db-host:5432/hogikids_e2e_test", URL_PROD);
    expect(r.ok).toBe(false);
    expect(lyDoCua(r)).toContain("(không có)");
  });

  it("URL e2e hợp lệ nhưng trùng host+port+db với DATABASE_URL ⇒ từ chối vì TRÙNG điểm nối", () => {
    // DATABASE_URL (giả định bị cấu hình nhầm) cũng trỏ đúng hogikids_e2e_test — user/password khác
    // (chuẩn hoá phải BỎ QUA password) vẫn phải bắt được là CÙNG một điểm nối.
    const urlProdNham = "postgresql://user_khac:pass_khac@db-host:5432/hogikids_e2e_test?schema=app";
    const r = kiemUrlDbE2e(URL_E2E_HOP_LE, urlProdNham);
    expect(r.ok).toBe(false);
    expect(lyDoCua(r)).toContain("trùng host+port+database với DATABASE_URL");
  });

  it("DATABASE_URL rác/không parse được ⇒ BỎ QUA phép so trùng, không chặn oan", () => {
    const r = kiemUrlDbE2e(URL_E2E_HOP_LE, "khong-phai-url");
    expect(r).toEqual({ ok: true });
  });

  it("đúng URL e2e, khác DATABASE_URL (prod) ⇒ nhận", () => {
    const r = kiemUrlDbE2e(URL_E2E_HOP_LE, URL_PROD);
    expect(r).toEqual({ ok: true });
  });
});
