import Link from "next/link";

import { formatVnd } from "@/lib/format";

export type DongDieuChinhDaGhi = { id: string; vao: boolean; soTien: number; moTa: string; ngayNhan: string };

/**
 * Trạng thái SAU khi bật: mốc, các dòng điều chỉnh quỹ của bước bật (sửa số/mô tả ở Sổ quỹ — chỉ chủ shop)
 * và đường tới các khối nợ. Thuần hiển thị; ngày đã format ở server.
 */
export function BatDaBatTomTat({ nhanM, dieuChinh }: { nhanM: string; dieuChinh: readonly DongDieuChinhDaGhi[] }) {
  const tong = dieuChinh.reduce((s, d) => s + (d.vao ? d.soTien : -d.soTien), 0);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-hairline p-4" data-testid="no-phai-tra-da-bat">
      <p className="text-sm text-ink">
        Đã bật theo dõi nợ phải trả từ <strong>{nhanM}</strong>. Từ ngày này quỹ chỉ giảm khi bạn thật trả thẻ, trả
        nhà cung cấp hoặc nạp ví quảng cáo; chi phí vẫn vào Lãi/Lỗ như cũ.
      </p>
      <div>
        <p className="text-xs text-muted-foreground">Điều chỉnh quỹ ngày bật ({dieuChinh.length} dòng)</p>
        {dieuChinh.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Không có dòng điều chỉnh nào (chênh lệch bằng 0).</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="no-phai-tra-lich-su-dieu-chinh">
            {dieuChinh.map((d) => (
              <li key={d.id} className="flex justify-between gap-3">
                <span className="text-muted-foreground">
                  {d.ngayNhan} · {d.moTa}
                </span>
                <span className={`tabular-nums ${d.vao ? "text-success" : "text-error"}`}>
                  {d.vao ? "+" : "−"}
                  {formatVnd(d.soTien)}
                </span>
              </li>
            ))}
            <li className="flex justify-between gap-3 border-t border-hairline pt-1 font-medium text-ink">
              <span>Tổng tác động lên quỹ</span>
              <span className="tabular-nums">
                {tong >= 0 ? "+" : "−"}
                {formatVnd(Math.abs(tong))}
              </span>
            </li>
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Thẻ, phiếu nợ và dòng điều chỉnh xem ở{" "}
        <Link href="/tai-chinh?tab=dong-tien" className="underline">
          Tài chính › Dòng tiền
        </Link>
        .
      </p>
    </div>
  );
}
