"use client";

import { differenceInCalendarDays, format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { SoTietKiemRowActions } from "./so-tiet-kiem-row-actions";

/**
 * Bảng khối "Sổ tiết kiệm" (tab Dòng tiền, spec mục 11). Cột "Đáo hạn/Tất toán" và "Lãi" ĐỔI NGHĨA
 * theo trạng thái sổ — bốn hàm thuần dưới đây là nơi DUY NHẤT quyết định chữ in ra, tách khỏi JSX để
 * `tests/so-tiet-kiem-table-format.test.ts` kiểm bằng số literal. Desktop bảng, mobile card dọc
 * (khuôn `khoan-vay-table.tsx`).
 */

const NGAY_COI_LA_TRE_CHU = "quá hạn";

/**
 * Cột "Đáo hạn / Tất toán". Sổ ĐANG GỬI: còn/quá bao nhiêu ngày tới `maturityDate`. Sổ ĐÃ TẤT TOÁN:
 * ngày tất toán + cờ rút trước hạn — đọc THẲNG `so.rutTruocHan` (đã tính sẵn ở Phase 02 bằng
 * `closedAt < maturityDate`), KHÔNG suy lại ở đây để tránh hai nơi tính ra hai kết quả khác nhau.
 */
export function daoHanTatToanText(
  so: Pick<SoTietKiemRow, "closedAt" | "maturityDate" | "rutTruocHan">,
  homNay: Date
): { text: string; rutTruocHan: boolean } {
  if (so.closedAt === null) {
    const conLai = differenceInCalendarDays(so.maturityDate, homNay);
    const veSau =
      conLai >= 0 ? `còn ${conLai} ngày` : `${NGAY_COI_LA_TRE_CHU} ${Math.abs(conLai)} ngày`;
    return { text: `đáo hạn ${format(so.maturityDate, "dd/MM")} · ${veSau}`, rutTruocHan: false };
  }
  return { text: `tất toán ${format(so.closedAt, "dd/MM")}`, rutTruocHan: so.rutTruocHan };
}

/** Cột "Lãi". Đang gửi: hai dòng (dự kiến + dồn tới nay). Đã tất toán: MỘT dòng "thực nhận" — không
 *  còn gì để "dự kiến" nữa, kể cả khi lãi = 0 (rút trước hạn ngân hàng không trả lãi). */
export function laiColumnLines(
  so: Pick<SoTietKiemRow, "closedAt" | "laiDuKien" | "laiDonToiNay" | "laiThucNhan">
): { dong1: string; dong2: string | null } {
  if (so.closedAt === null) {
    return {
      dong1: `dự kiến ${formatVnd(so.laiDuKien)}`,
      dong2: `dồn tới nay ≈ ${formatVnd(so.laiDonToiNay)}`,
    };
  }
  return { dong1: `thực nhận ${formatVnd(so.laiThucNhan ?? 0)}`, dong2: null };
}

function coDauPhanTram(bp: number): string {
  return `${bp < 0 ? "−" : "+"}${(Math.abs(bp) / 100).toLocaleString("vi-VN")}%/năm`;
}

function coDauTien(n: number): string {
  return n < 0 ? formatVnd(n) : `+${formatVnd(n)}`; // formatVnd tự có dấu − cho số âm, chỉ thêm + cho số dương
}

/** Dòng phụ "Từ khoản vay…" (spec mục 11) — ẨN khi `chenhLech` null (không gắn khoản vay, hoặc thiếu
 *  dữ liệu để so — spec §6.3). `laiVay` suy NGƯỢC từ `chenhBp = so.annualRateBp − laiVay` vì
 *  `SoTietKiemRow.loan` chỉ mang `{id, name}`, không mang lãi suất khoản vay trực tiếp. */
export function dongChenhLechText(
  so: Pick<SoTietKiemRow, "annualRateBp" | "loan" | "chenhLech">
): string | null {
  if (so.chenhLech === null || so.loan === null) return null;
  const { chenhBp, chenhMoiNam, quyDoi } = so.chenhLech;
  const laiVay = so.annualRateBp - chenhBp;
  return `Từ khoản vay ${so.loan.name} (${(laiVay / 100).toLocaleString("vi-VN")}%/năm${
    quyDoi ? ", quy đổi" : ""
  }) → chênh ${coDauPhanTram(chenhBp)} ≈ ${coDauTien(chenhMoiNam)} (ước tính)`;
}

/** Dòng tổng cuối bảng (spec mục 11): Σ đang gửi + Σ lãi dự kiến CHỈ tính sổ đang gửi; Σ lãi đã nhận
 *  CHỈ tính sổ đã tất toán — trộn hai vế là cộng lãi "dự kiến" của sổ đã xong vào Σ đã nhận.
 *
 *  `laiNhanSum` ở đây cộng TOÀN BỘ lịch sử sổ đã tất toán trong `rows` — hữu ích để kiểm bằng test,
 *  nhưng KHÔNG dùng để in ra dòng tổng bảng (xem `SoTietKiemTable`): chốt rà chéo #6 (2026-09-16) bắt
 *  "Lãi đã nhận trong kỳ Σ" phải LỌC THEO KỲ đang xem qua `tongLaiDaNhanTrongKy(range)` (Phase 02),
 *  không phải cộng mọi sổ đã tất toán từ trước tới nay nằm cạnh các số theo tháng khác trên cùng
 *  dòng — đọc sai chắc chắn. */
export function tongBangSoTietKiem(rows: SoTietKiemRow[]): {
  dangGui: number;
  laiDuKienSum: number;
  laiNhanSum: number;
} {
  let dangGui = 0;
  let laiDuKienSum = 0;
  let laiNhanSum = 0;
  for (const r of rows) {
    if (r.closedAt === null) {
      // `r.dangGui` (Σ SAVINGS_OUT − Σ SAVINGS_IN) chứ KHÔNG phải `r.principal` khai trên sổ: hai
      // số lệch nhau ngay khi sổ có dòng ghi tay, và footnote thẻ Quỹ ngay TRÊN bảng này đã dùng số
      // suy từ dòng tiền — lấy `principal` ở đây là hai con số tiền đá nhau trên cùng một màn.
      dangGui += r.dangGui;
      laiDuKienSum += r.laiDuKien;
    } else {
      laiNhanSum += r.laiThucNhan ?? 0;
    }
  }
  return { dangGui, laiDuKienSum, laiNhanSum };
}

function LaiSuatText({ so }: { so: SoTietKiemRow }) {
  const chenh = dongChenhLechText(so);
  return (
    <>
      {so.annualRateBp ? `${(so.annualRateBp / 100).toLocaleString("vi-VN")}%/năm` : "—"}
      {chenh && <p className="mt-0.5 text-xs font-normal text-muted-foreground">{chenh}</p>}
    </>
  );
}

function DaoHanBadge({ so, homNay }: { so: SoTietKiemRow; homNay: Date }) {
  const d = daoHanTatToanText(so, homNay);
  return (
    <>
      {d.text}
      {d.rutTruocHan && (
        <Badge variant="outline" className="ml-1.5">
          rút trước hạn
        </Badge>
      )}
    </>
  );
}

function LaiCell({ so }: { so: SoTietKiemRow }) {
  const l = laiColumnLines(so);
  return (
    <>
      <p>{l.dong1}</p>
      {l.dong2 && <p className="text-xs text-muted-foreground">{l.dong2}</p>}
    </>
  );
}

export function SoTietKiemTable({
  rows,
  loans,
  laiNhanTrongKy,
}: {
  rows: SoTietKiemRow[];
  loans: KhoanVayRow[];
  /**
   * Σ lãi đã nhận TRONG KỲ đang xem — CALLER đọc bằng `tongLaiDaNhanTrongKy(range)` (Phase 02) và
   * truyền vào, KHÔNG suy từ `rows` ở đây: `rows` chứa TOÀN BỘ sổ (mọi kỳ), còn trang Tài chính luôn
   * đang xem MỘT kỳ — chốt rà chéo #6 (2026-09-16). Xem chú thích `tongBangSoTietKiem.laiNhanSum` để
   * biết vì sao con số đó KHÔNG dùng ở đây.
   */
  laiNhanTrongKy: number;
}) {
  const homNay = new Date();
  const tong = tongBangSoTietKiem(rows);

  return (
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Tên</TableHead>
            <TableHead>Ngân hàng</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            <TableHead>Ngày gửi · Kỳ hạn</TableHead>
            <TableHead>Đáo hạn / Tất toán</TableHead>
            <TableHead>Lãi %/năm</TableHead>
            <TableHead>Lãi</TableHead>
            <TableHead className="text-right">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((so) => (
            <TableRow key={so.id}>
              <TableCell className="text-sm text-ink">{so.name}</TableCell>
              <TableCell className="text-sm">{so.bank || "—"}</TableCell>
              <TableCell className="text-right font-serif text-ink tabular-nums">
                {formatVnd(so.principal)}
              </TableCell>
              <TableCell className="text-sm">
                {format(so.startDate, "dd/MM/yyyy")} · {so.termMonths} tháng
              </TableCell>
              <TableCell className="text-sm">
                <DaoHanBadge so={so} homNay={homNay} />
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                <LaiSuatText so={so} />
              </TableCell>
              <TableCell className="text-sm">
                <LaiCell so={so} />
              </TableCell>
              <TableCell className="text-right">
                <SoTietKiemRowActions so={so} loans={loans} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Mobile: card dọc */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {rows.map((so) => (
          <div key={so.id} className="flex flex-col gap-1.5 rounded-lg border border-hairline p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-ink">{so.name}</p>
                <p className="text-xs text-muted-foreground">{so.bank || "—"}</p>
              </div>
              <SoTietKiemRowActions so={so} loans={loans} />
            </div>
            <p className="font-serif text-xl text-ink tabular-nums">{formatVnd(so.principal)}</p>
            <p className="text-xs text-muted-foreground">
              <DaoHanBadge so={so} homNay={homNay} />
            </p>
            <div className="text-xs text-ink">
              <LaiCell so={so} />
            </div>
            <p className="text-xs text-muted-foreground">
              {format(so.startDate, "dd/MM/yyyy")} · {so.termMonths} tháng · <LaiSuatText so={so} />
            </p>
          </div>
        ))}
      </div>

      <div className="border-t border-hairline p-3 text-xs text-muted-foreground">
        Đang gửi Σ {formatVnd(tong.dangGui)} · Lãi dự kiến Σ {formatVnd(tong.laiDuKienSum)} · Lãi đã
        nhận trong kỳ Σ {formatVnd(laiNhanTrongKy)}
      </div>
    </div>
  );
}
