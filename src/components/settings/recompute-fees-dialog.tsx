"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { countRecomputableOrders, recomputeFeesInRange } from "@/lib/actions/settings-channels";
import type { DateRange } from "@/lib/date-range";

const QUERY_DATE_FORMAT = "yyyy-MM-dd";

/** yyyy-MM-dd → biên [from 00:00, to 00:00] giờ VN; action tự endOfDay(to). */
function buildRange(fromStr: string, toStr: string): DateRange | null {
  if (!fromStr || !toStr) return null;
  const from = new Date(`${fromStr}T00:00:00+07:00`);
  const to = new Date(`${toStr}T00:00:00+07:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
  return { from, to };
}

/**
 * "Tính lại phí kỳ này": chọn Từ/Đến ngày NGAY trong dialog (mặc định đầu→cuối
 * tháng hiện tại — màn Cài đặt KHÔNG có date-range picker toàn cục nên không đọc
 * DateRangeProvider). Đổi range → đếm live số đơn Facebook/Website sẽ tính lại;
 * xác nhận → recompute (Shopee/TikTok giữ phí THẬT, không hoàn tác).
 */
export function RecomputeFeesDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fromStr, setFromStr] = useState("");
  const [toStr, setToStr] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function handleOpenChange(next: boolean) {
    if (next) {
      const now = new Date();
      setFromStr(format(startOfMonth(now), QUERY_DATE_FORMAT));
      setToStr(format(endOfMonth(now), QUERY_DATE_FORMAT));
      setCount(null);
    }
    setOpen(next);
  }

  // Đếm live mỗi khi range đổi (khi dialog mở). Bỏ kết quả cũ khi range đổi tiếp.
  useEffect(() => {
    if (!open) return;
    const range = buildRange(fromStr, toStr);
    if (!range) {
      setCount(null);
      return;
    }
    let cancelled = false;
    setCounting(true);
    countRecomputableOrders(range)
      .then((res) => {
        if (cancelled) return;
        setCount(res.ok ? res.data.count : null);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      })
      .finally(() => {
        if (!cancelled) setCounting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, fromStr, toStr]);

  async function handleConfirm() {
    const range = buildRange(fromStr, toStr);
    if (!range) return;
    setSubmitting(true);
    try {
      const res = await recomputeFeesInRange(range);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã tính lại phí cho ${res.data.updated} đơn`);
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Không tính lại được — kiểm tra kết nối");
    } finally {
      setSubmitting(false);
    }
  }

  const range = buildRange(fromStr, toStr);
  const fromLabel = range ? format(range.from, "dd/MM") : "—";
  const toLabel = range ? format(range.to, "dd/MM") : "—";
  const hasNone = count === 0;

  return (
    <>
      <Button type="button" variant="outline" onClick={() => handleOpenChange(true)}>
        Tính lại phí kỳ này
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Tính lại phí kỳ này</DialogTitle>
            <DialogDescription>
              Áp % hiện tại cho phí sàn ước tính của đơn Facebook/Website trong kỳ đã chọn.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="recompute-from">
                Từ ngày
              </label>
              <Input
                id="recompute-from"
                type="date"
                value={fromStr}
                max={toStr || undefined}
                onChange={(e) => setFromStr(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="recompute-to">
                Đến ngày
              </label>
              <Input
                id="recompute-to"
                type="date"
                value={toStr}
                min={fromStr || undefined}
                onChange={(e) => setToStr(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-lg border border-hairline bg-surface-soft p-3 text-sm text-ink">
            {!range ? (
              <span className="text-muted-foreground">Chọn khoảng ngày hợp lệ.</span>
            ) : counting || count === null ? (
              <span className="text-muted-foreground">Đang đếm số đơn…</span>
            ) : hasNone ? (
              <span className="text-muted-foreground">Không có đơn nào cần tính lại trong kỳ.</span>
            ) : (
              <>
                Tính lại phí ước tính cho <strong>{count}</strong> đơn (Facebook/Website) từ{" "}
                <strong>{fromLabel}</strong> đến <strong>{toLabel}</strong> theo % hiện tại. Đơn
                Shopee/TikTok giữ phí thật từ Pancake — không đổi.{" "}
                <span className="text-error">Không hoàn tác được.</span>
              </>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Hủy
            </Button>
            <Button
              type="button"
              disabled={submitting || counting || !range || hasNone || count === null}
              onClick={handleConfirm}
            >
              {submitting ? "Đang tính lại…" : "Tính lại"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
