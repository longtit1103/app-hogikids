import { cn } from "@/lib/utils";

/**
 * Khối xám giữ chỗ trong lúc chờ server trả trang. Chỉ nhấp nháy khi người dùng không bật
 * "giảm chuyển động" (`motion-safe`). Thuần trang trí ⇒ `aria-hidden`; vùng bao ngoài tự báo
 * trạng thái đang tải cho trình đọc màn hình.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("rounded-xl bg-surface-card motion-safe:animate-pulse", className)} />;
}
