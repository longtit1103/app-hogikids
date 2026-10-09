import { format } from "date-fns";

import { NutBatLaiKhoanChiDinhKy } from "@/components/finance/nut-bat-lai-khoan-chi-dinh-ky";
import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import type { RecurringExpenseRow } from "@/lib/expenses/expense-queries";
import { thangChoBatLai } from "@/lib/expenses/thang-cho-bat-lai";

/**
 * Khối liệt kê MỌI mẫu chi định kỳ (đang chạy lẫn đã dừng) — tab "Sổ chi phí". Mẫu đã dừng có nút
 * "Bật lại": server đặt mốc `activeFrom` = đầu tháng hiện tại (hoặc tháng sau, chủ shop chọn), nên
 * `ensureRecurringExpenses` chỉ sinh từ mốc trở đi — KHÔNG ghi lùi chi phí vào các tháng đã dừng (trước khi có mốc, 24/09 chốt bỏ
 * nút này chính vì bật lại là sinh lùi cho mọi tháng được render).
 * Mẫu đang chạy không có nút gì ở đây — dừng vẫn đi qua "Sửa"/"Xoá" dòng chi phí như cũ.
 *
 * Server component: tháng bật lại và nhãn mốc được format Ở ĐÂY (container giờ VN), không ở client.
 * Mặc định GẤP (`<details>` không `open`) — tra cứu phụ, không phải luồng chính của sổ chi phí.
 */
export function KhoanChiDinhKySection({
  items,
  choPhepSua = false,
  boQuaNhapHang = 0,
}: {
  items: RecurringExpenseRow[];
  /** Có `chi-phi:sua` (server tính). Thiếu/false ⇒ không nút "Bật lại" (action vẫn tự chặn). */
  choPhepSua?: boolean;
  /**
   * Số lần phát sinh của mẫu "Nhập hàng" bị bộ sinh BỎ QUA vì rơi vào/sau mốc bật theo dõi nợ phải trả
   * (`ensureRecurringExpensesChiTiet`, các tháng đang xem). > 0 ⇒ nhắc chủ shop: mẫu vẫn "Đang chạy"
   * nhưng không sinh nữa — tiền hàng đi phiếu nợ + "Trả tiền hàng".
   */
  boQuaNhapHang?: number;
}) {
  if (items.length === 0) return null;

  const soDangChay = items.filter((i) => i.active).length;
  const soDaDung = items.length - soDangChay;
  const thang = thangChoBatLai(new Date());

  return (
    // Có lần bị bỏ ⇒ mở sẵn: lời nhắc nằm trong khối gấp thì không ai thấy.
    <details className="rounded-xl border border-hairline bg-surface-card p-4" open={boQuaNhapHang > 0 || undefined}>
      <summary className="cursor-pointer text-sm font-medium text-ink">
        Khoản chi định kỳ ({soDangChay} đang chạy · {soDaDung} đã dừng)
      </summary>

      {boQuaNhapHang > 0 && (
        <p data-testid="dinh-ky-bo-qua-nhap-hang" className="mt-3 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
          Mẫu Nhập hàng không còn sinh sau ngày bật theo dõi nợ (bỏ qua {boQuaNhapHang} lần) — tiền hàng giờ ghi
          nhận qua phiếu nợ và trả bằng &quot;Trả tiền hàng&quot; ở tab Dòng tiền. Nên dừng mẫu này.
        </p>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-hairline text-left">
              <th className="py-1 pr-2 font-normal">Mô tả</th>
              <th className="py-1 pr-2 font-normal">Danh mục</th>
              <th className="py-1 pr-2 font-normal">Kênh</th>
              <th className="py-1 pr-2 text-right font-normal">Số tiền</th>
              <th className="py-1 pr-2 font-normal">Lặp lại</th>
              <th className="py-1 pr-2 font-normal">Trạng thái</th>
              <th className="py-1 font-normal">
                <span className="sr-only">Thao tác</span>
              </th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {items.map((item) => (
              <tr key={item.id} className="border-b border-hairline/50 last:border-0">
                <td className="py-1.5 pr-2">{item.description}</td>
                <td className="py-1.5 pr-2">{item.categoryName}</td>
                <td className="py-1.5 pr-2">{item.channelName ?? "—"}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{formatVnd(item.amount)}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  ngày {item.dayOfMonth} hằng tháng
                  {item.activeFrom && (
                    <span className="text-muted-foreground"> · từ {format(item.activeFrom, "MM/yyyy")}</span>
                  )}
                </td>
                <td className="py-1.5 pr-2">
                  <Badge variant={item.active ? "secondary" : "outline"}>
                    {item.active ? "Đang chạy" : "Đã dừng"}
                  </Badge>
                </td>
                <td className="py-1.5 text-right">
                  {choPhepSua && !item.active && (
                    <NutBatLaiKhoanChiDinhKy
                      recurringId={item.id}
                      description={item.description}
                      amount={item.amount}
                      dayOfMonth={item.dayOfMonth}
                      thang={thang}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Bật lại khoản đã dừng: app sinh chi phí từ tháng bạn chọn (tháng này hoặc tháng sau), không ghi
        bù các tháng đã dừng.
      </p>
    </details>
  );
}
