import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";

/**
 * Người dùng phiên GIẢ cho test mock `docNguoiDungPhien` — không cần cookie/DB. Mặc định là chủ shop
 * (OWNER) đã đổi mật khẩu; truyền `role: "STAFF"` để đo nhánh từ chối của cổng chỉ-chủ-shop.
 *
 * Dùng trong factory `vi.mock` (bị hoist lên đầu file) bằng import động:
 * `const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");`
 */
export function nguoiDungGia(p: Partial<NguoiDung> = {}): NguoiDung {
  return {
    id: "test-user",
    email: "test-user@hogikids.test",
    tenHienThi: "",
    role: "OWNER",
    quyen: new Set(),
    phaiDoiMatKhau: false,
    mocPhien: "0",
    ...p,
  };
}
