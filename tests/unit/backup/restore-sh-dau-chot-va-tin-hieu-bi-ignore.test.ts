import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  chayRestoreVoiDockerGia,
  donThuMucHarness,
  RESTORE_SH,
  type KetQuaChay,
} from "../../deploy/harness/restore/chay-restore-voi-docker-gia";

/**
 * `deploy/restore.sh` KHÔNG tin mã thoát của `docker exec` để biết lệnh trong container đã xong.
 *
 * Đo trên host 04/11/2026 (diễn tập nhánh REVOKE trên DB nháp, docker 29.4.1): docker CLI bị SIGINT thì
 * `docker exec -i` THOÁT MÃ 0 ngay, trong khi pg_restore / psql trong container còn chạy. Lượt
 * `restore.sh` chạy với SIGINT bị ignore lúc khởi động (`script … &` trong bash không tương tác ⇒
 * `SigIgn=0x6`; bash không trap được tín hiệu đã bị ignore lúc vào) đi tiếp: trả quyền, mở lại quyền nối,
 * xoá tệp đánh dấu, in "✓ Phục hồi xong", thoát 0 trên schema DỞ.
 *
 * Hai lớp vá, khoá ở đây:
 *  (a) `main` từ chối chạy (trước mọi lời gọi docker) khi INT/TERM bị ignore từ tiến trình cha;
 *  (b) mọi lệnh của vùng phá huỷ (DROP, nạp custom, nạp plain, hai khối trả quyền) + bước thu hồi phiên
 *      chạy kèm DẤU CHỐT hoàn tất in từ TRONG container. Thiếu dấu chốt (dù docker exec thoát 0) hay dấu
 *      chốt mã ≠ 0 ⇒ GIỮ khoá + tệp đánh dấu, không "✓", thoát ≠ 0.
 *
 * Chạy TRỌN script với `docker` giả (harness `tests/deploy/harness/restore/`) — stub chạy ĐÚNG chuỗi vỏ
 * dấu chốt restore.sh gửi bằng `sh` thật. Không Postgres/Docker thật nào bị chạm.
 *
 * Chứng minh test đỏ trên bản cũ: `RESTORE_SH_DUOI_TEST=<thư mục tạm>/restore.sh` (bản `main` chép ra, cạnh
 * nó là `thu-hoi-phien-sau-phuc-hoi.sql`).
 */
const DB_NHAP = "db_dien_tap_dr";
const ACL_CO_GRANT = "{=Tc/supabase_admin,supabase_admin=CTc/supabase_admin,hogikids=c/supabase_admin}";
const MA_THIEU_DAU_CHOT = 4;

afterEach(() => donThuMucHarness());

const dem = (r: KetQuaChay, nhan: string) => r.suKien.filter((s) => s === nhan).length;

/** Chế độ REVOKE (DB nháp): khoá KHÔNG được trả, tệp đánh dấu còn, không dòng mở lại / phục hồi xong. */
function expectGiuKhoaRevoke(r: KetQuaChay, dauTep: "bi_ngat_giua_nap=" | "loi_sau_drop=", buoc: string): void {
  expect(r.status, r.stderr).not.toBe(0);
  expect(dem(r, "REVOKE")).toBe(1);
  expect(r.suKien, "không được trả ACL khi lệnh trong container chưa chắc đã xong").not.toContain("TRA_ACL");
  expect(r.aclCuoi, "REVOKE cho DB nháp còn nguyên").toBe("DA_REVOKE");
  expect(r.tepDangDoConKhong, "giữ tệp đánh dấu để lượt sau dừng ở preflight").toBe(true);
  const tep = readFileSync(r.tepDangDo, "utf8");
  expect(tep).toContain("che_do=revoke");
  expect(tep).toContain(dauTep);
  expect(tep).toContain(`buoc_do=${buoc}`);
  expect(r.stderr).not.toContain("✓ Đã mở lại");
  expect(r.stderr).not.toMatch(/Phục hồi schema .* xong/);
  expect(r.stderr).toContain("KHÔNG mở lại đăng nhập");
  expect(r.stderr).toContain("ps aux"); // lệnh kiểm tiến trình còn chạy trong container
  expect(r.stderr).toContain("SET datacl"); // lệnh mở tay
  expect(r.suKien).not.toContain("THU_HOI");
  expect(r.tepTamSot).toEqual([]);
}

describe("dấu chốt hoàn tất — lệnh nạp (đích ≠ postgres: REVOKE)", () => {
  it.each([
    ["plain (.sql.gz, psql)", "gzip" as const, "NAP_PSQL"],
    ["custom (.dump, pg_restore)", "custom" as const, "NAP_PG_RESTORE"],
  ])("%s: docker exec thoát 0 mà KHÔNG có dấu chốt ⇒ coi như bị ngắt, GIỮ khoá, thoát ≠ 0", async (_ten, dinhDang, nhan) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang, db: DB_NHAP, kichBan: { aclBanDau: ACL_CO_GRANT, thieuDauChotO: nhan } });
    expect(r.status, r.stderr).toBe(MA_THIEU_DAU_CHOT);
    expectGiuKhoaRevoke(r, "bi_ngat_giua_nap=", "nap");
    expect(r.suKien, "dừng ngay — không trả quyền trên schema dở").not.toContain("TRA_OWNER");
    expect(r.stderr).toContain("KHÔNG thấy dấu chốt hoàn tất");
    expect(r.stderr).toContain("docker exec thoát 0");
  });

  // stdout docker exec = "x<dấu chốt>\n<dấu chốt>": chỉ so nguyên chuỗi neo ^…$ mới từ chối (bỏ neo ^ hoặc $
  // là tin nhầm). Lệnh giả cũng in `SET`/`COPY 3`/dòng giống dấu chốt ra stdout của nó — chỉ qua được nhờ
  // vỏ chuyển `1>&2`; các ca thành công bên dưới vì vậy cũng canh `1>&2`.
  it.each([
    ["plain (.sql.gz, psql)", "gzip" as const, "NAP_PSQL"],
    ["custom (.dump, pg_restore)", "custom" as const, "NAP_PG_RESTORE"],
  ])("%s: stdout docker exec có dòng nhiễu cạnh dấu chốt ⇒ KHÔNG tin, GIỮ khoá", async (_ten, dinhDang, nhan) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang, db: DB_NHAP, kichBan: { aclBanDau: ACL_CO_GRANT, nhieuStdoutO: nhan } });
    expect(r.status, r.stderr).toBe(MA_THIEU_DAU_CHOT);
    expectGiuKhoaRevoke(r, "bi_ngat_giua_nap=", "nap");
    expect(r.stderr).toContain("KHÔNG thấy dấu chốt hoàn tất");
  });

  // Mã 3/4 là mã RIÊNG của script (3 = "đã nạp, chỉ thiếu migrate" — runbook §4.2 `[ $? -eq 3 ]` chạy tiếp
  // `migrate deploy`; 4 = thiếu dấu chốt) ⇒ mã trùng từ trong container phải thành 1; mã khác giữ nguyên.
  it.each([
    ["plain (.sql.gz, psql)", "gzip" as const, "NAP_PSQL", 3, 1],
    ["custom (.dump, pg_restore)", "custom" as const, "NAP_PG_RESTORE", 3, 1],
    ["plain (.sql.gz, psql)", "gzip" as const, "NAP_PSQL", 4, 1],
    ["custom (.dump, pg_restore)", "custom" as const, "NAP_PG_RESTORE", 4, 1],
    ["plain (.sql.gz, psql)", "gzip" as const, "NAP_PSQL", 2, 2],
    ["custom (.dump, pg_restore)", "custom" as const, "NAP_PG_RESTORE", 1, 1],
  ])("%s: dấu chốt mã %i dù docker exec thoát 0 ⇒ lỗi sau DROP, GIỮ khoá, thoát %i (không mượn mã riêng 3/4)", async (_ten, dinhDang, nhan, rc, maMongDoi) => {
    const r = await chayRestoreVoiDockerGia({
      dinhDang,
      db: DB_NHAP,
      kichBan: { aclBanDau: ACL_CO_GRANT, dauChotRcO: { nhan, rc } },
    });
    expect(r.status, r.stderr).toBe(maMongDoi);
    expectGiuKhoaRevoke(r, "loi_sau_drop=", "nap");
    expect(r.suKien).not.toContain("TRA_OWNER");
    expect(r.stderr).toContain(`KẾT THÚC với mã ${rc}`);
  });

  it.each([
    // Nạp plain và thu hồi phiên là CÙNG một dòng lệnh (`psql … -X -v ON_ERROR_STOP=1`, chỉ khác stdin) ⇒ 2 lời gọi.
    ["plain (.sql.gz, psql)", "gzip" as const, "NAP_PSQL", "psql -U supabase_admin -d db_dien_tap_dr -X -v ON_ERROR_STOP=1", 2],
    [
      "custom (.dump, pg_restore)",
      "custom" as const,
      "NAP_PG_RESTORE",
      "pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges -n app -U supabase_admin -d db_dien_tap_dr",
      1,
    ],
  ])("%s: dấu chốt mã 0 ⇒ thành công như cũ, lệnh nạp đi qua vỏ dấu chốt", async (_ten, dinhDang, nhan, lenhNap, soLoiGoi) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang, db: DB_NHAP, kichBan: { aclBanDau: ACL_CO_GRANT } });
    expect(r.status, r.stderr).toBe(0);
    expect(dem(r, nhan)).toBe(1);
    expect(dem(r, "TRA_ACL")).toBe(1);
    expect(r.aclCuoi).toBe(ACL_CO_GRANT);
    expect(r.tepDangDoConKhong).toBe(false);
    expect(r.stderr).toContain("✓ Đã mở lại");
    expect(r.stderr).toMatch(/✓ Phục hồi schema 'app' của 'db_dien_tap_dr' xong/);
    const goiNap = r.loiGoi.filter((g) => g.endsWith(lenhNap));
    expect(goiNap, r.loiGoi.join("\n")).toHaveLength(soLoiGoi);
    for (const g of goiNap) expect(g.startsWith("exec -i supabase-db sh -c ")).toBe(true);
  });
});

describe("dấu chốt hoàn tất — các bước khác trong vùng phá huỷ", () => {
  it("DROP thiếu dấu chốt ⇒ KHÔNG biết transaction đã commit ⇒ GIỮ khoá (không nói 'schema CÒN NGUYÊN')", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { thieuDauChotO: "DROP" } });
    expect(r.status, r.stderr).toBe(MA_THIEU_DAU_CHOT);
    expectGiuKhoaRevoke(r, "bi_ngat_giua_nap=", "drop");
    expect(r.suKien).not.toContain("NAP_PSQL");
    expect(r.stderr).not.toContain("schema CÒN NGUYÊN");
    // Thiếu dấu chốt ở chính bước DROP ⇒ không biết DROP đã commit chưa — không được khẳng định "SAU khi đã DROP".
    expect(r.stderr).toContain("không rõ DROP đã commit hay chưa");
    expect(r.stderr).not.toContain("SAU khi đã DROP");
  });

  it.each([["TRA_OWNER"], ["CAP_QUYEN_N8N"]])("trả quyền (%s) thiếu dấu chốt ⇒ GIỮ khoá, buoc_do=tra_quyen", async (nhan) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { thieuDauChotO: nhan } });
    expect(r.status, r.stderr).toBe(MA_THIEU_DAU_CHOT);
    expectGiuKhoaRevoke(r, "bi_ngat_giua_nap=", "tra_quyen");
  });

  it("trả owner: dấu chốt mã ≠ 0 dù docker exec thoát 0 ⇒ GIỮ khoá, loi_sau_drop", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { dauChotRcO: { nhan: "TRA_OWNER", rc: 1 } } });
    expect(r.status, r.stderr).toBe(1);
    expectGiuKhoaRevoke(r, "loi_sau_drop=", "tra_quyen");
  });

  it("đích = postgres (NOLOGIN): nạp thiếu dấu chốt ⇒ GIỮ NOLOGIN + tệp đánh dấu, in lệnh LOGIN tay", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "custom", db: "postgres", kichBan: { thieuDauChotO: "NAP_PG_RESTORE" } });
    expect(r.status, r.stderr).toBe(MA_THIEU_DAU_CHOT);
    expect(dem(r, "NOLOGIN")).toBe(1);
    expect(r.suKien).not.toContain("LOGIN");
    expect(r.loginCuoi).toBe("f");
    expect(r.tepDangDoConKhong).toBe(true);
    expect(readFileSync(r.tepDangDo, "utf8")).toMatch(/bi_ngat_giua_nap=.* buoc_do=nap/);
    expect(r.stderr).toContain("ALTER ROLE hogikids LOGIN;");
    expect(r.stderr).not.toContain("✓ Đã mở lại");
    expect(r.stderr).not.toMatch(/Phục hồi schema .* xong/);
  });
});

describe("dấu chốt hoàn tất — bước thu hồi phiên (sau khi đã mở lại)", () => {
  it("thu hồi thiếu dấu chốt ⇒ thoát ≠ 0, KHÔNG in '✓ Đã thu hồi' lẫn '✓ Phục hồi xong'", async () => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db: DB_NHAP, kichBan: { thieuDauChotO: "THU_HOI" } });
    expect(r.status, r.stderr).not.toBe(0);
    expect(dem(r, "THU_HOI")).toBe(1);
    expect(r.stderr).toContain("thu hồi phiên THẤT BẠI");
    expect(r.stderr).not.toContain("✓ Đã thu hồi");
    expect(r.stderr).not.toMatch(/Phục hồi schema .* xong/);
    // Khoá đã mở ĐÚNG như thiết kế (trước bước thu hồi) — không bị đóng lại hay mở lần hai.
    expect(dem(r, "TRA_ACL")).toBe(1);
    expect(r.tepDangDoConKhong).toBe(false);
  });
});

describe("tín hiệu bị IGNORE từ tiến trình cha ⇒ từ chối TRƯỚC mọi lời gọi docker", () => {
  it.each([
    ["INT (chạy nền '&' trong bash không tương tác)", ["INT" as const], DB_NHAP],
    ["TERM", ["TERM" as const], DB_NHAP],
    ["INT + TERM, đích postgres (kể cả 'docker ps' preflight cũng không chạy)", ["INT" as const, "TERM" as const], "postgres"],
  ])("%s", async (_ten, tinHieu, db) => {
    const r = await chayRestoreVoiDockerGia({ dinhDang: "gzip", db, tinHieuBiIgnore: tinHieu });
    expect(r.status, r.stderr).toBe(1);
    expect(r.suKien).toEqual([]);
    expect(r.loiGoi).toEqual([]);
    expect(r.tepDangDoConKhong).toBe(false);
    for (const t of tinHieu) expect(r.stderr).toContain(t);
    expect(r.stderr).toContain("đang bị IGNORE");
    expect(r.stderr).toContain("DB KHÔNG bị đụng");
    expect(r.stderr).toContain("terminal thật");
    expect(r.stderr).not.toContain("Gõ 'y'");
  });
});

describe("cấu trúc: mọi lệnh của vùng phá huỷ đi qua vỏ dấu chốt", () => {
  const sh = readFileSync(RESTORE_SH, "utf8");
  const ma = sh
    .split("\n")
    .filter((d) => !d.trimStart().startsWith("#"))
    .join("\n");
  const thanHam = (ten: string) => {
    const dau = ma.indexOf(`\n${ten}() {`);
    expect(dau, `thiếu hàm ${ten}`).toBeGreaterThan(-1);
    return ma.slice(dau, ma.indexOf("\n}\n", dau));
  };

  it("DROP, hai khối trả quyền, thu hồi phiên: không gọi `docker exec` trực tiếp", () => {
    for (const ten of ["drop_schema_dich", "reassign_owner_scoped"]) {
      expect(thanHam(ten), ten).not.toMatch(/\bdocker\s+exec\b/);
      expect(thanHam(ten), ten).toContain("chay_co_dau_chot ");
    }
    // Hàm thu hồi còn một `docker exec … -tA` đọc cột (kết quả được kiểm 0/1, không cần dấu chốt) — lệnh
    // nạp file thu hồi thì phải qua vỏ.
    expect(thanHam("thu_hoi_phien_sau_phuc_hoi")).toMatch(/chay_co_dau_chot -i psql [^\n]*< "\$THU_HOI_PHIEN_SQL"/);
  });

  it("trong main, từ lúc vào vùng phá huỷ tới lúc ra: không lệnh `docker` trực tiếp nào", () => {
    const than = ma.slice(ma.indexOf("\nmain() {"));
    const ds = than.split("\n").map((d) => d.trim());
    const vao = ds.flatMap((d, i) => (d === "BUOC_PHA_HUY=drop" ? [i] : []));
    const ra = ds.indexOf('BUOC_PHA_HUY=""');
    expect(vao).toHaveLength(2);
    for (const i of vao) {
      expect(ra).toBeGreaterThan(i);
      expect(ds.slice(i, ra).filter((d) => /\bdocker\s/.test(d) && !d.startsWith("echo"))).toEqual([]);
    }
    expect(ds.filter((d) => d.startsWith("chay_co_dau_chot -i pg_restore --clean"))).toHaveLength(1);
    expect(ds.filter((d) => d.startsWith("chay_co_dau_chot -i psql ") && d.endsWith('< "$sql_tmp"'))).toHaveLength(1);
  });

  it("vỏ dấu chốt chuyển stdout của lệnh sang stderr (stdout docker exec chỉ mang dấu chốt) và trả đúng mã", () => {
    expect(sh).toContain(`SH_DAU_CHOT='"$@" 1>&2; rc=$?; echo "'"$DAU_CHOT_TIEN_TO"'$rc"; exit "$rc"'`);
  });

  it("kiểm tín hiệu bị ignore đứng NGAY sau khi cài trap INT/TERM, trước mọi lệnh khác của main", () => {
    const than = ma.slice(ma.indexOf("\nmain() {"));
    const iTerm = than.indexOf("trap 'bi_ngat 143' TERM");
    const iKiem = than.indexOf("kiem_bat_duoc_tin_hieu_ngat || exit 1");
    expect(iTerm).toBeGreaterThan(-1);
    expect(iKiem).toBeGreaterThan(iTerm);
    expect(than.slice(iTerm, iKiem).split("\n").filter((d) => d.trim() !== "")).toHaveLength(1);
    expect(than.slice(0, iKiem)).not.toMatch(/\bdocker\s/);
  });
});
