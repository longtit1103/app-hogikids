import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `deploy/restore.sh` THU HỒI MỌI PHIÊN ở bước cuối (spec §7.4 bước 4, runbook ý (c)).
 *
 * Dump mang `User.sessionEpoch` của đời chụp ⇒ không đổi epoch sau khi nạp là cookie cấp trong đời
 * dump SỐNG LẠI — với MỌI dump, không riêng dump đời trước phân quyền. restore.sh chạy chính file
 * `deploy/thu-hoi-phien-sau-phuc-hoi.sql` (không chép lại câu SQL) qua `psql -X -v ON_ERROR_STOP=1`
 * bằng đúng role hậu kỳ (`supabase_admin`), chỉ khi `User` đã có cột `sessionEpoch`.
 *
 * Hành vi SQL của file đã chứng minh trên Postgres thật ở
 * `tests/migration/script-sql-phan-quyen.integration.test.ts`; ở đây khoá phần bash: gọi gì, bằng
 * role nào, stdin là file nào, lỗi thì dừng. `docker` giả là hàm bash (source restore.sh — file tự
 * chặn `main()` khi được source), ghi tham số + stdin ra thư mục tạm.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const RESTORE_SH = path.join(repoRoot, "deploy/restore.sh");
const SQL_THU_HOI = path.join(repoRoot, "deploy/thu-hoi-phien-sau-phuc-hoi.sql");

const thuMucTam: string[] = [];
afterEach(() => {
  for (const d of thuMucTam.splice(0)) rmSync(d, { recursive: true, force: true });
});

function taoThuMucTam(): string {
  const d = mkdtempSync(path.join(tmpdir(), "restore-sh-thu-hoi-"));
  thuMucTam.push(d);
  return d;
}

type KetQua = { status: number | null; stdout: string; stderr: string; log: string };

/**
 * DB đích CỐ Ý khác `postgres` (mặc định): diễn tập DR chạy `restore.sh <dump> <db nháp> app`, và một
 * `-d postgres` gõ cứng ở bước thu hồi sẽ đổi epoch của PROD còn DB nháp thì không được thu hồi. Test
 * truyền `postgres` thì mù với đúng lỗi đó.
 */
const DB_DICH = "db_dien_tap_dr";
/** Mã thoát "dữ liệu đã nạp nhưng CHƯA XONG" của restore.sh (`MA_THOAT_CHUA_XONG`). */
const MA_CHUA_XONG = 3;

/**
 * `cot`: stdout của lượt `psql -c` kiểm cột (`"loi"` ⇒ lệnh hỏng). `thuHoi`: lượt nạp file thành công
 * hay hỏng. Lượt kiểm cột nhận ra bằng cờ `-c`; lượt nạp file đọc stdin.
 */
function chayThuHoi(p: { cot: string; thuHoi: "ok" | "loi"; schema?: string }): KetQua {
  const log = taoThuMucTam();
  const r = spawnSync(
    "bash",
    [
      "-c",
      `source "$1"
LOG="$2"
docker() {
  if [[ " $* " == *" -c "* ]]; then
    printf '%s\\n' "$*" > "$LOG/kiem.args"
    [[ "$COT" == loi ]] && { echo "psql: error: connection refused" >&2; return 2; }
    printf '%s\\n' "$COT"
    return 0
  fi
  printf '%s\\n' "$*" > "$LOG/thuhoi.args"
  cat > "$LOG/thuhoi.stdin"
  [[ "$THU_HOI" == ok ]] || { echo "ERROR:  permission denied for table User" >&2; return 3; }
}
set -e
thu_hoi_phien_sau_phuc_hoi "$4" "$3"
echo DA_DI_TIEP`,
      "bash",
      RESTORE_SH,
      log,
      p.schema ?? "app",
      DB_DICH,
    ],
    { encoding: "utf8", env: { ...process.env, COT: p.cot, THU_HOI: p.thuHoi } },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log };
}

const doc = (f: string) => readFileSync(f, "utf8");

describe("restore.sh — thu_hoi_phien_sau_phuc_hoi", () => {
  it("User có cột sessionEpoch ⇒ nạp ĐÚNG file thu-hoi-phien-sau-phuc-hoi.sql qua psql -X -v ON_ERROR_STOP=1 bằng supabase_admin", () => {
    const r = chayThuHoi({ cot: "1", thuHoi: "ok" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("DA_DI_TIEP");

    const kiem = doc(path.join(r.log, "kiem.args"));
    expect(kiem).toContain(`exec supabase-db psql -U supabase_admin -d ${DB_DICH} `);
    expect(kiem).toContain("ON_ERROR_STOP=1");
    expect(kiem).toMatch(/table_schema = 'app' AND table_name = 'User' AND column_name = 'sessionEpoch'/);

    expect(doc(path.join(r.log, "thuhoi.args")).trim()).toBe(
      `exec -i supabase-db psql -U supabase_admin -d ${DB_DICH} -X -v ON_ERROR_STOP=1`,
    );
    // Chính file trong deploy/, từng byte — không phải bản chép câu SQL trong bash.
    expect(doc(path.join(r.log, "thuhoi.stdin"))).toBe(doc(SQL_THU_HOI));
    expect(r.stderr).toMatch(/Đã thu hồi mọi phiên/);
  });

  it("dump đời trước phân quyền (chưa có cột) ⇒ KHÔNG nạp, in hướng dẫn migrate deploy rồi chạy script, thoát mã CHƯA XONG (3)", () => {
    const r = chayThuHoi({ cot: "0", thuHoi: "ok" });
    expect(r.status, r.stderr).toBe(MA_CHUA_XONG);
    expect(r.stdout, "set -e phải dừng ngay — không đi tiếp tới dòng ✓").not.toContain("DA_DI_TIEP");
    expect(existsSync(path.join(r.log, "thuhoi.args"))).toBe(false);
    expect(r.stderr).toMatch(/CHƯA XONG/);
    expect(r.stderr).toMatch(/đời TRƯỚC phân quyền/);
    expect(r.stderr).toContain(`-d ${DB_DICH} `);
    expect(r.stderr).toMatch(/GIỮ APP DỪNG/);
    expect(r.stderr).toContain("prisma migrate deploy");
    expect(r.stderr).toContain("deploy/thu-hoi-phien-sau-phuc-hoi.sql");
  });

  it("nạp file hỏng ⇒ thoát ≠ 0, KHÔNG đi tiếp, báo rõ cookie đời dump có thể sống lại", () => {
    const r = chayThuHoi({ cot: "1", thuHoi: "loi" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("DA_DI_TIEP");
    expect(r.stderr).toMatch(/thu hồi phiên THẤT BẠI/);
    expect(r.stderr).toMatch(/SỐNG LẠI/);
    expect(r.stderr).toContain("deploy/thu-hoi-phien-sau-phuc-hoi.sql");
  });

  it("không kiểm được cột (psql lỗi) ⇒ thoát ≠ 0, không nạp gì", () => {
    const r = chayThuHoi({ cot: "loi", thuHoi: "ok" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("DA_DI_TIEP");
    expect(existsSync(path.join(r.log, "thuhoi.args"))).toBe(false);
    expect(r.stderr).toMatch(/CHƯA thu hồi phiên/);
  });

  it("kết quả kiểm cột lạ (không phải 0/1) ⇒ thoát ≠ 0 — không đoán", () => {
    const r = chayThuHoi({ cot: "NOTICE: gi do", thuHoi: "ok" });
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(r.log, "thuhoi.args"))).toBe(false);
  });

  it("schema ≠ app ⇒ không gọi docker (file cố định search_path = app), chỉ cảnh báo", () => {
    const r = chayThuHoi({ cot: "1", thuHoi: "ok", schema: "public" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(r.log, "kiem.args"))).toBe(false);
    expect(existsSync(path.join(r.log, "thuhoi.args"))).toBe(false);
    expect(r.stderr).toMatch(/KHÔNG thu hồi phiên/);
  });
});

describe("restore.sh — main nối bước thu hồi phiên", () => {
  it("thu hồi phiên là bước CUỐI, sau hậu kỳ trả quyền (chạy bằng role đã có quyền trên schema)", () => {
    const sh = doc(RESTORE_SH);
    const than = sh.slice(sh.indexOf("\nmain() {"));
    const viTriQuyen = than.indexOf('reassign_owner_scoped "$DB" "$SCHEMA"');
    const viTriThuHoi = than.indexOf('thu_hoi_phien_sau_phuc_hoi "$DB" "$SCHEMA"');
    expect(viTriQuyen).toBeGreaterThan(-1);
    expect(viTriThuHoi).toBeGreaterThan(viTriQuyen);
    // Không lệnh docker/psql nào sau bước này trong main.
    expect(than.slice(viTriThuHoi, than.indexOf("\n}\n"))).not.toMatch(/docker |psql /);
  });

  it("thiếu file thu-hoi-phien-sau-phuc-hoi.sql ⇒ từ chối TRƯỚC mọi thao tác DB (không gọi docker)", () => {
    const d = taoThuMucTam();
    const shTam = path.join(d, "restore.sh");
    copyFileSync(RESTORE_SH, shTam); // KHÔNG chép file SQL cạnh nó
    const dump = path.join(d, "x.dump");
    writeFileSync(dump, "PGDMP-gia");
    const bin = path.join(d, "bin");
    const dockerGia = path.join(bin, "docker");
    const logDocker = path.join(d, "docker.log");
    mkdirSync(bin);
    writeFileSync(dockerGia, `#!/usr/bin/env bash\necho "$*" >> "${logDocker}"\n`);
    chmodSync(dockerGia, 0o755);

    const r = spawnSync("bash", [shTam, dump], {
      encoding: "utf8",
      input: "y\n",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("thu-hoi-phien-sau-phuc-hoi.sql");
    expect(existsSync(logDocker)).toBe(false);
  });
});

/**
 * Chạy TRỌN `restore.sh` (đường `.sql.gz`) với `docker` giả trên PATH — khoá cách `main` NỐI bước thu
 * hồi: mã thoát của nó phải thành mã thoát của script, và dòng ✓ chỉ in khi thật sự xong. So chuỗi
 * lệnh trong file (indexOf) mù với `thu_hoi_phien_sau_phuc_hoi … || true`.
 *
 * `docker` giả: lượt kiểm cột (`information_schema.columns`) in `$COT`; lượt `-c` khác (dọn schema, trả
 * quyền) thành công; lượt đọc stdin là file thu hồi (nhận ra bằng dòng đầu) thì ghi lại và thành
 * công/hỏng theo `$THU_HOI`; stdin khác (nạp SQL) nuốt và thành công. Mọi lời gọi ghi vào `calls`.
 */
function chayTronRestore(p: { cot: string; thuHoi: "ok" | "loi" }): KetQua {
  const d = taoThuMucTam();
  const bin = path.join(d, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LOG/calls"
if [[ "$*" == *information_schema.columns* ]]; then printf '%s\\n' "$COT"; exit 0; fi
if [[ " $* " == *" -c "* ]]; then exit 0; fi
than=$(cat)
if [[ "$than" == "-- thu-hoi-phien-sau-phuc-hoi.sql"* ]]; then
  printf '%s\\n' "$*" > "$LOG/thuhoi.args"
  [[ "$THU_HOI" == ok ]] || { echo "ERROR:  permission denied for table User" >&2; exit 3; }
fi
exit 0
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const dump = path.join(d, "x.sql.gz");
  writeFileSync(dump, gzipSync('CREATE SCHEMA app;\nCREATE TABLE app."X" (id integer);\n'));
  const r = spawnSync("bash", [RESTORE_SH, dump, DB_DICH, "app"], {
    encoding: "utf8",
    input: "y\n",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, LOG: d, COT: p.cot, THU_HOI: p.thuHoi },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: d };
}

describe("restore.sh — chạy trọn main: mã thoát + dòng ✓ theo kết quả thu hồi phiên", () => {
  it("thu hồi thành công ⇒ thoát 0, in ✓, thu hồi chạy trên ĐÚNG DB truyền vào", () => {
    const r = chayTronRestore({ cot: "1", thuHoi: "ok" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/✓ Phục hồi schema 'app' của 'db_dien_tap_dr' xong/);
    expect(doc(path.join(r.log, "thuhoi.args"))).toContain(`-d ${DB_DICH} `);
    // Không lời gọi docker nào của lượt này chạm DB `postgres` khi đích là DB khác.
    expect(doc(path.join(r.log, "calls"))).not.toMatch(/-d postgres\b/);
  });

  it("thu hồi HỎNG ⇒ thoát ≠ 0 và KHÔNG in ✓", () => {
    const r = chayTronRestore({ cot: "1", thuHoi: "loi" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/thu hồi phiên THẤT BẠI/);
    expect(r.stderr).not.toMatch(/✓ Phục hồi schema/);
  });

  it("dump đời trước phân quyền ⇒ thoát ĐÚNG mã 3, KHÔNG in ✓, báo CHƯA XONG", () => {
    const r = chayTronRestore({ cot: "0", thuHoi: "ok" });
    expect(r.status, r.stderr).toBe(MA_CHUA_XONG);
    expect(r.stderr).toMatch(/CHƯA XONG/);
    expect(r.stderr).not.toMatch(/✓ Phục hồi schema/);
    expect(existsSync(path.join(r.log, "thuhoi.args"))).toBe(false);
  });
});
