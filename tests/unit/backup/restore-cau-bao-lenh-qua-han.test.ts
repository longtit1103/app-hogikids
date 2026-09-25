import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Câu báo khi một lệnh pg bị dừng vì QUÁ HẠN phải nói ĐÚNG BẢN CHẤT của bước vừa chết.
 *
 * Trong 6 chỗ `runPgClient` được gọi thì chỉ 2 bước NẠP ghi được dữ liệu (`pg_restore <dump>` và
 * `psql -f <sql>`). Bốn câu ngắn còn lại — `pg_restore -l` đọc mục lục trong FILE (không mở kết nối
 * DB), câu SELECT hỏi quyền tạo schema, câu `DROP SCHEMA` mà lỗi lan ra trước khi xoá, và câu GRANT
 * cấp lại quyền đọc cho n8n (chạy SAU khi nạp xong) — tự chúng không để lại bản nạp dở. Doạ "dữ
 * liệu có thể đã nạp dở" ở mấy ca đó là xui chủ shop đi lùi về `pre-restore-*.dump` trong khi thử
 * lại là xong, tức đổi một lần thử lại vô hại lấy một lần mất dữ liệu thật. Ngược lại, khẳng định
 * "chưa có gì bị đổi trong DB" cũng sai với bước GRANT — nên câu báo chỉ nói về CHÍNH LỆNH đó.
 *
 * Không chạy pg thật: chặn ở `execFile` để tự dựng đúng lỗi "bị giết vì quá hạn" (`killed = true`).
 */
const gia = vi.hoisted(() => {
  /** Kịch bản theo BƯỚC, không theo dòng lệnh đầy đủ — mỗi ca chỉ khai đúng bước nó quan tâm. */
  const ketQua = new Map<string, { stdout: string } | Error>();
  const buoc = (cmd: string, args: string[]): string => {
    if (args[0] === "-l") return `${cmd} doc-muc-luc`;
    if (args.includes("-c")) return `${cmd} cau-ngan`;
    return `${cmd} nap`;
  };
  return { ketQua, buoc };
});

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, kq?: { stdout: string; stderr: string }) => void,
  ) => {
    const buoc = gia.buoc(cmd, args);
    const kq = gia.ketQua.get(buoc);
    if (kq === undefined) {
      cb(new Error(`Test chưa khai kịch bản cho bước "${buoc}"`));
      return;
    }
    if (kq instanceof Error) cb(kq);
    else cb(null, { stdout: kq.stdout, stderr: "" });
  },
}));

import { giay, HAN_LENH_NHANH_MS, HAN_NAP_PHUC_HOI_MS } from "@/lib/backup/han-chay-lenh-pg";
import { runRestore } from "@/lib/backup/run-restore";

/** Chuỗi CHỈ được ra console server — lọt vào câu trả về client là rò rỉ hạ tầng. */
const STDERR_NHAY_CAM =
  'pg_restore: error: connection to server at "supabase-db" (172.18.0.5) failed: FATAL: role "postgres" does not exist';

/**
 * Đúng hình dạng lỗi `execFile` trả khi tự bắn SIGTERM vì hết `timeout`.
 *
 * Mang theo `stderr` NHẠY CẢM dù SIGTERM thường để `stderr` rỗng thật (comment ở `run-restore.ts`
 * nói đúng thực tế đó) — cố ý viết lỗi giả KHÁC thực tế để test không mù: nếu code vô tình ghép
 * `stderr` vào message ném lên (thay vì chỉ `console.error`), assertion "không chứa" phải bắt được.
 */
function loiQuaHan(): Error {
  return Object.assign(new Error("Command failed"), {
    killed: true,
    signal: "SIGTERM",
    stderr: STDERR_NHAY_CAM,
  });
}

/** File `.dump` hợp lệ ở mức magic — đủ để `runRestore` đi vào nhánh custom. */
const DUMP = Buffer.from("PGDMP\x01noi-dung-gia");

/** Bắt lỗi ra để soi từng vế của câu báo (assert theo regex thì không nói được "KHÔNG chứa"). */
async function loiKhiPhucHoi(): Promise<string> {
  const err = await runRestore(DUMP).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

beforeEach(() => {
  gia.ketQua.clear();
  // Kết nối không bao giờ mở (execFile đã bị chặn) — URL giả chỉ để `parsePgUrl` có schema đích.
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@db-gia:5432/postgres?schema=app");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("câu báo quá hạn nói đúng bước nào có thể làm dữ liệu nạp dở", () => {
  it("bước NẠP quá hạn → cảnh báo nạp dở + chỉ đúng hạn của bước nạp", async () => {
    gia.ketQua.set("pg_restore doc-muc-luc", { stdout: "" }); // mục lục rỗng = không có object lạ
    gia.ketQua.set("pg_restore nap", loiQuaHan());

    const cau = await loiKhiPhucHoi();

    expect(cau).toContain(`quá hạn ${giay(HAN_NAP_PHUC_HOI_MS)}`);
    expect(cau).toContain("dữ liệu có thể đã nạp dở");
    expect(cau).not.toContain("supabase-db");
    expect(cau).not.toContain("172.18");
    expect(cau).not.toContain("FATAL");
  });

  it("ĐỌC MỤC LỤC quá hạn → KHÔNG doạ nạp dở: `pg_restore -l` chỉ đọc file, chưa ghi gì", async () => {
    gia.ketQua.set("pg_restore doc-muc-luc", loiQuaHan());

    const cau = await loiKhiPhucHoi();

    expect(cau).toContain(`quá hạn ${giay(HAN_LENH_NHANH_MS)}`);
    expect(cau).toContain("còn nguyên vẹn");
    expect(cau).toContain("thử lại được");
    expect(cau).not.toContain("nạp dở");
    // Bước này còn KHÔNG mở kết nối DB, nên vế "có phiên khác giữ khoá" cũng là chỉ sai hướng.
    expect(cau).not.toContain("giữ khoá");
    expect(cau).not.toContain("supabase-db");
    expect(cau).not.toContain("172.18");
    expect(cau).not.toContain("FATAL");
  });

  it("bước GRANT quá hạn (chạy SAU khi nạp xong) → phục hồi VẪN thành công, câu log không nói dối", async () => {
    gia.ketQua.set("pg_restore doc-muc-luc", { stdout: "" });
    gia.ketQua.set("pg_restore nap", { stdout: "" });
    gia.ketQua.set("psql cau-ngan", loiQuaHan()); // nhánh custom chỉ có đúng 1 câu ngắn: GRANT
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    // Quyền đọc của n8n hỏng KHÔNG được làm lượt phục hồi báo thất bại — báo thất bại là xui chủ
    // shop lùi về `pre-restore-*.dump`, tức vứt đúng dữ liệu vừa cứu được vì một quyền đọc.
    await expect(runRestore(DUMP)).resolves.toEqual({ format: "custom" });

    const cau = log.mock.calls.flat().join(" ");
    expect(cau).toContain("KHÔNG cấp lại được quyền đọc");
    // Bước này chạy SAU khi nạp: "chưa có gì bị đổi trong DB" sẽ là nói dối (schema vừa thay sạch),
    // còn "nạp dở" thì ngược lại — doạ sai. Câu đúng chỉ nói về CHÍNH LỆNH vừa chết.
    expect(cau).toContain("còn nguyên vẹn");
    expect(cau).not.toContain("nạp dở");
    expect(cau).not.toContain("chưa có gì bị đổi trong DB");
    log.mockRestore();
  });

  it("bước nạp thất bại vì lý do KHÁC (không phải quá hạn) → câu báo cố định, KHÔNG kèm stderr", async () => {
    gia.ketQua.set("pg_restore doc-muc-luc", { stdout: "" });
    gia.ketQua.set(
      "pg_restore nap",
      Object.assign(new Error("exit 1"), { code: 1, killed: false, stderr: STDERR_NHAY_CAM }),
    );

    const cau = await loiKhiPhucHoi();

    expect(cau).toContain("pg_restore thất bại");
    expect(cau).not.toContain("quá hạn");
    expect(cau).not.toContain("supabase-db");
    expect(cau).not.toContain("172.18");
    expect(cau).not.toContain("FATAL");
  });
});
