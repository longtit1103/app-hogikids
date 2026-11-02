import type { OrderStatus } from "@/generated/prisma/client";
import type { ChiSoBieuDo } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

/**
 * Màu trang chủ cho chỗ KHÔNG dùng được class Tailwind (Recharts `stroke`/`fill`, thuộc tính SVG).
 * Dùng HEX trực tiếp (không `var(--tq-…)`) — cùng quy ước `bao-cao/trend-chart.tsx` và
 * `kenh/channel-revenue-ads-chart.tsx`: `fill`/`stroke` SVG là attribute, CSS custom property không đảm
 * bảo resolve nhất quán trên mọi trình duyệt (nhất là WebKit/iPhone PWA).
 *
 * Mỗi HEX PHẢI bằng token `--tq-*` cùng tên ở `:root` của `globals.css` (spec trang chủ §6) — chú thích
 * bên cạnh trỏ token; test `tests/unit/trang-chu/mau-khop-token.test.ts` đọc globals.css và chặn lệch.
 */
export const MAU_CHI_SO: Record<ChiSoBieuDo, string> = {
  doanhSo: "#2c6ecb", // --tq-doanh-so
  chiPhi: "#e8a55a", // --tq-chi-phi
  loiNhuan: "#29845a", // --tq-loi-nhuan
  donHang: "#7a5af5", // --tq-don
};

/** Nhãn hiển thị riêng trang chủ (Thành công/Đang giao/Chờ xử lý/Hoàn/Hủy) do component tự giữ. */
export const MAU_TRANG_THAI: Record<OrderStatus, string> = {
  COMPLETED: "#29845a", // --tq-thanh-cong
  SHIPPING: "#2c6ecb", // --tq-dang-giao
  PENDING: "#e8a55a", // --tq-cho-xu-ly
  RETURNED: "#9b6b3c", // --tq-hoan
  CANCELLED: "#c64545", // --tq-huy
};

/** Đường kỳ trước (nét đứt) + lưới/vòng nền. */
export const MAU_KY_TRUOC = "#cfcfcf"; // --tq-ky-truoc

/** Chữ trong SVG (nhãn trục, số giữa vòng tròn) và viền chấm nổi bật. */
export const MAU_CHU_DAM = "#1a1a1a"; // --tq-chu-dam
export const MAU_CHU_PHU = "#616161"; // --tq-chu-phu
export const MAU_NEN_THE = "#ffffff"; // --tq-the
