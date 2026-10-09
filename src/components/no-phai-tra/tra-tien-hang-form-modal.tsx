"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { traTienHangGop } from "@/lib/actions/tra-tien-hang";
import { formatVnd } from "@/lib/format";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import type { PhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";

import { dongPhanBoGui, goiYPhanBoCuTruoc, tongPhanBo } from "./phan-bo-tra-gop";

/**
 * Modal "Trả tiền hàng" — MỘT lượt trả N phiếu nhập (spec §5.3). Gõ TỔNG tiền + ngày trả, bảng phiếu
 * còn nợ tự gợi ý phân bổ CŨ TRƯỚC (sửa tay được). Tổng phân bổ ≠ tổng ⇒ nút Ghi khoá + câu đỏ nói
 * thiếu/thừa bao nhiêu.
 *
 * - `yeuCauId` (uuid) sinh MỖI LẦN mở modal: gửi lại cùng mã + cùng nội dung (mất phản hồi, bấm lại) ⇒
 *   server trả `DA_GHI_ROI` — ở đây hiện "đã ghi rồi" chứ không báo lỗi.
 * - `vanTay` là của danh sách phiếu lúc trang render: có ai ghi/trả trong lúc modal mở ⇒ server từ chối
 *   `DANH_SACH_DA_DOI` ⇒ đóng modal + tải lại, chưa ghi gì.
 * - Phiếu đã huỷ không hiện trong danh sách chọn (server cũng chặn `PHIEU_DA_HUY`).
 */
export function TraTienHangFormModal({
  open,
  onOpenChange,
  phieu,
  vanTay,
  mocM,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Mọi phiếu (đã sắp cũ → mới) — modal tự lọc phiếu còn nợ. */
  phieu: readonly PhieuConNo[];
  vanTay: string;
  /** Mốc bật theo dõi nợ `yyyy-MM-dd`: ngày trả không được trước. */
  mocM: string;
}) {
  const router = useRouter();
  const homNay = format(new Date(), "yyyy-MM-dd");
  const conNo = useMemo(() => phieu.filter((p) => !p.daHuy && p.conNo > 0), [phieu]);

  const [yeuCauId, setYeuCauId] = useState("");
  const [tong, setTong] = useState(0);
  const [ngay, setNgay] = useState(homNay);
  const [moTa, setMoTa] = useState("");
  const [phanBo, setPhanBo] = useState<Record<string, number>>({});
  // Sau khi chủ shop sửa tay một ô phân bổ thì đổi TỔNG không ghi đè lên số họ vừa chỉnh nữa.
  const [daSuaTay, setDaSuaTay] = useState(false);
  const [loi, setLoi] = useState<{ phanBo?: string; ngay?: string; tong?: string }>({});
  const [dangLuu, setDangLuu] = useState(false);

  useEffect(() => {
    if (!open) return;
    setYeuCauId(crypto.randomUUID());
    setTong(0);
    setNgay(format(new Date(), "yyyy-MM-dd"));
    setMoTa("");
    setPhanBo({});
    setDaSuaTay(false);
    setLoi({});
  }, [open]);

  const tongPb = tongPhanBo(phanBo);
  const lech = tong - tongPb;
  const ngayHopLe = ngay !== "" && ngay >= mocM && ngay <= homNay;
  const duDieuKien = yeuCauId !== "" && tong > 0 && ngayHopLe && lech === 0 && !dangLuu;

  function doiTong(v: number) {
    setTong(v);
    if (!daSuaTay) setPhanBo(goiYPhanBoCuTruoc(conNo, v));
    setLoi({});
  }

  async function ghi() {
    setDangLuu(true);
    setLoi({});
    try {
      const res = await traTienHangGop({
        yeuCauId,
        vanTay,
        ngay: new Date(`${ngay}T00:00:00+07:00`),
        tong,
        phanBo: dongPhanBoGui(phanBo),
        moTa,
      });
      if (!res.ok) {
        if (res.code === "DANH_SACH_DA_DOI") {
          toast.error(res.error);
          onOpenChange(false);
          router.refresh();
        } else if (res.field === "phanBo" || res.field === "ngay" || res.field === "tong") {
          setLoi({ [res.field]: res.error });
        } else {
          toast.error(res.error);
        }
        return;
      }
      if ("code" in res && res.code === "DA_GHI_ROI") {
        toast.info("Đợt trả này đã được ghi rồi — không ghi thêm.");
      } else {
        toast.success(`Đã ghi trả tiền hàng ${formatVnd(res.data.tong)} cho ${res.data.daGhi} phiếu`);
      }
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Ghi thất bại — kiểm tra kết nối rồi thử lại (bấm lại an toàn, không ghi trùng)");
    } finally {
      setDangLuu(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Trả tiền hàng nhà cung cấp</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="tra-hang-tong" className="text-xs text-muted-foreground">
                Tổng số tiền trả
              </label>
              <Input
                id="tra-hang-tong"
                inputMode="numeric"
                placeholder="0"
                className="text-right"
                value={formatAmountInput(tong)}
                onChange={(e) => doiTong(parseAmountInput(e.target.value))}
              />
              {loi.tong && <p className="text-xs text-error">{loi.tong}</p>}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="tra-hang-ngay" className="text-xs text-muted-foreground">
                Ngày trả (ngày tiền rời tài khoản)
              </label>
              <Input
                id="tra-hang-ngay"
                type="date"
                value={ngay}
                min={mocM}
                max={homNay}
                onChange={(e) => setNgay(e.target.value)}
              />
              {loi.ngay && <p className="text-xs text-error">{loi.ngay}</p>}
            </div>
          </div>

          {conNo.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có phiếu nào còn nợ.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-hairline">
              <table className="w-full min-w-[480px] text-sm">
                <thead className="bg-surface-soft text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Phiếu</th>
                    <th className="px-3 py-2 font-medium">Ngày</th>
                    <th className="px-3 py-2 text-right font-medium">Còn nợ</th>
                    <th className="px-3 py-2 text-right font-medium">Trả phiếu này</th>
                  </tr>
                </thead>
                <tbody>
                  {conNo.map((p) => (
                    <tr key={p.id} className="border-t border-hairline">
                      <td className="whitespace-nowrap px-3 py-2 text-ink">{p.maPhieu}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {format(p.ngayPhieu, "dd/MM/yyyy")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatVnd(p.conNo)}</td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          inputMode="numeric"
                          aria-label={`Trả phiếu ${p.maPhieu}`}
                          className="ml-auto w-32 text-right tabular-nums"
                          placeholder="0"
                          value={formatAmountInput(phanBo[p.id] ?? 0)}
                          onChange={(e) => {
                            setDaSuaTay(true);
                            setPhanBo((t) => ({ ...t, [p.id]: parseAmountInput(e.target.value) }));
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Gợi ý trả phiếu cũ trước; sửa từng ô nếu muốn trả khác. Trả vượt còn nợ của một phiếu vẫn ghi
            được (hiện là &quot;trả thừa&quot;).
          </p>
          {tong > 0 && lech !== 0 && (
            <p className="text-sm text-error" data-testid="tra-hang-lech">
              {lech > 0
                ? `Còn thiếu ${formatVnd(lech)} chưa phân bổ cho phiếu nào`
                : `Phân bổ vượt tổng tiền trả ${formatVnd(-lech)}`}
              {" "}— tổng phân bổ phải bằng số tiền trả.
            </p>
          )}
          {loi.phanBo && <p className="text-sm text-error">{loi.phanBo}</p>}

          <div className="flex flex-col gap-1">
            <label htmlFor="tra-hang-mo-ta" className="text-xs text-muted-foreground">
              Ghi chú (tuỳ chọn)
            </label>
            <Input id="tra-hang-mo-ta" maxLength={200} value={moTa} onChange={(e) => setMoTa(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" disabled={!duDieuKien} onClick={ghi}>
            {dangLuu ? "Đang ghi…" : "Ghi trả tiền hàng"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
