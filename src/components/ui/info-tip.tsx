"use client";

import { useState } from "react";
import { CircleHelp } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Dấu "?" nhỏ cạnh một nhãn — rê chuột (hoặc chạm trên điện thoại) mới hiện lời
 * giải thích. Dùng cho chú thích DÀI mà để lộ thiên thì làm rối bảng.
 *
 * `title` thuần của trình duyệt không hiện trên điện thoại và không ai biết là có
 * chú thích ở đó, còn ghi thẳng ra màn thì mỗi dòng dài thêm một dòng phụ.
 *
 * Vì sao tự lo hover thay vì để thư viện làm: Popover của Base UI 1.6 KHÔNG có
 * `openOnHover` (đã thử, `tsc` báo prop không tồn tại), còn Tooltip thì không mở
 * được bằng chạm. Nên trigger giữ hành vi mặc định (bấm/chạm để mở) và hover chỉ
 * là lớp thêm cho chuột.
 *
 * `pointerType === "mouse"` là chỗ quan trọng: trình duyệt di động bắn kèm sự
 * kiện chuột GIẢ trước mỗi cú chạm, không lọc thì chạm sẽ "mở rồi đóng" ngay lập
 * tức — tức chú thích không bao giờ xem được trên điện thoại.
 */
export function InfoTip({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Giải thích: ${label}`}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setOpen(false);
        }}
        className={cn(
          "inline-flex shrink-0 rounded-full text-muted-foreground/70 transition-colors hover:text-ink focus-visible:text-ink print:hidden",
          className
        )}
      >
        <CircleHelp className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-64 text-xs leading-relaxed">{children}</PopoverContent>
    </Popover>
  );
}
