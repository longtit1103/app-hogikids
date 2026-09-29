"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getLatestSync, triggerSyncNow } from "@/lib/actions/sync";
import type { LatestSync } from "@/lib/actions/sync-types";
import { cn } from "@/lib/utils";

const POLL_MS = 5000;
const TIMEOUT_MS = 120_000; // hết cửa sổ chờ n8n → báo chưa phản hồi (KHÔNG báo thành công)

/**
 * Nút "Đồng bộ ngay": hiển thị SyncLog PANCAKE gần nhất + badge OK/Lỗi; bấm → kích webhook n8n
 * rồi poll SyncLog mỗi 5s, CHỈ nhận log có `startedAt > lúc bấm` (không lấy log cũ) đã hết RUNNING.
 */
export function SyncNowButton({
  trongTopbar = false,
}: {
  /**
   * CHỈ Topbar bật (component dùng ở 4 nơi): dưới md thu thành icon 44px (nút chữ to lặp lại trên
   * mọi màn mà ít khi bấm) và ẩn dòng "Đồng bộ lúc…" ở md–xl (hàng Topbar có sidebar quá chật —
   * xem topbar.tsx). Nơi khác (thẻ Tình trạng đồng bộ, màn chưa có dữ liệu, bảng Lãi/Lỗ) nút nằm
   * trong nội dung, không chật ⇒ giữ nút chữ + dòng trạng thái ở mọi khổ.
   */
  trongTopbar?: boolean;
} = {}) {
  const [latest, setLatest] = useState<LatestSync>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
  }, []);

  useEffect(() => {
    let alive = true;
    void getLatestSync("PANCAKE")
      .then((l) => alive && setLatest(l))
      .catch(() => {});
    return () => {
      alive = false;
      clearTimers();
    };
  }, [clearTimers]);

  const router = useRouter();

  const onClick = useCallback(async () => {
    const clickedAt = Date.now();
    setBusy(true);
    const res = await triggerSyncNow();
    if (!res.ok) {
      setBusy(false);
      toast.error(res.error);
      return;
    }
    toast.success("Đã gọi đồng bộ — đang chờ n8n…");

    clearTimers();
    pollRef.current = setInterval(async () => {
      const l = await getLatestSync("PANCAKE").catch(() => null);
      if (l && new Date(l.startedAt).getTime() > clickedAt && l.status !== "RUNNING") {
        setLatest(l);
        setBusy(false);
        clearTimers();
        // Nạp lại số của trang đang xem VÀ bỏ bản tải sẵn của các tab (thanh tab dưới tải sẵn
        // `prefetch`, giữ tới 5 phút) — không có dòng này thì "Đồng bộ xong" mà số vẫn cũ.
        router.refresh();
        if (l.status === "OK") toast.success("Đồng bộ xong");
        else toast.error(l.error ?? "Đồng bộ lỗi");
      }
    }, POLL_MS);
    timeoutRef.current = setTimeout(() => {
      clearTimers();
      setBusy(false);
      toast.error("n8n chưa phản hồi — kiểm tra workflow");
    }, TIMEOUT_MS);
  }, [clearTimers, router]);

  // RUNNING treo do app crash đã được withSyncLog cleanup >15' → không kẹt disabled vĩnh viễn.
  const disabled = busy || latest?.status === "RUNNING";
  const when = latest?.finishedAt ?? latest?.startedAt;

  return (
    // Topbar: một hàng không co (`shrink-0`). Trong thẻ Dashboard: được XUỐNG DÒNG — ở khổ 1024–1279
    // thẻ chỉ ~235px mà "Đồng bộ lúc HH:mm dd/MM" + nhãn + nút cần ~318px ⇒ từng đẩy cả trang tràn ngang.
    <div className={cn("flex items-center", trongTopbar ? "shrink-0 gap-3" : "min-w-0 flex-wrap gap-x-3 gap-y-2")}>
      <span
        className={cn(
          "hidden items-center gap-2 text-sm text-muted-foreground sm:inline-flex",
          trongTopbar && "md:hidden xl:inline-flex",
        )}
      >
        {when ? `Đồng bộ lúc ${format(new Date(when), "HH:mm dd/MM")}` : "Chưa đồng bộ"}
        {latest?.status === "OK" && <Badge className="bg-success/15 text-success">OK</Badge>}
        {latest?.status === "ERROR" && (
          <Badge className="bg-error/15 text-error" title={latest.error ?? undefined}>
            Lỗi
          </Badge>
        )}
      </span>
      {/* Mobile (chỉ Topbar): icon — nút chữ to ở mọi màn mà ít khi bấm (ảnh iPhone 26/09). */}
      {trongTopbar && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClick}
          disabled={disabled}
          aria-busy={disabled}
          aria-label={disabled ? "Đang đồng bộ" : "Đồng bộ ngay"}
          className="size-11 md:hidden"
        >
          <RefreshCw aria-hidden="true" className={cn("size-5", disabled && "motion-safe:animate-spin")} />
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        onClick={onClick}
        disabled={disabled}
        aria-busy={disabled}
        className={cn(trongTopbar && "hidden md:inline-flex")}
      >
        {disabled ? "Đang đồng bộ…" : "Đồng bộ ngay"}
      </Button>
    </div>
  );
}
