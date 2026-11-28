import type { OrderStatus } from "@/generated/prisma/client";

export type StatusTone = "neutral" | "success" | "warning" | "error";

/** Slug (URL filter) / nhãn tiếng Việt / tone màu cho 5 trạng thái đơn. */
export const ORDER_STATUS_META: Record<OrderStatus, { slug: string; label: string; tone: StatusTone }> = {
  PENDING: { slug: "cho_xu_ly", label: "Chờ xử lý", tone: "neutral" },
  SHIPPING: { slug: "dang_giao", label: "Đang giao", tone: "neutral" },
  COMPLETED: { slug: "hoan_thanh", label: "Hoàn thành", tone: "success" },
  RETURNED: { slug: "hoan_hang", label: "Hoàn hàng", tone: "warning" },
  CANCELLED: { slug: "huy_bom", label: "Hủy/Bom", tone: "error" },
};

const SLUG_TO_STATUS: Record<string, OrderStatus> = Object.fromEntries(
  (Object.entries(ORDER_STATUS_META) as [OrderStatus, { slug: string }][]).map(([status, m]) => [m.slug, status]),
);

/**
 * Chuỗi slug phẩy (`?trang_thai=hoan_hang,huy_bom`) → OrderStatus[] (slug lạ bỏ qua).
 *
 * Chỉ nhận khoá RIÊNG của bảng (`Object.hasOwn`): tra thẳng `SLUG_TO_STATUS[s]` thì `constructor`,
 * `__proto__`, `toString`… trả về thuộc tính kế thừa của Object (truthy) và lọt vào danh sách trạng thái
 * ⇒ truy vấn/trang lỗi 500 với URL gõ tay.
 */
export function slugToStatus(slugs: string): OrderStatus[] {
  return slugs
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && Object.hasOwn(SLUG_TO_STATUS, s))
    .map((s) => SLUG_TO_STATUS[s]);
}
