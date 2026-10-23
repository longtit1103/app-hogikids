/**
 * Đọc thân request thành TEXT với TRẦN tính theo BYTE (byte UTF-8 trên dây, KHÔNG phải số ký tự
 * JS) — dừng đọc ngay khi vượt, không dựng trọn body khổng lồ trong RAM rồi mới so như
 * `await req.text()`.
 *
 * Hai lớp:
 * 1. `Content-Length` khai báo vượt trần ⇒ từ chối luôn, không đọc byte nào.
 * 2. Đọc `req.body` theo chunk, cộng dồn byte; vượt trần ⇒ huỷ luồng, từ chối. Lớp này bắt cả
 *    body chunked (không có `Content-Length`) lẫn header khai THẤP hơn thực tế.
 *
 * Payload hợp lệ ⇒ chuỗi Y HỆT `await req.text()` từng ký tự: cùng bộ giải UTF-8 (bỏ BOM đầu
 * luồng, chuỗi byte hỏng thành U+FFFD), và `stream: true` giữ lại byte dở của ký tự đa byte bị
 * cắt giữa hai chunk để ghép với chunk sau. Điều này sống còn cho ingest: payload Pancake chứa
 * int64 dạng TEXT, đổi một byte là đổi id/tiền.
 *
 * Lỗi đọc luồng (client ngắt giữa chừng) NÉM ra ngoài như `req.text()` — người gọi tự quyết mã trả.
 */
export type KetQuaDocBody =
  | { ok: true; text: string; bytes: number }
  /** `bytes` = số khai trong `Content-Length`, hoặc số byte đã đọc tới lúc vượt trần. */
  | { ok: false; bytes: number };

export async function docBodyCoTran(req: Request, tranByte: number): Promise<KetQuaDocBody> {
  const khaiBao = req.headers.get("content-length")?.trim();
  // Header sai khuôn ⇒ bỏ qua, dựa vào lớp đếm byte khi đọc (không từ chối oan vì header lạ).
  if (khaiBao && /^\d+$/.test(khaiBao)) {
    const n = Number(khaiBao);
    if (n > tranByte) return { ok: false, bytes: n };
  }

  if (req.body === null) return { ok: true, text: "", bytes: 0 };

  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const phan: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > tranByte) {
      // Huỷ để ngừng nhận phần còn lại; lỗi lúc huỷ không đổi kết luận "vượt trần".
      await reader.cancel().catch(() => {});
      return { ok: false, bytes };
    }
    phan.push(decoder.decode(value, { stream: true }));
  }
  phan.push(decoder.decode()); // xả phần byte dở cuối luồng (nếu hỏng ⇒ U+FFFD như req.text())
  return { ok: true, text: phan.join(""), bytes };
}
