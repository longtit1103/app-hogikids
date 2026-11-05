import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  chayRestoreVoiDockerGia,
  donThuMucHarness,
  RESTORE_SH,
  type KetQuaChay,
} from "../../deploy/harness/restore/chay-restore-voi-docker-gia";

/**
 * Hai bất biến của `deploy/restore.sh` (đường phục hồi thảm hoạ DB):
 *
 *  (1) Chế độ NOLOGIN (đích DB chung `postgres`): khoá phải ĐÃ CÓ HIỆU LỰC trước vùng phá huỷ. Sau
 *      `ALTER ROLE <owner> NOLOGIN`, đọc lại `rolcanlogin` phải ra đúng `f` TRƯỚC khi cắt phiên / DROP.
 *      Ra `t` (câu khoá "thành công" mà không có hiệu lực) hay đọc LỖI ⇒ dừng trước DROP, thoát ≠ 0, không
 *      "✓ Phục hồi", role về LOGIN qua đường mở lại chuẩn (ALTER … LOGIN + đọc lại `t`).
 *  (2) MỌI lệnh psql chạy `-X` — không đọc `~/.psqlrc` (vd `\set AUTOCOMMIT off` ⇒ psql thoát 0 mà KHÔNG
 *      commit). Kiểm cả lời gọi thật (harness ghi lại) lẫn cấu trúc file nguồn.
 *
 * Chạy TRỌN script với `docker` giả (harness `tests/deploy/harness/restore/`). Không Postgres/Docker thật.
 * Chứng minh đỏ trên bản cũ: `RESTORE_SH_DUOI_TEST=<thư mục tạm>/deploy/restore.sh` (chép CẢ `deploy/`) —
 * kiểm cấu trúc cũng đọc file qua đường đó.
 */
const DB_NHAP = "db_dien_tap_dr";

afterEach(() => donThuMucHarness());

const dem = (r: KetQuaChay, nhan: string) => r.suKien.filter((s) => s === nhan).length;

describe("NOLOGIN phải có hiệu lực (rolcanlogin = f) TRƯỚC khi cắt phiên / DROP", () => {
  /** Khoá chưa xác nhận ⇒ dừng trước vùng phá huỷ, mở lại qua đường chuẩn, không "✓ Phục hồi". */
  function expectDungTruocDrop(r: KetQuaChay): void {
    expect(r.status, r.stderr).not.toBe(0);
    expect(dem(r, "NOLOGIN")).toBe(1);
    expect(dem(r, "DOC_LOGIN_SAU_KHOA"), "phải đọc lại SAU câu khoá").toBe(1);
    expect(r.suKien.indexOf("DOC_LOGIN_SAU_KHOA")).toBeGreaterThan(r.suKien.indexOf("NOLOGIN"));
    for (const n of ["CAT_PHIEN", "DEM_PHIEN", "DROP", "NAP_PSQL", "NAP_PG_RESTORE", "TRA_OWNER", "CAP_QUYEN_N8N", "THU_HOI"]) {
      expect(r.suKien, `không được tới ${n}`).not.toContain(n);
    }
    expect(r.stderr).toContain("DỪNG TRƯỚC khi cắt phiên / dọn schema — schema CÒN NGUYÊN");
    expect(r.stderr).not.toMatch(/✓ Phục hồi schema/);
    // Đường mở lại chuẩn: ALTER … LOGIN rồi đọc lại t.
    expect(dem(r, "LOGIN")).toBe(1);
    expect(dem(r, "DOC_LOGIN_SAU_MO")).toBe(1);
    expect(r.suKien.indexOf("LOGIN")).toBeGreaterThan(r.suKien.indexOf("DOC_LOGIN_SAU_KHOA"));
    expect(r.tepTamSot).toEqual([]);
  }

  it.each([
    ["plain (.sql.gz)", "gzip" as const],
    ["custom (.dump)", "custom" as const],
  ])("%s: ALTER ROLE … NOLOGIN thoát 0 nhưng đọc lại = t ⇒ dừng trước DROP, role về LOGIN", async (_ten, dinhDang) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang, db: "postgres", kichBan: { nologinKhongHieuLuc: true } });
    expectDungTruocDrop(r);
    expect(r.stderr).toContain("vẫn là 't' (kỳ vọng f)");
    expect(r.loginCuoi).toBe("t");
    expect(r.tepDangDoConKhong, "mở lại xác nhận được ⇒ xoá tệp đánh dấu").toBe(false);
    expect(r.stderr).toContain("✓ Đã mở lại");
  });

  it.each([
    ["plain (.sql.gz)", "gzip" as const],
    ["custom (.dump)", "custom" as const],
  ])("%s: đọc lại rolcanlogin sau NOLOGIN LỖI ⇒ dừng trước DROP, mở lại qua đường chuẩn", async (_ten, dinhDang) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang, db: "postgres", kichBan: { loiKhi: ["DOC_LOGIN_SAU_KHOA"] } });
    expectDungTruocDrop(r);
    expect(r.stderr).toContain("KHÔNG đọc lại được rolcanlogin");
    expect(r.loginCuoi).toBe("t");
    expect(r.tepDangDoConKhong).toBe(false);
    expect(r.stderr).toContain("✓ Đã mở lại");
  });

  it("đọc lại sau khoá ra t VÀ câu mở cũng không xác nhận được ⇒ vẫn dừng trước DROP, giữ tệp + lệnh mở tay", async () => {
    const r = await chayRestoreVoiDockerGia({
      dinhDang: "gzip",
      db: "postgres",
      kichBan: { nologinKhongHieuLuc: true, loiKhi: ["DOC_LOGIN_SAU_MO"] },
    });
    expectDungTruocDrop(r);
    expect(r.tepDangDoConKhong, "mở chưa xác nhận ⇒ giữ tệp").toBe(true);
    expect(readFileSync(r.tepDangDo, "utf8")).toContain("che_do=nologin");
    expect(r.stderr).toContain("KHÔNG mở lại được đăng nhập");
    expect(r.stderr).toContain("ALTER ROLE hogikids LOGIN;");
  });

  // `psql_mot_cau` không qua dấu chốt: docker exec có thể thoát 0 mà stdout rỗng/rác (CLI bị ngắt). Cổng phải
  // so NGUYÊN `f` — phép thử "không phải t" sẽ cho chuỗi rỗng qua và DROP khi khoá chưa xác nhận.
  it.each([
    ["rỗng", ""],
    ["rác", "loi rac"],
    ["hoa", "F"],
  ])("đọc lại sau khoá thoát 0 nhưng ra %s ⇒ dừng trước DROP, mở lại qua đường chuẩn", async (_ten, ra) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { raDocLoginSauKhoa: ra } });
    expectDungTruocDrop(r);
    expect(r.loginCuoi).toBe("t");
    expect(r.tepDangDoConKhong).toBe(false);
    expect(r.stderr).toContain("✓ Đã mở lại");
  });

  // Đọc lại sau câu mở cũng vậy: chỉ đúng `t` mới được xoá tệp đánh dấu — phép thử "không phải f" sẽ cho
  // chuỗi rỗng qua và báo đã mở trong khi chưa biết role đăng nhập được chưa.
  it.each([
    ["rỗng", ""],
    ["rác", "loi rac"],
  ])("lượt thành công nhưng đọc lại sau câu mở thoát 0 mà ra %s ⇒ GIỮ tệp đánh dấu, in lệnh mở tay", async (_ten, ra) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { raDocLoginSauMo: ra } });
    expect(r.status, r.stderr).not.toBe(0);
    expect(dem(r, "DOC_LOGIN_SAU_MO")).toBe(1);
    expect(r.tepDangDoConKhong, "mở chưa xác nhận ⇒ giữ tệp").toBe(true);
    expect(r.stderr).not.toContain("✓ Đã mở lại");
    expect(r.stderr).toContain("ALTER ROLE hogikids LOGIN;");
  });

  it("bình thường: đọc lại ra f ⇒ cắt phiên → DROP → … → phục hồi xong như cũ", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres" });
    expect(r.status, r.stderr).toBe(0);
    const i = (n: string) => r.suKien.indexOf(n);
    expect(dem(r, "DOC_LOGIN_SAU_KHOA")).toBe(1);
    expect(i("NOLOGIN")).toBeLessThan(i("DOC_LOGIN_SAU_KHOA"));
    expect(i("DOC_LOGIN_SAU_KHOA")).toBeLessThan(i("CAT_PHIEN"));
    expect(i("CAT_PHIEN")).toBeLessThan(i("DROP"));
    expect(r.loginCuoi).toBe("t");
    expect(r.tepDangDoConKhong).toBe(false);
    expect(r.stderr).toMatch(/✓ Phục hồi schema 'app' của 'postgres' xong/);
  });

  it("chế độ REVOKE (DB nháp) không đụng rolcanlogin", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP });
    expect(r.status, r.stderr).toBe(0);
    for (const n of ["DOC_LOGIN", "DOC_LOGIN_SAU_KHOA", "NOLOGIN", "LOGIN"]) expect(r.suKien).not.toContain(n);
  });
});

describe("mọi lệnh psql chạy -X (không đọc ~/.psqlrc)", () => {
  const goiPsql = (r: KetQuaChay) => r.loiGoi.filter((g) => /(^|\s)psql(\s|$)/.test(g));
  const coX = (g: string) => /(^|\s)psql\s.*\s-X(\s|$)/.test(g);

  it.each([
    ["custom, REVOKE (DB nháp)", "custom" as const, DB_NHAP, ["DROP", "NAP_PG_RESTORE", "REVOKE", "TRA_ACL"]],
    ["plain, REVOKE (DB nháp)", "gzip" as const, DB_NHAP, ["DROP", "NAP_PSQL", "REVOKE", "TRA_ACL"]],
    ["custom, NOLOGIN (postgres)", "custom" as const, "postgres", ["DROP", "NAP_PG_RESTORE", "NOLOGIN", "LOGIN"]],
    ["plain, NOLOGIN (postgres)", "gzip" as const, "postgres", ["DROP", "NAP_PSQL", "NOLOGIN", "LOGIN"]],
  ])("%s: mọi lời gọi docker exec … psql đều có -X", async (_ten, dinhDang, db, nhanPhaiCo) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang, db });
    expect(r.status, r.stderr).toBe(0);
    // Kịch bản phải thật sự đi qua các bước cần soi (DROP, nạp, trả owner/quyền, thu hồi phiên, khoá/mở).
    for (const n of [...nhanPhaiCo, "XEM_KHOA_VIEC_NANG", "CAT_PHIEN", "DEM_PHIEN", "TRA_OWNER", "CAP_QUYEN_N8N", "KIEM_COT", "THU_HOI"]) {
      expect(r.suKien, `kịch bản thiếu bước ${n}`).toContain(n);
    }
    const ds = goiPsql(r);
    expect(ds.length).toBeGreaterThan(5);
    expect(ds.filter((g) => !coX(g)), "lời gọi psql thiếu -X").toEqual([]);
  });

  it("cấu trúc: mọi dòng gọi psql trong restore.sh (kể cả lệnh in cho người vận hành) đều có -X", () => {
    const ma = readFileSync(RESTORE_SH, "utf8");
    const dong = ma
      .split("\n")
      .map((s, i) => ({ so: i + 1, s }))
      .filter(({ s }) => !/^\s*#/.test(s))
      .filter(({ s }) => /(^|[\s"'(])psql\s+-/.test(s));
    // Lưới không rỗng: DROP, 2 khối trả quyền, nạp plain, thu hồi phiên, psql_mot_cau, kiểm cột, lệnh in tay…
    expect(dong.length).toBeGreaterThanOrEqual(10);
    const thieu = dong.filter(({ s }) => !/\spsql\s.*\s-X(\s|$)/.test(` ${s}`));
    expect(thieu.map(({ so, s }) => `${so}: ${s.trim()}`), "dòng gọi psql thiếu -X").toEqual([]);
  });
});
