import { describe, expect, it } from "vitest";

import { buildOrderBy, type ExpenseListParams } from "@/lib/expenses/expense-queries";
import { ORDER_LIST_ORDER_BY } from "@/lib/queries/orders";

/**
 * Phân trang bằng OFFSET chỉ ổn định khi thứ tự là TOÀN PHẦN. Khoản chi trùng ngày/số tiền và đơn trùng
 * giờ đặt là chuyện thường, nên mọi thứ tự phải kết bằng `id` cùng chiều với khoá chính.
 */
describe("thứ tự sắp xếp có khoá phân xử cuối", () => {
  const cacKieu: [ExpenseListParams["sort"], string, "asc" | "desc"][] = [
    ["date_desc", "date", "desc"],
    ["date_asc", "date", "asc"],
    ["amount_desc", "amount", "desc"],
    ["amount_asc", "amount", "asc"],
  ];

  it.each(cacKieu)("sổ chi phí %s: [%s, id] cùng chiều", (sort, truong, chieu) => {
    expect(buildOrderBy(sort)).toEqual([{ [truong]: chieu }, { id: chieu }]);
  });

  it("kiểu sắp xếp lạ rơi về date_desc + id", () => {
    expect(buildOrderBy("khong-co" as ExpenseListParams["sort"])).toEqual([{ date: "desc" }, { id: "desc" }]);
  });

  it("danh sách đơn: orderedAt giảm dần rồi id giảm dần", () => {
    expect(ORDER_LIST_ORDER_BY).toEqual([{ orderedAt: "desc" }, { id: "desc" }]);
  });
});
