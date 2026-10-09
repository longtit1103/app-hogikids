"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { xoaViAds } from "@/lib/actions/vi-ads";
import { formatVnd } from "@/lib/format";
import type { HoSoViAds } from "@/lib/no-phai-tra/vi-ads-queries";

import { ViAdsFormModal } from "./vi-ads-form-modal";

const NHAN_NGUON: Record<HoSoViAds["nguonNap"], string> = { BANK: "Ngân hàng", CARD: "Thẻ tín dụng" };

/**
 * Khối "Ví quảng cáo trả trước" của trang Nợ phải trả (chỉ chủ shop). Một nền tảng một ví (hiện chỉ Shopee
 * Ads). Trước khi bật: số dư là số TẠM (bước xác nhận ghi đè). Sau khi bật: số dư ước tính = neo + nạp − chi.
 */
export function ViAdsSection({ vis, daBat }: { vis: readonly HoSoViAds[]; daBat: boolean }) {
  const router = useRouter();
  const [moThem, setMoThem] = useState(false);
  const [sua, setSua] = useState<HoSoViAds | undefined>(undefined);
  const [xoa, setXoa] = useState<HoSoViAds | undefined>(undefined);
  const [dangXoa, setDangXoa] = useState(false);
  const coShopee = vis.some((v) => v.nenTang === "SHOPEE_ADS");

  async function chayXoa() {
    if (!xoa) return;
    setDangXoa(true);
    try {
      const res = await xoaViAds(xoa.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã xoá hồ sơ ví (khôi phục được ở Thùng rác)");
      setXoa(undefined);
      router.refresh();
    } catch {
      toast.error("Xoá thất bại — kiểm tra kết nối");
    } finally {
      setDangXoa(false);
    }
  }

  return (
    <div id="vi-ads-tra-truoc" className="scroll-mt-20 rounded-xl border border-hairline p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Ví quảng cáo trả trước</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Shopee Ads nạp tiền trước rồi chạy — ví là tiền đã rời quỹ nhưng chưa tiêu
          </p>
        </div>
        {!coShopee && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setMoThem(true)}>
            + Thêm ví Shopee Ads
          </Button>
        )}
      </div>

      {vis.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Chưa có hồ sơ ví. Đang chạy quảng cáo Shopee thì phải tạo trước khi bật theo dõi nợ.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {vis.map((v) => (
            <li
              key={v.id}
              data-testid="vi-ads-dong"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-soft p-3 text-sm"
            >
              <div className="flex flex-col gap-0.5">
                <p className="text-ink">
                  {v.nenTang === "SHOPEE_ADS" ? "Shopee Ads" : v.nenTang}{" "}
                  <span className="text-xs text-muted-foreground">· nạp từ {NHAN_NGUON[v.nguonNap]}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {daBat
                    ? `Số dư ước tính ${formatVnd(v.soDuHienTai ?? v.soDuNeo)} · neo ${formatVnd(v.soDuNeo)} cuối ${v.ngayNeoNhan} · ${v.soLanNap} lần nạp`
                    : "Số dư thật khai ở bước xác nhận bật"}
                </p>
                {v.note && <p className="text-xs text-muted-foreground">{v.note}</p>}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setSua(v)}>
                  Sửa
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setXoa(v)}>
                  Xoá
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ViAdsFormModal open={moThem} onOpenChange={setMoThem} daBat={daBat} />
      <ViAdsFormModal open={sua !== undefined} onOpenChange={(o) => !o && setSua(undefined)} vi={sua} daBat={daBat} />
      <Dialog open={xoa !== undefined} onOpenChange={(o) => !o && setXoa(undefined)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Xoá hồ sơ ví</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ink">
            Xoá hồ sơ ví Shopee Ads? Chỉ xoá được khi ví chưa có lần nạp và chưa gánh chi quảng cáo nào.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setXoa(undefined)}>
              Hủy
            </Button>
            <Button type="button" variant="destructive" disabled={dangXoa} onClick={chayXoa}>
              {dangXoa ? "Đang xoá…" : "Xoá"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
