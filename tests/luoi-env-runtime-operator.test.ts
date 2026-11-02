import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Lưới tách biến môi trường RUNTIME ⇄ OPERATOR.
 *
 * `docker-compose.yml` nạp `env_file: .env` vào container app ⇒ mọi khoá trong `.env` host nằm trong môi trường tiến
 * trình app. Vì thế mẫu tách làm hai:
 *   - `.env.example`          = đúng những biến app đọc (dòng không comment = bắt buộc; comment `# KHOÁ=` = tuỳ chọn);
 *   - `.env.operator.example` = biến chỉ dùng trên máy dev/operator (test, script lấy token, n8n API, mật khẩu superuser).
 * Lưới khoá hai chiều: (1) mọi `process.env.X` trong `src/**` phải có trong `.env.example` (thiếu ⇒ deploy pha A không
 * đòi khoá đó và app thiếu biến mà log khởi động vẫn xanh); (2) không khoá operator nào được `src/**` đọc, và hai mẫu
 * không trùng khoá nào (trùng ⇒ pha A không phân biệt được khoá nào được phép nằm trong `.env` host).
 */

const goc = (...phan: string[]) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ...phan);

/** Biến do NỀN TẢNG cấp (Next.js / Dockerfile / compose `environment:`), không nằm trong `.env`. */
const NEN_TANG_CAP = new Set(["NODE_ENV", "NEXT_RUNTIME", "TZ", "VITEST"]); // VITEST: do chính Vitest đặt (khoá CLI miễn khi chạy test)

/**
 * Biến CHỈ của bản build e2e cổng ghi (`playwright.cong-ghi-prod.config.ts` đặt cho `next start`) — KHÔNG
 * thuộc mẫu `.env` nào: đặt ở `.env` host là bật lớp phòng thủ thứ hai của đường chỉ-test trên prod (lớp
 * một — bản build thường không có file `*.e2e.ts(x)` — vẫn còn, nhưng không được tháo cả hai). Chỉ đúng
 * các file khai ở đây được đọc biến.
 */
const CHI_E2E_CONG_GHI: Readonly<Record<string, readonly string[]>> = {
  E2E_CONG_GHI: ["src/app/api/restore/route.ts", "src/lib/backup/cong-ghi-e2e-chi-test.ts"],
};

/** File được phép dùng CẢ object `process.env` (truyền xuống tiến trình con pg_dump/pg_restore). */
const CHO_PHEP_DUNG_CA_OBJECT_ENV = new Set(["src/lib/backup/run-pg-dump.ts", "src/lib/backup/run-restore.ts"]);

/** Bỏ comment dòng (không bắt đầu ngay sau `:` như URL) và comment khối — comment hay nhắc tên biến mà không đọc nó. */
function boComment(noiDung: string): string {
  return noiDung.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

export type BienEnvDoc = { ten: Set<string>; dungCaObject: boolean };

/** Tên biến mà một đoạn mã đọc qua `process.env.X` / `process.env["X"]`; cờ nếu dùng cả object (spread/destructure). */
export function docBienEnv(noiDungDaBoComment: string): BienEnvDoc {
  const ten = new Set<string>();
  for (const m of noiDungDaBoComment.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) ten.add(m[1]);
  for (const m of noiDungDaBoComment.matchAll(/process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g)) ten.add(m[1]);
  // `process.env` đứng một mình (không theo sau `.X` hay `[`): spread, destructure, truyền cả object.
  const dungCaObject = /process\.env(?!\s*[.[])/.test(noiDungDaBoComment);
  return { ten, dungCaObject };
}

/** Khoá của một file mẫu: `KHOÁ=` đầu dòng; `ca` ⇒ gồm cả dòng comment `# KHOÁ=`. */
function khoaCuaMau(noiDung: string, ca: boolean): Set<string> {
  const re = ca ? /^#?\s*([A-Z][A-Z0-9_]*)=/gm : /^([A-Z][A-Z0-9_]*)=/gm;
  return new Set([...noiDung.matchAll(re)].map((m) => m[1]));
}

function fileMaNguon(thuMuc: string): string[] {
  return readdirSync(thuMuc).flatMap((ten) => {
    const duong = path.join(thuMuc, ten);
    if (ten === "node_modules" || ten === "generated") return [];
    if (statSync(duong).isDirectory()) return fileMaNguon(duong);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ten) && !ten.endsWith(".d.ts") ? [duong] : [];
  });
}

const mauRuntime = readFileSync(goc(".env.example"), "utf8");
const mauOperator = readFileSync(goc(".env.operator.example"), "utf8");
const khoaRuntimeCa = khoaCuaMau(mauRuntime, true);
const khoaRuntimeBatBuoc = khoaCuaMau(mauRuntime, false);
const khoaOperatorCa = khoaCuaMau(mauOperator, true);

/** Quét `src/**` một lần: tên → danh sách file đọc; file dùng cả object env. */
const docTrongSrc = (() => {
  const theoTen = new Map<string, string[]>();
  const dungCaObject: string[] = [];
  for (const f of fileMaNguon(goc("src"))) {
    const tuongDoi = path.relative(goc(), f).split(path.sep).join("/");
    const { ten, dungCaObject: caObject } = docBienEnv(boComment(readFileSync(f, "utf8")));
    for (const t of ten) theoTen.set(t, [...(theoTen.get(t) ?? []), tuongDoi]);
    if (caObject) dungCaObject.push(tuongDoi);
  }
  return { theoTen, dungCaObject };
})();

describe("mẫu env: runtime ⇄ operator", () => {
  it("quét src/** thật sự thấy biến (chống quét rỗng làm lưới xanh giả)", () => {
    expect(docTrongSrc.theoTen.size).toBeGreaterThanOrEqual(10);
    for (const chac of ["DATABASE_URL", "SESSION_SECRET", "INGEST_SECRET", "TOKEN_VAULT_SECRET", "APP_INTERNAL_URL"]) {
      expect(docTrongSrc.theoTen.has(chac), chac).toBe(true);
    }
  });

  it("mọi process.env.X trong src/** (trừ biến nền tảng cấp) CÓ trong .env.example", () => {
    const thieu = [...docTrongSrc.theoTen.entries()]
      .filter(([ten]) => !NEN_TANG_CAP.has(ten) && !Object.hasOwn(CHI_E2E_CONG_GHI, ten) && !khoaRuntimeCa.has(ten))
      .map(([ten, files]) => `${ten} (đọc ở ${files.slice(0, 2).join(", ")})`);
    expect(thieu, `khoá src đọc mà .env.example không khai: ${thieu.join("; ")}`).toEqual([]);
  });

  it("biến chỉ-e2e cổng ghi: không nằm trong mẫu .env nào, chỉ đúng file khai được đọc", () => {
    for (const [ten, fileDuocDoc] of Object.entries(CHI_E2E_CONG_GHI)) {
      expect(khoaRuntimeCa.has(ten) || khoaOperatorCa.has(ten), `${ten} không được khai ở mẫu .env`).toBe(false);
      expect([...(docTrongSrc.theoTen.get(ten) ?? [])].sort(), ten).toEqual([...fileDuocDoc].sort());
    }
  });

  it("KHÔNG khoá operator nào được src/** đọc", () => {
    const lo = [...docTrongSrc.theoTen.entries()]
      .filter(([ten]) => khoaOperatorCa.has(ten))
      .map(([ten, files]) => `${ten} (đọc ở ${files.slice(0, 2).join(", ")})`);
    expect(lo, `khoá operator bị app đọc: ${lo.join("; ")}`).toEqual([]);
  });

  it("hai mẫu không trùng khoá nào", () => {
    const trung = [...khoaOperatorCa].filter((k) => khoaRuntimeCa.has(k));
    expect(trung).toEqual([]);
  });

  it("biến nền tảng cấp không bị khai trùng vào mẫu runtime (đặt ở .env sẽ đè giá trị nền tảng)", () => {
    for (const k of NEN_TANG_CAP) expect(khoaRuntimeCa.has(k), k).toBe(false);
  });

  it("chỉ hai file chạy tiến trình con được dùng cả object process.env", () => {
    const la = docTrongSrc.dungCaObject.filter((f) => !CHO_PHEP_DUNG_CA_OBJECT_ENV.has(f));
    expect(la, `dùng cả process.env (qua mặt lưới tên biến): ${la.join(", ")}`).toEqual([]);
  });

  it("khoá BẮT BUỘC (dòng không comment) của mẫu runtime gồm đủ biến app đọc không có default", () => {
    for (const k of ["DATABASE_URL", "SESSION_SECRET", "INGEST_SECRET", "TOKEN_VAULT_SECRET", "APP_INTERNAL_URL", "NEXT_PUBLIC_APP_URL"]) {
      expect(khoaRuntimeBatBuoc.has(k), k).toBe(true);
    }
    // Tuỳ chọn phải là comment — nếu active, deploy pha A sẽ đòi mọi host có nó.
    for (const k of ["SESSION_SECRET_PREVIOUS", "TOKEN_VAULT_FALLBACK_INGEST", "N8N_SYNC_WEBHOOK_URL", "BACKUP_DIR", "INIT_EMAIL", "INIT_PASSWORD", "SEED_CHI_TAO_MOI"]) {
      expect(khoaRuntimeBatBuoc.has(k), `${k} phải là tuỳ chọn (comment)`).toBe(false);
      expect(khoaRuntimeCa.has(k), `${k} phải được khai (comment) trong mẫu`).toBe(true);
    }
  });

  it("mẫu runtime không mang biến test/operator; mẫu operator mang TEST_DATABASE_URL* và khối quản trị", () => {
    for (const k of khoaRuntimeCa) expect(k.startsWith("TEST_"), k).toBe(false);
    for (const k of ["TEST_DATABASE_URL", "TEST_DATABASE_URL_E2E", "TEST_DATABASE_URL_MIGRATION", "SUPABASE_DB_SUPERUSER_PW", "N8N_API_KEY", "MINIPC_SSH"]) {
      expect(khoaOperatorCa.has(k), k).toBe(true);
    }
  });

  it("compose giữ `env_file: .env` và đặt TZ qua environment (TZ không nằm trong .env)", () => {
    const compose = readFileSync(goc("docker-compose.yml"), "utf8")
      .split("\n")
      .filter((d) => !/^\s*#/.test(d))
      .join("\n");
    expect(compose).toMatch(/^\s+env_file: \.env\s*$/m);
    expect(compose).toMatch(/^\s+TZ: Asia\/Ho_Chi_Minh/m);
  });
});

describe("bộ quét biến env (đột biến: thêm biến operator vào src ⇒ lưới đỏ)", () => {
  it("bắt process.env.X, process.env['X'], process.env[`X`]", () => {
    const { ten } = docBienEnv(boComment("const a = process.env.N8N_API_KEY; const b = process.env['SUPABASE_DB_SUPERUSER_PW']; const c = process.env[`MINIPC_SSH`];"));
    expect([...ten].sort()).toEqual(["MINIPC_SSH", "N8N_API_KEY", "SUPABASE_DB_SUPERUSER_PW"]);
    // …và chính các tên đó nằm trong tập operator ⇒ assertion "không khoá operator nào được src đọc" sẽ đỏ.
    for (const k of ten) expect(khoaOperatorCa.has(k), k).toBe(true);
  });

  it("bắt dùng cả object (destructure / spread) — lối vòng qua đếm tên", () => {
    expect(docBienEnv(boComment("const { N8N_API_KEY } = process.env;")).dungCaObject).toBe(true);
    expect(docBienEnv(boComment("const e = { ...process.env, X: 1 };")).dungCaObject).toBe(true);
    expect(docBienEnv(boComment("const v = process.env.DATABASE_URL;")).dungCaObject).toBe(false);
  });

  it("không đếm tên nằm trong comment", () => {
    expect(docBienEnv(boComment("// đọc process.env.N8N_API_KEY ở đây\n/* process.env.MINIPC_SSH */ const x = 1;")).ten.size).toBe(0);
    expect(docBienEnv(boComment('fetch("https://x.test/a"); const k = process.env.INGEST_SECRET;')).ten.has("INGEST_SECRET")).toBe(true);
  });
});
