import { formatVnd } from "@/lib/format";
import type { TheDongConNo } from "@/lib/no-phai-tra/the-da-dong-con-no";

/**
 * Chỉ báo thẻ ĐÃ ĐÓNG còn dư nợ ước tính ≠ 0 (thường do chi tiêu ads chốt lại muộn, gán về thẻ theo đúng
 * ngày thẻ còn gánh nền tảng). CHỈ ĐỌC — app không tự chuyển nợ sang thẻ khác. Dương ⇒ gợi ý ghi "Trả thẻ"
 * (cổng server cho `CARD_PAY` vào thẻ đóng còn nợ, KHÔNG có trần — trả vượt số nợ được phép); âm ⇒ trả thừa
 * so với ước tính, chỉ nhắc đối chiếu sao kê. Danh sách rỗng ⇒ không render gì.
 */
export function CanhBaoTheDongConNo({ the }: { the: readonly TheDongConNo[] }) {
  if (the.length === 0) return null;
  return (
    <div
      className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700"
      role="status"
      data-testid="the-dong-con-no"
    >
      <p className="font-medium">Thẻ đã đóng nhưng dư nợ ước tính chưa về 0</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {the.map((t) => (
          <li key={t.id}>
            {t.duNo > 0
              ? `${t.ten}: còn nợ ${formatVnd(t.duNo)} — thường do chi tiêu ads về muộn. Ghi "Trả thẻ" (Nhập quỹ / rút quỹ) đúng số ngân hàng đã trừ để tất toán.`
              : `${t.ten}: trả thừa ${formatVnd(-t.duNo)} so với ước tính — đối chiếu sao kê ngân hàng.`}
          </li>
        ))}
      </ul>
    </div>
  );
}
