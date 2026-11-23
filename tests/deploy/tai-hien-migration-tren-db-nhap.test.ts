import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { taoPrismaClient } from "@/lib/tao-prisma-client";

import { ketNoiPsql } from "../helpers/ket-noi-psql-khong-lo-mat-khau";

/**
 * Rào của `deploy/tai-hien-migration-tren-db-nhap.sh` (tái hiện migration trên DB NHÁP — runbook ③a-6 bước (4)):
 *  - tên `postgres` / tên không khớp mẫu nháp ⇒ TỪ CHỐI, KHÔNG gọi psql;
 *  - tên hợp lệ nhưng phiên psql thật nối nhầm DB khác ⇒ chốt `current_database()` chặn TRƯỚC khi chạm file migration;
 *  - tên nháp hợp lệ, đúng đích ⇒ file đi qua stdin, psql in câu lỗi gốc (RAISE EXCEPTION của migration) ở client.
 * DB nháp tạo trên CÙNG server test (`TEST_DATABASE_URL`), dựng tối thiểu hai bảng migration chạm tới, xoá sau cùng.
 */

const GOC = process.cwd();
const SCRIPT = path.join(GOC, "deploy/tai-hien-migration-tren-db-nhap.sh");
const MIGRATION = path.join(GOC, "prisma/migrations/20261106150000_raw_pancake_order_land_seq/migration.sql");
const NHAP = "nhap_landseq_kiem_rao";
const tam = mkdtempSync(path.join(tmpdir(), "landseq-rao-nhap-"));

const urlServer = () => {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.search = "";
  return u;
};
/** psql local nối đúng server test; tên DB do script truyền bằng `-d`. */
const psqlLocal = () => {
  const u = urlServer();
  return `psql -h ${u.hostname} -p ${u.port || "5432"} -U ${decodeURIComponent(u.username) || "postgres"}`;
};
/** Mật khẩu DB test (nếu có) CHỈ đi qua env riêng của tiến trình con — không nằm trong lệnh. */
const ENV_PSQL = ketNoiPsql(process.env.TEST_DATABASE_URL!).env;
const chay = (ten: string, env: Record<string, string>, file = MIGRATION) =>
  spawnSync("bash", [SCRIPT, ten, file], { encoding: "utf8", env: { ...process.env, ...ENV_PSQL, ...env } });

/** psql "giả" chỉ ghi lại việc bị gọi — để chứng minh script TỪ CHỐI TRƯỚC khi gọi psql. */
function psqlGhiLuotGoi(ten: string) {
  const ghi = path.join(tam, `${ten}-da-goi.txt`);
  const gia = path.join(tam, `${ten}-psql-gia.sh`);
  writeFileSync(gia, `#!/usr/bin/env bash\necho goi >> "${ghi}"\n`);
  chmodSync(gia, 0o755);
  writeFileSync(ghi, "");
  return { gia, daGoi: () => readFileSync(ghi, "utf8") !== "" };
}

let admin: PrismaClient;

beforeAll(async () => {
  admin = taoPrismaClient(process.env.TEST_DATABASE_URL!);
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${NHAP}`);
  await admin.$executeRawUnsafe(`CREATE DATABASE ${NHAP}`);
  const u = urlServer();
  u.pathname = `/${NHAP}`;
  u.search = "?schema=app";
  const nhap = taoPrismaClient(u.toString());
  try {
    await nhap.$executeRawUnsafe(`CREATE SCHEMA app`);
    await nhap.$executeRawUnsafe(`CREATE TABLE app."RawPancakeOrder" (id text PRIMARY KEY, "shopId" text, "externalId" text,
      payload jsonb, "fetchedAt" timestamp(3))`);
    await nhap.$executeRawUnsafe(`CREATE TABLE app."Order" (id text PRIMARY KEY, "pancakeId" text, raw jsonb,
      "rawFetchedAt" timestamp(3))`);
    // Đơn MƠ HỒ: khớp 2 dòng kho thô cùng mốc ⇒ khối kiểm sớm của migration RAISE.
    await nhap.$executeRawUnsafe(`INSERT INTO app."RawPancakeOrder" VALUES
      ('a', '1', 'D1', '{}', '2026-07-01 10:00:00.100'), ('b', '1', 'D1', '{"x":1}', '2026-07-01 10:00:00.100')`);
    await nhap.$executeRawUnsafe(`INSERT INTO app."Order" VALUES ('o', 'D1', '{"shop_id": 1}', '2026-07-01 10:00:00.100')`);
  } finally {
    await nhap.$disconnect();
  }
}, 60_000);

afterAll(async () => {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${NHAP} WITH (FORCE)`);
  await admin.$disconnect();
});

describe("rào tái hiện migration trên DB nháp", () => {
  it("TỪ CHỐI postgres và tên không khớp mẫu nháp — không gọi psql", () => {
    const p = psqlGhiLuotGoi("ten");
    for (const ten of ["postgres", "hogikids_test", "template1", "nhap-x", "nhap_", "Nhap_a", "nhap_a;drop", "x_nhap_a"]) {
      const r = chay(ten, { PSQL_CMD: p.gia });
      expect(r.status, ten).toBe(64);
      expect(r.stderr, ten).toMatch(/TỪ CHỐI/);
    }
    expect(p.daGoi()).toBe(false); // psql KHÔNG bao giờ được gọi
  });

  it("đối chứng: psql THẬT làm theo `\\connect` nằm SAU một câu SQL ⇒ chạy file như vậy là rời DB nháp sang DB thật", () => {
    const u = urlServer();
    const r = spawnSync(
      "psql",
      ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-h", u.hostname, "-p", u.port || "5432", "-U",
        decodeURIComponent(u.username) || "postgres", "-d", NHAP, "-f", "-"],
      { encoding: "utf8", input: "SELECT 1; \\connect postgres\nSELECT current_database();\n", env: { ...process.env, ...ENV_PSQL } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["1", "postgres"]);
  });

  it("file có metacommand psql (đầu dòng, sau câu SQL, thụt lề) ⇒ TỪ CHỐI trước khi gọi psql, kể cả tên nháp hợp lệ", () => {
    const p = psqlGhiLuotGoi("meta");
    const bienThe = {
      "connect-sau-sql": "SELECT 1; \\connect postgres\nDROP TABLE app.\"Order\";\n",
      "c-dau-dong": "\\c postgres\nSELECT 1;\n",
      "i-nap-file": "SELECT 1;\n\\i /etc/hosts\n",
      "ir-nap-file": "SELECT 1;\n  \\ir khac.sql\n",
      "include-sau-chu-thich": "-- ghi chu\nBEGIN; \\include khac.sql\nCOMMIT;\n",
      "shell": "SELECT 1; \\! id\n",
      "tat-on-error-stop": "\\set ON_ERROR_STOP 0\nSELECT 1;\n",
    };
    for (const [ten, noiDung] of Object.entries(bienThe)) {
      const f = path.join(tam, `${ten}.sql`);
      writeFileSync(f, noiDung);
      const r = chay(NHAP, { PSQL_CMD: p.gia }, f);
      expect(r.status, ten).toBe(65);
      expect(r.stderr, ten).toMatch(/TỪ CHỐI: file .* có dấu '\\' \(metacommand psql/);
    }
    expect(p.daGoi()).toBe(false);
    // File rỗng cũng từ chối (không có gì để tái hiện).
    const rong = path.join(tam, "rong.sql");
    writeFileSync(rong, "");
    expect(chay(NHAP, { PSQL_CMD: p.gia }, rong).status).toBe(65);
    expect(p.daGoi()).toBe(false);
  });

  it("byte UTF-8 hỏng đứng trước `\\` ⇒ vẫn TỪ CHỐI + in đúng dòng, dưới cả locale UTF-8 lẫn C", () => {
    const p = psqlGhiLuotGoi("utf8");
    const f = path.join(tam, "utf8-hong.sql");
    writeFileSync(f, Buffer.concat([Buffer.from("SELECT 1;\n"), Buffer.from([0xc3]), Buffer.from("\\connect postgres\n")]));
    for (const LC_ALL of ["en_US.UTF-8", "C"]) {
      const r = chay(NHAP, { PSQL_CMD: p.gia, LC_ALL }, f);
      expect(r.status, LC_ALL).toBe(65);
      expect(r.stderr, LC_ALL).toMatch(/TỪ CHỐI: file .* có dấu '\\' .* ở dòng: 2 +— không gọi psql/);
    }
    expect(p.daGoi()).toBe(false);
  });

  it("file LỚN hơn bộ đệm pipe (256 KB) mở đầu bằng `\\connect` ⇒ TỪ CHỐI mọi lượt (không lọt do SIGPIPE + pipefail)", () => {
    const p = psqlGhiLuotGoi("lon");
    const f = path.join(tam, "lon-co-backslash-dau.sql");
    const dem = "SELECT 1; -- dòng đệm cho file lớn\n".repeat(Math.ceil((256 * 1024) / 36));
    writeFileSync(f, `\\connect postgres\n${dem}`);
    for (let i = 0; i < 3; i++) {
      const r = chay(NHAP, { PSQL_CMD: p.gia }, f);
      expect(r.status, `lượt ${i}`).toBe(65);
      expect(r.stderr, `lượt ${i}`).toMatch(/ở dòng: 1 +— không gọi psql/);
    }
    expect(p.daGoi()).toBe(false);
  });

  it("không ghi được file (ulimit -f 64 — như đĩa đầy) + file 200 KB mở đầu bằng `\\connect` ⇒ vẫn TỪ CHỐI; file sạch cùng cỡ vẫn qua", () => {
    const p = psqlGhiLuotGoi("ulimit");
    const dem = "SELECT 1; -- dòng đệm cho file lớn\n".repeat(Math.ceil((200 * 1024) / 36));
    const coBs = path.join(tam, "ulimit-co-bs.sql");
    writeFileSync(coBs, `\\connect postgres\n${dem}`);
    const chayUlimit = (f: string) =>
      spawnSync("bash", ["-c", `ulimit -f 64; exec bash "${SCRIPT}" ${NHAP} "${f}"`], {
        encoding: "utf8",
        env: { ...process.env, ...ENV_PSQL, PSQL_CMD: p.gia },
      });
    for (let i = 0; i < 3; i++) {
      const r = chayUlimit(coBs);
      expect(r.status, `lượt ${i}: ${r.stderr}`).toBe(65);
      expect(r.stderr).toMatch(/ở dòng: 1 +— không gọi psql/);
    }
    expect(p.daGoi()).toBe(false);
    const sach = path.join(tam, "ulimit-sach.sql");
    writeFileSync(sach, dem);
    // Không chặn oan: qua rào và psql được gọi (mã thoát cuối là của psql giả — nó không đọc stdin nên `printf` 200 KB
    // nhận SIGPIPE; không thuộc phép kiểm).
    expect(chayUlimit(sach).stderr).not.toMatch(/TỪ CHỐI/);
    expect(p.daGoi()).toBe(true);
  });

  it("phép kiểm TỰ LỖI (grep lỗi / in kết quả lạ) ⇒ KHÔNG KIỂM ĐƯỢC, mã 74, không coi là sạch, không gọi psql", () => {
    const p = psqlGhiLuotGoi("grep-loi");
    const sach = path.join(tam, "grep-loi-sach.sql");
    writeFileSync(sach, "SELECT 1;\n");
    const coBs = path.join(tam, "grep-loi-co-bs.sql");
    writeFileSync(coBs, "SELECT 1; \\connect postgres\n");
    const grepGia = (ten: string, than: string) => {
      const d = path.join(tam, `bin-${ten}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "grep"), `#!/bin/sh\ncat > /dev/null\n${than}\n`);
      chmodSync(path.join(d, "grep"), 0o755);
      return `${d}:${process.env.PATH}`;
    };
    for (const [ten, than] of [["ma-2", "exit 2"], ["dem-0-ma-2", "echo 0; exit 2"], ["in-la", "echo xx; exit 1"], ["bi-giet", "kill -9 $$"]]) {
      for (const f of [sach, coBs]) {
        const r = chay(NHAP, { PSQL_CMD: p.gia, PATH: grepGia(ten, than) }, f);
        expect(r.status, `${ten} ${path.basename(f)}: ${r.stderr}`).toBe(74);
        expect(r.stderr).toMatch(/TỪ CHỐI: KHÔNG KIỂM ĐƯỢC nội dung file .* không coi là sạch, không gọi psql/);
      }
    }
    expect(p.daGoi()).toBe(false);
  });

  it("phép kiểm phải thấy printf ghi TRỌN: grep chỉ đọc 100 byte rồi báo 0 dòng ⇒ printf 141 ⇒ KHÔNG KIỂM ĐƯỢC (74)", () => {
    const p = psqlGhiLuotGoi("printf-cut");
    const f = path.join(tam, "printf-cut.sql");
    writeFileSync(f, "SELECT 1;\n" + "SELECT 1; -- dòng đệm cho file lớn\n".repeat(6000) + "\\connect postgres\n");
    const d = path.join(tam, "bin-doc-100-byte");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "grep"), "#!/bin/sh\nhead -c 100 > /dev/null\necho 0\nexit 1\n");
    chmodSync(path.join(d, "grep"), 0o755);
    const r = chay(NHAP, { PSQL_CMD: p.gia, PATH: `${d}:${process.env.PATH}` }, f);
    expect(r.status, r.stderr).toBe(74);
    expect(r.stderr).toMatch(/KHÔNG KIỂM ĐƯỢC .*đếm=0, mã printf=141, mã grep=1/);
    expect(p.daGoi()).toBe(false);
  });

  it("chế độ POSIX (`bash --posix`, `POSIXLY_CORRECT`): file sạch KHÔNG bị chặn oan; file có `\\` vẫn 65", () => {
    const p = psqlGhiLuotGoi("posix");
    const sach = path.join(tam, "posix-sach.sql");
    writeFileSync(sach, "SELECT 1;\n");
    const coBs = path.join(tam, "posix-co-bs.sql");
    writeFileSync(coBs, "SELECT 1; \\connect postgres\n");
    const chayPosix = (cach: "co" | "bien", f: string) =>
      spawnSync("bash", cach === "co" ? ["--posix", SCRIPT, NHAP, f] : [SCRIPT, NHAP, f], {
        encoding: "utf8",
        env: { ...process.env, ...ENV_PSQL, PSQL_CMD: p.gia, ...(cach === "bien" ? { POSIXLY_CORRECT: "1" } : {}) },
      });
    for (const cach of ["co", "bien"] as const) {
      const r = chayPosix(cach, coBs);
      expect(r.status, `${cach}: ${r.stderr}`).toBe(65);
    }
    expect(p.daGoi()).toBe(false);
    for (const cach of ["co", "bien"] as const) {
      const r = chayPosix(cach, sach);
      expect(r.stderr, cach).not.toMatch(/TỪ CHỐI/);
      expect(r.status, `${cach}: ${r.stderr}`).toBe(0);
    }
    expect(p.daGoi()).toBe(true);
  });

  it("file chỉ đọc MỘT lần: psql nhận đúng nội dung ĐÃ KIỂM dù file bị ghi đè trước lúc psql đọc stdin", () => {
    const f = path.join(tam, "doc-mot-lan.sql");
    const sach = "SELECT 1;\nSELECT 2;\n";
    writeFileSync(f, sach);
    const nhan = path.join(tam, "psql-nhan.sql");
    const gia = path.join(tam, "psql-ghi-de.sh");
    // psql "giả": ghi đè file nguồn bằng metacommand TRƯỚC khi đọc stdin, rồi lưu lại đúng thứ nó nhận qua stdin.
    writeFileSync(gia, `#!/usr/bin/env bash\nprintf 'SELECT 1; \\\\connect postgres\\n' > "${f}"\ncat > "${nhan}"\n`);
    chmodSync(gia, 0o755);
    const r = chay(NHAP, { PSQL_CMD: gia }, f);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("SELECT 1; \\connect postgres\n"); // file đã bị ghi đè thật
    expect(readFileSync(nhan, "utf8")).toBe(sach); // psql vẫn chỉ nhận bản đã kiểm
  });

  it("migration landSeq thật KHÔNG có dấu `\\` ⇒ qua rào nội dung", () => {
    expect(readFileSync(MIGRATION, "utf8")).not.toContain("\\");
  });

  it("tên hợp lệ nhưng psql nối NHẦM DB khác ⇒ chốt current_database() chặn trước khi chạy file", () => {
    // psql "giả" đổi đích `-d <tên>` thành DB `postgres` (không có schema app — lỡ chạy file cũng chỉ lỗi) — mô phỏng lệnh
    // bị sửa tay / biến môi trường lái kết nối sang DB thật.
    const lai = path.join(tam, "psql-lai-dich.sh");
    const dbTest = "postgres";
    writeFileSync(
      lai,
      `#!/usr/bin/env bash\nargs=()\nwhile [ $# -gt 0 ]; do if [ "$1" = "-d" ]; then args+=("-d" "${dbTest}"); shift 2; ` +
        `else args+=("$1"); shift; fi; done\nexec ${psqlLocal()} "\${args[@]}"\n`,
    );
    chmodSync(lai, 0o755);
    const r = chay(NHAP, { PSQL_CMD: lai });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SAI ĐÍCH: đang nối .* chứ không phải nhap_landseq_kiem_rao/);
    expect(r.stderr).not.toMatch(/landSeq:/); // file migration chưa được chạy
  });

  it("tên nháp hợp lệ, đúng đích ⇒ file qua stdin, psql in đúng lỗi gốc của migration", () => {
    const r = chay(NHAP, { PSQL_CMD: psqlLocal() });
    expect(r.status).toBe(3); // ON_ERROR_STOP
    expect(r.stderr).toMatch(/ERROR:\s+landSeq: 1 đơn Silver khớp >= 2 dòng kho thô cùng mốc land/);
  });
});
