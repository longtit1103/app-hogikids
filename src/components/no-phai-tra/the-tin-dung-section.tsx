import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { GoiYChotSaoKe } from "@/lib/no-phai-tra/doc-khoi-no-phai-tra";
import type { PhanPhaiTra } from "@/lib/no-phai-tra/ky-sao-ke";
import type { TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";

import { MocGanNenTang } from "./moc-gan-nen-tang";
import { TheTinDungAddButton } from "./the-tin-dung-add-button";
import { TheTinDungRowActions } from "./the-tin-dung-row-actions";

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

function KyGanNhat({ the }: { the: TheKemTrangThai }) {
  const p = the.phaiTra;
  if (p === null) return <span className="text-xs text-muted-foreground">Chưa có kỳ sao kê</span>;
  if (p.nghiaVuKy === 0) return <span className="text-xs text-muted-foreground">Đã trả đủ kỳ gần nhất</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs text-muted-foreground">
        Phải trả <strong className="tabular-nums text-ink">{formatVnd(p.nghiaVuKy)}</strong>
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
 */
export function TheTinDungSection({
  the,
  mocM,
  goiYChot,
  choPhepSua = false,
  laChuShop = false,
}: {
  the: readonly TheKemTrangThai[];
  mocM: string | null;
  goiYChot: Readonly<Record<string, GoiYChotSaoKe>>;
  choPhepSua?: boolean;
  /** Chốt sao kê chỉ chủ shop. */
  laChuShop?: boolean;
}) {
  return (
    <div id="the-tin-dung" className="scroll-mt-20 rounded-xl border border-hairline p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Thẻ tín dụng</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            dư nợ ƯỚC TÍNH từ sao kê gần nhất + chi tiêu − tiền đã trả; quỹ chỉ giảm khi bạn trả thẻ thật
          </p>
        </div>
        {choPhepSua && <TheTinDungAddButton mocM={mocM} />}
      </div>

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
                      <p className="mt-0.5 text-xs text-warning" data-testid="the-nhac-chot-sao-ke">
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
                    <MocGanNenTang gan={t.gan} choPhepSua={choPhepSua} />
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
