import Link from "next/link";

import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { formatVnd } from "@/lib/format";
import { CUA_SO_CHO_QUYET_TOAN_NGAY, type DonSanChuaGhiDoanhThu } from "@/lib/reports/doi-soat-tien-ve";
import { cn } from "@/lib/utils";

/**
 * Khối "Sàn chưa ghi doanh thu" — con của `DoiSoatSection`, tách file riêng vì file
 * gốc đã 300+ dòng.
 *
 * CHỈ-ĐỌC, CHỈ CẢNH BÁO (chủ shop chốt 03/09): sàn đã có giao dịch quyết toán cho
 * đơn nhưng chưa ghi đồng doanh thu nào (có khi còn thu ngược phí), mà Pancake vẫn
 * để trạng thái đã giao nên app vẫn cộng doanh thu vào P&L. Khối này KHÔNG sửa P&L,
 * KHÔNG sửa trạng thái đơn, KHÔNG đổi công thức nào — xem chú thích
 * `DonSanChuaGhiDoanhThu` ở `doi-soat-tien-ve.ts` cho đầy đủ bối cảnh + số đo prod.
 */
export function DoiSoatSanChuaGhiDoanhThu({
  danhSach,
  tongDoanhThuApp,
}: {
  danhSach: DonSanChuaGhiDoanhThu[];
  tongDoanhThuApp: number;
}) {
  if (danhSach.length === 0) return null;

  return (
    <div className="mt-3 border-t border-hairline pt-3" data-testid="doi-soat-san-chua-ghi-doanh-thu">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-ink">Sàn chưa ghi doanh thu</p>
        <p className="font-serif tabular-nums text-error">
          Doanh thu app đang tính {formatVnd(tongDoanhThuApp)}
        </p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sàn đã có giao dịch quyết toán cho các đơn này nhưng chưa ghi đồng doanh thu nào — app vẫn
        đang tính doanh thu vì Pancake để trạng thái đã giao. Kiểm tra đơn bên TikTok/Pancake; app
        không tự sửa.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-2 font-normal">Đơn</th>
              <th className="py-1.5 pr-2 font-normal">Trạng thái</th>
              <th className="py-1.5 pr-2 text-right font-normal">Doanh thu app tính</th>
              <th className="py-1.5 pr-2 text-right font-normal">Sàn đã trả</th>
              <th className="py-1.5 pr-2 text-right font-normal">Tuổi đơn</th>
              <th className="py-1.5 font-normal">Cần làm gì</th>
            </tr>
          </thead>
          <tbody>
            {danhSach.map((d) => (
              <tr
                key={d.id}
                className="border-b border-hairline/60 last:border-0"
                data-testid="doi-soat-san-chua-ghi-doanh-thu-dong"
              >
                <td className="py-1.5 pr-2">
                  <Link href={`/don-hang?don=${d.id}`} className="text-ink underline-offset-2 hover:underline">
                    #{d.code}
                  </Link>
                  {/* Mã ngắn KHÔNG định danh được đơn (TikTok có 2 cặp mã trùng) —
                      hiện đuôi mã sàn để tra bên Pancake không nhầm đơn. */}
                  <span className="ml-1 text-xs text-muted-foreground" title={d.pancakeId}>
                    …{d.pancakeId.slice(-6)}
                  </span>
                  <span className="ml-1 text-xs text-muted-foreground">({d.soGiaoDich} gd)</span>
                </td>
                <td className="py-1.5 pr-2">
                  <OrderStatusBadge status={d.status} />
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{formatVnd(d.doanhThuApp)}</td>
                <td className={cn("py-1.5 pr-2 text-right tabular-nums", d.sanTra < 0 && "text-error")}>
                  {formatVnd(d.sanTra)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{d.tuoiNgay} ngày</td>
                <td className="py-1.5 text-xs">
                  {d.conTrongCuaSoCho ? (
                    <span className="text-muted-foreground">còn chờ sàn</span>
                  ) : (
                    <span className="text-error">cần kiểm tra</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        <span className="text-muted-foreground">còn chờ sàn</span>: đơn ĐẶT trong vòng{" "}
        {CUA_SO_CHO_QUYET_TOAN_NGAY} ngày — sàn có thể chưa kịp ghi nhận doanh thu, chưa kết luận
        được. <span className="text-error">cần kiểm tra</span>: đơn ĐẶT đã quá{" "}
        {CUA_SO_CHO_QUYET_TOAN_NGAY} ngày mà sàn vẫn chưa ghi doanh thu — đối chiếu trạng thái thật
        bên TikTok/Pancake.
      </p>
    </div>
  );
}
