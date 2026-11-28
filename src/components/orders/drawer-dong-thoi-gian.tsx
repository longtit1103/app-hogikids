import type { CSSProperties } from "react";

import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";
import type { MocTrangThaiDon } from "@/lib/orders/don-hang-kieu-du-lieu";
import { trangThaiHienThi } from "@/lib/orders/trang-thai-don-hien-thi";
import { DrawerKhoiThe } from "./drawer-khoi-the";

/**
 * Dòng thời gian trạng thái dọc: mỗi mốc một chấm màu theo trạng thái, mốc cuối đậm + "hiện tại" khi
 * trùng trạng thái đang có của đơn. Không có mốc nào (raw thiếu/hỏng) ⇒ ẩn cả khối, không hiện khung rỗng.
 */
export function DrawerDongThoiGian({ moc }: { moc: MocTrangThaiDon[] }) {
  if (moc.length === 0) return null;
  const cuoi = moc.length - 1;

  return (
    <DrawerKhoiThe tieuDe="Dòng thời gian trạng thái">
      <ol className="m-0 list-none p-0">
        {moc.map((m, i) => {
          const tt = trangThaiHienThi(m.status);
          return (
            <li
              key={`${m.status}-${m.luc.getTime()}`}
              // Đường nối xuống mốc kế (không vẽ ở mốc cuối).
              className={
                i === cuoi
                  ? "relative flex gap-3"
                  : "relative flex gap-3 pb-3.5 before:absolute before:top-3.5 before:bottom-0 before:left-[5px] before:w-0.5 before:bg-border"
              }
              style={{ "--m": tt.mau } as CSSProperties}
            >
              <span
                aria-hidden
                className={
                  m.hienTai
                    ? "mt-1 size-3 flex-none rounded-full bg-[var(--m)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--m)_22%,transparent)]"
                    : "mt-1 size-3 flex-none rounded-full bg-[var(--m)] opacity-55"
                }
              />
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 text-[13px] text-tq-chu-phu">
                <b className={m.hienTai ? "font-semibold text-tq-chu-dam" : "font-medium text-tq-chu"}>{tt.nhan}</b>
                <span>{formatNgayVn(m.luc, "dd/MM HH:mm")}</span>
                {m.hienTai && (
                  <span className="rounded bg-tq-nen px-1.5 py-px text-[11px] text-tq-chu-dam">hiện tại</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </DrawerKhoiThe>
  );
}
