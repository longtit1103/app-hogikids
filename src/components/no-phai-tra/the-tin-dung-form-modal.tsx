"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { addDays, format } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { suaThe, taoThe } from "@/lib/actions/the-tin-dung";
import type { TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";

import { OCoNhan } from "./o-nhap-co-nhan";

/** Ô trong form ứng với `field` server trả — lỗi ngoài tập này đi toast. */
const O_TREN_FORM = new Set(["ten", "nganHang", "ngayChotSaoKe", "ngayHanTra", "note", "neoBanDau"]);

/**
 * Modal Thêm/Sửa thẻ tín dụng (hồ sơ — không mang tiền). SAU khi bật theo dõi nợ (`mocM` ≠ null), thẻ
 * mới BẮT BUỘC kèm dư nợ ban đầu = 0 tại một ngày: nợ cũ của thẻ chưa gắn đã trừ quỹ qua chi phí
 * quảng cáo — nhập số > 0 rồi trả thẻ là trừ quỹ hai lần, nên ô số dư khoá cứng ở 0 và thẻ đang có nợ
 * phải khai ở bước bật. Sửa thẻ không đụng neo.
 */
export function TheTinDungFormModal({
  open,
  onOpenChange,
  the,
  mocM,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Có = chế độ sửa. */
  the?: TheKemTrangThai;
  /** `yyyy-MM-dd`; null = chưa bật. */
  mocM: string | null;
}) {
  const router = useRouter();
  const laSua = the !== undefined;
  const homQua = format(addDays(new Date(), -1), "yyyy-MM-dd");
  // Neo hợp lệ ∈ [M − 1, hôm qua] (neo trước M chỉ sinh ở bước bật).
  const neoSomNhat = mocM === null ? null : format(addDays(new Date(`${mocM}T00:00:00+07:00`), -1), "yyyy-MM-dd");

  const [ten, setTen] = useState("");
  const [nganHang, setNganHang] = useState("");
  const [ngayChot, setNgayChot] = useState("");
  const [ngayHan, setNgayHan] = useState("");
  const [note, setNote] = useState("");
  const [ngayNeo, setNgayNeo] = useState(homQua);
  const [loi, setLoi] = useState<Record<string, string>>({});
  const [dangLuu, setDangLuu] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTen(the?.ten ?? "");
    setNganHang(the?.nganHang ?? "");
    setNgayChot(the ? String(the.ngayChotSaoKe) : "");
    setNgayHan(the ? String(the.ngayHanTra) : "");
    setNote(the?.note ?? "");
    setNgayNeo(homQua);
    setLoi({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, the?.id]);

  const canNeo = !laSua && mocM !== null;
  const hopLe =
    ten.trim() !== "" &&
    ngayChot !== "" &&
    ngayHan !== "" &&
    (!canNeo || (ngayNeo !== "" && ngayNeo <= homQua && (neoSomNhat === null || ngayNeo >= neoSomNhat)));

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    setLoi({});
    setDangLuu(true);
    const hoSo = { ten, nganHang, ngayChotSaoKe: Number(ngayChot), ngayHanTra: Number(ngayHan), note };
    try {
      const res = laSua
        ? await suaThe(the.id, hoSo)
        : await taoThe({
            ...hoSo,
            ...(canNeo ? { neoBanDau: { ngayChot: new Date(`${ngayNeo}T00:00:00+07:00`), soDu: 0 } } : {}),
          });
      if (!res.ok) {
        if (res.field && O_TREN_FORM.has(res.field)) setLoi({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      toast.success(laSua ? "Đã cập nhật thẻ" : "Đã thêm thẻ");
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangLuu(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{laSua ? "Sửa thẻ tín dụng" : "Thêm thẻ tín dụng"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={luu} className="flex flex-col gap-3">
          <OCoNhan id="the-ten" nhan="Tên thẻ" loi={loi.ten}>
            <Input id="the-ten" maxLength={60} value={ten} onChange={(e) => setTen(e.target.value)} />
          </OCoNhan>
          <OCoNhan id="the-ngan-hang" nhan="Ngân hàng" loi={loi.nganHang}>
            <Input id="the-ngan-hang" maxLength={60} value={nganHang} onChange={(e) => setNganHang(e.target.value)} />
          </OCoNhan>
          <div className="grid grid-cols-2 gap-3">
            <OCoNhan id="the-ngay-chot" nhan="Ngày chốt sao kê (1–31)" loi={loi.ngayChotSaoKe}>
              <Input
                id="the-ngay-chot"
                type="number"
                min={1}
                max={31}
                value={ngayChot}
                onChange={(e) => setNgayChot(e.target.value)}
              />
            </OCoNhan>
            <OCoNhan id="the-ngay-han" nhan="Ngày hạn trả (1–31)" loi={loi.ngayHanTra}>
              <Input
                id="the-ngay-han"
                type="number"
                min={1}
                max={31}
                value={ngayHan}
                onChange={(e) => setNgayHan(e.target.value)}
              />
            </OCoNhan>
          </div>
          <OCoNhan id="the-ghi-chu" nhan="Ghi chú" loi={loi.note}>
            <Input id="the-ghi-chu" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </OCoNhan>

          {canNeo && (
            <div className="flex flex-col gap-2 rounded-lg border border-hairline p-3" data-testid="the-neo-ban-dau">
              <p className="text-sm text-ink">Dư nợ ban đầu của thẻ</p>
              <div className="grid grid-cols-2 gap-3">
                <OCoNhan id="the-neo-ngay" nhan="Tại ngày (cuối ngày)">
                  <Input
                    id="the-neo-ngay"
                    type="date"
                    value={ngayNeo}
                    min={neoSomNhat ?? undefined}
                    max={homQua}
                    onChange={(e) => setNgayNeo(e.target.value)}
                  />
                </OCoNhan>
                <OCoNhan id="the-neo-so-du" nhan="Số dư">
                  <Input id="the-neo-so-du" value="0" readOnly disabled className="text-right" aria-label="Dư nợ ban đầu" />
                </OCoNhan>
              </div>
              <p className="text-xs text-muted-foreground">
                Luôn bằng 0: thẻ đang có nợ phải khai ở bước bật theo dõi nợ (nợ cũ đã trừ quỹ qua chi phí
                quảng cáo — khai thêm ở đây là trừ quỹ hai lần).
              </p>
              <p className="text-xs text-muted-foreground" data-testid="the-neo-goi-y-ngay">
                Giao dịch gắn thẻ (trả thẻ, nạp ví bằng thẻ, chi phí trừ vào thẻ) chỉ ghi được từ SAU ngày neo
                này — muốn ghi lại khoản của mấy hôm trước thì lùi ngày neo về trước ngày đó.
              </p>
              {loi.neoBanDau && <p className="text-xs text-error">{loi.neoBanDau}</p>}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <Button type="submit" disabled={!hopLe || dangLuu}>
              {dangLuu ? "Đang lưu…" : "Lưu"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
