"use client";

import { differenceInCalendarDays, format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

import { KhoanVayRowActions } from "./khoan-vay-row-actions";

/**
 * Bảng khoản vay của khối "Khoản vay" (tab Dòng tiền). Dư nợ gốc là cột NỔI BẬT — nó là con số chủ
 * shop cần khi quyết định vay thêm hay trả bớt. Desktop bảng, mobile card dọc (khuôn
 * `cash-movement-table`).
 *
 * Mọi số ở đây do `listKhoanVay()` suy lại từ dòng tiền, KHÔNG có cột dư nợ lưu sẵn để lệch với sổ.
 */

const NGAY_COI_LA_TRE = 7;

/**
 * Cột "Lãi" (tiêu đề KHÔNG ghim "%/năm" nữa — khoản BULLET khai lãi CỐ ĐỊNH theo giấy ngân hàng
 * (`Loan.laiCoDinhMoiKy`), tiêu đề cũ "Lãi %/năm" khiến số "1.121.096 ₫/kỳ" đọc lướt thành lãi suất
 * 1.121.096%/năm). Khoản BULLET hiện thẳng số tiền/kỳ đó, đừng in "—" như vay người thân không lãi:
 * khoản 200tr trả 1.121.096đ/kỳ mà hiện y hệt khoản 0đ lãi khiến chủ shop xếp sai thứ tự ưu tiên trả
 * nợ. Nội dung tự mang đơn vị ("10,5%/năm" hay "…/kỳ") nên tiêu đề chỉ cần nói "Lãi".
 */
function laiSuatText(loan: Pick<KhoanVayRow, "kind" | "annualRateBp" | "laiCoDinhMoiKy">): string {
  if (loan.kind === "BULLET" && loan.laiCoDinhMoiKy !== null) {
    return `${formatVnd(loan.laiCoDinhMoiKy)}/kỳ`;
  }
  return loan.annualRateBp ? `${(loan.annualRateBp / 100).toLocaleString("vi-VN")}%/năm` : "—";
}

/**
 * Kỳ hạn HỢP ĐỒNG (số kỳ chủ shop khai lúc tạo — với khoản mang sang là số kỳ CÒN LẠI lúc khai),
 * KHÔNG trừ số kỳ đã duyệt. Cột phải mang tên "Kỳ hạn", đừng hứa "còn lại". Thấu chi KHÔNG có
 * `termMonths` (luôn null) — hiện thẳng "thấu chi" thay vì "không lịch" (đó là câu dành cho vay
 * người thân, không mô tả đúng thấu chi).
 */
function kyHanText(loan: KhoanVayRow): string {
  if (loan.kind === "OVERDRAFT") return "thấu chi";
  return loan.termMonths === null ? "không lịch" : `${loan.termMonths} kỳ`;
}

/** Thấu chi chỉ có lịch THU LÃI (không có lịch trả gốc) nên câu phải nói rõ "lãi", khác vay kỳ hạn. */
function ngayTraText(loan: KhoanVayRow): string {
  if (loan.kind === "OVERDRAFT") {
    return loan.firstDueDate === null
      ? "lãi khi tất toán"
      : `lãi ngày ${format(loan.firstDueDate, "dd")} hàng tháng`;
  }
  return loan.firstDueDate === null ? "—" : `${format(loan.firstDueDate, "dd/MM")} hàng tháng`;
}

function KyToi({ loan }: { loan: KhoanVayRow }) {
  if (loan.kyCho === null) return <span className="text-muted-foreground">—</span>;
  const tre = differenceInCalendarDays(new Date(), loan.kyCho.denNgay) > NGAY_COI_LA_TRE;
  return (
    <span className="inline-flex items-center gap-1.5">
      {format(loan.kyCho.denNgay, "dd/MM")}
      {tre && <Badge variant="outline">trễ</Badge>}
    </span>
  );
}

function TrangThai({ loan }: { loan: KhoanVayRow }) {
  return (
    <Badge variant={loan.closedAt === null ? "secondary" : "outline"}>
      {loan.closedAt === null ? "Đang vay" : "Đã tất toán"}
    </Badge>
  );
}

export function KhoanVayTable({ rows }: { rows: KhoanVayRow[] }) {
  return (
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Tên</TableHead>
            <TableHead>Ngân hàng</TableHead>
            <TableHead>Lãi</TableHead>
            <TableHead>Kỳ hạn</TableHead>
            <TableHead>Ngày trả</TableHead>
            <TableHead className="text-right">Dư nợ gốc</TableHead>
            <TableHead>Kỳ tới</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead className="text-right">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((loan) => (
            <TableRow key={loan.id}>
              <TableCell className="text-sm text-ink">{loan.name}</TableCell>
              <TableCell className="text-sm">{loan.lender || "—"}</TableCell>
              <TableCell className="text-sm tabular-nums">{laiSuatText(loan)}</TableCell>
              <TableCell className="text-sm">{kyHanText(loan)}</TableCell>
              <TableCell className="text-sm">{ngayTraText(loan)}</TableCell>
              <TableCell className="text-right font-serif text-ink tabular-nums">
                {formatVnd(loan.duNo)}
                {loan.laiTamTinh !== null && (
                  <p className="text-right font-sans text-xs font-normal text-muted-foreground">
                    lãi tới nay ≈ {formatVnd(loan.laiTamTinh)}
                  </p>
                )}
                {loan.tienGuiDangGiu > 0 && (
                  <p className="text-right font-sans text-xs font-normal text-muted-foreground">
                    Sổ tiết kiệm NH giữ: {formatVnd(loan.tienGuiDangGiu)}
                  </p>
                )}
              </TableCell>
              <TableCell className="text-sm">
                <KyToi loan={loan} />
              </TableCell>
              <TableCell>
                <TrangThai loan={loan} />
              </TableCell>
              <TableCell className="text-right">
                <KhoanVayRowActions loan={loan} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Mobile: card dọc */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {rows.map((loan) => (
          <div key={loan.id} className="flex flex-col gap-1.5 rounded-lg border border-hairline p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-ink">{loan.name}</p>
                <p className="text-xs text-muted-foreground">{loan.lender || "—"}</p>
              </div>
              <KhoanVayRowActions loan={loan} />
            </div>
            <p className="font-serif text-xl text-ink tabular-nums">{formatVnd(loan.duNo)}</p>
            {loan.laiTamTinh !== null && (
              <p className="text-xs text-muted-foreground">lãi tới nay ≈ {formatVnd(loan.laiTamTinh)}</p>
            )}
            {loan.tienGuiDangGiu > 0 && (
              <p className="text-xs text-muted-foreground">
                Sổ tiết kiệm NH giữ: {formatVnd(loan.tienGuiDangGiu)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {laiSuatText(loan)} · {kyHanText(loan)} · {ngayTraText(loan)}
            </p>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                Kỳ tới: <KyToi loan={loan} />
              </span>
              <TrangThai loan={loan} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
