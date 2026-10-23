import { describe, expect, it } from "vitest";

import { docBodyCoTran } from "@/lib/ingest/doc-body-co-tran";

/**
 * Đọc thân request có trần BYTE theo luồng — hàm thuần, không DB.
 *
 * Hợp đồng sống còn: payload hợp lệ ra chuỗi Y HỆT `await req.text()` (int64 trong text Pancake —
 * đổi một byte là đổi id/tiền), kể cả khi ký tự đa byte UTF-8 bị cắt giữa hai chunk.
 */
const luong = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });

/** `duplex` bắt buộc khi body là ReadableStream (undici) — chưa có trong kiểu RequestInit của lib.dom. */
const req = (body: BodyInit | null, headers?: Record<string, string>): Request =>
  new Request("http://localhost/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);

const chuoiThat =
  '﻿{"id":"585140898791786238","customer":{"name":"Chị Hoà — bé gái 🎀"},"fee":5839}' + "đ".repeat(40);

describe("docBodyCoTran", () => {
  it("cắt TỪNG BYTE (ký tự đa byte bị chẻ giữa chunk) ⇒ chuỗi y hệt req.text()", async () => {
    const bytes = new TextEncoder().encode(chuoiThat);
    const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
    const mau = await req(bytes).text();

    const kq = await docBodyCoTran(req(luong(chunks)), 10_000);

    expect(kq).toEqual({ ok: true, text: mau, bytes: bytes.length });
    // `text()` bỏ BOM đầu luồng — bộ giải theo luồng phải làm y hệt.
    expect(kq.ok && kq.text.startsWith("{")).toBe(true);
    expect(kq.ok && kq.text.includes("585140898791786238")).toBe(true);
  });

  it("byte UTF-8 hỏng / cụt cuối luồng ⇒ U+FFFD đúng như req.text()", async () => {
    const hong = Uint8Array.of(0x61, 0xff, 0xe1, 0xba, 0x62, 0xe1);
    const mau = await req(hong).text();

    const kq = await docBodyCoTran(req(luong([hong.slice(0, 3), hong.slice(3)])), 100);

    expect(kq.ok && kq.text).toBe(mau);
  });

  it("Content-Length khai vượt trần ⇒ từ chối KHÔNG đọc body", async () => {
    const r = req("x".repeat(20), { "content-length": "20" });

    const kq = await docBodyCoTran(r, 10);

    expect(kq).toEqual({ ok: false, bytes: 20 });
    expect(r.bodyUsed).toBe(false);
  });

  it("không có Content-Length (chunked) mà vượt trần ⇒ dừng đọc, từ chối", async () => {
    const chunk = new Uint8Array(1000);
    let soChunkDaKeo = 0;
    const vohan = new ReadableStream<Uint8Array>({
      pull(c) {
        soChunkDaKeo++;
        c.enqueue(chunk);
      },
    });

    const kq = await docBodyCoTran(req(vohan), 2500);

    expect(kq).toEqual({ ok: false, bytes: 3000 });
    // Luồng vô hạn mà hàm vẫn trả ⇒ đã dừng kéo; không bao giờ dựng trọn body.
    expect(soChunkDaKeo).toBeLessThan(10);
  });

  it("trần tính theo BYTE, không theo ký tự: 'đ' = 2 byte", async () => {
    const s = "đ".repeat(6); // 6 ký tự, 12 byte
    expect((await docBodyCoTran(req(luong([new TextEncoder().encode(s)])), 11)).ok).toBe(false);
    expect(await docBodyCoTran(req(luong([new TextEncoder().encode(s)])), 12)).toEqual({ ok: true, text: s, bytes: 12 });
  });

  it("đúng bằng trần ⇒ nhận; Content-Length sai khuôn ⇒ bỏ qua header, vẫn đếm byte", async () => {
    expect(await docBodyCoTran(req("abc", { "content-length": "3" }), 3)).toEqual({ ok: true, text: "abc", bytes: 3 });
    expect((await docBodyCoTran(req(luong([new TextEncoder().encode("abcd")]), { "content-length": "2x" }), 3)).ok).toBe(false);
  });

  it("không có body ⇒ chuỗi rỗng (như req.text())", async () => {
    expect(await docBodyCoTran(new Request("http://localhost/x"), 10)).toEqual({ ok: true, text: "", bytes: 0 });
  });
});
