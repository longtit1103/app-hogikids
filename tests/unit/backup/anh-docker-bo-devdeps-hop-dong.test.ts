import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { goiNpx, goiNpxTrongContainer, noiLenhNhieuDong } from "../../helpers/lenh-npx-trong-van-ban";

/**
 * Hợp đồng ảnh Docker production KHÔNG mang devDependencies (#261) — soi MÃ NGUỒN, không chạy ảnh
 * (bước chạy ảnh thật nằm ở job `docker` của CI). Ảnh `app` kiêm hộp dụng cụ vận hành: runbook/DR chạy
 * `npx --no-install prisma …` và `npx --no-install tsx scripts/…` TRONG container ⇒ `prisma` + `tsx` phải
 * là dependencies, mọi thứ script/app import phải nằm trong dependencies, và lệnh container luôn
 * `--no-install` (thiếu gói thì ĐỎ, không bao giờ để `npx` tự tải bản mới từ npm — đo 30/09: nó đòi
 * `prisma@8.0.0-rc.19`). File này chỉ đọc file CÓ ở repo public; phần runbook `deploy/*.md` + `docs/`
 * (bị loại khỏi public) nằm ở runbook-npx-chi-dung-dependencies.test.ts.
 */

const goc = (...phan: string[]) => path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..", ...phan);
const doc = (...phan: string[]) => readFileSync(goc(...phan), "utf8");
const pkg = JSON.parse(doc("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  prisma?: unknown;
};
const deps = new Set(Object.keys(pkg.dependencies));

/** Bỏ dòng comment `#` — assertion không được xanh (hay đỏ) nhờ lời giải thích thay vì dòng lệnh thật. */
const boComment = (noiDung: string) =>
  noiDung
    .split("\n")
    .filter((d) => !/^\s*#/.test(d))
    .join("\n");

/** Dòng lệnh (đã nối dòng tiếp nối, bỏ comment + dòng trống, trim) của một đoạn shell/Dockerfile. */
const dongLenh = (noiDung: string) =>
  noiLenhNhieuDong(boComment(noiDung))
    .split("\n")
    .map((d) => d.trim())
    .filter(Boolean);

const lenhDockerfile = dongLenh(doc("Dockerfile"));

/** Mọi file .ts/.tsx (trừ .d.ts) dưới một thư mục, đệ quy. */
function fileTs(thuMuc: string): string[] {
  return readdirSync(goc(thuMuc)).flatMap((ten) => {
    const rel = path.join(thuMuc, ten);
    if (statSync(goc(rel)).isDirectory()) return fileTs(rel);
    return /\.tsx?$/.test(ten) && !ten.endsWith(".d.ts") ? [rel] : [];
  });
}

/** Specifier của các import mang GIÁ TRỊ (bỏ `import type`, `export type`, import toàn specifier type). */
function importGiaTri(rel: string): string[] {
  const sf = ts.createSourceFile(rel, doc(rel), ts.ScriptTarget.Latest, true);
  const ra: string[] = [];
  const tham = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const toanType =
        !!c?.isTypeOnly ||
        (!!c && !c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) &&
          c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!toanType) ra.push(n.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      ra.push(n.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (!n.isTypeOnly && ts.isStringLiteral(e)) ra.push(e.text);
    } else if (ts.isCallExpression(n)) {
      const laImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const laRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      const a = n.arguments[0];
      if ((laImport || laRequire) && a && ts.isStringLiteralLike(a)) ra.push(a.text);
    }
    ts.forEachChild(n, tham);
  };
  tham(sf);
  return ra;
}

/** Giá trị chuỗi `migrations.seed` trong `prisma.config.ts` (đọc AST — comment không làm test xanh giả). */
function seedTrongPrismaConfig(): string | undefined {
  const sf = ts.createSourceFile("prisma.config.ts", doc("prisma.config.ts"), ts.ScriptTarget.Latest, true);
  const tenThuocTinh = (p: ts.ObjectLiteralElementLike) =>
    ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
  let ketQua: string | undefined;
  const tham = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && tenThuocTinh(n) === "migrations" && ts.isObjectLiteralExpression(n.initializer)) {
      const seed = n.initializer.properties.find((p) => tenThuocTinh(p) === "seed");
      if (seed && ts.isPropertyAssignment(seed) && ts.isStringLiteralLike(seed.initializer)) ketQua = seed.initializer.text;
    }
    ts.forEachChild(n, tham);
  };
  tham(sf);
  return ketQua;
}

/** "next/navigation" → "next"; "@prisma/client/x" → "@prisma/client"; tương đối / alias / builtin → null. */
function tenGoi(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) return null;
  if (spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0])) return null;
  const phan = spec.split("/");
  return spec.startsWith("@") ? `${phan[0]}/${phan[1]}` : phan[0];
}

describe("package.json: công cụ vận hành trong container là dependencies", () => {
  it("prisma + tsx nằm ở dependencies, không ở devDependencies", () => {
    for (const ten of ["prisma", "tsx"]) {
      expect(deps.has(ten), `${ten} phải ở dependencies`).toBe(true);
      expect(Object.keys(pkg.devDependencies)).not.toContain(ten);
    }
  });

  it("lệnh seed (`prisma.config.ts` → migrations.seed) chạy bằng tsx — seed chạy trong container ⇒ tsx phải có sau prune", () => {
    // Prisma 7 đọc lệnh seed từ `prisma.config.ts`, KHÔNG còn đọc mục `"prisma"` của package.json.
    expect(pkg.prisma, "mục \"prisma\" trong package.json bị Prisma 7 bỏ qua — khai ở prisma.config.ts").toBeUndefined();
    expect(seedTrongPrismaConfig()).toMatch(/^tsx\s/);
  });
});

describe("Dockerfile: prune devDeps + CMD không qua npx", () => {
  it("`npm prune --omit=dev` ở stage build, SAU `npm run build`, TRƯỚC stage runner", () => {
    const iBuild = lenhDockerfile.findIndex((d) => /^RUN .*npm run build/.test(d));
    const iPrune = lenhDockerfile.indexOf("RUN npm prune --omit=dev");
    const iRunner = lenhDockerfile.findIndex((d) => /^FROM base AS runner$/.test(d));
    expect(iBuild).toBeGreaterThan(-1);
    expect(iRunner).toBeGreaterThan(-1);
    expect(iPrune).toBeGreaterThan(iBuild);
    expect(iPrune).toBeLessThan(iRunner);
  });

  it("`prisma generate` chạy ở stage build TRƯỚC prune; runner chép trọn /app (client sinh + prisma.config.ts)", () => {
    // Prisma 7: client là mã TS sinh vào src/generated/prisma (không còn query engine trong node_modules) —
    // seed/rebuild-from-raw chạy bằng tsx trong container cần nó, CLI migrate/seed cần prisma.config.ts.
    const iGenerate = lenhDockerfile.findIndex((d) => /^RUN npx --no-install prisma generate\b/.test(d));
    const iPrune = lenhDockerfile.indexOf("RUN npm prune --omit=dev");
    const iRunner = lenhDockerfile.findIndex((d) => /^FROM base AS runner$/.test(d));
    expect(iGenerate).toBeGreaterThan(-1);
    expect(iGenerate).toBeLessThan(iPrune);
    expect(lenhDockerfile.slice(iRunner)).toContain("COPY --from=build --chown=node:node /app ./");
    const dockerignore = dongLenh(doc(".dockerignore"));
    expect(dockerignore, ".dockerignore không được loại prisma.config.ts").not.toContain("prisma.config.ts");
    expect(dockerignore, "client sinh của máy host không được lọt vào context").toContain("src/generated");
  });

  it("CMD gọi thẳng bin của next, không qua npx (npx chặn SIGTERM + tốn RAM vỏ npm exec)", () => {
    const cmd = lenhDockerfile.filter((d) => d.startsWith("CMD"));
    expect(cmd).toEqual(['CMD ["node_modules/.bin/next", "start", "-p", "3000"]']);
  });

  it("mọi `npx` trong lệnh RUN đều --no-install (build thiếu gói thì ĐỎ, không tự tải)", () => {
    const goi = goiNpx(lenhDockerfile.filter((d) => d.startsWith("RUN")).join("\n"));
    expect(goi.length).toBeGreaterThanOrEqual(1);
    for (const { co, bin } of goi) expect(co, `npx ${bin}`).toEqual(["--no-install"]);
  });
});

describe("code + script chỉ import gói có trong dependencies", () => {
  it("mọi import mang giá trị trong src/, scripts/, prisma/seed.ts, next.config.ts, prisma.config.ts ⊆ dependencies ∪ builtin Node", () => {
    // next.config.ts: `next start` nạp nó lúc CHẠY trong ảnh đã prune. prisma.config.ts: CLI
    // `migrate status|deploy`/`db seed` trong container nạp nó (kéo `prisma/config`).
    const files = [...fileTs("src"), ...fileTs("scripts"), "prisma/seed.ts", "next.config.ts", "prisma.config.ts"];
    expect(files.length).toBeGreaterThan(100); // chống quét rỗng xanh giả
    const lech = files.flatMap((f) =>
      importGiaTri(f)
        .map(tenGoi)
        .filter((g): g is string => g !== null && !deps.has(g))
        .map((g) => `${f} → ${g}`),
    );
    expect(lech).toEqual([]);
  });
});

describe("CI job docker: chạy ảnh đã prune, không chỉ dựng", () => {
  const ci = doc(".github/workflows/ci.yml");
  const batDau = ci.search(/^ {2}docker:$/m);
  const sau = ci.slice(batDau + 1).search(/^ {2}[a-z][\w-]*:$/m); // job kế tiếp (nếu có)
  const jobDocker = sau === -1 ? ci.slice(batDau) : ci.slice(batDau, batDau + 1 + sau);
  const anh = "hogikids-app:ci-${{ github.sha }}";

  /** Dòng lệnh trong khối `run: |` của step có tên đúng `ten` (đã bỏ comment, nối dòng tiếp nối). */
  function lenhStep(ten: string): string[] {
    const i = jobDocker.indexOf(`- name: ${ten}\n`);
    expect(i, `thiếu step "${ten}"`).toBeGreaterThan(-1);
    const conLai = jobDocker.slice(i + 1);
    const j = conLai.search(/^ {6}- /m); // step kế tiếp
    const step = j === -1 ? conLai : conLai.slice(0, j);
    const r = step.indexOf("run: |\n");
    expect(r, `step "${ten}" không có run: |`).toBeGreaterThan(-1);
    return dongLenh(step.slice(r + "run: |\n".length));
  }

  /** Chuẩn hoá khoảng trắng để so NGUYÊN khối lệnh (nối dòng `\` để lại 2 dấu cách). */
  const chuanHoa = (dong: string[]) => dong.map((d) => d.replace(/\s+/g, " ").trim());

  it("NGUYÊN khối lệnh 3 step so từng dòng theo thứ tự — chèn `exit 0`/`code=143`/`ok=1` là đỏ", () => {
    expect(chuanHoa(lenhStep("Ảnh đủ công cụ vận hành, không còn devDependencies"))).toEqual([
      `docker run --rm --entrypoint sh ${anh} -c '`,
      "set -e",
      "npx --no-install prisma --version",
      "npx --no-install tsx --version",
      "for p in vitest jsdom shadcn vite @testing-library/react; do",
      'if [ -e "node_modules/$p" ]; then echo "✗ ảnh còn devDependency $p"; exit 1; fi',
      "done",
      "test -e src/generated/prisma/client.ts",
      "test -e prisma.config.ts",
      "test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x",
      String.raw`npx --no-install tsx -e "import(\"@/lib/tao-prisma-client\").then((m) => { if (typeof m.taoPrismaClient !== \"function\") process.exit(1); console.log(\"tsx nạp client Prisma OK\"); })"`,
      String.raw`npx --no-install tsx -e "Promise.all([import(\"@/lib/backup/run-pg-dump\"), import(\"@/lib/backup/assert-plain-sql-only-schema\")]).then(([a, b]) => { if (typeof a.pgDumpArgsFromUrl !== \"function\" || typeof b.assertPlainSqlOnlySchema !== \"function\") process.exit(1); console.log(\"tsx nạp module ③b OK\"); })"`,
      "'",
    ]);
    expect(chuanHoa(lenhStep("Ảnh đã prune chạy Prisma 7 với Postgres thật"))).toEqual([
      `psql "postgresql://ci:ci@localhost:5432/hogikids_ci" -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA IF NOT EXISTS app;'`,
      `docker run --rm --network host -e DATABASE_URL='postgresql://ci:ci@127.0.0.1:5432/hogikids_ci?schema=app' --entrypoint sh ${anh} -c '`,
      "set -e",
      "npx --no-install prisma migrate deploy",
      "npx --no-install prisma migrate status",
      String.raw`npx --no-install tsx -e "import(\"@/lib/tao-prisma-client\").then(async (m) => { const p = m.taoPrismaClient(process.env.DATABASE_URL); const r = await p.\$queryRawUnsafe(\"SELECT 1 AS ok, count(*)::int AS n FROM _prisma_migrations\"); await p.\$disconnect(); if (r[0].ok !== 1 || !(r[0].n > 0)) process.exit(1); console.log(\"client Prisma 7 trong ảnh truy vấn DB OK:\", r[0].n, \"migration\"); })"`,
      "'",
    ]);
    expect(chuanHoa(lenhStep("Ảnh khởi động bằng CMD mặc định và dừng sạch"))).toEqual([
      `docker run -d --name ci-app -e SESSION_SECRET=ci-khong-phai-secret-that-0123456789abcdef0123456789 -e INGEST_SECRET=ci-khong-phai-secret -e DATABASE_URL=postgresql://ci:ci@127.0.0.1:1/ci ${anh}`,
      "ok=0",
      "for i in $(seq 1 60); do",
      "if docker exec ci-app curl -fsS -o /dev/null http://127.0.0.1:3000/dang-nhap; then ok=1; break; fi",
      "sleep 1",
      "done",
      "docker stop -t 15 ci-app >/dev/null",
      "code=$(docker inspect -f '{{.State.ExitCode}}' ci-app)",
      "docker logs ci-app 2>&1 | tail -20",
      '[ "$ok" = 1 ] || { echo "✗ /dang-nhap không lên trong 60 s"; exit 1; }',
      '[ "$code" = 143 ] || { echo "✗ dừng thoát $code, mong 143"; exit 1; }',
    ]);
  });

  it("không bước nào bị tắt/nuốt lỗi và mọi npx đều --no-install", () => {
    expect(batDau).toBeGreaterThan(-1);
    const lenhJob = boComment(jobDocker);
    // `if: false` / `continue-on-error: true` làm bước mới im lặng mà mọi chuỗi lệnh vẫn còn nguyên.
    expect(lenhJob).not.toMatch(/^\s+(?:-\s+)?(?:if|continue-on-error):/m);
    const goi = goiNpx(lenhJob);
    expect(goi.length).toBeGreaterThanOrEqual(3);
    for (const { co, bin } of goi) expect(co, `npx ${bin}`).toEqual(["--no-install"]);
  });

  it("job có Postgres 15 tạm (service) đúng DB mà step Prisma nối tới — không bao giờ DB thật", () => {
    const lenhJob = boComment(jobDocker);
    const khoiService = lenhJob.slice(lenhJob.indexOf("    services:\n"), lenhJob.indexOf("    steps:\n"));
    expect(khoiService).toMatch(/^ {6}postgres:\n {8}image: postgres:15\n/m);
    expect(khoiService).toContain("POSTGRES_DB: hogikids_ci");
    expect(khoiService).toContain("- 5432:5432");
    expect(lenhJob.indexOf("    services:\n")).toBeGreaterThan(-1);
  });

  it("step Prisma: migrate deploy → migrate status → tsx truy vấn thật, trong ảnh vừa dựng, set -e", () => {
    const l = lenhStep("Ảnh đã prune chạy Prisma 7 với Postgres thật");
    const run = l.filter((d) => d.startsWith("docker run "));
    expect(run).toHaveLength(1);
    expect(run[0].replace(/\s+/g, " ").endsWith(`--entrypoint sh ${anh} -c '`)).toBe(true);
    const iSetE = l.indexOf("set -e");
    const iDeploy = l.indexOf("npx --no-install prisma migrate deploy");
    const iStatus = l.indexOf("npx --no-install prisma migrate status");
    const iTsx = l.findIndex((d) => d.startsWith("npx --no-install tsx -e ") && d.includes("taoPrismaClient(process.env.DATABASE_URL)"));
    expect(iSetE).toBeGreaterThan(l.indexOf(run[0]));
    expect(iDeploy).toBeGreaterThan(iSetE);
    expect(iStatus).toBeGreaterThan(iDeploy);
    expect(iTsx).toBeGreaterThan(iStatus);
    expect(l[iTsx]).toContain("process.exit(1)");
    expect(l[iTsx]).toContain("FROM _prisma_migrations");
  });

  it("step công cụ: chạy TRONG ảnh, set -e, đủ từng lệnh kiểm (so nguyên dòng — `echo …` thay lệnh là đỏ)", () => {
    const l = lenhStep("Ảnh đủ công cụ vận hành, không còn devDependencies");
    expect(l[0]).toBe(`docker run --rm --entrypoint sh ${anh} -c '`);
    for (const dong of [
      "set -e",
      "npx --no-install prisma --version",
      "npx --no-install tsx --version",
      "test -e src/generated/prisma/client.ts",
      "test -e prisma.config.ts",
      "test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x",
    ]) {
      expect(l, dong).toContain(dong);
    }
    // Vòng cấm devDeps: đủ tên gói, thân vòng thoát 1 khi còn gói.
    const iFor = l.findIndex((d) => /^for p in .+; do$/.test(d));
    expect(iFor).toBeGreaterThan(-1);
    const goiCam = l[iFor].replace(/^for p in /, "").replace(/; do$/, "").split(/\s+/);
    expect(goiCam).toEqual(expect.arrayContaining(["vitest", "jsdom", "shadcn", "vite", "@testing-library/react"]));
    expect(l[iFor + 1]).toMatch(/^if \[ -e "node_modules\/\$p" \]; then .*exit 1; fi$/);
    expect(l[iFor + 2]).toBe("done");
    // tsx nạp ĐÚNG hai module bước ③b và thoát 1 khi thiếu hàm.
    const tsx = l.find((d) => d.startsWith("npx --no-install tsx -e ") && d.includes("run-pg-dump"));
    expect(tsx).toBeDefined();
    // tsx nạp nhà máy client Prisma 7 (client sinh + adapter pg) — đường seed/rebuild-from-raw trong container.
    const tsxClient = l.find((d) => d.startsWith("npx --no-install tsx -e ") && d.includes("tao-prisma-client"));
    expect(tsxClient).toBeDefined();
    expect(tsxClient).toContain('import(\\"@/lib/tao-prisma-client\\")');
    expect(tsxClient).toContain("process.exit(1)");
    for (const can of [
      'import(\\"@/lib/backup/run-pg-dump\\")',
      'import(\\"@/lib/backup/assert-plain-sql-only-schema\\")',
      "process.exit(1)",
    ]) {
      expect(tsx, can).toContain(can);
    }
  });

  it("step khởi động: CMD mặc định (không override), chờ /dang-nhap, dừng + đọc exit, đòi ok=1 và 143", () => {
    const l = lenhStep("Ảnh khởi động bằng CMD mặc định và dừng sạch");
    const run = l.filter((d) => d.startsWith("docker run "));
    expect(run).toHaveLength(1);
    expect(run[0]).toMatch(/^docker run -d --name ci-app /);
    expect(run[0].endsWith(` ${anh}`), "sau tên ảnh không được có lệnh override CMD").toBe(true);
    expect(run[0]).not.toContain("--entrypoint");
    for (const dong of [
      "if docker exec ci-app curl -fsS -o /dev/null http://127.0.0.1:3000/dang-nhap; then ok=1; break; fi",
      "docker stop -t 15 ci-app >/dev/null",
      "code=$(docker inspect -f '{{.State.ExitCode}}' ci-app)",
    ]) {
      expect(l, dong).toContain(dong);
    }
    expect(l.some((d) => /^\[ "\$ok" = 1 \] \|\| \{ .*exit 1; \}$/.test(d)), "cổng ok=1").toBe(true);
    expect(l.some((d) => /^\[ "\$code" = 143 \] \|\| \{ .*exit 1; \}$/.test(d)), "cổng exit 143").toBe(true);
  });
});

describe("lệnh container `docker compose run … app npx` luôn --no-install", () => {
  it("header scripts/, comment src/, deploy/*.sh, Dockerfile, .env.example (kể cả lệnh nhiều dòng): đúng --no-install + bin ∈ dependencies", () => {
    // deploy/*.sh: câu nhắc lệnh in ra cho người vận hành chép-dán lúc DR (vd restore.sh) cũng phải --no-install.
    const shDeploy = readdirSync(goc("deploy")).filter((t) => t.endsWith(".sh")).map((t) => `deploy/${t}`);
    const nguon = [...fileTs("scripts"), ...fileTs("src"), ...shDeploy, "Dockerfile", ".env.example"];
    const lenh = nguon.flatMap((f) => goiNpxTrongContainer(doc(f)).map((g) => ({ f, ...g })));
    // Ngưỡng chỉ chống quét rỗng — độ phủ nằm ở chỗ MỌI lệnh tìm thấy phải đúng cờ.
    // 3 header script + 1 comment src + 1 comment Dockerfile + 1 dòng seed .env.example + 1 câu nhắc restore.sh
    expect(lenh.length).toBeGreaterThanOrEqual(7);
    expect(lenh.some((l) => l.f === "deploy/restore.sh"), "restore.sh phải nằm trong tập quét").toBe(true);
    for (const { f, co, bin } of lenh) {
      expect(co, `${f}: npx ${bin}`).toEqual(["--no-install"]);
      expect(deps.has(bin), `${f}: ${bin} không thuộc dependencies`).toBe(true);
    }
  });
});
