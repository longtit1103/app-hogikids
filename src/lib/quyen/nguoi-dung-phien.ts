/**
 * Ngữ cảnh người dùng của MỘT request: mở cookie → tra ĐÚNG dòng `User` của người đó → `NguoiDung | null`.
 *
 * Mọi quyết định "ai đang gọi, được làm gì" đi qua đây (trực tiếp hoặc qua 3 cổng `cong-*.ts`). Cookie
 * iron-session là cookie KÝ, không có bản ghi phiên phía máy chủ — thu hồi phiên = đổi
 * `User.sessionEpoch` của người đó; cookie mang epoch khác ⇒ coi như chưa đăng nhập.
 */
import type { Role } from "@prisma/client";
import { cache } from "react";

import { prisma } from "@/lib/prisma";
import { chuanHoaQuyen, type Quyen } from "@/lib/quyen/danh-muc-quyen";
import { getSession, type ClientPhien, type SessionData } from "@/lib/session";

/**
 * Epoch mà cookie ĐỜI CŨ (cấp trước khi có trường `mocPhien`) được quy về. Khớp mặc định cột
 * `User.sessionEpoch` ("0" = chưa từng thu hồi) ⇒ nâng cấp không đá ai ra; đã thu hồi một lần là
 * cookie đời cũ hết đường vào.
 */
const MOC_PHIEN_COOKIE_DOI_CU = "0";

export type NguoiDung = {
  id: string;
  email: string;
  tenHienThi: string;
  role: Role;
  /** OWNER ⇒ `coQuyen` luôn true, set có thể rỗng. */
  quyen: ReadonlySet<Quyen>;
  phaiDoiMatKhau: boolean;
  /** Epoch đã xác thực (bằng `User.sessionEpoch` lúc đọc) — đổi mật khẩu đối chiếu lại dưới khoá dòng. */
  mocPhien: string;
};

const QUYEN_LOI_LO: Quyen = "tai-chinh-loi-lo:xem";

/**
 * Bộ quyền đọc từ DB, qua CÙNG `chuanHoaQuyen` với form quản trị — nên DB bị sửa tay vẫn ra đúng tổ
 * hợp app sẽ tạo:
 * - mã lạ bị bỏ;
 * - `X:sua` KÉO THEO `X:xem` (cố ý nới: app không bao giờ tạo "sửa mà không xem", và chặn xem trong
 *   khi cho sửa chỉ sinh màn hình vỡ, không giữ được bí mật gì);
 * - Lãi/Lỗ mà thiếu giá vốn (tổ hợp app cấm) ⇒ bỏ ĐÚNG quyền Lãi/Lỗ (thu hẹp — không tự tick thêm
 *   quyền thấy lợi nhuận), giữ phần hợp lệ còn lại.
 * KHÔNG ném: một dòng lệch không được làm sập mọi trang của người đó.
 */
function quyenTuDb(raw: readonly string[]): ReadonlySet<Quyen> {
  const r = chuanHoaQuyen(raw);
  if (r.ok) return new Set(r.quyen);
  const thuHep = chuanHoaQuyen(raw.filter((q) => q !== QUYEN_LOI_LO));
  return new Set(thuHep.ok ? thuHep.quyen : []);
}

/** Thuần-DB, không đụng `cookies()` — để test và để tái dùng với client khác (DB tạm, transaction). */
export async function kiemPhien(session: SessionData, db: ClientPhien = prisma): Promise<NguoiDung | null> {
  if (!session.userId) return null;
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      tenHienThi: true,
      role: true,
      quyen: true,
      isActive: true,
      mustChangePassword: true,
      sessionEpoch: true,
    },
  });
  if (!user || !user.isActive) return null;
  if ((session.mocPhien ?? MOC_PHIEN_COOKIE_DOI_CU) !== user.sessionEpoch) return null;
  return {
    id: user.id,
    email: user.email,
    tenHienThi: user.tenHienThi,
    role: user.role,
    quyen: quyenTuDb(user.quyen),
    phaiDoiMatKhau: user.mustChangePassword,
    mocPhien: user.sessionEpoch,
  };
}

/**
 * Người dùng của request hiện tại. `React.cache` CHỈ chống đọc lặp trong một lượt render RSC (layout +
 * page). Server Action / Route Handler là request riêng — tự gọi hàm này, tự tra DB, không chia sẻ
 * kết quả với lượt render (ngoài RSC `cache` là hàm chuyển thẳng, không nhớ gì).
 */
export const docNguoiDungPhien: () => Promise<NguoiDung | null> = cache(async () =>
  kiemPhien(await getSession()),
);

export function laChuShop(nd: NguoiDung): boolean {
  return nd.role === "OWNER";
}

/** OWNER ⇒ luôn true (chủ shop không cần tick quyền). */
export function coQuyen(nd: NguoiDung, q: Quyen): boolean {
  return laChuShop(nd) || nd.quyen.has(q);
}

/**
 * Yêu cầu quyền của một cổng: không truyền ⇒ chỉ cần đăng nhập; một mã ⇒ phải có mã đó; mảng ⇒ có
 * ÍT NHẤT MỘT (tab gộp nhiều khối như Dòng tiền/thùng rác). Mảng rỗng ⇒ từ chối (fail-closed: mảng
 * rỗng chỉ có thể là lỗi lập trình, không được hiểu thành "ai cũng qua").
 */
export function duQuyenYeuCau(nd: NguoiDung, yeuCau?: Quyen | readonly Quyen[]): boolean {
  if (yeuCau === undefined) return true;
  if (typeof yeuCau === "string") return coQuyen(nd, yeuCau);
  return yeuCau.some((q) => coQuyen(nd, q));
}

/** Mô tả quyền thiếu cho nhật ký/thông báo — mảng "ít nhất một" nối bằng `|`. */
export function moTaQuyenYeuCau(yeuCau: Quyen | readonly Quyen[]): string {
  return typeof yeuCau === "string" ? yeuCau : yeuCau.join("|");
}
