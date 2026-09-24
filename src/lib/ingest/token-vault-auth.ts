import { timingSafeEqual } from "node:crypto";

/**
 * Bearer RIÊNG cho hai route kho token OAuth (`/api/ingest/meta-token`, `/api/ingest/tiktok-token`).
 *
 * VÌ SAO TÁCH (21/09/2026, audit bảo mật mục M-02): trước đây cả hai route dùng chung
 * `INGEST_SECRET` với 7 route ingest khác. Nhưng `INGEST_SECRET` là khoá VẠN NĂNG theo nghĩa xấu —
 * nó nằm trong mọi workflow n8n, trong `Setting.n8nIngestSecret`, và lọt `ps aux` mỗi lần một
 * script chạy tay `curl -H "Authorization: Bearer ..."`. Hai route này thì KHÁC hẳn 7 route kia:
 * chúng trả về **token OAuth nguyên văn** của Meta và TikTok Shop (gồm cả refresh token). Đọc được
 * một secret ingest lẽ ra chỉ cho phép BƠM dữ liệu vào Bronze, không cho phép RÚT chìa khoá của
 * 4 nền tảng ra.
 *
 * FALLBACK MỘT NHỊP: bật `TOKEN_VAULT_FALLBACK_INGEST=1` thì route nhận cả `INGEST_SECRET` như cũ.
 * Đó là cầu để deploy không gãy — app lên trước, workflow n8n cập nhật sau. Gỡ biến này ngay khi
 * đã đo 3 workflow chạy 200 bằng secret mới; còn để là M-02 vẫn hở nguyên.
 */

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** true khi cầu tương thích đang mở — tách ra để test đọc được ý định, không phải so chuỗi env rải rác. */
export function dangMoCauTuongThichIngest(): boolean {
  return process.env.TOKEN_VAULT_FALLBACK_INGEST === "1";
}

/**
 * Trả `Response` 401 nếu bearer sai, `null` nếu hợp lệ.
 *
 * Thiếu `TOKEN_VAULT_SECRET` ⇒ **từ chối tất**, trừ khi cầu tương thích đang mở. Fail-closed ở đây
 * là cố ý: env thiếu mà route vẫn mở bằng khoá cũ nghĩa là bản vá này im lặng thành no-op.
 */
export function requireTokenVaultSecret(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const vaultSecret = process.env.TOKEN_VAULT_SECRET;
  if (vaultSecret && safeEqual(auth, `Bearer ${vaultSecret}`)) return null;

  if (dangMoCauTuongThichIngest()) {
    const ingestSecret = process.env.INGEST_SECRET;
    if (ingestSecret && safeEqual(auth, `Bearer ${ingestSecret}`)) {
      // Ồn ào có chủ đích: log này là cách DUY NHẤT biết còn ai đang đi đường cũ trước khi gỡ cầu.
      console.warn("[token-vault] nhận INGEST_SECRET qua cầu tương thích — cập nhật phía gọi rồi gỡ TOKEN_VAULT_FALLBACK_INGEST");
      return null;
    }
  }

  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}
