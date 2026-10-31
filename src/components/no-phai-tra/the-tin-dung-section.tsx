import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { CanhBaoHoaDonTiktok } from "@/lib/no-phai-tra/canh-bao-hoa-don-tiktok-tre";
import type { GoiYChotSaoKe } from "@/lib/no-phai-tra/doc-khoi-no-phai-tra";
import type { PhanPhaiTra } from "@/lib/no-phai-tra/ky-sao-ke";
import { locTheDongConNo } from "@/lib/no-phai-tra/the-da-dong-con-no";
import type { TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";

import { CanhBaoTheDongConNo } from "./canh-bao-the-dong-con-no";
import { MocGanNenTang } from "./moc-gan-nen-tang";
import { NhapSaoKeTheButton } from "./nhap-sao-ke-the-button";
import { TheTinDungAddButton } from "./the-tin-dung-add-button";
import { TheTinDungRowActions } from "./the-tin-dung-row-actions";

/** Khoá ngày `yyyy-MM-dd` ⇒ `dd/MM` (không qua `Date` — khỏi lệch múi giờ khi render). */
function nhanNgay(khoa: string): string {
  const [, thang, ngay] = khoa.split("-");
  return `${ngay}/${thang}`;
}

/** Một phần của kỳ phải trả: số tiền · hạn, kèm nhãn đỏ "quá hạn từ dd/MM" / "đến hạn hôm nay". */
function PhanKy({ phan }: { phan: PhanPhaiTra }) {
  return (
    <p className="text-xs">
      <span className="tabular-nums text-ink">{formatVnd(phan.soTien)}</span>
      <span className="text-muted-foreground"> · hạn {format(phan.hanTra, "dd/MM")}</span>
      {phan.quaHan && (
        <span className="ml-1.5 font-medium text-error">quá hạn từ {format(phan.hanTra, "dd/MM")}</span>
      )}
      {phan.denHanHomNay && <span className="ml-1.5 font-medium text-warning">đến hạn hôm nay</span>}
    </p>
  );
}

const GIAI_THICH_PHAI_TRA = "Phải trả = số sao kê ngân hàng; dư nợ ước tính còn gồm bill ghi sổ trễ";

function KyGanNhat({ the }: { the: TheKemTrangThai }) {
  const p = the.phaiTra;
  if (p === null) return <span className="text-xs text-muted-foreground">Chưa có kỳ sao kê</span>;
  if (p.nghiaVuKy === 0) return <span className="text-xs text-muted-foreground">Đã trả đủ kỳ gần nhất</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {/* Nghĩa vụ kỳ = số ngân hàng in trên sao kê; neo dư nợ có thể cao hơn vì gồm bill ghi sổ trễ (ngân hàng xếp kỳ sau). */}
      <p className="text-xs text-muted-foreground" title={GIAI_THICH_PHAI_TRA}>
        Phải trả <strong className="tabular-nums text-ink">{formatVnd(p.nghiaVuKy)}</strong> theo sao kê
      </p>
      {p.phanTruoc && <PhanKy phan={p.phanTruoc} />}
      {p.phanMoi && <PhanKy phan={p.phanMoi} />}
    </div>
  );
}

/**
 * Khối "Thẻ tín dụng" (tab Dòng tiền, dưới Khoản vay) — thuần hiển thị, dữ liệu do `docKhoiNoPhaiTra`.
 * Dư nợ là số ƯỚC TÍNH (neo sao kê + giao dịch gán về thẻ), KHÔNG phải số ngân hàng; chốt sao kê là
 * cách đưa nó về đúng số thật. Quỹ chỉ đổi khi trả thẻ thật — khối này không động tới quỹ.
 * Thẻ đã đóng còn dư nợ ≠ 0 (ads về muộn) có chỉ báo riêng ngay dưới tiêu đề.
 */
export function TheTinDungSection({
  the,
  mocM,
  goiYChot,
  choPhepSua = false,
  laChuShop = false,
  canhBaoHoaDonTiktok = null,
}: {
  the: readonly TheKemTrangThai[];
  mocM: string | null;
  goiYChot: Readonly<Record<string, GoiYChotSaoKe>>;
  choPhepSua?: boolean;
  /** Chốt sao kê chỉ chủ shop. */
  laChuShop?: boolean;
  /** Hoá đơn TikTok trừ thẻ ngừng về (`docCanhBaoHoaDonTiktok`) — `null` = ổn. */
  canhBaoHoaDonTiktok?: CanhBaoHoaDonTiktok | null;
}) {
  // Nhập sao kê PDF = chốt sao kê ⇒ cùng điều kiện với mục "Chốt sao kê" ở menu từng thẻ: chủ shop, đã bật, thẻ còn mở.
  const theMo = laChuShop && mocM !== null ? the.filter((t) => t.closedAt === null).map((t) => ({ id: t.id, ten: t.ten })) : [];
  return (
    <div id="the-tin-dung" className="scroll-mt-20 rounded-xl border border-hairline p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Thẻ tín dụng</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            dư nợ ƯỚC TÍNH = sao kê gần nhất + các lần TikTok trừ thẻ thật (hoá đơn, gồm VAT) + chi tay − tiền đã trả; lệch ngân hàng ± khoảng 1 ngày hoá đơn theo HAI chiều: app thiếu hoá đơn TikTok về trễ (app thấp hơn) / ngân hàng ghi sổ trễ lần TikTok trừ (app cao hơn); quỹ chỉ giảm khi bạn trả thẻ thật
          </p>
        </div>
        {(choPhepSua || theMo.length > 0) && (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {theMo.length > 0 && <NhapSaoKeTheButton the={theMo} />}
            {choPhepSua && <TheTinDungAddButton mocM={mocM} />}
          </div>
        )}
      </div>
      {canhBaoHoaDonTiktok !== null && (
        <p className="mt-2 text-sm font-medium text-warning" data-testid="the-canh-bao-hoa-don-tiktok">
          Chưa có hoá đơn TikTok trừ thẻ từ {nhanNgay(canhBaoHoaDonTiktok.tuNgay)} — dư nợ ước tính đang THIẾU (kiểm quyền
          finance BC / chạy dựng lại Silver hoá đơn)
        </p>
      )}
      <CanhBaoTheDongConNo the={locTheDongConNo(the)} />

      {the.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Chưa có thẻ tín dụng nào.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-hairline">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Thẻ</TableHead>
                <TableHead className="text-right">Dư nợ (ước tính)</TableHead>
                <TableHead>Kỳ gần nhất</TableHead>
                <TableHead>Gắn nền tảng ads</TableHead>
                {choPhepSua && <TableHead className="text-right">Thao tác</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {the.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="text-sm">
                    <span className="text-ink">{t.ten}</span>
                    {t.closedAt !== null && (
                      <Badge variant="outline" className="ml-1.5">
                        Đã đóng
                      </Badge>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t.nganHang || "—"} · chốt ngày {t.ngayChotSaoKe}, hạn ngày {t.ngayHanTra}
                    </p>
                    {t.chuaChotKyGanNhat && (
                      <p className="mt-0.5 text-sm text-warning" data-testid="the-nhac-chot-sao-ke">
                        Chưa chốt sao kê kỳ gần nhất
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-serif text-ink tabular-nums">
                    {t.duNo === null ? (
                      <span className="font-sans text-xs font-normal text-muted-foreground">chưa có neo</span>
                    ) : (
                      formatVnd(t.duNo)
                    )}
                    <p className="font-sans text-xs font-normal text-muted-foreground">ước tính</p>
                  </TableCell>
                  <TableCell>
                    <KyGanNhat the={t} />
                  </TableCell>
                  <TableCell>
                    <MocGanNenTang gan={t.gan} choPhepSua={choPhepSua} daBat={mocM !== null} />
                  </TableCell>
                  {choPhepSua && (
                    <TableCell className="text-right">
                      <TheTinDungRowActions
                        the={t}
                        mocM={mocM}
                        laChuShop={laChuShop}
                        ngayChotMacDinh={goiYChot[t.id]?.ngayChot ?? ""}
                        hanTraGoiY={goiYChot[t.id]?.hanTra ?? ""}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
