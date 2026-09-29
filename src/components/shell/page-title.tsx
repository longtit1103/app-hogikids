import { cn } from "@/lib/utils";

/**
 * Tiêu đề + mô tả đầu trang cho 8 trang MỤC MENU. Ẩn dưới `md`: Topbar đã ghi đúng tên đó, trên
 * điện thoại hai dòng lặp nhau ăn ~1/5 màn hình trước con số đầu tiên (ảnh iPhone thật 26/09).
 * `print:flex` tường minh — bản in không được phụ thuộc bề rộng khổ giấy. Trang con (tên khác
 * Topbar) KHÔNG dùng component này.
 */
export function PageTitle({
  title,
  children,
  className,
}: {
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="page-title" className={cn("hidden flex-col gap-1 md:flex print:flex", className)}>
      <h1 className="font-serif text-2xl text-ink">{title}</h1>
      {children}
    </div>
  );
}
