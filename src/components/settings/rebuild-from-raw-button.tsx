"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { dungLaiTuKhoTho } from "@/lib/actions/data-admin";
import { getLatestSync } from "@/lib/actions/sync";
import type { LatestSync } from "@/lib/actions/sync-types";

/** Nhịp hỏi nhật ký đồng bộ — cùng nhịp với nút "Đồng bộ ngay". */
const POLL_MS = 5000;

/** Trần chờ; khớp mốc `withSyncLog` chuyển log RUNNING treo thành ERROR (15 phút). */
const TIMEOUT_MS = 15 * 60_000;

/**
 * "Dựng lại từ kho thô" — đọc lại bản gốc trong kho thô để dựng lại đơn hàng và số liệu Tiền đã về.
 * KHÔNG dựng lại sản phẩm/tồn kho (tồn do đồng bộ + webhook lo, xem `dungLaiGiaoDichTuKhoTho`).
 *
 * CHỈ 1 bước xác nhận (không gõ tên shop): lượt dựng lại chỉ upsert, không xoá gì và chạy lại được
 * bao nhiêu lần cũng ra cùng kết quả — chốt nặng tay ở đây chỉ làm chủ shop ngại bấm đúng nút cần
 * bấm khi số liệu thiếu.
 *
 * KẾT LUẬN THEO NHẬT KÝ, KHÔNG theo lời gọi: lượt quét cả bảng có thể chạy quá ~100s và bị
 * Cloudflare cắt kết nối, lúc đó lời gọi báo lỗi trong khi server vẫn đang chạy. Nên sau khi bấm,
 * component poll `SyncLog` PANCAKE (chỉ nhận log có `startedAt` sau lúc bấm, đã hết RUNNING) — y
 * cách nút "Đồng bộ ngay" làm. Lời gọi về trước thì dùng luôn số liệu chi tiết của nó; hai đường về
 * cùng lúc thì `daKetLuan` bảo đảm chỉ báo 1 lần.
 *
 * Nút bị khoá khi có lượt đồng bộ / dựng lại đang chạy (server cũng từ chối lượt thứ hai).
 */
export function RebuildFromRawButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [latest, setLatest] = useState<LatestSync>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const daKetLuan = useRef(false);

  const clearTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
  }, []);

  const napTrangThai = useCallback(() => {
    void getLatestSync("PANCAKE")
      .then(setLatest)
      .catch(() => {});
  }, []);

  useEffect(() => {
    napTrangThai();
    return clearTimers;
  }, [napTrangThai, clearTimers]);

  /** Chốt kết quả 1 lần duy nhất — lời gọi và vòng poll có thể cùng về. */
  const ketLuan = useCallback(
    (bao: () => void) => {
      if (daKetLuan.current) return;
      daKetLuan.current = true;
      clearTimers();
      setRunning(false);
      bao();
    },
    [clearTimers],
  );

  const dangKhoa = running || latest?.status === "RUNNING";

  function handleOpenChange(next: boolean) {
    // Đang chạy thì không cho đóng — đóng dialog không huỷ được lượt đã gửi đi.
    if (running) return;
    setOpen(next);
    if (next) napTrangThai(); // lượt đồng bộ đêm có thể vừa bắt đầu sau lần nạp trước
  }

  function handleConfirm() {
    const bamLuc = Date.now();
    daKetLuan.current = false;
    setRunning(true);

    pollRef.current = setInterval(() => {
      void getLatestSync("PANCAKE")
        .then((l) => {
          if (!l || new Date(l.startedAt).getTime() <= bamLuc || l.status === "RUNNING") return;
          setLatest(l);
          ketLuan(() => {
            if (l.status === "OK") {
              toast.success("Đã dựng lại xong — xem chi tiết ở khu Kết nối & Đồng bộ");
              setOpen(false);
              router.refresh();
            } else {
              toast.error(l.error ?? "Dựng lại thất bại");
            }
          });
        })
        .catch(() => {});
    }, POLL_MS);

    timeoutRef.current = setTimeout(() => {
      ketLuan(() =>
        toast.error("Lượt dựng lại chưa kết thúc — xem nhật ký ở khu Kết nối & Đồng bộ"),
      );
    }, TIMEOUT_MS);

    // KHÔNG await: mất kết nối giữa chừng không có nghĩa là lượt chạy thất bại, vòng poll ở trên mới
    // là căn cứ kết luận.
    void dungLaiTuKhoTho()
      .then((res) => {
        if (!res.ok) {
          ketLuan(() => toast.error(res.error));
          return;
        }
        const d = res.data;
        ketLuan(() => {
          toast.success(
            `Đã dựng lại ${d.ordersUpserted} đơn và ${d.adsExpensesUpserted} dòng chi tiêu quảng cáo; ` +
              `Tiền đã về: ${d.settlementsUpserted} sao kê, ${d.adsUpserted} khoản quảng cáo, ` +
              `${d.paymentsUpserted} lệnh rút tiền, ${d.shopeeUpserted} dòng ví Shopee`,
          );
          if (d.soCanhBao > 0) {
            toast.warning(`${d.soCanhBao} cảnh báo: ${d.canhBao.join(" · ")}`);
          }
          setOpen(false);
          napTrangThai();
          router.refresh();
        });
      })
      .catch(() => {});
  }

  return (
    <>
      <Button type="button" variant="outline" disabled={dangKhoa} onClick={() => handleOpenChange(true)}>
        {dangKhoa ? "Đang chạy…" : "Dựng lại từ kho thô"}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Dựng lại từ kho thô</DialogTitle>
            <DialogDescription>
              Đọc lại toàn bộ bản gốc đang lưu trong kho thô và dựng lại đơn hàng, số liệu Tiền đã về
              cùng chi tiêu quảng cáo.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              Không xóa gì và bấm lại nhiều lần cũng an toàn. Giá vốn nhập tay, chi phí nhập tay và
              cài đặt giữ nguyên.
            </p>
            <p>
              Sản phẩm và tồn kho <strong className="text-ink">không</strong> bị lượt này chạm tới —
              tồn kho do đồng bộ và webhook Pancake giữ cho khớp.
            </p>
            <p>
              Đơn cũ hơn khoảng thời gian kho thô còn giữ thì không dựng lại được — phần đó chỉ phục
              hồi bản sao lưu mới có. Chi phí nhập tay cũng không dựng lại được.
            </p>
            {running && (
              <p className="text-warning">
                Đang chạy, có thể mất vài phút — đóng trang cũng không sao, lượt chạy vẫn tiếp tục và
                kết quả được ghi vào nhật ký đồng bộ.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={running}
              onClick={() => handleOpenChange(false)}
            >
              Hủy
            </Button>
            <Button type="button" disabled={running} onClick={handleConfirm}>
              {running ? "Đang dựng lại…" : "Dựng lại"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
