import { FileDown } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Nút "Xuất Excel" tab Sổ quỹ (dòng chạy) — LINK tới route server `/api/export/so-quy?ky=yyyy-MM`
 * (spec phân quyền §4.3: file dựng ở server, qua cổng `tai-chinh-so-quy:xem` ∧ `xuat-du-lieu`). Chỉ render
 * khi có số để xuất (nhánh `CO_SO` của `SoQuyDongChay`); controller (`so-quy-dong-chay-tab.tsx`) tự quyết
 * ẩn/không gắn nút này ở hai nhánh còn lại. `ky` = khoá kỳ đang xem (`yyyy-MM`).
 *
 * `choPhepXuat` false (thiếu `xuat-du-lieu`) ⇒ không render — route vẫn tự trả 403 nếu thiếu quyền.
 * Server component (không `"use client"`): chỉ là một link, không dữ liệu sổ quỹ nào đi xuống trình duyệt.
 */
export function SoQuyXuatExcelButton({ ky, choPhepXuat }: { ky: string; choPhepXuat: boolean }) {
  if (!choPhepXuat) return null;
  return (
    <a
      href={`/api/export/so-quy?${new URLSearchParams({ ky }).toString()}`}
      download
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "print:hidden")}
    >
      <FileDown className="size-4" />
      Xuất Excel
    </a>
  );
}
