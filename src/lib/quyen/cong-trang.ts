/**
 * Cổng TRANG (page/layout) — chỉ gọi từ Server Component: từ chối bằng `redirect` (ném), KHÔNG ghi
 * nhật ký — người dùng bấm vào một mục menu bị ẩn/URL cũ không phải sự kiện bảo mật, ghi vào chỉ tạo
 * nhiễu. Bảo vệ thật nằm ở cổng action/route (có nhật ký).
 *
 * Thứ tự: chưa đăng nhập → phải đổi mật khẩu → thiếu quyền. Không dùng `forbidden()` của Next (còn sau
 * cờ experimental) — trang `/khong-co-quyen` nằm trong shell và nêu quyền thiếu.
 */
import { redirect } from "next/navigation";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { docNguoiDungPhien, duQuyenYeuCau, laChuShop, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";

async function nguoiDungDaDangNhap(currentPath: string): Promise<NguoiDung> {
  const nd = await docNguoiDungPhien();
  if (!nd) redirect(`/dang-nhap?redirect=${encodeURIComponent(currentPath)}`);
  if (nd.phaiDoiMatKhau) redirect("/doi-mat-khau-lan-dau");
  return nd;
}

function veKhongCoQuyen(currentPath: string): never {
  redirect(`/khong-co-quyen?tu=${encodeURIComponent(currentPath)}`);
}

/** `quyen` mảng = có ÍT NHẤT MỘT. Không truyền = chỉ cần đăng nhập. */
export async function yeuCauQuyenTrang(
  currentPath: string,
  quyen?: Quyen | readonly Quyen[],
): Promise<NguoiDung> {
  const nd = await nguoiDungDaDangNhap(currentPath);
  if (!duQuyenYeuCau(nd, quyen)) veKhongCoQuyen(currentPath);
  return nd;
}

/** Trang chỉ chủ shop (OWNER) — sao lưu/phục hồi, quản trị tài khoản… */
export async function yeuCauChuShopTrang(currentPath: string): Promise<NguoiDung> {
  const nd = await nguoiDungDaDangNhap(currentPath);
  if (!laChuShop(nd)) veKhongCoQuyen(currentPath);
  return nd;
}
