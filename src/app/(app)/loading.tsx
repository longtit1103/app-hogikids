import { Skeleton } from "@/components/ui/skeleton";

/**
 * Khung chờ CHUNG cho mọi trang trong app. Không có file này thì bấm tab/mục menu là màn hình
 * đứng im tới khi server tính xong TOÀN BỘ trang mới (Tài chính/Dashboard truy vấn nhiều) ⇒
 * cảm giác bấm không ăn. Có nó: Next đổi màn NGAY lúc bấm (tiêu đề Topbar + tab đổi theo địa
 * chỉ mới), số liệu thế chỗ khung khi về. Next còn tải sẵn khung này cho các link đang hiện,
 * nên cú chuyển không phải chờ mạng.
 */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" data-testid="khung-cho-trang" className="flex flex-col gap-4">
      <span className="sr-only">Đang tải…</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-32" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  );
}
