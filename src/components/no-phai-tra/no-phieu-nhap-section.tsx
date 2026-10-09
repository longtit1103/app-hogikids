import { differenceInCalendarDays, format } from "date-fns";
import Link from "next/link";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import { lyDoKhongXoaPhieu } from "@/lib/no-phai-tra/ly-do-khong-xoa-phieu";
import type { PhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";

import { NhanTrangThaiPhieu } from "./nhan-trang-thai-phieu";
import { TraTienHangButton } from "./tra-tien-hang-button";
import { XoaPhieuNoButton } from "./xoa-phieu-no-button";

/**
 * Khối "Nợ tiền hàng nhà cung cấp" (tab Dòng tiền, dưới Khoản vay). Mỗi dòng một phiếu nhập đã ghi nhận
 * vào sổ nợ: tổng · đã trả (trước + dòng tiền) · còn nợ / trả thừa / cần thu hồi · tuổi nợ. Phiếu đã
 * trả đủ gom vào một câu (không dài danh sách). Còn nợ suy từ dòng tiền — không có cột lưu sẵn.
 * `mocM` null (chưa bật) ⇒ chỉ đọc, KHÔNG có nút trả tiền (action đòi cổng bật).
 * `choPhepSua` ⇒ thêm cột thao tác: nút "Xoá" CHỈ ở phiếu chưa có dòng tiền nào (`lyDoKhongXoaPhieu` null —
 * cùng câu server ném); phiếu còn dòng tiền không có nút (gỡ các dòng trả/hoàn trước).
 */
export function NoPhieuNhapSection({
  phieu,
  vanTay,
  mocM,
  choPhepSua = false,
  homNay = new Date(),
}: {
  phieu: readonly PhieuConNo[];
  vanTay: string;
  mocM: string | null;
  choPhepSua?: boolean;
  homNay?: Date;
}) {
  const hienThi = phieu.filter((p) => p.trangThai !== "DA_TRA_DU");
  const soDaTraDu = phieu.length - hienThi.length;
  const tongConNo = phieu.reduce((s, p) => s + (p.conNo > 0 ? p.conNo : 0), 0);

  return (
    <div id="no-phieu-nhap" className="scroll-mt-20 rounded-xl border border-hairline p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Nợ tiền hàng nhà cung cấp</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            còn nợ = tổng phiếu − đã trả trước − các lần trả + hoàn; phiếu ghi nhận ở{" "}
            <Link href="/tai-chinh/chi-phi-nhap-hang" className="underline underline-offset-2">
              Chi phí nhập hàng từ Pancake
            </Link>
          </p>
        </div>
        {choPhepSua && mocM !== null && <TraTienHangButton phieu={phieu} vanTay={vanTay} mocM={mocM} />}
      </div>

      {phieu.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Chưa có phiếu nhập nào trong sổ nợ.</p>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink">
            Tổng còn nợ nhà cung cấp: <strong className="tabular-nums">{formatVnd(tongConNo)}</strong>
          </p>
          {hienThi.length > 0 && (
            <div className="mt-2 overflow-x-auto rounded-xl border border-hairline">
              <Table className="min-w-[620px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Phiếu</TableHead>
                    <TableHead>Ngày</TableHead>
                    <TableHead className="text-right">Tổng</TableHead>
                    <TableHead className="text-right">Đã trả</TableHead>
                    <TableHead className="text-right">Còn nợ</TableHead>
                    <TableHead className="text-right">Tuổi nợ</TableHead>
                    {choPhepSua && <TableHead className="w-0" aria-label="Thao tác" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hienThi.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-sm text-ink">{p.maPhieu}</TableCell>
                      <TableCell className="text-sm">{format(p.ngayPhieu, "dd/MM/yyyy")}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {p.daHuy ? <span className="text-muted-foreground">đã huỷ</span> : formatVnd(p.tongTien)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {formatVnd(p.daTraTruoc + p.daTra)}
                        {(p.daTraTruoc > 0 || p.daHoan > 0) && (
                          <p className="text-xs font-normal text-muted-foreground">
                            {p.daTraTruoc > 0 && <>trước {formatVnd(p.daTraTruoc)}</>}
                            {p.daTraTruoc > 0 && p.daHoan > 0 && " · "}
                            {p.daHoan > 0 && <>hoàn {formatVnd(p.daHoan)}</>}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        <NhanTrangThaiPhieu trangThai={p.trangThai} conNo={p.conNo} />
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                        {p.trangThai === "CON_NO"
                          ? `${Math.max(0, differenceInCalendarDays(homNay, p.ngayPhieu))} ngày`
                          : "—"}
                      </TableCell>
                      {choPhepSua && (
                        <TableCell className="text-right">
                          {lyDoKhongXoaPhieu({ soDongTien: p.soDongTien }) === null && (
                            <XoaPhieuNoButton phieuNhapId={p.id} maPhieu={p.maPhieu} />
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {ghiChuPhieuDaTraDu(soDaTraDu)}
        </>
      )}
    </div>
  );
}

function ghiChuPhieuDaTraDu(n: number) {
  if (n <= 0) return null;
  return <p className="mt-2 text-xs text-muted-foreground">{n.toLocaleString("vi-VN")} phiếu đã trả đủ (ẩn).</p>;
}
