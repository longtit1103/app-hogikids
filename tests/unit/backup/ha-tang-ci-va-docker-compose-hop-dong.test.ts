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

describe("CI: GITHUB_TOKEN mặc định chỉ đọc", () => {
  it("khai `permissions: contents: read` ở mức workflow", () => {
    const ci = doc(".github/workflows/ci.yml");
    const m = ci.match(/^permissions:\n(?:.*\n)*?\s*contents:\s*read/m);
    expect(m).not.toBeNull();
  });
});
