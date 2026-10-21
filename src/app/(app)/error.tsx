"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Ranh giới lỗi của MỌI trang trong khung đã đăng nhập: một truy vấn hỏng giữa lúc render chỉ làm
 * hỏng phần nội dung, thanh bên + thanh trên vẫn còn nên người dùng bấm sang trang khác được thay vì
 * rơi vào màn lỗi trắng của Next.
 *
 * Chỉ hiện `digest` (mã tham chiếu Next gắn cho lỗi phía server, để tra log) — KHÔNG hiện
 * `error.message`: ở production Next đã che nó, còn ở dev nó có thể chứa câu truy vấn/dữ liệu.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Chỉ ghi tên + mã tham chiếu: message của lỗi server có thể mang câu truy vấn hoặc giá trị tham số.
    console.error("[app] lỗi render trang", error.name, error.digest ?? "");
  }, [error]);

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-5 rounded-xl border border-hairline bg-canvas px-6 py-16 text-center"
    >
      <h1 className="font-serif text-2xl text-ink">Đã có lỗi xảy ra</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Trang không tải được. Bạn thử tải lại; nếu vẫn lỗi, hãy báo kèm mã bên dưới (nếu có).
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground">
          Mã lỗi: <code className="font-mono">{error.digest}</code>
        </p>
      )}
      <Button onClick={reset}>Thử lại</Button>
    </div>
  );
}
