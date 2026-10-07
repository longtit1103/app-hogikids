"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getLatestSync, getTienDoDongBoNgay, triggerSyncNow } from "@/lib/actions/sync";
import type { LatestSync } from "@/lib/actions/sync-types";
import {
  ketLuanTienDo,
  MA_MOC_NGOAI_DAI,
  thongDiepKetLuan,
  TRAN_MAY_KHACH_MS,
} from "@/lib/ingest/tien-do-dong-bo-ngay";
import { cn } from "@/lib/utils";

const POLL_MS = 5000;

/**
 * Nút "Đồng bộ ngay": hiển thị SyncLog PANCAKE gần nhất + badge OK/Lỗi; bấm → kích webhook n8n
 * rồi poll tiến độ mỗi 5s. Lượt chỉ XONG khi gặp dòng SyncLog của BƯỚC CUỐI workflow
 * (`/api/ingest/dem-gia-von`, `stats.mode`) sau mốc bấm — KHÔNG phải dòng đầu tiên (mỗi trang kéo là
 * một dòng, dòng đầu về khi mới được một trang). Workflow chết giữa chừng ⇒ có lối ra theo trần
 * (`tien-do-dong-bo-ngay.ts`), không quay mãi; bước cuối ERROR ⇒ báo lỗi, không báo "xong".
 *
 * `choPhepDongBo` = người xem có `cai-dat:sua` (server tính, truyền boolean). Thiếu/false ⇒ KHÔNG render
 * gì (cả dòng trạng thái — `getLatestSync` đằng nào cũng đòi quyền cài đặt). Ẩn là tiện dụng; cổng thật
 * là `triggerSyncNow` ở server.
 */
export function SyncNowButton({
  choPhepDongBo = false,
  trongTopbar = false,
}: {
  choPhepDongBo?: boolean;
  /**
   * CHỈ Topbar bật (component dùng ở 4 nơi): dưới md thu thành icon 44px (nút chữ to lặp lại trên
   * mọi màn mà ít khi bấm) và ẩn dòng "Đồng bộ lúc…" ở md–xl (hàng Topbar có sidebar quá chật —
   * xem topbar.tsx). Nơi khác (thẻ Tình trạng đồng bộ, màn chưa có dữ liệu, bảng Lãi/Lỗ) nút nằm
   * trong nội dung, không chật ⇒ giữ nút chữ + dòng trạng thái ở mọi khổ.
   */
  trongTopbar?: boolean;
} = {}) {
  if (!choPhepDongBo) return null;
  return <NutDongBoNgay trongTopbar={trongTopbar} />;
}

function NutDongBoNgay({ trongTopbar }: { trongTopbar: boolean }) {
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
      .then((r) => alive && setLatest(r.ok ? r.data : null))
      .catch(() => {});
    return () => {
      alive = false;
      clearTimers();
    };
  }, [clearTimers]);

  const router = useRouter();

  const onClick = useCallback(async () => {
    setBusy(true);
    const res = await triggerSyncNow();
    if (!res.ok) {
      setBusy(false);
      toast.error(res.error);
      return;
    }
    const { mocBam } = res.data;
    toast.success("Đã gọi đồng bộ — đang chờ n8n…");

    clearTimers();
    // Một lời hỏi một lúc: server action chậm hơn nhịp poll thì không chồng lời hỏi lên nhau.
    let dangHoi = false;
    pollRef.current = setInterval(async () => {
      if (dangHoi) return;
      dangHoi = true;
      try {
        const r = await getTienDoDongBoNgay(mocBam).catch(() => null);
        if (r && !r.ok && r.code === MA_MOC_NGOAI_DAI) {
          // Server từ chối mốc (ngoài dải theo dõi) ⇒ hỏi lại cũng vô ích: dừng, báo rõ.
          clearTimers();
          setBusy(false);
          toast.error(r.error);
          return;
        }
        if (!r?.ok) return; // hỏng lẻ ⇒ hỏi lại nhịp sau; hỏng mãi ⇒ lưới cuối phía máy khách
        const thongDiep = thongDiepKetLuan(ketLuanTienDo(r.data));
        if (!thongDiep) return;

        clearTimers();
        setBusy(false);
        void getLatestSync("PANCAKE")
          .then((l) => {
            if (l.ok) setLatest(l.data);
          })
          .catch(() => {});
        // Nạp lại số của trang đang xem VÀ bỏ bản tải sẵn của các tab (thanh tab dưới tải sẵn
        // `prefetch`, giữ tới 5 phút) — không có dòng này thì "Đồng bộ xong" mà số vẫn cũ. Gọi cả khi
        // lỗi/dừng giữa chừng: phần dữ liệu đã về vẫn là dữ liệu thật.
        if (r.data.soLuot > 0) router.refresh();
        if (thongDiep.muc === "thanh-cong") toast.success(thongDiep.noiDung);
        else if (thongDiep.muc === "canh-bao") toast.warning(thongDiep.noiDung);
        else toast.error(thongDiep.noiDung);
      } finally {
        dangHoi = false;
      }
    }, POLL_MS);
    timeoutRef.current = setTimeout(() => {
      clearTimers();
      setBusy(false);
      toast.error("Không theo dõi được tiến độ đồng bộ — tải lại trang để xem kết quả");
    }, TRAN_MAY_KHACH_MS);
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
