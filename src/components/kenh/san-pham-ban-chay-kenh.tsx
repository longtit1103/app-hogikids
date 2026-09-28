import Link from "next/link";

import { formatPct1 } from "@/components/kenh/channel-format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { ProductReportRow } from "@/lib/reports/product-report";

/**
 * Khối "Sản phẩm bán chạy theo kênh" ở `/kenh/:id` — top 10 sản phẩm theo
 * doanh thu trong kỳ đang xem. `rows` dùng chung reader `computeProductReport`
 * (product-report.ts, đã chạy với `channelId` ở page.tsx) — trang cắt 10 dòng
 * (`rows.slice(0, 10)`) TRƯỚC khi truyền xuống đây, component chỉ render
 * (không tự lọc/sort lại — giữ đúng thứ tự doanh thu desc từ reader).
 *
 * Biên gộp CHƯA trừ phí sàn (25–36%) — chú thích bắt buộc dưới bảng (bài học
 * khảo sát §2.6 #43: chủ shop dễ đọc nhầm biên gộp thành lãi thật).
 */
export function SanPhamBanChayKenh({
  rows,
  channelId,
  ky,
}: {
  rows: ProductReportRow[];
  channelId: string;
  ky: { tu: string; den: string };
}) {
  return (
    <div className="rounded-xl border border-hairline bg-canvas p-4">
      <h3 className="font-serif text-lg text-ink">Sản phẩm bán chạy theo kênh</h3>

      {rows.length === 0 ? (
        <p className="mt-4 py-8 text-center text-sm text-muted-foreground">Kỳ này kênh chưa bán sản phẩm nào.</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-hairline">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sản phẩm</TableHead>
                <TableHead className="text-right">SL bán</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                <TableHead className="text-right">Biên gộp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell>
                    <Link
                      href={`/bao-cao?kenh=${channelId}&tu=${ky.tu}&den=${ky.den}&sp=${row.productId}`}
                      className="text-primary hover:underline"
                    >
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.soldQty.toLocaleString("vi-VN")}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatVnd(row.revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.marginPct === null ? "—" : formatPct1(row.marginPct)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Biên gộp = (Doanh thu − Giá vốn) ÷ Doanh thu — chưa trừ phí sàn (25–36%). Lãi thật xem ở Lãi/Lỗ.
      </p>
    </div>
  );
}
