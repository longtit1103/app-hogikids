import type { z } from "zod";

/**
 * Lỗi zod ĐẦU TIÊN → `{ error, field }` cho `ActionResult` (message đã tiếng Việt sẵn trong schema).
 * Dùng chung cho các file `"use server"` — file đó KHÔNG được export hàm thường (Next chỉ cho export
 * async function), nên helper phải nằm ở file riêng không có chỉ thị "use server".
 *
 * `field` = phần tử đầu của `path` (tên ô trên form) — form dùng nó để tô đỏ đúng ô.
 */
export function mapZodError(error: z.ZodError): { error: string; field?: string } {
  const issue = error.issues[0];
  return { error: issue.message, field: issue.path.length ? String(issue.path[0]) : undefined };
}
