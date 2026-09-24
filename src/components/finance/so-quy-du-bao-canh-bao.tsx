import { differenceInCalendarDays, format, parse } from "date-fns";

import { formatVnd } from "@/lib/format";
import type { KhoaNgay, KhoanDuKien } from "@/lib/so-quy/du-bao-quy-types";
import { cn } from "@/lib/utils";

/**
 * Khối cảnh báo "quỹ sắp cạn" của tab Sổ quỹ. Hai nhánh loại trừ nhau theo `cham`
 * (`DuBaoQuy.cham`, null = không chạm ngưỡng trong 30 ngày):
 * - chạm: hộp cảnh báo + liệt kê khoản của đúng ngày chạm.
 * - không chạm: một dòng thông tin nhẹ nêu điểm thấp nhất trong kỳ.
 * Cả hai LUÔN kèm chú thích "dự báo THẬN TRỌNG" — chủ shop không được đọc số dự báo như một lời hứa
 * tiền sàn sẽ về kịp.
 */

/** Chạm ngưỡng trong vòng bao nhiêu ngày thì lên hộp ĐỎ (gấp) thay vì VÀNG (theo dõi). */
const SO_NGAY_GAP = 7;

function ngayNganNgay(ngay: KhoaNgay): string {
  return format(parse(ngay, "yyyy-MM-dd", new Date()), "dd/MM");
}

const GHI_CHU_THAN_TRONG =
  "Dự báo THẬN TRỌNG — chỉ tính khoản chi đã biết (kỳ trả nợ, chi phí định kỳ, khoản đã ghi trước), " +
  "CHƯA tính tiền sàn sẽ về.";

export function SoQuyDuBaoCanhBao({
  homNay,
  quyHomNay,
  nguong,
  nguongDaDat,
  cham,
  thapNhat,
}: {
  homNay: KhoaNgay;
  /** Số dư quỹ HÔM NAY thật (`DuBaoQuy.quyHomNay`) — KHÁC điểm dự báo đầu tiên (`cham.ngay` sớm nhất
   * luôn là ngày mai, xem `ghepDuBao`). So trực tiếp với `nguong` để biết quỹ đã cạn TỪ HÔM NAY, tránh
   * câu nói "ngày mai" cho một việc đã xảy ra. */
  quyHomNay: number;
  nguong: number;
  /** Ngưỡng CHƯA từng đặt (Setting rỗng/hỏng) thì `nguong` mặc định 0 — câu chữ phải nói "quỹ ÂM" chứ
   * không phải "xuống dưới mức tối thiểu" (chủ shop chưa từng đặt mức nào). */
  nguongDaDat: boolean;
  cham: null | { ngay: KhoaNgay; soDu: number; khoan: KhoanDuKien[] };
  thapNhat: { ngay: KhoaNgay; soDu: number };
}) {
  const duoiNguongHomNay = quyHomNay < nguong;

  if (duoiNguongHomNay) {
    return (
      <div
        className="flex flex-col gap-2 rounded-lg border border-error/40 bg-error/5 p-3 text-error"
        data-testid="so-quy-du-bao-canh-bao"
      >
        <p className="text-sm font-semibold">
          {nguongDaDat ? "Quỹ hiện đã dưới mức tối thiểu" : "Quỹ hiện đã âm"} (còn {formatVnd(quyHomNay)})
        </p>
        {cham && cham.khoan.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs">
            {cham.khoan.map((k, i) => (
              <li key={`${k.loai}-${i}`} className="flex items-center justify-between gap-4">
                <span>{k.moTa}</span>
                <span className="shrink-0">{formatVnd(k.soTien)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-error/80">{GHI_CHU_THAN_TRONG}</p>
      </div>
    );
  }

  if (!cham) {
    return (
      <div className="flex flex-col gap-1.5" data-testid="so-quy-du-bao-khong-cham">
        <p className="text-sm text-muted-foreground">
          30 ngày tới quỹ thấp nhất {formatVnd(thapNhat.soDu)} ngày {ngayNganNgay(thapNhat.ngay)}.
        </p>
        <p className="text-xs text-muted-foreground">{GHI_CHU_THAN_TRONG}</p>
      </div>
    );
  }

  const soNgayToiHan = differenceInCalendarDays(
    parse(cham.ngay, "yyyy-MM-dd", new Date()),
    parse(homNay, "yyyy-MM-dd", new Date())
  );
  const gap = soNgayToiHan <= SO_NGAY_GAP;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        gap ? "border-error/40 bg-error/5 text-error" : "border-warning/40 bg-warning/10 text-ink"
      )}
      data-testid="so-quy-du-bao-canh-bao"
    >
      <p className="text-sm font-semibold">
        {nguongDaDat
          ? `Dự báo quỹ xuống dưới mức tối thiểu ngày ${ngayNganNgay(cham.ngay)} (còn ${formatVnd(cham.soDu)})`
          : `Dự báo quỹ ÂM ngày ${ngayNganNgay(cham.ngay)} (còn ${formatVnd(cham.soDu)})`}
      </p>
      {cham.khoan.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {cham.khoan.map((k, i) => (
            <li key={`${k.loai}-${i}`} className="flex items-center justify-between gap-4">
              <span>{k.moTa}</span>
              <span className="shrink-0">{formatVnd(k.soTien)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={cn("text-xs", gap ? "text-error/80" : "text-muted-foreground")}>{GHI_CHU_THAN_TRONG}</p>
    </div>
  );
}
