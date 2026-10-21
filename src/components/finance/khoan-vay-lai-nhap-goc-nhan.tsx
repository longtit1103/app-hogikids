import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import { laLaiNhapGoc } from "@/lib/so-quy/lich-tra-no";

/**
 * Nhãn "Lãi nhập gốc" của khoản thấu chi trong bảng/thẻ Khoản vay. Thuần hiển thị, đọc đúng vị từ
 * `laLaiNhapGoc` (cờ hồ sơ + chỉ thấu chi) — không tự suy lại điều kiện ở chỗ nào khác.
 */

/** Huy hiệu nhỏ cạnh tên khoản; khoản không có cờ ⇒ không vẽ gì. */
export function NhanLaiNhapGoc({ loan }: { loan: Pick<KhoanVayRow, "kind" | "laiNhapGoc"> }) {
  if (!laLaiNhapGoc(loan)) return null;
  return (
    <Badge variant="outline" className="ml-1.5" data-testid="nhan-lai-nhap-goc">
      Lãi nhập gốc
    </Badge>
  );
}

/**
 * Dòng phụ dưới dư nợ: phần lãi đã được ngân hàng cộng vào dư nợ (Σ dòng `LAI_NHAP_GOC` thật). Dư nợ
 * `loan.duNo` do server tính ĐÃ gồm số này — chỉ in ra để chủ shop biết vì sao dư nợ lớn hơn tiền đã rút.
 * Ẩn khi chưa có kỳ nào nhập gốc (kể cả khoản vừa bật cờ).
 */
export function DongDuNoGomLaiNhapGoc({
  loan,
  className,
}: {
  loan: Pick<KhoanVayRow, "nhapGoc">;
  className: string;
}) {
  const tong = loan.nhapGoc.reduce((s, d) => s + d.soTien, 0);
  if (tong <= 0) return null;
  return (
    <p className={className} data-testid="du-no-gom-lai-nhap-goc">
      đã gồm lãi nhập gốc {formatVnd(tong)}
    </p>
  );
}
