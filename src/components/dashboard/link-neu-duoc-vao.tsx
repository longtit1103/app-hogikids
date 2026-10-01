import Link from "next/link";

import { coTheVaoHref } from "@/components/shell/nav-config";

/**
 * Link chỉ dựng khi người xem vào được trang đích (`hrefDuocPhep` = tập server tính từ quyền). Không
 * vào được ⇒ hiện cùng nội dung nhưng là khối tĩnh: bấm vào chỉ gặp "không có quyền" là link gãy.
 * Thiếu tập quyền ⇒ MẶC ĐỊNH tĩnh (không bao giờ mở link khi quên truyền).
 */
export function LinkNeuDuocVao({
  href,
  hrefDuocPhep = [],
  className,
  classNameTinh,
  khoi = false,
  children,
}: {
  href: string;
  hrefDuocPhep?: readonly string[];
  className?: string;
  /** Lớp khi không link (bỏ hiệu ứng hover/màu link). Mặc định dùng lại `className`. */
  classNameTinh?: string;
  /** Khối tĩnh là `div` thay vì `span` — cho hàng flex/thẻ. */
  khoi?: boolean;
  children: React.ReactNode;
}) {
  if (coTheVaoHref(hrefDuocPhep, href)) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  const Tinh = khoi ? "div" : "span";
  return <Tinh className={classNameTinh ?? className}>{children}</Tinh>;
}
