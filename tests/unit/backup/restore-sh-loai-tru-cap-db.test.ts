import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  chayRestoreVoiDockerGia,
  donThuMucHarness,
  RESTORE_SH,
  type KetQuaChay,
} from "../../deploy/harness/restore/chay-restore-voi-docker-gia";

/**
 * `deploy/restore.sh` LOẠI TRỪ phiên role app suốt lúc thay schema. Lối thoát TRƯỚC khi DROP commit (kể
 * cả chính lệnh DROP lỗi thường — một transaction, rollback) ⇒ mở lại. Lối thoát SAU DROP (lỗi nạp, lỗi
 * trả quyền, bị ngắt ở bất kỳ bước nào tới hết hậu kỳ quyền) ⇒ FAIL-CLOSED: giữ khoá + tệp đánh dấu.
 *
 * Chạy TRỌN script với `docker` giả (harness `tests/deploy/harness/restore/`): không Postgres/Docker
 * thật nào bị chạm; stub ghi lại từng lời gọi (nhãn sự kiện + toàn văn SQL) và giữ một máy trạng thái
 * (`datacl` của DB đích, `rolcanlogin` của role app, số phiên còn sống).
 *
 * Hai chế độ (đo prod 28/10):
 *  - Đích ≠ `postgres` (DB nháp diễn tập DR): REVOKE CONNECT cấp DATABASE, trả lại ĐÚNG `datacl` đã lưu.
 *    KHÔNG `ALTER ROLE` — role là đối tượng toàn cluster, NOLOGIN lúc diễn tập là đánh sập prod.
 *  - Đích = `postgres` (DB chung Supabase): CẤM REVOKE PUBLIC (PostgREST/storage nối nhờ PUBLIC) ⇒ app
 *    phải dừng sẵn + NOLOGIN role app.
 */
const DB_NHAP = "db_dien_tap_dr";
const ACL_CO_GRANT = "{=Tc/supabase_admin,supabase_admin=CTc/supabase_admin,hogikids=c/supabase_admin}";
const MA_CHUA_XONG = 3;

afterEach(() => donThuMucHarness());

/** Vị trí ĐẦU TIÊN của nhãn trong chuỗi sự kiện; -1 nếu không có. */
const viTri = (r: KetQuaChay, nhan: string) => r.suKien.indexOf(nhan);
const dem = (r: KetQuaChay, nhan: string) => r.suKien.filter((s) => s === nhan).length;

/** Chuỗi nhãn phải xuất hiện ĐỦ và ĐÚNG thứ tự (cho phép nhãn khác chen giữa). */
function expectThuTu(r: KetQuaChay, nhan: string[]): void {
  const pos = nhan.map((n) => viTri(r, n));
  expect(pos.every((p) => p >= 0), `thiếu nhãn trong ${r.suKien.join(" ")}`).toBe(true);
  expect([...pos].sort((a, b) => a - b), `sai thứ tự: ${r.suKien.join(" ")}`).toEqual(pos);
}

/** Bất biến chung của chế độ REVOKE ở MỌI lối thoát sau khi đã khoá. */
function expectDaMoLaiRevoke(r: KetQuaChay, aclBanDau: string): void {
  expect(dem(r, "REVOKE")).toBe(1);
  expect(dem(r, "TRA_ACL"), "mở lại đúng MỘT lần — không thiếu, không lặp").toBe(1);
  expect(viTri(r, "TRA_ACL")).toBeGreaterThan(viTri(r, "REVOKE"));
  expect(r.aclCuoi, "datacl trả về đúng chuỗi đã lưu").toBe(aclBanDau);
  expect(r.tepDangDoConKhong, "mở xong phải xoá tệp đánh dấu").toBe(false);
  expect(r.suKien).not.toContain("NOLOGIN");
  expect(r.tepTamSot, "file tạm phải được dọn ở mọi lối thoát").toEqual([]);
}

/** Bất biến chung của chế độ NOLOGIN ở MỌI lối thoát sau khi đã khoá. */
function expectDaMoLaiNologin(r: KetQuaChay): void {
  expect(dem(r, "NOLOGIN")).toBe(1);
  expect(dem(r, "LOGIN")).toBe(1);
  expect(viTri(r, "LOGIN")).toBeGreaterThan(viTri(r, "NOLOGIN"));
  expect(r.loginCuoi).toBe("t");
  expect(r.tepDangDoConKhong).toBe(false);
  expect(r.tepTamSot).toEqual([]);
}

describe("restore.sh — đích ≠ postgres: REVOKE CONNECT cấp DATABASE", () => {
  it("thành công: khoá sát trước DROP, mở ngay sau hậu kỳ quyền, TRƯỚC thu hồi phiên; datacl NULL trả về NULL", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP });
    expect(r.status, r.stderr).toBe(0);
    expectThuTu(r, [
      "XEM_KHOA_VIEC_NANG",
      "DOC_ACL",
      "REVOKE",
      "KIEM_QUYEN",
      "CAT_PHIEN",
      "DEM_PHIEN",
      "DROP",
      "NAP_PSQL",
      "TRA_OWNER",
      "CAP_QUYEN_N8N",
      "TRA_ACL",
      "KIEM_COT",
      "THU_HOI",
    ]);
    expectDaMoLaiRevoke(r, "NULL");
    expect(r.suKien).not.toContain("PS");

    // So CHUỖI SQL thật gửi đi — không chỉ nhãn.
    expect(r.loiGoi).toContain(
      `exec supabase-db psql -U supabase_admin -d ${DB_NHAP} -X -tA -v ON_ERROR_STOP=1 -c REVOKE CONNECT ON DATABASE "${DB_NHAP}" FROM PUBLIC, hogikids;`,
    );
    expect(r.loiGoi).toContain(
      `exec supabase-db psql -U supabase_admin -d ${DB_NHAP} -X -tA -v ON_ERROR_STOP=1 -c UPDATE pg_catalog.pg_database SET datacl = NULL WHERE datname = '${DB_NHAP}';`,
    );
    const cat = r.loiGoi.find((g) => g.includes("pg_terminate_backend"));
    expect(cat).toContain(`pg_terminate_backend(pid, 5000)`);
    expect(cat).toContain(`WHERE datname = '${DB_NHAP}' AND usename = 'hogikids'`);
    // Không một lời gọi nào chạm DB `postgres` hay đụng role (đối tượng toàn cluster).
    expect(r.loiGoi.join("\n")).not.toMatch(/-d postgres\b/);
    expect(r.loiGoi.join("\n")).not.toMatch(/ALTER ROLE/);
    expect(r.stderr).toMatch(/✓ Phục hồi schema 'app' của 'db_dien_tap_dr' xong/);
  });

  it("datacl có grant sẵn ⇒ trả lại ĐÚNG chuỗi nguyên văn (đường custom)", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "custom", db: DB_NHAP, kichBan: { aclBanDau: ACL_CO_GRANT } });
    expect(r.status, r.stderr).toBe(0);
    expectThuTu(r, ["DOC_TOC", "BUNG_DUMP", "REVOKE", "DROP", "NAP_PG_RESTORE", "TRA_OWNER", "TRA_ACL", "THU_HOI"]);
    expectDaMoLaiRevoke(r, ACL_CO_GRANT);
    expect(r.loiGoi.find((g) => g.includes("SET datacl"))).toContain(
      `SET datacl = '${ACL_CO_GRANT}'::aclitem[] WHERE datname = '${DB_NHAP}';`,
    );
  });

  it("phiên chưa chết ngay ⇒ cắt lại + đếm lại tới 0 rồi mới DROP", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { phienConLai: 2 }, hanChoLan: 5 });
    expect(r.status, r.stderr).toBe(0);
    expect(dem(r, "DEM_PHIEN")).toBe(3);
    expect(dem(r, "CAT_PHIEN")).toBe(3);
    expect(viTri(r, "DROP")).toBeGreaterThan(r.suKien.lastIndexOf("DEM_PHIEN"));
  });

  describe("lối thoát TRƯỚC khoá — không khoá thì không mở", () => {
    it.each([
      ["bung dump lỗi (guard file đường custom)", { dinhDang: "custom" as const, kichBan: { loiKhi: ["BUNG_DUMP"] } }],
      ["guard SQL plain từ chối (đụng schema hệ thống)", { dinhDang: "gzip" as const, sqlGzip: "CREATE SCHEMA app;\nDELETE FROM auth.users;\n" }],
      ["xem trước khoá việc nặng lỗi / đang giữ", { dinhDang: "gzip" as const, kichBan: { loiKhi: ["XEM_KHOA_VIEC_NANG"] } }],
      ["không đọc được datacl (DB không tồn tại)", { dinhDang: "gzip" as const, kichBan: { aclBanDau: "" } }],
    ])("%s", async (_ten, o) => {
      const r = await chayRestoreVoiDockerGia({ db: DB_NHAP, ...o });
      expect(r.status).toBe(1);
      for (const n of ["REVOKE", "TRA_ACL", "DROP", "NOLOGIN", "LOGIN"]) expect(r.suKien).not.toContain(n);
      expect(r.tepDangDoConKhong).toBe(false);
      expect(r.tepTamSot).toEqual([]);
    });
  });

  describe("lối thoát SAU khoá nhưng TRƯỚC khi DROP commit — mở lại đúng một lần, trả đúng ACL", () => {
    it.each([
      // Cổng + DROP + CREATE trong MỘT `psql -c` ⇒ lỗi = rollback, schema còn nguyên ⇒ mở như lỗi trước DROP.
      ["DROP lỗi (transaction rollback)", "gzip" as const, "DROP"],
      ["cắt phiên lỗi", "gzip" as const, "CAT_PHIEN"],
      // Lỗi nằm TRONG `$(…)`: subshell thừa hưởng trap ERR (set -E) — không chặn theo BASH_SUBSHELL là mở hai lần.
      ["đếm phiên lỗi (trong command substitution)", "gzip" as const, "DEM_PHIEN"],
      ["kiểm quyền sau REVOKE lỗi (trong command substitution)", "gzip" as const, "KIEM_QUYEN"],
    ])("%s", async (_ten, dinhDang, nhanLoi) => {
      const r = await chayRestoreVoiDockerGia({ dinhDang, db: DB_NHAP, kichBan: { aclBanDau: ACL_CO_GRANT, loiKhi: [nhanLoi] } });
      expect(r.status).not.toBe(0);
      expect(viTri(r, "TRA_ACL")).toBeGreaterThan(viTri(r, nhanLoi));
      expectDaMoLaiRevoke(r, ACL_CO_GRANT);
      expect(r.suKien).not.toContain("THU_HOI");
      expect(r.stderr).not.toMatch(/✓ Phục hồi schema/);
    });

    it("phiên không chết trong hạn ⇒ dừng TRƯỚC DROP, mở lại", async () => {
      const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { phienConLai: 99 }, hanChoLan: 3 });
      expect(r.status).toBe(1);
      expect(dem(r, "DEM_PHIEN")).toBe(3);
      expect(r.suKien).not.toContain("DROP");
      expectDaMoLaiRevoke(r, "NULL");
      expect(r.stderr).toMatch(/vẫn còn '1' phiên 'hogikids'/);
    });

    it("REVOKE xong mà quyền hiệu lực vẫn còn (grant từ role khác) ⇒ dừng TRƯỚC cắt phiên, mở lại", async () => {
      const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { conQuyenSauRevoke: true } });
      expect(r.status).toBe(1);
      expect(r.suKien).not.toContain("CAT_PHIEN");
      expect(r.suKien).not.toContain("DROP");
      expectDaMoLaiRevoke(r, "NULL");
    });

    it("dump đời trước phân quyền (mã 3) ⇒ đã mở TRƯỚC lối thoát — hướng dẫn migrate deploy bằng role app chạy được", async () => {
      const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { cotSessionEpoch: "0" } });
      expect(r.status, r.stderr).toBe(MA_CHUA_XONG);
      expectThuTu(r, ["NAP_PSQL", "TRA_OWNER", "TRA_ACL", "KIEM_COT"]);
      expectDaMoLaiRevoke(r, "NULL");
      expect(r.suKien).not.toContain("THU_HOI");
      expect(r.stderr).toContain("prisma migrate deploy");
      expect(r.stderr.indexOf("✓ Đã mở lại đăng nhập")).toBeLessThan(r.stderr.indexOf("CHƯA XONG"));
    });

    it("SIGTERM SAU khoá nhưng TRƯỚC DROP (đang cắt phiên) ⇒ trap mở lại, dọn file tạm, thoát 143", async () => {
      const r = await chayRestoreVoiDockerGia({
        dinhDang: "gzip",
        db: DB_NHAP,
        kichBan: { aclBanDau: ACL_CO_GRANT, nguO: "CAT_PHIEN" },
        guiTermKhiStubNgu: true,
      });
      expect(r.status).toBe(143);
      expect(r.suKien).not.toContain("DROP");
      expectDaMoLaiRevoke(r, ACL_CO_GRANT);
    });

    it("chính bước mở lại lỗi ⇒ thoát ≠ 0, in lệnh mở tay, GIỮ tệp đánh dấu, không thử lại vòng vô hạn", async () => {
      const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { loiKhi: ["TRA_ACL"] } });
      expect(r.status).not.toBe(0);
      expect(dem(r, "TRA_ACL")).toBe(1);
      expect(r.suKien).not.toContain("THU_HOI");
      expect(r.tepDangDoConKhong).toBe(true);
      const tep = readFileSync(r.tepDangDo, "utf8");
      expect(tep).toContain(`db=${DB_NHAP}`);
      expect(tep).toContain("che_do=revoke");
      expect(tep).toContain("acl_da_luu=NULL");
      expect(tep).toContain(`UPDATE pg_catalog.pg_database SET datacl = NULL WHERE datname = '${DB_NHAP}';`);
      expect(r.stderr).toMatch(/KHÔNG mở lại được đăng nhập role 'hogikids'/);
      expect(r.stderr).toContain(`docker exec -i supabase-db psql -U supabase_admin -d ${DB_NHAP} -X -v ON_ERROR_STOP=1 <<'SQL'`);
      expect(r.stderr).toContain("deploy/thu-hoi-phien-sau-phuc-hoi.sql");
    });
  });

  /**
   * SAU khi DROP đã commit, schema có thể DỞ ở mọi lối thoát ⇒ KHÔNG mở lại đăng nhập, GIỮ tệp đánh dấu
   * (lý do + bước dở), in cách kiểm schema + lệnh mở tay. Bị ngắt: `docker exec` KHÔNG chuyển tín hiệu
   * vào container nên pg_restore/psql/ALTER … OWNER có thể vẫn chạy. Lỗi thường: nạp/trả quyền dở.
   */
  describe("SAU khi đã DROP (ngắt hoặc lỗi bất kỳ tới hết hậu kỳ quyền) — GIỮ khoá + tệp đánh dấu", () => {
    function expectGiuKhoaRevoke(r: KetQuaChay, dauTep: "bi_ngat_giua_nap=" | "loi_sau_drop=", buoc: string): void {
      expect(dem(r, "REVOKE")).toBe(1);
      expect(r.suKien, "không được mở lại khi schema có thể đang dở").not.toContain("TRA_ACL");
      expect(r.aclCuoi).toBe("DA_REVOKE");
      expect(r.tepDangDoConKhong, "giữ tệp đánh dấu để lượt sau dừng ở preflight").toBe(true);
      const tep = readFileSync(r.tepDangDo, "utf8");
      expect(tep).toContain("che_do=revoke");
      expect(tep).toContain(dauTep);
      expect(tep).toContain(`buoc_do=${buoc}`);
      expect(r.stderr).toContain("KHÔNG mở lại đăng nhập");
      expect(r.stderr).toContain("ps aux");
      expect(r.stderr).toContain("pg_stat_activity");
      expect(r.stderr).toContain("pg_tables WHERE schemaname = 'app'"); // kiểm schema dở tới đâu
      expect(r.stderr).toContain("SET datacl"); // lệnh mở tay
      expect(r.stderr).toContain("Chạy lại restore.sh từ đầu");
      expect(r.suKien).not.toContain("THU_HOI");
      expect(r.stderr).not.toMatch(/✓ Phục hồi schema/);
      expect(r.tepTamSot).toEqual([]);
    }

    it.each([
      ["psql nạp SQL plain", "gzip" as const, "NAP_PSQL"],
      ["pg_restore nạp custom", "custom" as const, "NAP_PG_RESTORE"],
      ["đang DROP", "gzip" as const, "DROP"],
    ])("SIGTERM giữa lúc %s ⇒ thoát 143, giữ khoá", async (_ten, dinhDang, nhan) => {
      const r = await chayRestoreVoiDockerGia({
        dinhDang,
        db: DB_NHAP,
        kichBan: { aclBanDau: ACL_CO_GRANT, nguO: nhan },
        guiTermKhiStubNgu: true,
      });
      expect(r.status).toBe(143);
      expectGiuKhoaRevoke(r, "bi_ngat_giua_nap=", nhan === "DROP" ? "drop" : "nap");
      expect(r.suKien).not.toContain("TRA_OWNER");
    });

    it("SIGTERM giữa hậu kỳ trả quyền (`reassign_owner_scoped`) ⇒ thoát 143, giữ khoá", async () => {
      const r = await chayRestoreVoiDockerGia({
        dinhDang: "gzip",
        db: DB_NHAP,
        kichBan: { aclBanDau: ACL_CO_GRANT, nguO: "TRA_OWNER" },
        guiTermKhiStubNgu: true,
      });
      expect(r.status).toBe(143);
      expectGiuKhoaRevoke(r, "bi_ngat_giua_nap=", "tra_quyen");
    });

    it("lệnh nạp chết vì tín hiệu (mã 130 — Ctrl-C tới cả nhóm tiến trình) ⇒ giữ khoá như bị ngắt", async () => {
      const r = await chayRestoreVoiDockerGia({
        dinhDang: "gzip",
        db: DB_NHAP,
        kichBan: { aclBanDau: ACL_CO_GRANT, loiKhi: ["NAP_PSQL"], maLoi: 130 },
      });
      expect(r.status).toBe(130);
      expectGiuKhoaRevoke(r, "bi_ngat_giua_nap=", "nap");
    });

    it.each([
      ["psql nạp SQL plain tự lỗi (mã 1 — schema nạp dở)", "gzip" as const, "NAP_PSQL", "nap"],
      ["pg_restore nạp custom tự lỗi (mã 1 — schema nạp dở)", "custom" as const, "NAP_PG_RESTORE", "nap"],
      ["hậu kỳ trả owner lỗi (role app thiếu quyền một phần)", "gzip" as const, "TRA_OWNER", "tra_quyen"],
      ["hậu kỳ cấp quyền n8n lỗi", "gzip" as const, "CAP_QUYEN_N8N", "tra_quyen"],
    ])("%s ⇒ thoát ≠ 0, GIỮ khoá + tệp đánh dấu ghi lý do", async (_ten, dinhDang, nhanLoi, buoc) => {
      const r = await chayRestoreVoiDockerGia({ dinhDang, db: DB_NHAP, kichBan: { aclBanDau: ACL_CO_GRANT, loiKhi: [nhanLoi] } });
      expect(r.status).not.toBe(0);
      expectGiuKhoaRevoke(r, "loi_sau_drop=", buoc);
      expect(readFileSync(r.tepDangDo, "utf8")).toMatch(/loi_sau_drop=.* ma=\d+ kieu=loi buoc_do=/);
      expect(r.stderr).toMatch(new RegExp(`Lỗi \\(mã \\d+\\) ở bước '${buoc}' SAU khi đã DROP`));
    });
  });

  it("preflight: còn tệp đánh dấu của lượt trước ⇒ dừng, KHÔNG gọi docker lần nào", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, tepDangDoCoSan: "che_do=revoke\ndb=db_cu\n" });
    expect(r.status).toBe(1);
    expect(r.suKien).toEqual([]);
    expect(r.stderr).toMatch(/còn tệp đánh dấu/);
    expect(r.stderr).toContain("db=db_cu");
    expect(r.tepDangDoConKhong, "không tự xoá tệp của lượt khác").toBe(true);
  });
});

describe("restore.sh — đích = postgres (DB chung Supabase): NOLOGIN, CẤM REVOKE PUBLIC", () => {
  it("thành công: preflight app đã dừng → NOLOGIN → cắt phiên → … → LOGIN trước thu hồi phiên; không đụng datacl", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres" });
    expect(r.status, r.stderr).toBe(0);
    expectThuTu(r, [
      "PS",
      "XEM_KHOA_VIEC_NANG",
      "DOC_LOGIN",
      "NOLOGIN",
      "CAT_PHIEN",
      "DEM_PHIEN",
      "DROP",
      "NAP_PSQL",
      "TRA_OWNER",
      "CAP_QUYEN_N8N",
      "LOGIN",
      "KIEM_COT",
      "THU_HOI",
    ]);
    expectDaMoLaiNologin(r);
    for (const n of ["DOC_ACL", "REVOKE", "TRA_ACL"]) expect(r.suKien).not.toContain(n);
    const tatCa = r.loiGoi.join("\n");
    expect(tatCa).not.toMatch(/REVOKE/);
    expect(tatCa).not.toMatch(/pg_database/);
    expect(r.loiGoi).toContain("exec supabase-db psql -U supabase_admin -d postgres -X -tA -v ON_ERROR_STOP=1 -c ALTER ROLE hogikids NOLOGIN;");
    expect(r.loiGoi).toContain("exec supabase-db psql -U supabase_admin -d postgres -X -tA -v ON_ERROR_STOP=1 -c ALTER ROLE hogikids LOGIN;");
    expect(r.loiGoi.find((g) => g.includes("pg_terminate_backend"))).toContain(
      "WHERE datname = 'postgres' AND usename = 'hogikids'",
    );
  });

  it("container app ĐANG CHẠY ⇒ dừng ở preflight, không exec lệnh DB nào", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { containerDangChay: ["hogikids-app"] } });
    expect(r.status).toBe(1);
    expect(r.suKien).toEqual(["PS"]);
    expect(r.stderr).toContain("docker compose stop app");
  });

  it("docker ps lỗi ⇒ fail-closed, không exec lệnh DB nào", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { loiKhi: ["PS"] } });
    expect(r.status).toBe(1);
    expect(r.suKien).toEqual(["PS"]);
  });

  it("role đã NOLOGIN sẵn mà không có tệp đánh dấu ⇒ từ chối, KHÔNG tự mở (không biết trạng thái gốc)", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { loginBanDau: "f" } });
    expect(r.status).toBe(1);
    expect(r.suKien).not.toContain("NOLOGIN");
    expect(r.suKien).not.toContain("LOGIN");
    expect(r.suKien).not.toContain("DROP");
    expect(r.loginCuoi).toBe("f");
  });

  it("DROP lỗi (transaction rollback, schema còn nguyên) ⇒ LOGIN đúng một lần", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { loiKhi: ["DROP"] } });
    expect(r.status).not.toBe(0);
    expect(viTri(r, "LOGIN")).toBeGreaterThan(viTri(r, "DROP"));
    expectDaMoLaiNologin(r);
  });

  it("pg_restore nạp lỗi (mã 1, đầy đĩa…) SAU DROP ⇒ GIỮ NOLOGIN + tệp đánh dấu ghi lý do, in lệnh LOGIN tay", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "custom", db: "postgres", kichBan: { loiKhi: ["NAP_PG_RESTORE"] } });
    expect(r.status).not.toBe(0);
    expect(dem(r, "NOLOGIN")).toBe(1);
    expect(r.suKien).not.toContain("LOGIN");
    expect(r.loginCuoi).toBe("f");
    expect(r.tepDangDoConKhong).toBe(true);
    expect(readFileSync(r.tepDangDo, "utf8")).toMatch(/loi_sau_drop=.* buoc_do=nap/);
    expect(r.stderr).toContain("ALTER ROLE hogikids LOGIN;");
    expect(r.stderr).toContain("Schema đang DỞ — đừng bật app.");
    expect(r.tepTamSot).toEqual([]);
  });

  it("mã 3 ⇒ LOGIN TRƯỚC lối thoát", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { cotSessionEpoch: "0" } });
    expect(r.status, r.stderr).toBe(MA_CHUA_XONG);
    expect(viTri(r, "LOGIN")).toBeLessThan(viTri(r, "KIEM_COT"));
    expectDaMoLaiNologin(r);
  });

  it("SIGTERM TRƯỚC DROP (đang cắt phiên) ⇒ LOGIN lại, thoát 143", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { nguO: "CAT_PHIEN" }, guiTermKhiStubNgu: true });
    expect(r.status).toBe(143);
    expect(r.suKien).not.toContain("DROP");
    expectDaMoLaiNologin(r);
  });

  it("SIGTERM giữa lúc nạp ⇒ GIỮ NOLOGIN + tệp đánh dấu, in cách kiểm + lệnh mở tay, thoát 143", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", kichBan: { nguO: "NAP_PSQL" }, guiTermKhiStubNgu: true });
    expect(r.status).toBe(143);
    expect(dem(r, "NOLOGIN")).toBe(1);
    expect(r.suKien).not.toContain("LOGIN");
    expect(r.loginCuoi).toBe("f");
    expect(r.tepDangDoConKhong).toBe(true);
    expect(readFileSync(r.tepDangDo, "utf8")).toContain("bi_ngat_giua_nap=");
    expect(r.stderr).toContain("ALTER ROLE hogikids LOGIN;");
    expect(r.stderr).toContain("ps aux");
    expect(r.tepTamSot).toEqual([]);
  });

  it("diễn tập trên stack song song (`CONTAINER_DB_DICH=supabase-db-drill`): kiểm app CÙNG hậu tố, mọi lệnh vào container drill", async () => {
    // App prod `hogikids-app` đang chạy là bình thường lúc diễn tập — chỉ app drill phải dừng.
    const ok = await chayRestoreVoiDockerGia({
      dinhDang: "gzip",
      db: "postgres",
      containerDb: "supabase-db-drill",
      kichBan: { containerDangChay: ["hogikids-app"] },
    });
    expect(ok.status, ok.stderr).toBe(0);
    const exec = ok.loiGoi.filter((g) => g.startsWith("exec "));
    expect(exec.length).toBeGreaterThan(0);
    expect(exec.every((g) => /^exec (-i )?supabase-db-drill /.test(g))).toBe(true);

    const chan = await chayRestoreVoiDockerGia({
      dinhDang: "gzip",
      db: "postgres",
      containerDb: "supabase-db-drill",
      kichBan: { containerDangChay: ["hogikids-app-drill"] },
    });
    expect(chan.status).toBe(1);
    expect(chan.suKien).toEqual(["PS"]);
  });

  it("container đích lạ ⇒ từ chối trước mọi lời gọi docker", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: "postgres", containerDb: "postgres-cua-ai-do" });
    expect(r.status).toBe(1);
    expect(r.suKien).toEqual([]);
  });
});

describe("restore.sh — cấu trúc trap và vị trí khoá/mở trong main", () => {
  const sh = readFileSync(RESTORE_SH, "utf8");
  const ma = sh
    .split("\n")
    .filter((d) => !d.trimStart().startsWith("#"))
    .join("\n");
  const than = ma.slice(ma.indexOf("\nmain() {"));

  it("ĐÚNG MỘT trap EXIT (gộp mở lại + dọn file tạm), không chỗ nào gỡ/đè nó", () => {
    expect(ma.match(/\btrap\b[^\n]*\bEXIT\b/g)).toEqual(["trap 'don_dep_khi_thoat' EXIT"]);
    expect(ma).not.toMatch(/trap - EXIT/);
  });

  it("trap ERR gọi khi_loi (mở lại trừ khi đang trong vùng phá huỷ) với set -E", () => {
    expect(than).toContain("set -E");
    expect(than).toContain("trap 'khi_loi $?' ERR");
    expect(than.indexOf("set -E")).toBeLessThan(than.indexOf("trap 'khi_loi $?' ERR"));
    expect(than).toContain("trap 'bi_ngat 130' INT");
    expect(than).toContain("trap 'bi_ngat 143' TERM");
  });

  it("vùng phá huỷ: drop ngay trước DROP, nap ngay sau DROP, chỉ ra khỏi vùng SAU hậu kỳ trả quyền", () => {
    const ds = than.split("\n").map((d) => d.trim());
    const viTriDrop = ds.flatMap((d, i) => (d.startsWith("drop_schema_dich ") ? [i] : []));
    expect(viTriDrop.length).toBe(2);
    for (const i of viTriDrop) {
      expect(ds[i - 1]).toBe("BUOC_PHA_HUY=drop");
      expect(ds[i + 1]).toBe("BUOC_PHA_HUY=nap");
    }
    const iHauKy = ds.indexOf('reassign_owner_scoped "$DB" "$SCHEMA"');
    expect(ds[iHauKy - 1]).toBe("BUOC_PHA_HUY=tra_quyen");
    expect(ds[iHauKy + 1]).toBe('BUOC_PHA_HUY=""');
    // Không chỗ nào khác ra khỏi vùng giữa DROP và hậu kỳ (ra sớm là mở lại trên schema dở).
    const ra = ds.flatMap((d, i) => (d === 'BUOC_PHA_HUY=""' ? [i] : []));
    expect(ra).toEqual([iHauKy + 1]);
  });

  it("mỗi lời gọi drop_schema_dich trong main có khoa_dang_nhap_role_app NGAY TRƯỚC, sau mọi guard file", () => {
    const goiDrop = [...than.matchAll(/drop_schema_dich "\$DB"/g)].map((m) => m.index as number);
    expect(goiDrop).toHaveLength(2);
    // Lời gọi thứ nhất thuộc nhánh custom (guard soi SQL bung), thứ hai thuộc nhánh plain.
    const guardCuaNhanh = ['assert_sql_only_schema "$SCHEMA" "$sql_bung"', 'assert_sql_only_schema "$SCHEMA" "$sql_tmp"'];
    goiDrop.forEach((iDrop, k) => {
      const truoc = than.slice(0, iDrop);
      const iKhoa = truoc.lastIndexOf('khoa_dang_nhap_role_app "$DB" "$SCHEMA"');
      expect(iKhoa).toBeGreaterThan(-1);
      // Không lệnh docker nào chen giữa khoá và DROP.
      expect(truoc.slice(iKhoa)).not.toMatch(/docker /);
      // Guard file của nhánh tương ứng đứng TRƯỚC khoá (khoá MUỘN).
      const iGuard = truoc.lastIndexOf(guardCuaNhanh[k]);
      expect(iGuard).toBeGreaterThan(-1);
      expect(iGuard).toBeLessThan(iKhoa);
    });
  });

  it("mo_lai_dang_nhap tường minh nằm SAU hậu kỳ quyền và TRƯỚC thu hồi phiên (lối thoát mã 3)", () => {
    const iHauKy = than.indexOf('reassign_owner_scoped "$DB" "$SCHEMA"');
    const iMo = than.indexOf("if ! mo_lai_dang_nhap; then");
    const iThuHoi = than.indexOf('thu_hoi_phien_sau_phuc_hoi "$DB" "$SCHEMA"');
    expect(iHauKy).toBeGreaterThan(-1);
    expect(iMo).toBeGreaterThan(iHauKy);
    expect(iThuHoi).toBeGreaterThan(iMo);
  });

  it("chế độ chọn theo DB đích — REVOKE PUBLIC chỉ nằm ở nhánh ≠ DB chung", () => {
    const ham = ma.slice(ma.indexOf("khoa_dang_nhap_role_app() {"), ma.indexOf("\n}\n", ma.indexOf("khoa_dang_nhap_role_app() {")));
    const iNhanh = ham.indexOf('if [[ "$db" == "$DB_SUPABASE_CHUNG" ]]; then');
    const iElse = ham.indexOf("\n  else\n", iNhanh);
    expect(iNhanh).toBeGreaterThan(-1);
    expect(iElse).toBeGreaterThan(iNhanh);
    expect(ham.slice(iNhanh, iElse)).not.toMatch(/REVOKE/);
    expect(ham.slice(iNhanh, iElse)).toContain("NOLOGIN");
    expect(ham.slice(iElse)).toContain("REVOKE CONNECT ON DATABASE");
    expect(ham.slice(iElse)).not.toMatch(/ALTER ROLE/);
    expect(ma).toMatch(/^DB_SUPABASE_CHUNG=postgres$/m);
  });
});
