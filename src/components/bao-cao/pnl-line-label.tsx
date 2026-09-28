"use client";

import Link from "next/link";
import { ChevronRight, TriangleAlert } from "lucide-react";

import { InfoTip } from "@/components/ui/info-tip";
import type { PnlLineItem } from "@/lib/reports/pnl-line-items";
import { cn } from "@/lib/utils";

/**
 * Ô "Khoản mục" của bảng P&L — nơi diễn đạt QUAN HỆ CHA–CON của cây khoản mục.
 *
 * QUY ƯỚC CHUNG cho cả bảng, giữ y hệt ở mọi dòng (đọc bảng là thấy ngay dòng
 * nào thuộc dòng nào, không phải đoán):
 *
 *   bậc 0 — mạch chính     : sát lề, chữ ink; nhóm/mốc kết quả in đậm + có nền
 *   bậc 1 — con của nhóm   : lùi 1 nấc, có VẠCH DỌC bên trái nối theo cha
 *   bậc 2 — con của con    : lùi 2 nấc, vạch dọc nhạt hơn, chữ nhỏ + xám
 *
 * Ba chi tiết nhỏ nhưng quyết định bảng có "sạch" hay không:
 *  - Chỗ của mũi tên LUÔN được giữ (kể cả dòng không có con) ⇒ mọi nhãn cùng bậc
 *    thẳng một hàng, không so le.
 *  - KHÔNG còn tiền tố "−"/"=" trước nhãn: dấu trừ đã nằm ở cột Số tiền, in thêm
 *    lần nữa chỉ làm rối mắt; vai trò của dòng nay thể hiện bằng nền + độ đậm.
 *  - Chú thích dài thu vào dấu "?" (rê chuột/chạm mới hiện) thay vì ghi thành
 *    dòng phụ dưới nhãn — bảng ngắn lại đúng một nửa.
 */

/** Thụt lề mỗi bậc, tính bằng px để vạch dọc và nhãn luôn khớp nhau. */
const BAC_LUI_PX = 22;

export function PnlLineLabel({
  item,
  expandable,
  expanded,
  onToggle,
  href,
}: {
  item: PnlLineItem;
  /** Dòng có con → mọc mũi tên thu/bung. */
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Đã qua `resolvePnlDrillHref`; vắng → nhãn không bấm được. */
  href?: string;
}) {
  const depth = item.depth ?? 0;
  const chuThich = [item.hint, item.note].filter(Boolean).join(" ");

  return (
    <div className="relative flex items-center gap-1.5" style={{ paddingLeft: depth * BAC_LUI_PX }}>
      {/* Vạch dọc = "dòng này thuộc khối phía trên". Cao TRÀN hàng (`inset-y`) nên
          các dòng cùng khối nối thành một đường liền, đọc ra ngay cả khối; vạch
          ngắt từng dòng thì mắt phải tự nối, đúng chỗ bảng trông rối.
          Dòng bậc 2 vẽ CẢ vạch của bậc 1 — thiếu nó thì cháu trông như mồ côi.
          Dòng ghi chú (`aside`) vẽ y hệt: cùng bậc thì phải cùng cách thể hiện,
          nó khác ở chỗ KHÔNG mang dấu trừ và có chú thích nói rõ sàn chịu khoản
          đó — chứ không phải ở một ký hiệu riêng. */}
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          // `-inset-y-2` bù đúng `p-2` của ô bảng để vạch chạm mép trên/dưới hàng.
          className={cn("absolute -inset-y-2 w-px", i === 0 ? "bg-hairline" : "bg-hairline/60")}
          style={{ left: i * BAC_LUI_PX + 6 }}
        />
      ))}

      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Thu gọn" : "Xem"} chi tiết ${item.label}`}
          className="-ml-1 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-surface-card hover:text-ink print:hidden"
        >
          <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
        </button>
      ) : (
        // Giữ chỗ đúng bằng nút mũi tên để nhãn các dòng cùng bậc thẳng hàng.
        <span aria-hidden className="w-4 shrink-0 print:hidden" />
      )}

      {href ? (
        <Link href={href} className="hover:underline">
          {item.label}
        </Link>
      ) : (
        <span>{item.label}</span>
      )}

      {chuThich && (
        <>
          <InfoTip label={item.label}>{chuThich}</InfoTip>
          {/* Bản IN không có chuột để rê nên tooltip vô dụng — in thẳng chú thích ra.
              Thiếu chỗ này thì file PDF gửi đi mất sạch caveat ("đơn bù là phí ước
              tính", "COGS đổi theo giá vốn hiện hành"…), người nhận đọc số trần. */}
          {/* `aria-hidden`: đây là BẢN SAO của nội dung trong popup, để trình đọc
              màn hình khỏi đọc hai lần cùng một câu. */}
          <span aria-hidden className="hidden text-[11px] font-normal text-muted-foreground italic print:inline">
            — {chuThich}
          </span>
        </>
      )}

      {/* COGS thiếu giá vốn thì cảnh báo dẫn thẳng sang chỗ sửa; cảnh báo dòng
          khác chỉ là dấu hiệu dữ liệu lạ, không có trang nào để đi tới. */}
      {item.warn &&
        (item.id === "cogs" && item.warnCoDich !== false ? (
          <Link
            href="/san-pham?loc=da_ban_thieu_gia_von"
            title="Có SKU thiếu giá vốn — không tính được COGS đầy đủ"
            className="shrink-0 text-warning"
          >
            <TriangleAlert className="size-3.5" />
          </Link>
        ) : (
          <span className="shrink-0 text-warning" title={item.hint}>
            <TriangleAlert className="size-3.5" />
          </span>
        ))}
    </div>
  );
}
