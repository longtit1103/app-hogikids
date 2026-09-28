import { format, isAfter, startOfDay } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { DongSoQuy } from "@/lib/so-quy/dong-chay-so-quy-types";
import { NGUON_LABEL } from "@/lib/so-quy/nhan-nguon-dong-quy";
import { cn } from "@/lib/utils";

/**
 * Bảng dòng chạy Sổ quỹ — CHI TIẾT từng khoản tiền vào/ra trong kỳ, dòng đầu "Đầu kỳ" và dòng cuối
 * "Cuối kỳ" neo đúng hai số của thẻ Quỹ (không tự cộng lại — truyền thẳng từ props). Cùng khuôn
 * desktop-table/mobile-card với `cash-movement-table.tsx`. Nhãn 8 `NguonDongQuy` dùng chung với sheet
 * Excel xuất ra ở `nhan-nguon-dong-quy.ts` — hợp đồng `dong-chay-so-quy-types.ts` không cõng phần
 * hiển thị.
 */

/** dd/MM, cộng thêm giờ HH:mm khi giờ (đã ở múi VN — container `TZ=Asia/Ho_Chi_Minh`) khác 00:00. */
function formatNgay(d: Date): string {
  const ngay = format(d, "dd/MM");
  const gio = format(d, "HH:mm");
  return gio === "00:00" ? ngay : `${ngay} ${gio}`;
}

function ThuCell({ thu }: { thu: number }) {
  return (
    <TableCell
      className={cn("text-right text-sm tabular-nums", thu > 0 ? "text-success" : "text-muted-foreground")}
    >
      {thu > 0 ? formatVnd(thu) : "—"}
    </TableCell>
  );
}

function ChiCell({ chi }: { chi: number }) {
  return (
    <TableCell
      className={cn("text-right text-sm tabular-nums", chi > 0 ? "text-error" : "text-muted-foreground")}
    >
      {chi > 0 ? formatVnd(chi) : "—"}
    </TableCell>
  );
}

/** Ngày dòng nằm SAU hôm nay (theo ngày, không theo giờ) ⇒ khoản chưa thật sự xảy ra — ghi tay trước
 * (chi phí định kỳ sinh sẵn cả tháng, kỳ trả nợ duyệt trước hạn…). Không đổi SỐ, chỉ gắn dấu để chủ
 * shop khỏi tưởng khoản đã chi/thu thật hôm nay. */
function laDongDuKien(ngay: Date): boolean {
  return isAfter(startOfDay(ngay), startOfDay(new Date()));
}

function DauKienTag() {
  return <span className="text-xs text-muted-foreground">(dự kiến)</span>;
}

function DongRow({ dong }: { dong: DongSoQuy }) {
  const duKien = laDongDuKien(dong.ngay);
  return (
    <TableRow data-testid="so-quy-dong-chay-row">
      <TableCell className="text-sm whitespace-nowrap">
        {formatNgay(dong.ngay)} {duKien && <DauKienTag />}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{NGUON_LABEL[dong.nguon]}</Badge>
      </TableCell>
      <TableCell className="max-w-[280px] truncate" title={dong.dienGiai}>
        {dong.dienGiai}
      </TableCell>
      <ThuCell thu={dong.thu} />
      <ChiCell chi={dong.chi} />
      <TableCell className="text-right text-sm tabular-nums text-ink">{formatVnd(dong.soDu)}</TableCell>
    </TableRow>
  );
}

function DongCardMobile({ dong }: { dong: DongSoQuy }) {
  const duKien = laDongDuKien(dong.ngay);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-hairline p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">{NGUON_LABEL[dong.nguon]}</Badge>
        <span className="text-xs text-muted-foreground">
          {formatNgay(dong.ngay)} {duKien && <DauKienTag />}
        </span>
      </div>
      <p className="text-sm text-ink">{dong.dienGiai}</p>
      <div className="flex items-center justify-between text-sm tabular-nums">
        <span>
          {dong.thu > 0 && <span className="text-success">+{formatVnd(dong.thu)}</span>}
          {dong.chi > 0 && <span className="text-error">−{formatVnd(dong.chi)}</span>}
        </span>
        <span className="text-ink">{formatVnd(dong.soDu)}</span>
      </div>
    </div>
  );
}

export function SoQuyDongChayTable({
  dong,
  dauKy,
  cuoiKy,
  nhanCuoiKy = "Cuối kỳ",
  ghiChuCuoiKy,
}: {
  dong: DongSoQuy[];
  /** = `SoQuyDongChay.dauKy` (CO_SO) — số của thẻ Quỹ, không tự cộng lại ở đây. */
  dauKy: number;
  /** = `SoQuyDongChay.cuoiKy` (CO_SO) — số của thẻ Quỹ. */
  cuoiKy: number;
  /** "Cuối kỳ (dự kiến hết tháng)" khi tháng hiện tại còn khoản ghi ngày sau hôm nay — cùng luật
   * nhãn của thẻ Quỹ (`so-quy-card.tsx`), tab tính sẵn và truyền xuống. */
  nhanCuoiKy?: string;
  /** Ghi chú dưới nhãn — chỉ có khi `nhanCuoiKy` đổi. */
  ghiChuCuoiKy?: string;
}) {
  return (
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Ngày</TableHead>
            <TableHead>Nguồn</TableHead>
            <TableHead>Diễn giải</TableHead>
            <TableHead className="text-right">Thu</TableHead>
            <TableHead className="text-right">Chi</TableHead>
            <TableHead className="text-right">Số dư</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="bg-surface-soft">
            <TableCell colSpan={5} className="text-sm font-medium text-ink">
              Đầu kỳ
            </TableCell>
            <TableCell className="text-right text-sm font-medium tabular-nums text-ink">
              {formatVnd(dauKy)}
            </TableCell>
          </TableRow>
          {dong.map((d) => (
            <DongRow key={d.key} dong={d} />
          ))}
          {dong.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-xs text-muted-foreground">
                Không có phát sinh trong tháng.
              </TableCell>
            </TableRow>
          )}
          <TableRow className="bg-surface-soft">
            <TableCell colSpan={5} className="text-sm font-medium text-ink">
              {nhanCuoiKy}
              {ghiChuCuoiKy && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">{ghiChuCuoiKy}</span>
              )}
            </TableCell>
            <TableCell className="text-right text-sm font-medium tabular-nums text-ink">
              {formatVnd(cuoiKy)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      {/* Mobile: card dọc — không bảng nên không cuộn ngang cả trang ở màn hẹp. */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        <div className="flex items-center justify-between rounded-lg bg-surface-soft px-3 py-2 text-sm font-medium text-ink">
          <span>Đầu kỳ</span>
          <span className="tabular-nums">{formatVnd(dauKy)}</span>
        </div>
        {dong.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">Không có phát sinh trong tháng.</p>
        ) : (
          dong.map((d) => <DongCardMobile key={d.key} dong={d} />)
        )}
        <div className="flex flex-col gap-0.5 rounded-lg bg-surface-soft px-3 py-2 text-sm font-medium text-ink">
          <div className="flex items-center justify-between">
            <span>{nhanCuoiKy}</span>
            <span className="tabular-nums">{formatVnd(cuoiKy)}</span>
          </div>
          {ghiChuCuoiKy && <p className="text-xs font-normal text-muted-foreground">{ghiChuCuoiKy}</p>}
        </div>
      </div>
    </div>
  );
}
