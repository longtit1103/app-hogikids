"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { chotSaoKeTuPdf, xemTruocSaoKeThe, type XemTruocSaoKe } from "@/lib/actions/sao-ke-the";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";

import { NhapSaoKeTheXemTruoc } from "./nhap-sao-ke-the-xem-truoc";
import { OCoNhan } from "./o-nhap-co-nhan";

/**
 * Trần phía trình duyệt 2,5 MB — THẤP hơn trần server 3 MB có chủ đích: body gửi lên còn mang các trường khác, file
 * sát 3 MB lọt cổng này sẽ bị chính Next chặn (trần body Server Action 3 MB) với lỗi chung khó hiểu. Sao kê thật chỉ
 * vài trăm KB.
 */
const TRAN_FILE = 2.5 * 1024 * 1024;

/**
 * Modal "Nhập sao kê PDF" (CHỈ chủ shop, sau khi bật theo dõi nợ): chọn thẻ + file PDF sao kê ⇒ server tách dòng, ghép
 * hoá đơn TikTok, ra số đề xuất ⇒ chủ shop xem, sửa số nếu cần ⇒ "Chốt sao kê với số này". Khi chốt, modal gửi LẠI
 * file: server tách + đối chiếu lại, số đề xuất đổi ⇒ từ chối (xem trước lại). `yeuCauId` sinh mỗi lần xem trước —
 * bấm lại an toàn, không ghi trùng.
 */
export function NhapSaoKeTheModal({
  open,
  onOpenChange,
  the,
  cardIdMacDinh,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Thẻ còn mở. */
  the: readonly { id: string; ten: string }[];
  cardIdMacDinh: string;
}) {
  const router = useRouter();
  const [cardId, setCardId] = useState(cardIdMacDinh);
  const [file, setFile] = useState<File | null>(null);
  const [xemTruoc, setXemTruoc] = useState<XemTruocSaoKe | null>(null);
  const [loiFile, setLoiFile] = useState<string | null>(null);
  const [dangDoc, setDangDoc] = useState(false);
  const [yeuCauId, setYeuCauId] = useState("");
  const [soDu, setSoDu] = useState<number | null>(null);
  const [hanTra, setHanTra] = useState("");
  const [note, setNote] = useState("");
  const [loi, setLoi] = useState<Record<string, string>>({});
  const [dangLuu, setDangLuu] = useState(false);

  function datLai() {
    setFile(null);
    setXemTruoc(null);
    setLoiFile(null);
    setSoDu(null);
    setHanTra("");
    setNote("");
    setLoi({});
  }

  useEffect(() => {
    if (!open) return;
    setCardId(cardIdMacDinh);
    datLai();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cardIdMacDinh]);

  async function xem(f: File) {
    if (!/\.pdf$/i.test(f.name)) {
      setLoiFile("Cần file PDF sao kê");
      return;
    }
    if (f.size > TRAN_FILE) {
      setLoiFile("File quá lớn (tối đa 2,5 MB) — sao kê PDF tải từ ngân hàng chỉ vài trăm KB, kiểm đúng file");
      return;
    }
    setFile(f);
    setLoiFile(null);
    setDangDoc(true);
    try {
      const fd = new FormData();
      fd.set("cardId", cardId);
      fd.set("file", f);
      const res = await xemTruocSaoKeThe(fd);
      if (!res.ok) {
        setXemTruoc(null);
        setLoiFile(res.error);
        return;
      }
      setXemTruoc(res.data);
      setYeuCauId(crypto.randomUUID());
      setSoDu(res.data.ketQua.soDeXuat >= 0 ? res.data.ketQua.soDeXuat : null);
      setHanTra(res.data.saoKe.hanTra);
      setLoi({});
    } catch {
      setLoiFile("Không đọc được file — thử lại");
    } finally {
      setDangDoc(false);
    }
  }

  async function chot(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !xemTruoc || soDu === null) return;
    if (canGhiChu && note.trim() === "") {
      setLoi({ note: "Số chốt khác số đề xuất — ghi chú lý do sửa" });
      return;
    }
    setLoi({});
    setDangLuu(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("cardId", cardId);
      fd.set("yeuCauId", yeuCauId);
      fd.set("hash", xemTruoc.hash);
      fd.set("soDu", String(soDu));
      fd.set("soDeXuat", String(xemTruoc.ketQua.soDeXuat));
      fd.set("hanTra", hanTra);
      fd.set("note", note);
      const res = await chotSaoKeTuPdf(fd);
      if (!res.ok) {
        if (res.field && ["soDu", "hanTra", "note"].includes(res.field)) setLoi({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      if (res.code === "DA_GHI_ROI") toast.info("Sao kê này đã được chốt rồi — không ghi thêm.");
      else toast.success("Đã chốt sao kê từ file PDF");
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối rồi thử lại (bấm lại an toàn, không ghi trùng)");
    } finally {
      setDangLuu(false);
    }
  }

  const choChot = xemTruoc !== null && xemTruoc.lyDoKhongChot === null;
  /** Sửa số khác số đề xuất ⇒ bắt buộc ghi chú lý do (server cũng chặn). */
  const canGhiChu = xemTruoc !== null && soDu !== null && soDu !== xemTruoc.ketQua.soDeXuat;
  const hopLe =
    choChot && yeuCauId !== "" && soDu !== null && hanTra !== "" && hanTra > (xemTruoc?.saoKe.ngaySaoKe ?? "") && !dangLuu;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nhập sao kê PDF</DialogTitle>
        </DialogHeader>

        {xemTruoc === null ? (
          <div className="flex flex-col gap-3">
            <OCoNhan id="sao-ke-pdf-the" nhan="Thẻ">
              <select
                id="sao-ke-pdf-the"
                className="h-9 rounded-lg border border-input bg-canvas px-2 text-sm text-ink"
                value={cardId}
                onChange={(e) => setCardId(e.target.value)}
              >
                {the.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.ten}
                  </option>
                ))}
              </select>
            </OCoNhan>
            <p className="text-xs text-muted-foreground">Sao kê thẻ Techcombank, file PDF tải từ ngân hàng (không phải ảnh chụp).</p>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-hairline bg-surface-soft p-8 text-center text-sm text-muted-foreground hover:border-primary focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/40">
              <span>{dangDoc ? "Đang đọc sao kê…" : "Bấm để chọn file .pdf"}</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                aria-label="Chọn file sao kê PDF"
                disabled={dangDoc || cardId === ""}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void xem(f);
                  e.target.value = "";
                }}
              />
            </label>
            {loiFile && (
              <p
                role="alert"
                className="rounded-lg border border-error/40 bg-error/5 p-2.5 text-sm text-error"
                data-testid="sao-ke-pdf-loi"
              >
                {loiFile}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={chot} className="flex flex-col gap-3">
            <NhapSaoKeTheXemTruoc x={xemTruoc} />
            {xemTruoc.lyDoKhongChot !== null ? (
              <p className="text-sm text-warning" data-testid="sao-ke-pdf-chi-xem">
                {xemTruoc.lyDoKhongChot}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <OCoNhan id="sao-ke-pdf-so-du" nhan="Số chốt" loi={loi.soDu}>
                    <Input
                      id="sao-ke-pdf-so-du"
                      inputMode="numeric"
                      className="text-right"
                      value={soDu === null ? "" : formatAmountInput(soDu) || "0"}
                      onChange={(e) =>
                        setSoDu(e.target.value.replace(/\D/g, "") === "" ? null : parseAmountInput(e.target.value))
                      }
                    />
                  </OCoNhan>
                  <OCoNhan id="sao-ke-pdf-han-tra" nhan="Hạn trả" loi={loi.hanTra}>
                    <Input id="sao-ke-pdf-han-tra" type="date" value={hanTra} onChange={(e) => setHanTra(e.target.value)} />
                  </OCoNhan>
                </div>
                <OCoNhan
                  id="sao-ke-pdf-ghi-chu"
                  nhan={canGhiChu ? "Ghi chú (bắt buộc — vì sao sửa số)" : "Ghi chú (tuỳ chọn)"}
                  loi={loi.note}
                >
                  <Input id="sao-ke-pdf-ghi-chu" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                </OCoNhan>
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={datLai} disabled={dangLuu}>
                Chọn file khác
              </Button>
              {file && (
                <Button type="button" variant="outline" onClick={() => void xem(file)} disabled={dangLuu || dangDoc}>
                  {dangDoc ? "Đang đọc…" : "Xem lại"}
                </Button>
              )}
              {choChot && (
                <Button type="submit" disabled={!hopLe}>
                  {dangLuu ? "Đang lưu…" : "Chốt sao kê với số này"}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
