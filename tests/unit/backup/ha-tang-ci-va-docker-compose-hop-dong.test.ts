import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Soi MÃ NGUỒN docker-compose.yml + deploy/docker-compose.n8n-mau.yml + .github/workflows/ci.yml
 * (KHÔNG soi output chạy thử — bài học cũ: test soi output có thể xanh nhờ đúng cái lỗi nó đang
 * canh, xem lịch sử 23/09 trong lộ trình dự án). Tách khỏi backup-scripts-secret-khong-qua-argv
 * vì hai script bash đó KHÔNG có mặt ở repo public (loại theo EXCLUDE_RE của
 * scripts/publish-public-snapshot.sh) — gộp chung một file làm bản public đỏ.
 */

const goc = (...phan: string[]) => {
  const day = path.dirname(fileURLToPath(import.meta.url));
  return path.join(day, "../../..", ...phan);
};

const doc = (...phan: string[]) => readFileSync(goc(...phan), "utf8");

/** Bỏ dòng comment (bắt đầu bằng # sau khoảng trắng) trước khi so khớp — một assertion khớp
 *  trên nội dung CHƯA lọc comment có thể xanh nhờ VÍ DỤ MINH HOẠ trong lời giải thích thay vì
 *  DÒNG LỆNH THẬT (comment cũng hay nhắc lại đúng chuỗi mà assertion đang tìm). */
const boDongComment = (noiDung: string) =>
  noiDung
    .split("\n")
    .filter((dong) => !/^\s*#/.test(dong))
    .join("\n");

describe("docker-compose.yml: cảnh báo replica + healthcheck", () => {
  it("có comment cấm scale nhiều replica (lockout đăng nhập là Map trong RAM)", () => {
    const compose = doc("docker-compose.yml");
    expect(compose).toMatch(/KHÔNG scale service này ra nhiều replica/);
  });

  it("service app KHÔNG đè CMD: không có `command:`/`entrypoint:` (CMD Dockerfile chạy next trực tiếp, PID 1 = node)", () => {
    const compose = boDongComment(doc("docker-compose.yml"));
    const batDau = compose.search(/^ {2}app:\s*$/m);
    expect(batDau, "thiếu service app").toBeGreaterThan(-1);
    const tuDongSau = compose.indexOf("\n", batDau) + 1; // bỏ dòng `  app:` để regex không tự khớp chính nó
    const sau = compose.slice(tuDongSau).search(/^ {0,2}[A-Za-z][\w-]*:/m); // service/khoá cấp trên kế tiếp
    const khoiApp = sau === -1 ? compose.slice(batDau) : compose.slice(batDau, tuDongSau + sau);
    expect(khoiApp).not.toMatch(/^\s+(?:command|entrypoint):/m);
  });

  it("có ĐÚNG dòng lệnh healthcheck trỏ /dang-nhap (không phải chỉ nhắc tới trong comment)", () => {
    const semComment = boDongComment(doc("docker-compose.yml"));
    expect(semComment).toMatch(/healthcheck:/);
    // Khoá đúng dòng lệnh `test:`, không chỉ dò rời rạc `/dang-nhap` (comment giải thích ở trên
    // nó cũng nhắc "/dang-nhap" — dò rời rạc trên nội dung CHƯA lọc comment sẽ xanh giả nếu ai
    // xoá mất dòng `test:` thật mà giữ nguyên comment).
    expect(semComment).toMatch(
      /test:\s*\["CMD",\s*"curl",\s*"-fsS",\s*"http:\/\/127\.0\.0\.1:3000\/dang-nhap"\]/,
    );
  });
});

describe("deploy/docker-compose.n8n-mau.yml: không phơi LAN + không dùng :latest", () => {
  it("cổng 5678 chỉ bind 127.0.0.1", () => {
    const compose = doc("deploy/docker-compose.n8n-mau.yml");
    expect(compose).toMatch(/"127\.0\.0\.1:5678:5678"/);
    expect(compose).not.toMatch(/^\s*-\s*"5678:5678"\s*$/m);
  });

  it("image ghim tag cụ thể, KHÔNG phải :latest (không khoá cứng số version — số đổi theo host)", () => {
    const compose = doc("deploy/docker-compose.n8n-mau.yml");
    const m = compose.match(/image:\s*docker\.n8n\.io\/n8nio\/n8n:(\S+)/);
    expect(m).not.toBeNull();
    expect(m?.[1]).not.toBe("latest");
  });
});

describe("CI typecheck: bộ test âm script publish chạy offline, không token", () => {
  // Bộ test này chạy git THẬT trên repo fixture; sự cố 28/09 một đột biến của nó đã đi tới push
  // thật. Khoá các hàng rào mạng ở mức MÃ NGUỒN ci.yml: gỡ một lớp là đỏ ở đây trước khi tới runner.
  const ci = doc(".github/workflows/ci.yml");
  const batDau = ci.search(/^ {2}typecheck:$/m);
  const sau = ci.slice(batDau + 1).search(/^ {2}[a-z][\w-]*:$/m);
  const jobTypecheck = sau === -1 ? ci.slice(batDau) : ci.slice(batDau, batDau + 1 + sau);
  const ten = "Bộ test âm script publish public (offline, không token)";

  /** Khối của step tên `ten` (tới step kế tiếp), đã bỏ dòng comment. */
  function khoiStep(): string {
    const i = jobTypecheck.indexOf(`- name: ${ten}\n`);
    expect(i, `thiếu step "${ten}" trong job typecheck`).toBeGreaterThan(-1);
    const conLai = jobTypecheck.slice(i + 1);
    const j = conLai.search(/^ {6}- /m);
    return boDongComment(j === -1 ? conLai : conLai.slice(0, j));
  }

  it("NGUYÊN khối lệnh so từng dòng — thay `bash \"$T\"` bằng echo/exit 0 hay bỏ chặn gh là đỏ", () => {
    const step = khoiStep();
    const r = step.indexOf("run: |\n");
    expect(r, "step không có run: |").toBeGreaterThan(-1);
    const dong = step
      .slice(r + "run: |\n".length)
      .split("\n")
      .map((d) => d.trim())
      .filter(Boolean);
    expect(dong).toEqual([
      "T=scripts/test-publish-public-snapshot.sh",
      "S=scripts/publish-public-snapshot.sh",
      'if [ -f "$T" ] && [ -f "$S" ]; then',
      'CHAN="$RUNNER_TEMP/chan-gh-that"',
      'mkdir -p "$CHAN"',
      String.raw`printf '#!/bin/sh\necho "gh thật bị chặn trong bước này" >&2\nexit 97\n' > "$CHAN/gh"`,
      'chmod +x "$CHAN/gh"',
      'PATH="$CHAN:$PATH" bash "$T"',
      'elif [ ! -f "$T" ] && [ ! -f "$S" ]; then',
      'echo "▸ Bỏ qua: đây là bản snapshot công khai (script publish + bộ test cố ý không có mặt)."',
      "else",
      'echo "✗ Chỉ thiếu MỘT trong hai ($T / $S) — trạng thái không nhất quán." >&2',
      "exit 1",
      "fi",
    ]);
  });

  it("env ép GIT_ALLOW_PROTOCOL=file, có trần thời gian, không bị tắt/nuốt lỗi", () => {
    const step = khoiStep();
    expect(step).toMatch(/^ {8}env:\n(?: {10}.*\n)*? {10}GIT_ALLOW_PROTOCOL: file\n/m);
    expect(step).toMatch(/^ {8}timeout-minutes: [1-9]\n/m);
    expect(step).not.toMatch(/^\s+(?:-\s+)?(?:if|continue-on-error):/m);
  });

  it("job typecheck không cầm token: checkout không giữ credential, không secret/GITHUB_TOKEN/GH_TOKEN", () => {
    const job = boDongComment(jobTypecheck);
    expect(job).toMatch(/- uses: actions\/checkout@v\d+\n {8}with:\n {10}persist-credentials: false\n/);
    expect(job).not.toMatch(/secrets\.|GITHUB_TOKEN|GH_TOKEN|github\.token/);
  });
});

describe("CI job e2e-cong-ghi-prod: chạy đúng lệnh, chỉ khi đụng đường cổng ghi, không cầm secret", () => {
  const ci = doc(".github/workflows/ci.yml");
  const batDau = ci.search(/^ {2}e2e-cong-ghi-prod:$/m);
  const sau = ci.slice(batDau + 1).search(/^ {2}[a-z][\w-]*:$/m); // job kế tiếp (nếu có)
  const job = batDau === -1 ? "" : sau === -1 ? ci.slice(batDau) : ci.slice(batDau, batDau + 1 + sau);
  const jobSemComment = boDongComment(job);
  const TEN_BUOC_LOC = "Xác định có đụng đường cổng ghi không";

  /** Khối của step tên `ten` (tới step kế tiếp), nguyên văn. */
  function khoiStep(ten: string): string {
    const i = job.indexOf(`- name: ${ten}\n`);
    expect(i, `thiếu step "${ten}"`).toBeGreaterThan(-1);
    const conLai = job.slice(i + 1);
    const j = conLai.search(/^ {6}- /m);
    return j === -1 ? conLai : conLai.slice(0, j);
  }

  /** Nội dung khối `run: |` của step lọc đường, đã bỏ phần thụt lề của YAML. */
  function scriptLoc(): string {
    const step = khoiStep(TEN_BUOC_LOC);
    const r = step.indexOf("run: |\n");
    expect(r, "step lọc đường không có run: |").toBeGreaterThan(-1);
    return step
      .slice(r + "run: |\n".length)
      .split("\n")
      .map((d) => d.replace(/^ {10}/, ""))
      .join("\n");
  }

  /** Các mẫu `grep -E` trong heredoc DANH_SACH, theo thứ tự. */
  function mauDuong(): string[] {
    const m = /<<'DANH_SACH'\n([\s\S]*?)\nDANH_SACH\n/.exec(scriptLoc());
    expect(m, "thiếu heredoc DANH_SACH").not.toBeNull();
    return (m as RegExpExecArray)[1].split("\n");
  }

  it("job tồn tại, có trần thời gian hợp lý và chạy ĐÚNG lệnh npm run test:e2e:prod:cong-ghi", () => {
    expect(batDau, "thiếu job e2e-cong-ghi-prod").toBeGreaterThan(-1);
    expect(jobSemComment).toMatch(/^ {4}timeout-minutes: (?:1\d|2\d|30)\n/m);
    const lenh = [...jobSemComment.matchAll(/^ {8}run: (npm run test:e2e:\S+)$/gm)].map((m) => m[1]);
    expect(lenh).toEqual(["npm run test:e2e:prod:cong-ghi"]);
    const pkg = JSON.parse(doc("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:e2e:prod:cong-ghi"]).toBe("playwright test -c playwright.cong-ghi-prod.config.ts");
  });

  it("cùng khuôn setup job e2e: Postgres tạm, TEST_DATABASE_URL khác DATABASE_URL, schema app, migrate + seed, chromium", () => {
    expect(jobSemComment).toMatch(/^ {8}image: postgres:15$/m);
    expect(jobSemComment).toMatch(/^ {6}TZ: Asia\/Ho_Chi_Minh$/m);
    expect(jobSemComment).toMatch(/^ {6}DATABASE_URL: postgresql:\/\/ci:ci@localhost:5432\/postgres\?schema=app$/m);
    expect(jobSemComment).toMatch(/^ {6}TEST_DATABASE_URL: postgresql:\/\/ci:ci@localhost:5432\/hogikids_test\?schema=app$/m);
    for (const lenh of [
      "run: npm ci",
      "run: npx prisma generate",
      "CREATE SCHEMA IF NOT EXISTS app;",
      "npx prisma migrate deploy",
      "npx prisma db seed",
      "npx playwright install --with-deps chromium",
    ]) {
      expect(jobSemComment, `thiếu "${lenh}"`).toContain(lenh);
    }
  });

  it("KHÔNG cầm secret/token và KHÔNG khai biến bật route chỉ-test (config tự đặt) — chạy được ở cả repo public", () => {
    expect(jobSemComment).not.toMatch(/secrets\.|GITHUB_TOKEN|GH_TOKEN|github\.token/);
    expect(job).not.toMatch(/E2E_CONG_GHI/);
    expect(jobSemComment).toMatch(/- uses: actions\/checkout@v\d+\n {8}with:\n {10}fetch-depth: 0\n {10}persist-credentials: false\n/);
  });

  it("danh sách đường lọc đúng NGUYÊN văn, thứ tự cố định — bớt/thêm một đường là đỏ", () => {
    expect(mauDuong()).toEqual([
      "^src/lib/backup/cong-ghi-",
      String.raw`^src/lib/backup/khoa-bao-tri\.ts$`,
      String.raw`^src/lib/backup/khoa-chung-cli\.ts$`,
      String.raw`^src/lib/prisma\.ts$`,
      String.raw`^src/lib/tao-prisma-client\.ts$`,
      "^src/app/api/restore/",
      String.raw`^next\.config\.ts$`,
      String.raw`^src/app/.*\.e2e\.[^/]*$`,
      String.raw`^tests/e2e/cong-ghi-prod\.spec\.ts$`,
      String.raw`^playwright\.cong-ghi-prod\.config\.ts$`,
      String.raw`^tests/helpers/khoa-doc-quyen-db-test\.ts$`,
      String.raw`^playwright\.config\.ts$`,
      String.raw`^tests/e2e/global-setup\.ts$`,
      String.raw`^tests/e2e/test-database-url\.ts$`,
      String.raw`^package-lock\.json$`,
    ]);
  });

  it("mẫu đường khớp file thật cần canh và KHÔNG khớp file na ná", () => {
    const mau = mauDuong().map((m) => new RegExp(m));
    const khop = (f: string) => mau.some((r) => r.test(f));
    for (const f of [
      "src/lib/backup/cong-ghi-toan-cuc.ts",
      "src/lib/backup/cong-ghi-e2e-chi-test.ts",
      "src/lib/backup/khoa-bao-tri.ts",
      "src/lib/backup/khoa-chung-cli.ts",
      "src/lib/prisma.ts",
      "src/lib/tao-prisma-client.ts",
      "src/app/api/restore/route.ts",
      "src/app/api/restore/cat-phien/route.ts",
      "next.config.ts",
      "src/app/e2e-cong-ghi/page.e2e.tsx",
      "src/app/api/e2e-cong-ghi/route.e2e.ts",
      "tests/e2e/cong-ghi-prod.spec.ts",
      "playwright.cong-ghi-prod.config.ts",
      "tests/helpers/khoa-doc-quyen-db-test.ts",
      "playwright.config.ts",
      "tests/e2e/global-setup.ts",
      "tests/e2e/test-database-url.ts",
      "package-lock.json",
    ]) {
      expect(khop(f), `phải khớp: ${f}`).toBe(true);
    }
    for (const f of [
      "src/lib/prismaX.ts",
      "src/lib/backup/khoa-viec-nang.ts",
      "src/lib/backup/run-pg-dump.ts",
      "src/app/page.tsx",
      "src/app/(app)/tong-quan/page.tsx",
      "tests/e2e/auth.spec.ts",
      "next.config.ts.bak",
      "docs/next.config.ts",
    ]) {
      expect(khop(f), `không được khớp: ${f}`).toBe(false);
    }
  });

  it("mọi step sau bước lọc đều chờ `steps.duong.outputs.chay == 'true'` (bước lọc xong thì bỏ qua êm, không đỏ)", () => {
    const i = job.indexOf(`- name: ${TEN_BUOC_LOC}\n`);
    const saLoc = job.slice(i + 1);
    const buoc = saLoc.split(/^ {6}- /m).slice(1); // bỏ phần thân của chính bước lọc
    expect(buoc.length).toBeGreaterThanOrEqual(6);
    for (const b of buoc) {
      expect(b, `bước thiếu điều kiện chạy:\n${b.slice(0, 120)}`).toMatch(/steps\.duong\.outputs\.chay == 'true'/);
    }
    // Bước lọc luôn chạy và không tự nuốt lỗi.
    expect(boDongComment(khoiStep(TEN_BUOC_LOC))).not.toMatch(/^\s+(?:if|continue-on-error):/m);
  });

  describe("hành vi bước lọc đường trên repo tạm", () => {
    let thuMuc = "";
    // Script + file GITHUB_OUTPUT nằm NGOÀI repo tạm — nằm trong là `add -A` commit luôn chúng vào diff.
    let thuMucPhu = "";
    let baseSha = "";

    const chayGit = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: thuMuc,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ALLOW_PROTOCOL: "file" },
      }).trim();

    /** Chạy NGUYÊN script của step; trả về giá trị `chay=` bước ghi vào GITHUB_OUTPUT. */
    function chayBuocLoc(env: Record<string, string>): string {
      const out = path.join(thuMucPhu, "github-output.txt");
      const script = path.join(thuMucPhu, "loc-duong.sh");
      writeFileSync(out, "");
      writeFileSync(script, scriptLoc());
      execFileSync("bash", [script], {
        cwd: thuMuc,
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: thuMucPhu, GITHUB_OUTPUT: out, GIT_CONFIG_GLOBAL: "/dev/null", ...env },
        stdio: "pipe",
      });
      return readFileSync(out, "utf8").trim();
    }

    /** Tạo commit chỉ thêm file `rel`, trả SHA; rồi đưa HEAD về lại nền. */
    function commitFile(rel: string): string {
      mkdirSync(path.dirname(path.join(thuMuc, rel)), { recursive: true });
      writeFileSync(path.join(thuMuc, rel), "x\n");
      chayGit("add", "-A");
      chayGit("commit", "-q", "-m", "c");
      const sha = chayGit("rev-parse", "HEAD");
      chayGit("reset", "-q", "--hard", baseSha);
      return sha;
    }

    function don() {
      rmSync(thuMuc, { recursive: true, force: true });
      rmSync(thuMucPhu, { recursive: true, force: true });
    }

    const choPr = (head: string) => ({ SU_KIEN: "pull_request", SHA_BASE_PR: baseSha, SHA_HEAD_PR: head });

    function dung() {
      thuMuc = mkdtempSync(path.join(tmpdir(), "hk-loc-duong-ci-"));
      thuMucPhu = mkdtempSync(path.join(tmpdir(), "hk-loc-duong-ci-phu-"));
      chayGit("init", "-q", ".");
      chayGit("config", "user.email", "t@example.test");
      chayGit("config", "user.name", "t");
      writeFileSync(path.join(thuMuc, "README.md"), "a\n");
      chayGit("add", "-A");
      chayGit("commit", "-q", "-m", "nen");
      baseSha = chayGit("rev-parse", "HEAD");
    }

    it("PR chỉ đổi file ngoài đường cổng ghi ⇒ chay=false; đổi một file trong đường ⇒ chay=true", () => {
      dung();
      try {
        expect(chayBuocLoc(choPr(commitFile("src/app/page.tsx")))).toBe("chay=false");
        expect(chayBuocLoc(choPr(commitFile("src/lib/prismaX.ts")))).toBe("chay=false");
        expect(chayBuocLoc(choPr(commitFile("src/lib/backup/cong-ghi-toan-cuc.ts")))).toBe("chay=true");
        expect(chayBuocLoc(choPr(commitFile("next.config.ts")))).toBe("chay=true");
        expect(chayBuocLoc(choPr(commitFile("src/app/e2e-cong-ghi/page.e2e.tsx")))).toBe("chay=true");
      } finally {
        don();
      }
    });

    it("bấm tay, push nhánh mới (before toàn số 0), before không còn trong lịch sử ⇒ luôn chạy; push thường lọc theo diff", () => {
      dung();
      try {
        expect(chayBuocLoc({ SU_KIEN: "workflow_dispatch" })).toBe("chay=true");
        const khongDen = { SU_KIEN: "push", SHA_HIEN_TAI: baseSha };
        expect(chayBuocLoc({ ...khongDen, SHA_TRUOC_PUSH: "0".repeat(40) })).toBe("chay=true");
        expect(chayBuocLoc({ ...khongDen, SHA_TRUOC_PUSH: "1".repeat(40) })).toBe("chay=true");
        expect(chayBuocLoc({ SU_KIEN: "push", SHA_TRUOC_PUSH: baseSha, SHA_HIEN_TAI: commitFile("docs/a.md") })).toBe("chay=false");
        expect(chayBuocLoc({ SU_KIEN: "push", SHA_TRUOC_PUSH: baseSha, SHA_HIEN_TAI: commitFile("src/lib/prisma.ts") })).toBe("chay=true");
      } finally {
        don();
      }
    });
  });
});

describe("CI: GITHUB_TOKEN mặc định chỉ đọc", () => {
  it("khai `permissions: contents: read` ở mức workflow", () => {
    const ci = doc(".github/workflows/ci.yml");
    const m = ci.match(/^permissions:\n(?:.*\n)*?\s*contents:\s*read/m);
    expect(m).not.toBeNull();
  });
});
