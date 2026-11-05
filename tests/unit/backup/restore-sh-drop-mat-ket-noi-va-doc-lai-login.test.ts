import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  chayRestoreVoiDockerGia,
  donThuMucHarness,
  type KetQuaChay,
} from "../../deploy/harness/restore/chay-restore-voi-docker-gia";

/**
 * Hai lối `deploy/restore.sh` từng MỞ LẠI đăng nhập role app mà không chắc an toàn:
 *
 *  (1) Lệnh DROP (cổng khoá việc nặng + DROP + CREATE trong MỘT `psql -c`) kết thúc mã ≠ 1. Trước bản vá,
 *      mọi lỗi DROP mã ≤ 128 đều bị coi là "lỗi SQL ⇒ rollback ⇒ schema CÒN NGUYÊN" rồi mở lại. psql mã 2 =
 *      MẤT KẾT NỐI — COMMIT có thể đã tới server mà client không nhận được trả lời ⇒ không rõ schema còn
 *      hay mất ⇒ phải giữ khoá (REVOKE / NOLOGIN) + tệp đánh dấu `buoc_do=drop`. Chỉ mã 1 (lỗi câu lệnh
 *      của `-c` — server đã rollback cả chuỗi) mới được mở lại như cũ. Mã lạ khác (3, 127…) cũng giữ khoá.
 *  (2) Mở lại chế độ NOLOGIN tin mã thoát của `ALTER ROLE … LOGIN`, không đọc lại `rolcanlogin` (nhánh
 *      REVOKE thì có đọc lại `datacl`). Đọc lại không ra `t` (hoặc đọc lỗi) ⇒ giữ tệp đánh dấu, in lệnh
 *      mở tay, thoát ≠ 0, không "✓".
 *
 * Chạy TRỌN script với `docker` giả (harness `tests/deploy/harness/restore/`). Không Postgres/Docker thật.
 * Chứng minh đỏ trên bản cũ: `RESTORE_SH_DUOI_TEST=<thư mục tạm>/deploy/restore.sh` (chép CẢ `deploy/`).
 */
const DB_NHAP = "db_dien_tap_dr";
const ACL_CO_GRANT = "{=Tc/supabase_admin,supabase_admin=CTc/supabase_admin,hogikids=c/supabase_admin}";

afterEach(() => donThuMucHarness());

const dem = (r: KetQuaChay, nhan: string) => r.suKien.filter((s) => s === nhan).length;

/** Bất biến chung khi bước DROP kết thúc KHÔNG RÕ: giữ khoá + tệp `buoc_do=drop`, không khẳng định gì. */
function expectGiuKhoaODrop(r: KetQuaChay): void {
  expect(r.status, r.stderr).not.toBe(0);
  expect(r.tepDangDoConKhong, "giữ tệp đánh dấu để lượt sau dừng ở preflight").toBe(true);
  expect(readFileSync(r.tepDangDo, "utf8")).toMatch(/buoc_do=drop/);
  expect(r.stderr).not.toContain("schema CÒN NGUYÊN");
  expect(r.stderr).not.toContain("✓ Đã mở lại");
  expect(r.stderr).not.toMatch(/✓ Phục hồi schema/);
  expect(r.stderr).toContain("không rõ DROP đã commit hay chưa");
  expect(r.stderr).toContain("FROM pg_namespace WHERE nspname = 'app'"); // lệnh kiểm schema còn/mất
  expect(r.stderr).toContain("KHÔNG mở lại đăng nhập");
  expect(r.suKien, "dừng ngay ở DROP").not.toContain("NAP_PSQL");
  expect(r.suKien).not.toContain("NAP_PG_RESTORE");
  expect(r.suKien).not.toContain("THU_HOI");
  expect(r.tepTamSot).toEqual([]);
}

describe("DROP kết thúc mã ≠ 1 (mất kết nối…) ⇒ không rõ đã commit ⇒ GIỮ khoá", () => {
  it.each([
    ["plain (.sql.gz)", "gzip" as const],
    ["custom (.dump)", "custom" as const],
  ])("REVOKE (DB nháp), %s: dấu chốt DROP mã 2 ⇒ giữ REVOKE, in lệnh trả datacl tay", async (_ten, dinhDang) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang, db: DB_NHAP, kichBan: { aclBanDau: ACL_CO_GRANT, dauChotRcO: { nhan: "DROP", rc: 2 } } });
    expect(r.status, r.stderr).toBe(2);
    expectGiuKhoaODrop(r);
    expect(dem(r, "REVOKE")).toBe(1);
    expect(r.suKien, "không được trả ACL khi không rõ DROP đã commit").not.toContain("TRA_ACL");
    expect(r.aclCuoi).toBe("DA_REVOKE");
    expect(readFileSync(r.tepDangDo, "utf8")).toContain("che_do=revoke");
    expect(r.stderr).toContain("SET datacl"); // lệnh mở tay
  });

  it.each([
    ["plain (.sql.gz)", "gzip" as const],
    ["custom (.dump)", "custom" as const],
  ])("NOLOGIN (đích postgres), %s: dấu chốt DROP mã 2 ⇒ giữ NOLOGIN, in lệnh LOGIN tay", async (_ten, dinhDang) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang, db: "postgres", kichBan: { dauChotRcO: { nhan: "DROP", rc: 2 } } });
    expect(r.status, r.stderr).toBe(2);
    expectGiuKhoaODrop(r);
    expect(dem(r, "NOLOGIN")).toBe(1);
    expect(r.suKien).not.toContain("LOGIN");
    expect(r.loginCuoi).toBe("f");
    expect(readFileSync(r.tepDangDo, "utf8")).toContain("che_do=nologin");
    expect(r.stderr).toContain("ALTER ROLE hogikids LOGIN;");
  });

  it("psql giả TỰ thoát mã 2 (không qua tiêm dấu chốt) ⇒ cũng giữ khoá", async () => {
    // Vỏ dấu chốt thật mang mã 2 của lệnh bên trong — cùng đường như psql thật mất kết nối giữa câu.
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { loiKhi: ["DROP"], maLoi: 2 } });
    expect(r.status, r.stderr).toBe(2);
    expectGiuKhoaODrop(r);
    expect(r.suKien).not.toContain("TRA_ACL");
  });

  // Fail-closed: chỉ mã ĐÃ BIẾT CHẮC rollback (1) mới mở lại. Mã 3 bị đổi thành 1 ở mã thoát (mã riêng của
  // script) — nhưng quyết định phải dựa trên mã GỐC trong container, không phải mã đã đổi.
  it.each([3, 127])("dấu chốt DROP mã %i (không phải kết cục đã biết của psql -c) ⇒ giữ khoá", async (rc) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { dauChotRcO: { nhan: "DROP", rc } } });
    expectGiuKhoaODrop(r);
    expect(r.status, "không mượn mã riêng 3").not.toBe(3);
    expect(r.suKien).not.toContain("TRA_ACL");
  });

  it.each([
    ["REVOKE (DB nháp)", DB_NHAP],
    ["NOLOGIN (postgres)", "postgres"],
  ])("%s: dấu chốt DROP mã 1 (lỗi SQL, cổng từ chối ⇒ rollback) ⇒ vẫn mở lại như cũ", async (_ten, db) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db, kichBan: { aclBanDau: ACL_CO_GRANT, dauChotRcO: { nhan: "DROP", rc: 1 } } });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("schema CÒN NGUYÊN");
    expect(r.stderr).toContain("✓ Đã mở lại");
    expect(r.tepDangDoConKhong).toBe(false);
    if (db === "postgres") {
      expect(dem(r, "LOGIN")).toBe(1);
      expect(r.loginCuoi).toBe("t");
    } else {
      expect(dem(r, "TRA_ACL")).toBe(1);
      expect(r.aclCuoi).toBe(ACL_CO_GRANT);
    }
  });
});

describe("mở lại NOLOGIN phải đọc lại rolcanlogin = t trước khi xoá tệp đánh dấu", () => {
  /** Câu mở không có hiệu lực / đọc lại lỗi ⇒ giữ tệp, in lệnh mở tay, không "✓ Đã mở lại", thoát ≠ 0. */
  function expectMoLaiKhongXacNhan(r: KetQuaChay): void {
    expect(r.status, r.stderr).not.toBe(0);
    expect(dem(r, "LOGIN")).toBe(1);
    expect(dem(r, "DOC_LOGIN_SAU_MO"), "phải đọc lại SAU câu mở").toBe(1);
    expect(r.suKien.indexOf("DOC_LOGIN_SAU_MO")).toBeGreaterThan(r.suKien.indexOf("LOGIN"));
    expect(r.tepDangDoConKhong, "chưa xác nhận mở ⇒ giữ tệp đánh dấu").toBe(true);
    expect(r.stderr).not.toContain("✓ Đã mở lại");
    expect(r.stderr).not.toMatch(/✓ Phục hồi schema/);
    expect(r.stderr).toContain("KHÔNG mở lại được đăng nhập");
    expect(r.stderr).toContain("ALTER ROLE hogikids LOGIN;"); // lệnh mở tay
    expect(r.suKien, "luồng chính dừng trước thu hồi phiên").not.toContain("THU_HOI");
    expect(r.tepTamSot).toEqual([]);
  }

  it("ALTER ROLE … LOGIN thoát 0 nhưng rolcanlogin đọc lại = f ⇒ giữ tệp, thoát ≠ 0", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { loginKhongHieuLuc: true } });
    expectMoLaiKhongXacNhan(r);
    expect(r.loginCuoi).toBe("f");
    expect(r.stderr).toContain("rolcanlogin của 'hogikids' sau khi mở là 'f'");
  });

  it("đọc lại rolcanlogin LỖI ⇒ giữ tệp, thoát ≠ 0", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "custom", db: "postgres", kichBan: { loiKhi: ["DOC_LOGIN_SAU_MO"] } });
    expectMoLaiKhongXacNhan(r);
  });

  it("lối mở qua trap ERR (DROP lỗi SQL mã 1) cũng đọc lại: ra f ⇒ giữ tệp", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { loiKhi: ["DROP"], loginKhongHieuLuc: true } });
    expect(r.status).not.toBe(0);
    expect(dem(r, "DOC_LOGIN_SAU_MO")).toBe(1);
    expect(r.tepDangDoConKhong).toBe(true);
    expect(r.stderr).not.toContain("✓ Đã mở lại");
  });

  it("bình thường: đọc lại ra t ⇒ xoá tệp, '✓ Đã mở lại', phục hồi xong như cũ", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres" });
    expect(r.status, r.stderr).toBe(0);
    expect(dem(r, "DOC_LOGIN_SAU_MO")).toBe(1);
    expect(r.suKien.indexOf("DOC_LOGIN_SAU_MO")).toBeLessThan(r.suKien.indexOf("THU_HOI"));
    expect(r.loginCuoi).toBe("t");
    expect(r.tepDangDoConKhong).toBe(false);
    expect(r.stderr).toContain("✓ Đã mở lại");
  });
});
