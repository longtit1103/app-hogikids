"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { SoSanBao } from "@/components/marketing/so-san-bao";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatVnd } from "@/lib/format";
import { nhanTrangThaiChotHoaHong } from "@/lib/marketing/nhan-trang-thai-chot-hoa-hong";
import type { DonCuaCreator } from "@/lib/reports/marketing/creator-tiktok";

/**
 * Drawer đơn cấp DÒNG SKU của MỘT creator (tab `creator`, spec §5.3). Mở qua `?creator=<username>` —
 * cùng cơ chế `?don=` của `OrderDetailDrawer`: server (`page.tsx`) đọc param, gọi `donCuaCreator`
 * rồi truyền dữ liệu xuống; component này chỉ render + đóng (xoá param khỏi URL).
 *
 * MỌI số ở đây là SỐ SÀN TỰ NHẬN CÔNG (bọc `<SoSanBao>`). Hoa hồng "—" = sàn KHÔNG báo (object
 * rỗng), KHÁC "0 ₫" = sàn báo 0 tường minh — giữ đúng hai mặt chữ đó.
 *
 * Cột "Trạng thái" (chủ shop chốt 30/08: chỉ đổi cách HIỂN THỊ ở drawer, không đụng reader/bảng creator): chuỗi sàn
 * → nhãn Việt qua `nhanTrangThaiChotHoaHong`
 * — fail-open, chỉ SETTLED/INELIGIBLE là trạng thái cuối, còn lại (kể cả sàn không báo) là "đang chờ sàn
 * chốt"; chuỗi gốc giữ trong `title` của ô để không mất bằng chứng. Đây là lý do "HH đã trả" có thể còn
 * "—" ở dòng mới: sàn chốt SAU giao, app kéo lại đơn 60 ngày gần nhất mỗi đêm nên nhãn sẽ tự đổi.
 */
export function CreatorDrawer({
  creator,
  dong,
}: {
  creator: string | null;
  dong: DonCuaCreator[] | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function close() {
    const params = new URLSearchParams(searchParams);
    params.delete("creator");
    router.replace(params.size ? `${pathname}?${params.toString()}` : pathname);
  }

  if (creator === null || dong === null) return null;

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-serif text-lg">
            Đơn affiliate — {creator === "" ? "(không rõ creator)" : creator}
          </SheetTitle>
        </SheetHeader>

        {dong.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">Kỳ này creator không có dòng SKU nào.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-hairline text-left text-muted-foreground">
                  <th className="py-1.5 pr-2 font-normal">Ngày</th>
                  <th className="py-1.5 pr-2 font-normal">Mã đơn</th>
                  <th className="py-1.5 pr-2 font-normal">SKU</th>
                  <th className="py-1.5 pr-2 font-normal">Kênh</th>
                  <th className="py-1.5 pr-2 text-right font-normal">HH ước tính</th>
                  <th className="py-1.5 pr-2 text-right font-normal">HH đã trả</th>
                  <th
                    className="py-1.5 font-normal"
                    title="Trạng thái chốt hoa hồng do sàn báo: đã chốt · không đủ ĐK · đang chờ sàn chốt (mọi trạng thái khác, kể cả sàn chưa báo)"
                  >
                    Trạng thái
                  </th>
                </tr>
              </thead>
              <tbody>
                {dong.map((d) => {
                  // Nhãn + chuỗi gốc tính MỘT lần mỗi dòng (fail-open — xem docblock).
                  const tt = nhanTrangThaiChotHoaHong(d.trangThaiChot);
                  return (
                  <tr key={`${d.donId}:${d.skuId}`} className="border-b border-hairline/60 last:border-0">
                    <td className="py-1.5 pr-2 tabular-nums text-ink">{d.ngay}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-ink">{d.donId}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">{d.skuId}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{d.loaiNoiDung ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {d.hoaHongUocTinh === null ? "—" : <SoSanBao>{formatVnd(d.hoaHongUocTinh)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {d.hoaHongDaTra === null ? "—" : <SoSanBao>{formatVnd(d.hoaHongDaTra)}</SoSanBao>}
                    </td>
                    <td
                      className="py-1.5 text-muted-foreground"
                      title={tt.goc === null ? "Sàn không báo trạng thái" : `Sàn báo: ${tt.goc}`}
                    >
                      {tt.nhan}
                      {d.hoanToanBo && " · hoàn toàn bộ"}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 border-t border-hairline pt-2 text-[11px] text-muted-foreground">
          Số do TikTok quy công cho creator — chỉ tham khảo. &quot;—&quot; = sàn không báo khoản đó (khác 0 ₫
          = sàn báo 0 tường minh). &quot;Đang chờ sàn chốt&quot; = sàn chưa chốt hoa hồng (kể cả chưa báo trạng
          thái); app kéo lại đơn trong 60 ngày gần nhất mỗi đêm nên nhãn tự đổi khi sàn chốt.
        </p>
      </SheetContent>
    </Sheet>
  );
}
