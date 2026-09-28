import { timingSafeEqual } from "node:crypto";

/** So sánh chuỗi hằng-thời-gian (tránh timing attack lên bearer). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Xác thực bearer INGEST_SECRET cho mọi endpoint /api/ingest/*.
 * Trả Response 401 nếu sai; `null` nếu hợp lệ (tiếp tục xử lý).
 */
export function requireIngestSecret(req: Request): Response | null {
  const secret = process.env.INGEST_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}
