import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

// Route gọi getSession() đầu tiên — mock phiên hợp lệ để test đi tới các guard
// file. Unit THUẦN, KHÔNG Postgres: mọi case dưới đều return TRƯỚC bước
// pre-restore backup (pg_dump) nên không exec lệnh pg nào.
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ userId: "test-user" }),
  // Route dùng phép kiểm CÓ soi mốc phiên (thu hồi khi đổi mật khẩu) — mock phải khớp.
  getAuthenticatedUserId: async () => "test-user",
  // Route đẩy mốc phiên sau khi nạp xong — các case dưới đều return trước đó, chỉ cần export tồn tại.
  thuHoiMoiPhien: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/restore/route";

/**
 * Request giả chỉ cần `.formData()` — cố tình KHÔNG đi qua serialize multipart
 * thật (Request(body) sẽ re-parse thành File mới, mất `size` đã patch).
 */
function requestWithFile(file: unknown): Request {
  return {
    formData: async () => ({ get: (key: string) => (key === "file" ? file : null) }),
    // `headers` RỖNG nhưng PHẢI có: từ 2026-09-20 route gọi `chanRequestKhacOrigin(request)` ngay
    // sau cổng phiên, tức nó ĐỌC header trước khi tới các guard upload mà suite này đo. Thiếu
    // trường này thì mọi ca ở đây chết bằng TypeError chứ không phải bằng khẳng định của chính nó.
    // Rỗng = không có `Origin` = cổng fail-open ⇒ suite vẫn đo đúng guard upload, không vô tình đo
    // cổng CSRF (cổng đó có suite riêng `tests/chan-request-khac-origin.test.ts`).
    headers: new Headers(),
  } as unknown as Request;
}

/** File thật (content nhỏ) nhưng shadow getter `size` để giả file khổng lồ. */
function fileWithFakeSize(content: Buffer, size: number): File {
  const f = new File([new Uint8Array(content)], "backup.sql.gz");
  Object.defineProperty(f, "size", { value: size });
  return f;
}

/**
 * Request giả có `Content-Length` — dùng cho lớp guard THỨ NHẤT, chặn TRƯỚC `formData()`.
 * `formData` ném nếu bị gọi: đó chính là điều cần chốt — vượt trần thì không được chạm thân request.
 */
function requestWithContentLength(len: string): Request {
  return {
    formData: async () => {
      throw new Error("formData() KHÔNG được gọi khi Content-Length đã vượt trần");
    },
    headers: new Headers({ "content-length": len }),
  } as unknown as Request;
}

describe("POST /api/restore — guard Content-Length (chặn TRƯỚC khi đọc thân request)", () => {
  it("Content-Length vượt trần → 413 mà KHÔNG gọi formData()", async () => {
    // Cap `file.size` cũ chỉ đo được SAU khi `formData()` đã phân tích trọn thân request — tức sau
    // đúng bước tốn RAM/đĩa. Lớp này chặn từ header.
    const res = await POST(requestWithContentLength(String(201 * 1024 * 1024 + 1)));

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("quá lớn");
  });

  it("thiếu Content-Length → đi tiếp, để cap `file.size` gác (không fail-closed oan)", async () => {
    // Thân chunked không có header này. Từ chối luôn ở đây là cắt nhầm request hợp lệ.
    const nhoHopLe = fileWithFakeSize(Buffer.from("hello"), 1024);
    const res = await POST(requestWithFile(nhoHopLe));

    // `toBe(400)` chứ KHÔNG phải `not.toBe(413)`: khẳng định phủ định cũng xanh khi route chết ở
    // 401/500 trước đó, tức không chứng minh được là đã ĐI QUA guard. 400 = tới được bước nhận diện
    // định dạng (nội dung "hello" không phải gzip/dump).
    expect(res.status).toBe(400);
  });

  it("Content-Length bịa dạng không phải số → đi tiếp, không ném", async () => {
    const nhoHopLe = fileWithFakeSize(Buffer.from("hello"), 1024);
    const req = {
      formData: async () => ({ get: (k: string) => (k === "file" ? nhoHopLe : null) }),
      headers: new Headers({ "content-length": "khong-phai-so" }),
    } as unknown as Request;
    const res = await POST(req);

    expect(res.status).toBe(400); // đi qua guard, chết ở bước nhận diện định dạng — xem ca trên
  });
});

describe("POST /api/restore — guard upload (SEC-H1, không cần DB)", () => {
  it("file quá 200MB → 413, KHÔNG đọc bytes vào RAM", async () => {
    const oversized = fileWithFakeSize(Buffer.from("x"), 200 * 1024 * 1024 + 1);
    const res = await POST(requestWithFile(oversized));

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("quá lớn");
  });

  it("file đúng 200MB (biên) → KHÔNG bị cap chặn (đi tiếp tới detect → 400 vì không phải backup)", async () => {
    // size = đúng ngưỡng nhưng content không phải PGDMP/gzip → phải rơi vào 400
    // "không hợp lệ" của bước detect, KHÔNG phải 413 của cap.
    const atLimit = fileWithFakeSize(Buffer.from("hello"), 200 * 1024 * 1024);
    const res = await POST(requestWithFile(atLimit));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("không hợp lệ");
  });

  it(".tar.gz backup-toàn-server → 400 qua gunzipHead + assertNotArchive, TRƯỚC mọi bước DB", async () => {
    const tar = Buffer.alloc(1024, 0);
    tar.write("./some-file", 0, "ascii");
    tar.write("ustar", 257, "ascii");
    const tarGz = gzipSync(tar);
    const res = await POST(requestWithFile(new File([new Uint8Array(tarGz)], "backup.tar.gz")));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("toàn-server");
  });

  it("thiếu file trong form → 400", async () => {
    const res = await POST(requestWithFile(null));
    expect(res.status).toBe(400);
  });
});
