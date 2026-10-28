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
import { ngayHoaDonTiktokDuVe } from "@/lib/sao-ke-the/cong-chot-sao-ke";

import { OCoNhan } from "./o-nhap-co-nhan";

/** `undefined` = đang tính · `null` = app chưa có neo ≤ ngày đó · `"loi"` = không tính được. */
type Uoc = number | null | undefined | "loi";

/**
 * Các lần TikTok trừ THẺ THẬT tạo ĐÚNG ngày chốt (server đếm, đã bỏ phần ví TikTok Shop trả — `viTra`) — `null` khi
 * đang tính / không tính được.
 */
type HoaDonNgayChot = { soLan: number; tong: number; viTra?: number } | null;

/** Khoá ngày `yyyy-MM-dd` giờ VN (UTC+7 cố định, không DST) — không lệ thuộc múi giờ trình duyệt. */
function khoaNgayVn(d: Date): string {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Cảnh báo CHỐT SỚM: hoá đơn TikTok tạo chiều/tối ngày chốt D chỉ về app ở lượt kéo đêm D+2 (API hoá đơn trễ 6–11h).
 * Chốt trước D+2 thì các lần đó chưa có trong app, rồi khi về chúng mang ngày ≤ D ⇒ lõi coi là đã nằm trong neo ⇒ bỏ
 * tới kỳ chốt sau. Chỉ CẢNH BÁO, không chặn (chủ shop tự gõ số) — đường nhập PDF thì CHẶN (`lyDoHoaDonTiktokChuaVe`, cùng
 * mốc D+2). `homNay` = khoá ngày VN. `null` = đã đủ muộn.
 */
export function canhBaoChotSom(ngayChot: string, homNay: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ngayChot)) return null;
  const tuNgay = ngayHoaDonTiktokDuVe(ngayChot);
  if (homNay >= tuNgay) return null;
  const [, thang, ngay] = tuNgay.split("-");
  return (
    "Hoá đơn TikTok chiều/tối ngày chốt thường về app sau 2 đêm — chốt sớm có thể làm app bỏ sót chúng tới kỳ sau; " +
    `nên chốt từ ${ngay}/${thang}.`
  );
}

/**
 * Câu nói chênh lệch sao kê ↔ ước tính của app (dương = sao kê cao hơn app tính). Độ trễ có HAI chiều: hoá đơn
 * TikTok về app trễ 6–11h (app THẤP hơn ngân hàng) và ngân hàng ghi sổ lần TikTok trừ trễ ~1 ngày (app CAO hơn).
 */
export function cauChenhSaoKe(soDu: number, uoc: number): string {
  const chenh = soDu - uoc;
  if (chenh === 0) return "Khớp ước tính của app.";
  return chenh > 0
    ? `Sao kê CAO hơn app tính ${formatVnd(chenh)} — chênh nhỏ thường do hoá đơn TikTok chưa kéo về app (TikTok báo trễ); lớn thì có khoản chi/phí/lãi chưa ghi vào app?`
    : `Sao kê THẤP hơn app tính ${formatVnd(-chenh)} — chênh nhỏ thường do ngân hàng ghi sổ trễ các lần TikTok trừ; lớn thì có lần trả thẻ chưa ghi hoặc ghi trùng?`;
}

/**
 * Câu nhắc khi ngày chốt có lần TikTok trừ thẻ — sao kê ngân hàng thường chưa gồm chúng (ghi sổ trễ ~1 ngày). CHỈ nêu
 * phần trừ THẺ THẬT (server đã bỏ phần ví TikTok Shop trả — không bao giờ lên sao kê, cộng vào là neo thừa).
 */
export function cauHoaDonNgayChot(h: { soLan: number; tong: number; viTra?: number }): string {
  const vi = (h.viTra ?? 0) > 0 ? ` Đã bỏ ${formatVnd(h.viTra ?? 0)} ví TikTok Shop trả (không lên sao kê ngân hàng).` : "";
  return (
    `Sao kê ngân hàng thường CHƯA gồm ${h.soLan} lần TikTok trừ thẻ trong ngày chốt (tổng ${formatVnd(h.tong)}). ` +
    `Nếu sao kê không có chúng, gõ số sao kê + ${formatVnd(h.tong)}; có rồi thì gõ đúng số sao kê.` +
    vi
  );
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
  const [hoaDonNgayChot, setHoaDonNgayChot] = useState<HoaDonNgayChot>(null);
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
    setHoaDonNgayChot(null);
    docUocTinhSaoKe({ cardId: the.id, ngay: ngayChot })
      .then((res) => {
        if (huy) return;
        setUoc(res.ok ? res.data.uocTinh : "loi");
        setHoaDonNgayChot(res.ok ? (res.data.hoaDonNgayChot ?? null) : null);
      })
      .catch(() => {
        if (!huy) setUoc("loi");
      });
    return () => {
      huy = true;
    };
  }, [open, the.id, ngayChot]);

  const hanSauChot = hanTra !== "" && ngayChot !== "" && hanTra > ngayChot;
  const chotSom = ngayChot === "" ? null : canhBaoChotSom(ngayChot, khoaNgayVn(new Date()));
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
          {chotSom !== null && (
            <p className="text-xs text-warning" data-testid="sao-ke-canh-bao-chot-som">
              {chotSom}
            </p>
          )}

          <OCoNhan
            id="sao-ke-so-du"
            nhan="Số dư trên sao kê (dư nợ cuối ngày chốt)"
            loi={loi.soDu}
            ghiChu="Gõ dư nợ trên sao kê ngân hàng cuối ngày chốt (kể cả khi đã trả một phần) — xem nhắc về các lần TikTok trừ trong ngày chốt bên dưới."
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
            {hoaDonNgayChot !== null && hoaDonNgayChot.soLan > 0 && hoaDonNgayChot.tong > 0 && (
              <p className="mt-1 text-xs text-warning" data-testid="sao-ke-hoa-don-ngay-chot">
                {cauHoaDonNgayChot(hoaDonNgayChot)}
              </p>
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
