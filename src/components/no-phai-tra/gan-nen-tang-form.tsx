"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ganNenTang } from "@/lib/actions/the-tin-dung";

import { NEN_TANG_CHON } from "./nen-tang-gan-the";
import { OCoNhan } from "./o-nhap-co-nhan";

/**
 * Modal "Gắn nền tảng quảng cáo → thẻ" từ một ngày. Nền tảng chọn trong danh sách CỐ ĐỊNH (Meta,
 * TikTok Ads — không có Shopee Ads). Đổi thẻ = thêm mốc mới, không sửa mốc cũ. SAU khi bật theo dõi nợ
 * mốc không được lùi về quá khứ (server: `GAN_LUI_NGAY`) — ô ngày đã chặn `min = hôm nay`, câu lỗi của
 * server vẫn hiện nếu lọt.
 */
export function GanNenTangForm({
  open,
  onOpenChange,
  the,
  daBat,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  the: { id: string; ten: string };
  daBat: boolean;
}) {
  const router = useRouter();
  const homNay = format(new Date(), "yyyy-MM-dd");
  const [nenTang, setNenTang] = useState("");
  const [tuNgay, setTuNgay] = useState(homNay);
  const [loi, setLoi] = useState<Record<string, string>>({});
  const [dangLuu, setDangLuu] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNenTang("");
    setTuNgay(format(new Date(), "yyyy-MM-dd"));
    setLoi({});
  }, [open]);

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    setLoi({});
    setDangLuu(true);
    try {
      const res = await ganNenTang({ cardId: the.id, nenTang, tuNgay: new Date(`${tuNgay}T00:00:00+07:00`) });
      if (!res.ok) {
        if (res.field === "tuNgay" || res.field === "nenTang") setLoi({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      toast.success(`Đã gắn nền tảng vào thẻ ${the.ten}`);
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
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Gắn nền tảng ads vào thẻ {the.ten}</DialogTitle>
        </DialogHeader>
        <form onSubmit={luu} className="flex flex-col gap-3">
          <OCoNhan id="gan-nen-tang" nhan="Nền tảng quảng cáo" loi={loi.nenTang}>
            <Select value={nenTang} onValueChange={(v) => setNenTang(typeof v === "string" ? v : "")}>
              <SelectTrigger className="w-full" id="gan-nen-tang">
                <SelectValue placeholder="Chọn nền tảng" />
              </SelectTrigger>
              <SelectContent>
                {NEN_TANG_CHON.map((n) => (
                  <SelectItem key={n.value} value={n.value}>
                    {n.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </OCoNhan>
          <OCoNhan
            id="gan-tu-ngay"
            nhan="Gắn từ ngày"
            loi={loi.tuNgay}
            ghiChu={
              daBat
                ? "Đã bật theo dõi nợ: chỉ chọn từ hôm nay trở đi (gắn lùi sẽ đổi quỹ và dư nợ các ngày đã qua)."
                : "Chi phí ads của nền tảng từ ngày này sẽ tính vào nợ thẻ khi bật theo dõi nợ."
            }
          >
            <Input
              id="gan-tu-ngay"
              type="date"
              value={tuNgay}
              min={daBat ? homNay : undefined}
              onChange={(e) => setTuNgay(e.target.value)}
            />
          </OCoNhan>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <Button type="submit" disabled={nenTang === "" || tuNgay === "" || dangLuu}>
              {dangLuu ? "Đang lưu…" : "Gắn"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
