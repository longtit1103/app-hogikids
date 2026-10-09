"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { chotSaoKe } from "@/lib/actions/chot-sao-ke";
import { docUocTinhSaoKe } from "@/lib/actions/uoc-tinh-sao-ke";
import { formatVnd } from "@/lib/format";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";

import { OCoNhan } from "./o-nhap-co-nhan";

/** `undefined` = đang tính · `null` = app chưa có neo ≤ ngày đó · `"loi"` = không tính được. */
type Uoc = number | null | undefined | "loi";

/** Câu nói chênh lệch sao kê ↔ ước tính của app (dương = sao kê cao hơn app tính). */
export function cauChenhSaoKe(soDu: number, uoc: number): string {
  const chenh = soDu - uoc;
  if (chenh === 0) return "Khớp ước tính của app.";
  return chenh > 0
    ? `Sao kê CAO hơn app tính ${formatVnd(chenh)} — có khoản chi/phí/lãi chưa ghi vào app?`
    : `Sao kê THẤP hơn app tính ${formatVnd(-chenh)} — có khoản trả/hoàn chưa ghi vào app?`;
}

/**
 * Modal "Chốt sao kê" (CHỈ chủ shop): gõ đúng số trên sao kê ngân hàng (dư nợ cuối ngày chốt) + hạn
 * trả. Trước khi lưu hiện "ước tính của app tại ngày đó" (server tự tính theo neo + giao dịch) và
 * chênh lệch — lưu xong sao kê mới thành neo của dư nợ. `yeuCauId` sinh mỗi lần mở: gửi lại cùng nội
 * dung ⇒ server trả `DA_GHI_ROI` ⇒ báo "đã ghi rồi", không lỗi.
 */
export function ChotSaoKeFormModal({
  open,
  onOpenChange,
  the,
  mocM,
  ngayChotMacDinh,
  hanTraGoiY,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  the: { id: string; ten: string };
  /** `yyyy-MM-dd` — ngày chốt không được trước. */
  mocM: string;
  /** Ngày chốt gần nhất ≤ hôm qua theo ngày chốt của thẻ (server tính bằng `ngayChotGanNhat`). */
  ngayChotMacDinh: string;
  /** Hạn trả gợi ý (ngày hạn của thẻ sau ngày chốt). */
  hanTraGoiY: string;
}) {
  const router = useRouter();
  const [yeuCauId, setYeuCauId] = useState("");
  const [ngayChot, setNgayChot] = useState(ngayChotMacDinh);
  const [hanTra, setHanTra] = useState(hanTraGoiY);
  const [soDu, setSoDu] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [uoc, setUoc] = useState<Uoc>(undefined);
  const [loi, setLoi] = useState<Record<string, string>>({});
  const [dangLuu, setDangLuu] = useState(false);

  useEffect(() => {
    if (!open) return;
    setYeuCauId(crypto.randomUUID());
    setNgayChot(ngayChotMacDinh);
    setHanTra(hanTraGoiY);
    setSoDu(null);
    setNote("");
    setLoi({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, the.id]);

  // Ước tính tại ngày chốt — tính lại mỗi khi đổi ngày; bỏ kết quả của lượt hỏi đã cũ.
  useEffect(() => {
    if (!open || ngayChot === "") return;
    let huy = false;
    setUoc(undefined);
    docUocTinhSaoKe({ cardId: the.id, ngay: ngayChot })
      .then((res) => {
        if (!huy) setUoc(res.ok ? res.data.uocTinh : "loi");
      })
      .catch(() => {
        if (!huy) setUoc("loi");
      });
    return () => {
      huy = true;
    };
  }, [open, the.id, ngayChot]);

  const hanSauChot = hanTra !== "" && ngayChot !== "" && hanTra > ngayChot;
  const hopLe = yeuCauId !== "" && ngayChot !== "" && ngayChot >= mocM && soDu !== null && hanSauChot && !dangLuu;

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    if (soDu === null) return;
    setLoi({});
    setDangLuu(true);
    try {
      const res = await chotSaoKe({
        yeuCauId,
        cardId: the.id,
        ngayChot: new Date(`${ngayChot}T00:00:00+07:00`),
        soDu,
        hanTra: new Date(`${hanTra}T00:00:00+07:00`),
        note,
      });
      if (!res.ok) {
        if (res.field && ["ngayChot", "hanTra", "soDu", "note"].includes(res.field)) {
          setLoi({ [res.field]: res.error });
        } else {
          toast.error(res.error);
        }
        return;
      }
      if (res.code === "DA_GHI_ROI") toast.info("Sao kê này đã được chốt rồi — không ghi thêm.");
      else toast.success(`Đã chốt sao kê thẻ ${the.ten}`);
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối rồi thử lại (bấm lại an toàn, không ghi trùng)");
    } finally {
      setDangLuu(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chốt sao kê thẻ {the.ten}</DialogTitle>
        </DialogHeader>
        <form onSubmit={luu} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <OCoNhan id="sao-ke-ngay-chot" nhan="Ngày chốt sao kê" loi={loi.ngayChot}>
              <Input
                id="sao-ke-ngay-chot"
                type="date"
                value={ngayChot}
                min={mocM}
                onChange={(e) => setNgayChot(e.target.value)}
              />
            </OCoNhan>
            <OCoNhan id="sao-ke-han-tra" nhan="Hạn trả" loi={loi.hanTra}>
              <Input id="sao-ke-han-tra" type="date" value={hanTra} onChange={(e) => setHanTra(e.target.value)} />
            </OCoNhan>
          </div>
          {hanTra !== "" && !hanSauChot && <p className="text-xs text-error">Hạn trả phải sau ngày chốt.</p>}

          <OCoNhan
            id="sao-ke-so-du"
            nhan="Số dư trên sao kê (dư nợ cuối ngày chốt)"
            loi={loi.soDu}
            ghiChu="Gõ đúng số trên sao kê ngân hàng, kể cả khi bạn đã trả một phần."
          >
            <Input
              id="sao-ke-so-du"
              inputMode="numeric"
              placeholder="0"
              className="text-right"
              value={soDu === null ? "" : formatAmountInput(soDu) || "0"}
              onChange={(e) => setSoDu(e.target.value.replace(/\D/g, "") === "" ? null : parseAmountInput(e.target.value))}
            />
          </OCoNhan>

          <div className="rounded-lg bg-surface-soft p-3 text-sm" data-testid="sao-ke-uoc-tinh">
            {uoc === undefined && <p className="text-muted-foreground">Đang tính ước tính của app…</p>}
            {uoc === "loi" && <p className="text-warning">Không tính được ước tính của app — vẫn chốt được.</p>}
            {uoc === null && (
              <p className="text-muted-foreground">
                App chưa có điểm neo nào tới ngày này — không có số ước tính để so.
              </p>
            )}
            {typeof uoc === "number" && (
              <>
                <p className="text-ink">
                  Ước tính của app tại ngày đó: <strong className="tabular-nums">{formatVnd(uoc)}</strong>
                </p>
                {soDu !== null && <p className="mt-1 text-xs text-muted-foreground">{cauChenhSaoKe(soDu, uoc)}</p>}
              </>
            )}
          </div>

          <OCoNhan id="sao-ke-ghi-chu" nhan="Ghi chú (tuỳ chọn)" loi={loi.note}>
            <Input id="sao-ke-ghi-chu" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </OCoNhan>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <Button type="submit" disabled={!hopLe}>
              {dangLuu ? "Đang lưu…" : "Chốt sao kê"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
