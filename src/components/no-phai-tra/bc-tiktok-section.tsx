"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { boDanhDauBcTiktokKhongDung, danhDauBcTiktokKhongDung } from "@/lib/actions/bc-tiktok-hoa-don";

/** Một BC đã định dạng sẵn ở server (ngày `dd/MM/yyyy` giờ VN) — client không đụng múi giờ. */
export type BcTiktokDong = {
  bcId: string;
  /** Câu trạng thái lượt kéo gần nhất (đã dịch). */
  trangThai: string;
  canhBao: boolean;
  lanCuoiDocDuoc: string | null;
  khongDungTu: string | null;
  khongDungGhiChu: string | null;
  khongDungBoi: string | null;
};

/**
 * Khối "Business Center TikTok" của trang Nợ phải trả (chỉ chủ shop). Liệt kê BC app đã biết (đã gửi dấu lượt hoặc có
 * hoá đơn trong kho thô) và cho chủ shop xác nhận BC "KHÔNG dùng thẻ" — cổng chốt sao kê thẻ bỏ BC đó khỏi tập xét.
 * Xác nhận sai thì hoá đơn trừ thẻ của BC không được kiểm, nên hộp xác nhận nói rõ hệ quả.
 */
export function BcTiktokSection({ dong }: { dong: readonly BcTiktokDong[] }) {
  const router = useRouter();
  const [danhDau, setDanhDau] = useState<string | undefined>(undefined);
  const [ghiChu, setGhiChu] = useState("");
  const [dangChay, setDangChay] = useState(false);

  async function chay(goi: () => Promise<{ ok: true; data: { daDoi: boolean } } | { ok: false; error: string }>, thanhCong: string) {
    setDangChay(true);
    try {
      const res = await goi();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.data.daDoi ? thanhCong : "Không có gì thay đổi");
      setDanhDau(undefined);
      setGhiChu("");
      router.refresh();
    } catch {
      toast.error("Thao tác thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  return (
    <div id="bc-tiktok" className="scroll-mt-20 rounded-xl border border-hairline p-4">
      <p className="text-sm text-muted-foreground">Business Center TikTok</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Chốt sao kê thẻ kiểm hoá đơn TikTok của từng BC. BC TikTok báo thiếu quyền finance, hoặc từng đọc được rồi mất
        quyền, sẽ chặn chốt — cấp quyền finance rồi kéo lại, hoặc đánh dấu BC không trả quảng cáo bằng thẻ.
      </p>
      {dong.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Chưa có Business Center nào gửi hoá đơn về app.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {dong.map((b) => (
            <li
              key={b.bcId}
              data-testid="bc-tiktok-dong"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-soft p-3 text-sm"
            >
              <div className="flex flex-col gap-0.5">
                <p className="font-mono text-ink">BC {b.bcId}</p>
                <p className={b.canhBao && b.khongDungTu === null ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {b.trangThai}
                  {b.lanCuoiDocDuoc ? ` · đọc được hoá đơn lần cuối ${b.lanCuoiDocDuoc}` : " · chưa từng đọc được hoá đơn"}
                </p>
                {b.khongDungTu && (
                  <p className="text-xs text-muted-foreground">
                    Không dùng thẻ — {b.khongDungBoi} xác nhận {b.khongDungTu}
                    {b.khongDungGhiChu ? ` · ${b.khongDungGhiChu}` : ""}
                  </p>
                )}
              </div>
              {b.khongDungTu ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={dangChay}
                  onClick={() => chay(() => boDanhDauBcTiktokKhongDung(b.bcId), `Đã bỏ đánh dấu BC ${b.bcId} — cổng chốt sao kê xét lại BC này`)}
                >
                  Bỏ đánh dấu
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => setDanhDau(b.bcId)}>
                  Không dùng thẻ
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={danhDau !== undefined} onOpenChange={(o) => !o && setDanhDau(undefined)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>BC {danhDau} không dùng thẻ</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ink">
            Xác nhận Business Center này KHÔNG trả quảng cáo bằng thẻ tín dụng? Chốt sao kê thẻ sẽ không kiểm hoá đơn của
            BC này nữa — nếu BC thật ra vẫn trừ thẻ, số chốt có thể thiếu. Bỏ đánh dấu được bất cứ lúc nào.
          </p>
          <label htmlFor="bc-tiktok-ghi-chu" className="text-xs text-muted-foreground">
            Ghi chú (tuỳ chọn)
          </label>
          <Input id="bc-tiktok-ghi-chu" maxLength={500} value={ghiChu} onChange={(e) => setGhiChu(e.target.value)} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDanhDau(undefined)}>
              Hủy
            </Button>
            <Button
              type="button"
              disabled={dangChay || danhDau === undefined}
              onClick={() =>
                danhDau !== undefined &&
                chay(() => danhDauBcTiktokKhongDung({ bcId: danhDau, ghiChu }), `Đã đánh dấu BC ${danhDau} không dùng thẻ`)
              }
            >
              {dangChay ? "Đang lưu…" : "Xác nhận"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
