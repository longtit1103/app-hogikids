import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import { duKienNKy, type KyDuKien } from "@/lib/so-quy/lich-tra-no";

/**
 * Thẻ "Lịch trả nợ dự kiến" — N kỳ SẮP TỚI của mọi khoản vay còn hiệu lực có lịch, để chủ shop liệu
 * dòng tiền thay vì bị bất ngờ từng tháng. Server component thuần hiển thị.
 *
 * 🔴 ĐÂY LÀ DỰ BÁO, KHÔNG PHẢI SỐ PHẢI NỘP: ngân hàng thu theo giấy báo, app chỉ ước theo lịch. Và
 * TUYỆT ĐỐI không có nút ghi nào trong thẻ — `KyTraNoCard` (kỳ chờ duyệt) vẫn là lối ghi sổ DUY NHẤT,
 * giữ một đường ghi thì con dấu `lastDueHandled` mới còn là cổng chống ghi trùng.
 *
 * Kỳ ĐÃ tới hạn mà chưa duyệt vẫn nằm trong bảng — bỏ nó đi thì dòng "Σ N kỳ tới" hụt đúng kỳ gần
 * nhất, tức sai ở chỗ chủ shop cần chính xác nhất. Chỉ kỳ quá hạn ĐẦU TIÊN mang nhãn "đang chờ
 * duyệt" (đúng cái `KyTraNoCard` đang hiện); các kỳ quá hạn sau đó là "quá hạn — chưa ghi", vì thẻ
 * ghi sổ chỉ duyệt được TUẦN TỰ từng kỳ một.
 *
 * 🔴 MỌI SỐ TIỀN LẤY THẲNG TỪ `duKienNKy`, thẻ KHÔNG tự cộng: cột "Tiền thật chuyển" là
 * `tongChuyenNganHang` (đã trừ phần sổ tiết kiệm ngân hàng cấn ở kỳ cuối) và cột "Gốc" là `gocThuc`
 * (đã kẹp về dư nợ thật). Tự cộng `lãi + gốc + tiền gửi` ở đây là dựng lại chỗ in thứ hai — đúng sự
 * cố mà `tien-ky-tra-no.ts` được lập ra để diệt.
 */

/** 6 kỳ ≈ nửa năm: đủ xa để liệu tiền, đủ gần để số còn đáng tin (lãi/gốc còn phụ thuộc lượt trả thật). */
const SO_KY = 6;

function BangKy({ ds, coTienGui }: { ds: KyDuKien[]; coTienGui: boolean }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-hairline text-left">
            <th className="py-1 pr-2 font-normal">Kỳ</th>
            <th className="py-1 pr-2 font-normal">Đến hạn</th>
            <th className="py-1 pr-2 text-right font-normal">Lãi</th>
            <th className="py-1 pr-2 text-right font-normal">Gốc</th>
            {coTienGui && <th className="py-1 pr-2 text-right font-normal">Tiền gửi</th>}
            <th className="py-1 pr-2 text-right font-normal">Tiền thật chuyển</th>
            <th className="py-1 text-right font-normal">Dư nợ sau kỳ</th>
          </tr>
        </thead>
        <tbody className="text-ink">
          {ds.map((k) => (
            <tr key={k.ky} className="border-b border-hairline/50 last:border-0">
              <td className="py-1 pr-2 tabular-nums">{k.ky}</td>
              <td className="py-1 pr-2 whitespace-nowrap">
                {format(k.denNgay, "dd/MM/yyyy")}
                {k.dangChoDuyet && (
                  <Badge variant="secondary" className="ml-1">
                    đang chờ duyệt
                  </Badge>
                )}
                {k.quaHan && !k.dangChoDuyet && (
                  <Badge variant="outline" className="ml-1">
                    quá hạn — chưa ghi
                  </Badge>
                )}
              </td>
              <td className="py-1 pr-2 text-right tabular-nums">{formatVnd(k.lai)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{formatVnd(k.gocThuc)}</td>
              {coTienGui && <td className="py-1 pr-2 text-right tabular-nums">{formatVnd(k.tienGui)}</td>}
              <td className="py-1 pr-2 text-right tabular-nums font-medium">{formatVnd(k.tongChuyen)}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{formatVnd(k.duNoSauKy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LichTraNoDuKienCard({ loans, homNay }: { loans: KhoanVayRow[]; homNay: Date }) {
  // `KhoanVayRow` chứa đủ mọi field của `KhoanVayLich` nên truyền thẳng — không dựng bản sao thứ ba
  // của builder (bản client ở `thau-chi-tat-toan-dialog.tsx` cố ý tách để không kéo Prisma vào bundle).
  // `KhoanVayRow` chứa đủ mọi field của `KhoanVayLich` nên truyền thẳng làm `lich` — không dựng bản
  // sao thứ ba của builder (bản client ở `thau-chi-tat-toan-dialog.tsx` cố ý tách để không kéo Prisma
  // vào bundle). Cổng `closedAt` nằm TRONG `duKienNKy`, ở đây chỉ là lọc sớm cho đỡ tính.
  const khoan = loans
    .filter((l) => l.closedAt === null)
    .map((l) => ({
      loan: l,
      ds: duKienNKy({
        lich: l,
        traGoc: l.traGoc,
        lastDueHandled: l.lastDueHandled,
        homNay,
        soKy: SO_KY,
        duNoHienTai: l.duNo,
        tienGuiDangGiu: l.tienGuiDangGiu,
        closedAt: l.closedAt,
      }),
    }))
    .filter((x) => x.ds.length > 0);

  if (khoan.length === 0) return null;

  const tongTatCa = khoan.reduce((s, x) => s + x.ds.reduce((a, k) => a + k.tongChuyen, 0), 0);

  return (
    <div className="mt-4 rounded-xl bg-surface-card p-4" data-testid="lich-tra-no-du-kien">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-ink">Lịch trả nợ dự kiến — {SO_KY} kỳ tới</p>
        {khoan.length > 1 && (
          <p className="text-xs text-muted-foreground">
            Σ tất cả khoản:{" "}
            <span className="tabular-nums text-ink">{formatVnd(tongTatCa)}</span>
          </p>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        <span className="text-warning">DỰ KIẾN</span> — app ước theo lịch và dư nợ hiện tại; ngân hàng
        thu theo giấy báo. Ghi sổ ở thẻ &quot;Kỳ trả nợ chờ duyệt&quot;, không ghi được từ bảng này.
        Các kỳ sau kỳ chờ duyệt chỉ duyệt được LẦN LƯỢT, mỗi lần một kỳ.
      </p>

      {khoan.map(({ loan, ds }) => {
        const coTienGui = ds.some((k) => k.tienGui > 0);
        const tong = ds.reduce((s, k) => s + k.tongChuyen, 0);
        const kyCuoiGocTron = loan.kind === "BULLET" && ds.some((k) => k.gocThuc > 0);
        return (
          <div
            key={loan.id}
            data-testid={`lich-du-kien-khoan-${loan.id}`}
            className="mt-3 border-t border-hairline pt-3 first:border-0 first:pt-0"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs text-ink">
                {loan.name}
                {loan.lender ? ` · ${loan.lender}` : ""}
                <span className="text-muted-foreground">
                  {" · "}
                  {loan.kind === "OVERDRAFT" ? "thấu chi — kỳ chỉ thu lãi" : null}
                  {loan.kind === "BULLET" ? "trả gốc cuối kỳ" : null}
                  {loan.kind === "TERM" ? "vay kỳ hạn" : null}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                Σ {ds.length} kỳ:{" "}
                <span className="tabular-nums text-ink" data-testid={`lich-du-kien-tong-${loan.id}`}>
                  {formatVnd(tong)}
                </span>
              </p>
            </div>
            <BangKy ds={ds} coTienGui={coTienGui} />
            <div className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              {loan.kind === "OVERDRAFT" && (
                <p>
                  Thấu chi không có lịch trả gốc — bảng chỉ là các kỳ THU LÃI; gốc trả khi tất toán nên
                  dư nợ giữ nguyên.
                </p>
              )}
              {loan.kind === "BULLET" && (
                <p>
                  Trả gốc cuối kỳ — các kỳ trước chỉ nộp lãi (gốc 0, dư nợ phẳng), TRỌN gốc dồn vào kỳ
                  cuối{kyCuoiGocTron ? " (đã nằm trong bảng này)" : " — chưa nằm trong 6 kỳ tới"}.
                </p>
              )}
              {coTienGui && (
                <p>
                  Cột &quot;Tiền gửi&quot; là tiền tiết kiệm bắt buộc — tiền CỦA SHOP ngân hàng giữ hộ,
                  cấn lại ở kỳ cuối. &quot;Tiền thật chuyển&quot; đã trừ phần cấn đó.
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
