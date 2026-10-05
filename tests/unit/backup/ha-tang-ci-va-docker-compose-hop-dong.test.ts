import { readFileSync } from "node:fs";
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

describe("CI: GITHUB_TOKEN mặc định chỉ đọc", () => {
  it("khai `permissions: contents: read` ở mức workflow", () => {
    const ci = doc(".github/workflows/ci.yml");
    const m = ci.match(/^permissions:\n(?:.*\n)*?\s*contents:\s*read/m);
    expect(m).not.toBeNull();
  });
});
