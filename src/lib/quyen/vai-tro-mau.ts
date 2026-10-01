/**
 * Vai trò mẫu — CHỈ để điền sẵn form tạo/sửa tài khoản. Khi lưu, tài khoản giữ danh sách quyền RIÊNG
 * của nó: sửa mẫu ở đây về sau KHÔNG âm thầm đổi quyền người đã tạo.
 *
 * Mọi mẫu phải ⊆ danh mục và tự thoả ràng buộc của `chuanHoaQuyen` (lưới `tests/quyen/vai-tro-mau.test.ts`).
 */
import { DANH_MUC_QUYEN, type Quyen } from "@/lib/quyen/danh-muc-quyen";

export type MaVaiTroMau = "kho" | "ke-toan" | "marketing" | "dong-so-huu";

const MOI_QUYEN_XEM: readonly Quyen[] = DANH_MUC_QUYEN.filter((q) => q.endsWith(":xem"));

export const VAI_TRO_MAU: Record<MaVaiTroMau, { ten: string; quyen: readonly Quyen[] }> = {
  // Không tong-quan (thẻ tổng quan lộ doanh thu/lãi), không xuất file, không giá vốn.
  kho: {
    ten: "Kho / vận hành",
    quyen: ["don-hang:xem", "san-pham:xem", "ton-kho:xem"],
  },
  "ke-toan": {
    ten: "Kế toán",
    quyen: [
      "tong-quan:xem",
      "don-hang:xem",
      "bao-cao:xem",
      "tai-chinh-loi-lo:xem",
      "tai-chinh-dong-tien:xem",
      "tai-chinh-dong-tien:sua",
      "tai-chinh-so-quy:xem",
      "tai-chinh-so-quy:sua",
      "chi-phi:xem",
      "chi-phi:sua",
      "gia-von-loi-nhuan:xem",
      "xuat-du-lieu",
    ],
  },
  marketing: {
    ten: "Marketing",
    quyen: ["tong-quan:xem", "don-hang:xem", "kenh:xem", "marketing:xem", "marketing:sua", "bao-cao:xem"],
  },
  // Chỉ đọc toàn bộ; muốn sửa module nào thì tick thêm `:sua` trên form.
  "dong-so-huu": {
    ten: "Đồng sở hữu",
    quyen: [...MOI_QUYEN_XEM, "xuat-du-lieu"],
  },
};
