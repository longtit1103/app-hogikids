"use client";

/**
 * Lưới cuối cùng: lỗi ném ngay từ layout gốc (hoặc từ chính ranh giới `(app)/error.tsx`) — lúc đó
 * không còn khung nào để vẽ, nên thành phần này TỰ dựng `<html><body>`. Không dùng component UI, font
 * hay class Tailwind của app vì chúng có thể chính là thứ vừa hỏng; chỉ style inline tối thiểu.
 * `digest` là mã tham chiếu Next gắn cho lỗi phía server — KHÔNG hiện `error.message` (có thể mang dữ liệu).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="vi">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 16,
          textAlign: "center",
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#faf9f5",
          color: "#141413",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 500 }}>Đã có lỗi xảy ra</h1>
        <p style={{ margin: 0, maxWidth: 360, fontSize: 14, color: "#6c6a64" }}>
          Ứng dụng gặp sự cố nghiêm trọng. Bạn thử tải lại; nếu vẫn lỗi, hãy báo kèm mã bên dưới (nếu có).
        </p>
        {error.digest && (
          <p style={{ margin: 0, fontSize: 12, color: "#6c6a64" }}>
            Mã lỗi: <code>{error.digest}</code>
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          style={{
            height: 36,
            padding: "0 16px",
            border: "none",
            borderRadius: 8,
            background: "#cc785c",
            color: "#ffffff",
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Thử lại
        </button>
      </body>
    </html>
  );
}
