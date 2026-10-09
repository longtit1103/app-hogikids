import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import type { TrangThaiPhieu } from "@/lib/no-phai-tra/con-no-phieu";

/**
 * Nhãn còn nợ của một phiếu: bốn trạng thái, bốn nhãn KHÁC NHAU (không gộp "trả thừa" với "cần thu
 * hồi" — một bên nhà cung cấp còn giữ tiền thừa của phiếu thường, bên kia phiếu đã huỷ mà shop vẫn đã
 * trả tiền). `conNo` âm ở hai trạng thái sau — hiện số TUYỆT ĐỐI.
 */
export function NhanTrangThaiPhieu({ trangThai, conNo }: { trangThai: TrangThaiPhieu; conNo: number }) {
  switch (trangThai) {
    case "CON_NO":
      return <span className="tabular-nums text-ink">{formatVnd(conNo)}</span>;
    case "DA_TRA_DU":
      return <Badge variant="outline">Đã trả đủ</Badge>;
    case "TRA_THUA":
      return (
        <Badge variant="outline" className="border-warning/60 text-warning" title="Đã trả nhiều hơn tổng phiếu">
          Trả thừa {formatVnd(Math.abs(conNo))}
        </Badge>
      );
    case "CAN_THU_HOI":
      return (
        <Badge
          variant="outline"
          className="border-error/60 text-error"
          title="Phiếu đã huỷ nhưng shop đã trả tiền — cần nhà cung cấp hoàn lại"
        >
          Cần thu hồi {formatVnd(Math.abs(conNo))}
        </Badge>
      );
  }
}
