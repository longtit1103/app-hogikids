"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getLatestSync, triggerSyncNow } from "@/lib/actions/sync";
import type { LatestSync } from "@/lib/actions/sync-types";

const POLL_MS = 5000;
const TIMEOUT_MS = 120_000; // hết cửa sổ chờ n8n → báo chưa phản hồi (KHÔNG báo thành công)

/**
 * Nút "Đồng bộ ngay": hiển thị SyncLog PANCAKE gần nhất + badge OK/Lỗi; bấm → kích webhook n8n
 * rồi poll SyncLog mỗi 5s, CHỈ nhận log có `startedAt > lúc bấm` (không lấy log cũ) đã hết RUNNING.
 */
export function SyncNowButton() {
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
        if (l.status === "OK") toast.success("Đồng bộ xong");
        else toast.error(l.error ?? "Đồng bộ lỗi");
      }
    }, POLL_MS);
    timeoutRef.current = setTimeout(() => {
      clearTimers();
      setBusy(false);
      toast.error("n8n chưa phản hồi — kiểm tra workflow");
    }, TIMEOUT_MS);
  }, [clearTimers]);

  // RUNNING treo do app crash đã được withSyncLog cleanup >15' → không kẹt disabled vĩnh viễn.
  const disabled = busy || latest?.status === "RUNNING";
  const when = latest?.finishedAt ?? latest?.startedAt;

  return (
    <div className="flex shrink-0 items-center gap-3">
      <span className="hidden items-center gap-2 text-sm text-muted-foreground sm:inline-flex">
        {when ? `Đồng bộ lúc ${format(new Date(when), "HH:mm dd/MM")}` : "Chưa đồng bộ"}
        {latest?.status === "OK" && <Badge className="bg-success/15 text-success">OK</Badge>}
        {latest?.status === "ERROR" && (
          <Badge className="bg-error/15 text-error" title={latest.error ?? undefined}>
            Lỗi
          </Badge>
        )}
      </span>
      <Button type="button" size="sm" onClick={onClick} disabled={disabled}>
        {disabled ? "Đang đồng bộ…" : "Đồng bộ ngay"}
      </Button>
    </div>
  );
}
