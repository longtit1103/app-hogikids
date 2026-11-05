import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Dải NHẮC VIỆC vàng ("có việc chờ bạn duyệt" — giá vốn lệch, kỳ vay tới hạn, phiếu nhập chưa ghi, quỹ sắp cạn).
 *
 * Chủ shop chốt 02/11: trước đây mỗi việc là một hộp vàng 2 dòng nằm trong vùng STICKY nên bám theo khi cuộn,
 * chồng nhau chiếm nửa màn và che nội dung. Nay gom MỘT dải gọn ở đầu trang, mỗi việc MỘT dòng mảnh, KHÔNG sticky
 * — nhìn thấy khi mở trang là đủ. Băng ĐỎ "hệ đang hỏng" (đồng bộ/sao lưu) vẫn ở vùng sticky riêng: đó là thứ
 * phải thấy ở mọi vị trí cuộn.
 *
 * `mb-6` (không phải mb-4): trang chủ kéo nền xám lên bằng `-mt-6`; lề nhỏ hơn thì nền xám chờm lên đáy dải.
 * `empty:hidden`: không việc nào ⇒ dải biến mất cùng lề của nó.
 */
export function DaiNhacViec({ children }: { children: ReactNode }) {
  return (
    <div
      className="mb-6 flex flex-col divide-y divide-warning/25 overflow-hidden rounded-lg border border-warning/40 bg-warning/10 empty:hidden"
      data-testid="dai-nhac-viec"
    >
      {children}
    </div>
  );
}

/**
 * Một dòng nhắc việc. Cả dòng là link khi có `href` (tên truy cập = câu nhắc + nhãn hành động, nên
 * `getByRole("link", { name: /câu nhắc/ })` vẫn bắt được); không có `href` (người xem không vào được trang
 * duyệt) ⇒ dòng tĩnh, không mũi tên.
 */
export function DongNhacViec({
  href,
  nhanHanhDong = "Xem",
  children,
  "data-testid": testId,
}: {
  href?: string;
  nhanHanhDong?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const noiDung = (
    <>
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">{children}</span>
      {href ? <span className="shrink-0 text-[12px] font-medium text-primary-active">{nhanHanhDong} →</span> : null}
    </>
  );
  const lop = "flex items-center gap-2 px-3 py-2 text-[13px] leading-snug text-ink";
  return href ? (
    <Link href={href} className={`${lop} transition hover:bg-warning/15`} data-testid={testId}>
      {noiDung}
    </Link>
  ) : (
    <div className={lop} data-testid={testId}>
      {noiDung}
    </div>
  );
}
