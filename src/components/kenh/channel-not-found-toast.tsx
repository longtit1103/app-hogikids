"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

/**
 * `/kenh/:id` (drill-down, phase sau) redirect về đây kèm `?loi=khong_tim_thay`
 * khi id không hợp lệ (thiết kế 8.1). Bắn toast lỗi 1 lần rồi dọn param khỏi
 * URL — tránh toast lặp lại khi user back/forward hoặc refresh giữ nguyên
 * query cũ. Luôn mount ở page.tsx, tự đọc `?loi=` qua `useSearchParams` (mount-only,
 * giống `date-range-provider.tsx`) thay vì nhận prop — tránh trùng logic parse ở 2 nơi.
 */
export function ChannelNotFoundToast() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("loi") !== "khong_tim_thay") return;

    toast.error("Không tìm thấy kênh");

    const params = new URLSearchParams(searchParams);
    params.delete("loi");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // Intentionally mount-only (deps: []) — chỉ xử lý param có trên URL lúc landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
