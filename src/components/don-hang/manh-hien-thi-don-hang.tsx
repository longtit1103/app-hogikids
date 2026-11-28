import type { OrderStatus } from "@/generated/prisma/client";

import type { OChu } from "@/lib/orders/o-dong-don-hang";
import { trangThaiHienThi } from "@/lib/orders/trang-thai-don-hien-thi";
import { cn } from "@/lib/utils";

/**
 * Mảnh hiển thị nhỏ dùng chung bảng, thẻ điện thoại và hàng đầu trang của danh sách đơn.
 * Chỉ nhận chuỗi/hằng đã chuẩn bị — không tính tiền, không đọc quyền.
 */

/** Màu chữ theo `OChu.kieu`. Lỗ = đỏ (kèm dấu "−" trong chữ), cảnh báo = vàng nâu, xám cho đơn hoàn/hủy. */
const LOP_KIEU_O: Record<OChu["kieu"], string> = {
  thuong: "text-tq-chu-dam",
  xam: "text-tq-chu-phu",
  lo: "text-tq-xau-chu",
  "canh-bao": "text-[#7a4f01]",
};

export function lopKieuO(kieu: OChu["kieu"]): string {
  return LOP_KIEU_O[kieu];
}

/** Viên thuốc trạng thái: chấm màu + nhãn, nền/chữ lấy từ hằng của bản mẫu đã duyệt. */
export function VienThuocTrangThai(props: { status: OrderStatus; "data-testid"?: string }) {
  const t = trangThaiHienThi(props.status);
  return (
    <span
      data-testid={props["data-testid"]}
      className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-2 text-[12px] font-medium whitespace-nowrap"
      style={{ backgroundColor: t.nen, color: t.chu }}
    >
      <i className="size-[7px] rounded-full" style={{ backgroundColor: t.mau }} aria-hidden="true" />
      {t.nhan}
    </span>
  );
}

/** Chấm màu kênh + tên. */
export function ChamKenh(props: { ten: string; mau: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-[7px]", props.className)}>
      <i className="size-2 shrink-0 rounded-full" style={{ backgroundColor: props.mau }} aria-hidden="true" />
      <span className="truncate">{props.ten}</span>
    </span>
  );
}

/** Nhãn "tạm tính" cạnh tỉ lệ phí sàn (sàn chưa chốt phí). */
export function NhanTamTinh() {
  return (
    <span
      className="ml-1 inline-block rounded bg-[#fff1d6] px-1.5 text-[11px] font-medium text-[#7a4f01]"
      title="Sàn chưa đối soát xong — phí thật thường cao hơn"
    >
      tạm tính
    </span>
  );
}
