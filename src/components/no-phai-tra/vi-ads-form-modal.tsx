"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { suaViAds, taoViAds } from "@/lib/actions/vi-ads";
import type { HoSoViAds } from "@/lib/no-phai-tra/vi-ads-queries";

import { OCoNhan } from "./o-nhap-co-nhan";

const O_TREN_FORM = new Set(["nenTang", "nguonNap", "soDuNeo", "ngayNeo", "note"]);

/** Ba lựa chọn nguồn nạp — "ví bán hàng Shopee" hiện để chủ shop thấy, server từ chối kèm hướng dẫn. */
const NGUON = [
  { value: "BANK", nhan: "Ngân hàng (chuyển khoản / thẻ ghi nợ)" },
  { value: "CARD", nhan: "Thẻ tín dụng" },
  { value: "VI_BAN_HANG", nhan: "Ví bán hàng Shopee" },
] as const;
type Nguon = (typeof NGUON)[number]["value"];

/**
 * Modal Thêm/Sửa hồ sơ ví quảng cáo trả trước (Shopee Ads — nạp rồi chạy). TRƯỚC khi bật theo dõi nợ:
 * chỉ cần nền tảng + nguồn nạp; số dư thật cuối ngày trước mốc bật khai ở bước xác nhận. SAU khi bật: số
 * dư ban đầu KHOÁ = 0 (server từ chối số khác — `NEO_KHAC_0`), lý do dặn ngay trên form.
 */
export function ViAdsFormModal({
  open,
  onOpenChange,
  vi,
  daBat,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Có = chế độ sửa (chỉ nguồn nạp + ghi chú). */
  vi?: HoSoViAds;
  daBat: boolean;
}) {
  const router = useRouter();
  const laSua = vi !== undefined;
  const [nguon, setNguon] = useState<Nguon>("BANK");
  const [note, setNote] = useState("");
  const [loi, setLoi] = useState<Record<string, string>>({});
  const [dangLuu, setDangLuu] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNguon(vi?.nguonNap ?? "BANK");
    setNote(vi?.note ?? "");
    setLoi({});
  }, [open, vi]);

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    setLoi({});
    setDangLuu(true);
    try {
      const res = laSua
        ? await suaViAds(vi.id, { nguonNap: nguon, note })
        : await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: nguon, note, ...(daBat ? { soDuNeo: 0 } : {}) });
      if (!res.ok) {
        if (res.field && O_TREN_FORM.has(res.field)) setLoi({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      toast.success(laSua ? "Đã sửa hồ sơ ví" : "Đã tạo hồ sơ ví Shopee Ads");
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
          <DialogTitle>{laSua ? "Sửa hồ sơ ví Shopee Ads" : "Thêm hồ sơ ví Shopee Ads"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={luu} className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Ví quảng cáo nạp tiền trước rồi chạy: sau khi bật theo dõi nợ, quỹ giảm lúc NẠP ví (ghi &quot;Nạp ví
            quảng cáo&quot; ở Sổ quỹ), chi phí quảng cáo Shopee vẫn vào Lãi/Lỗ theo ngày chạy nhưng không trừ quỹ lần nữa.
          </p>
          <fieldset className="flex flex-col gap-1.5" aria-describedby="vi-ads-nguon-loi">
            <legend className="text-xs text-muted-foreground">Thường nạp ví từ đâu?</legend>
            {NGUON.map((n) => (
              <label key={n.value} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="vi-ads-nguon"
                  value={n.value}
                  checked={nguon === n.value}
                  onChange={() => setNguon(n.value)}
                />
                {n.nhan}
              </label>
            ))}
            {loi.nguonNap && (
              <p id="vi-ads-nguon-loi" className="text-xs text-error">
                {loi.nguonNap}
              </p>
            )}
          </fieldset>

          {!laSua && daBat && (
            <OCoNhan
              id="vi-ads-so-du"
              nhan="Số dư ví ban đầu (cuối ngày hôm qua)"
              loi={loi.soDuNeo}
              ghiChu="Luôn bằng 0: tiền đang có trong ví đã rời ngân hàng mà quỹ chưa trừ — khai số khác 0 thì quỹ cao hơn ngân hàng đúng bằng số đó. Ví đang có số dư phải khai ở bước bật; đã bật rồi thì chỉ tạo hồ sơ khi ví đã dùng hết tiền."
            >
              <Input id="vi-ads-so-du" value="0" readOnly disabled className="text-right" aria-label="Số dư ví ban đầu" />
            </OCoNhan>
          )}
          {!laSua && !daBat && (
            <p className="text-xs text-muted-foreground">
              Số dư ví cuối ngày trước ngày bật sẽ khai ở bước Xác nhận.
            </p>
          )}

          <OCoNhan id="vi-ads-ghi-chu" nhan="Ghi chú (tuỳ chọn)" loi={loi.note}>
            <Input id="vi-ads-ghi-chu" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </OCoNhan>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <Button type="submit" disabled={dangLuu}>
              {dangLuu ? "Đang lưu…" : "Lưu"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
