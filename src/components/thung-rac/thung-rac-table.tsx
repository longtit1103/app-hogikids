import Link from "next/link";
import { format } from "date-fns";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NHAN_LOAI_THUNG_RAC, THUNG_RAC_PAGE_SIZE, type ThungRacRow } from "@/lib/thung-rac/thung-rac-queries";
import { trangThaiThungRac } from "@/lib/thung-rac/trang-thai-thung-rac";

import { ThungRacRowActions } from "./thung-rac-row-actions";

function hrefWith(sp: Record<string, string | undefined>, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  const merged = { ...sp, ...overrides };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `/tai-chinh/thung-rac?${qs}` : "/tai-chinh/thung-rac";
}

/** Cột "Trạng thái": text + màu tuỳ theo `trangThaiThungRac()`, KHÔNG tự viết câu ở đây. */
function TrangThaiCell({ dong }: { dong: ThungRacRow }) {
  const t = trangThaiThungRac(dong);
  if (t.kind === "da_khoi_phuc") {
    return <span className="text-muted-foreground">{t.nhan}</span>;
  }
  if (t.kind === "khong_khoi_phuc_duoc") {
    return <span className="text-amber-700 dark:text-amber-500">{t.lyDo}</span>;
  }
  return <span className="text-muted-foreground">Chưa khôi phục</span>;
}

export function ThungRacTable({
  rows,
  total,
  page,
  sp,
}: {
  rows: ThungRacRow[];
  total: number;
  page: number;
  sp: Record<string, string | undefined>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / THUNG_RAC_PAGE_SIZE));

  return (
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Xoá lúc</TableHead>
            <TableHead>Loại</TableHead>
            <TableHead>Nội dung</TableHead>
            <TableHead>Ngày</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead className="text-right">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((dong) => {
            const t = trangThaiThungRac(dong);
            return (
              <TableRow key={dong.id} className={cn(t.kind === "da_khoi_phuc" && "opacity-50")}>
                <TableCell className="text-sm text-muted-foreground">
                  {format(dong.xoaLuc, "dd/MM/yyyy HH:mm")}
                </TableCell>
                <TableCell className="text-sm">{NHAN_LOAI_THUNG_RAC[dong.bang]}</TableCell>
                <TableCell className="text-sm text-ink">{dong.nhan}</TableCell>
                <TableCell className="text-sm">{format(dong.ngay, "dd/MM/yyyy")}</TableCell>
                <TableCell className="text-right font-serif text-ink tabular-nums">
                  {formatVnd(dong.soTien)}
                </TableCell>
                <TableCell className="text-sm">
                  <TrangThaiCell dong={dong} />
                </TableCell>
                <TableCell className="text-right">
                  {t.kind !== "da_khoi_phuc" && (
                    <ThungRacRowActions row={dong} khoiPhucDuoc={t.kind === "khoi_phuc_duoc"} />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Mobile: card dọc */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {rows.map((dong) => {
          const t = trangThaiThungRac(dong);
          return (
            <div
              key={dong.id}
              className={cn("flex flex-col gap-1.5 rounded-lg border border-hairline p-3", t.kind === "da_khoi_phuc" && "opacity-50")}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">{NHAN_LOAI_THUNG_RAC[dong.bang]}</p>
                  <p className="text-sm font-medium text-ink">{dong.nhan}</p>
                </div>
              </div>
              <p className="font-serif text-lg text-ink tabular-nums">{formatVnd(dong.soTien)}</p>
              <p className="text-xs text-muted-foreground">
                Ngày {format(dong.ngay, "dd/MM/yyyy")} · Xoá lúc {format(dong.xoaLuc, "dd/MM/yyyy HH:mm")}
              </p>
              <p className="text-xs">
                <TrangThaiCell dong={dong} />
              </p>
              {t.kind !== "da_khoi_phuc" && (
                <ThungRacRowActions row={dong} khoiPhucDuoc={t.kind === "khoi_phuc_duoc"} />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-4 py-3 text-sm text-muted-foreground">
        <span>{total} mục</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <Link
              href={hrefWith(sp, { trang: String(Math.max(1, page - 1)) })}
              aria-disabled={page <= 1}
              className={cn("rounded-md px-2 py-1 hover:bg-surface-soft", page <= 1 && "pointer-events-none opacity-40")}
            >
              ‹
            </Link>
            <span className="tabular-nums">
              {page}/{totalPages}
            </span>
            <Link
              href={hrefWith(sp, { trang: String(Math.min(totalPages, page + 1)) })}
              aria-disabled={page >= totalPages}
              className={cn(
                "rounded-md px-2 py-1 hover:bg-surface-soft",
                page >= totalPages && "pointer-events-none opacity-40"
              )}
            >
              ›
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
