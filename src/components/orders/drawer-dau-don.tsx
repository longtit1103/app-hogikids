"use client";

import { ChevronLeft, ChevronRight, Copy, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type Ref } from "react";

import { SheetTitle } from "@/components/ui/sheet";
import { KENH_BAN_TRUC_TIEP } from "@/lib/channels/kenh-ban-truc-tiep";
import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";
import { trangThaiHienThi } from "@/lib/orders/trang-thai-don-hien-thi";
import type { OrderDetailChe } from "@/lib/queries/orders";
import { cn } from "@/lib/utils";

/**
 * Đầu drawer đơn: mã + sao chép · viên thuốc trạng thái · kênh · cụm ‹ i / N › · ✕ · dòng phụ
 * (mã sàn, đặt, cập nhật, đồng bộ). Cụm ‹ › nhận href dựng sẵn từ trang — drawer không biết bộ lọc.
 */
export type DieuHuongDon = {
  /** 1-based trong tập lọc + sắp xếp; null = đơn ngoài bộ lọc. */
  viTri: number | null;
  tong: number;
  hrefTruoc: string | null;
  hrefSau: string | null;
};

type DonDauDrawer = Pick<
  OrderDetailChe,
  | "code"
  | "status"
  | "channelId"
  | "channelName"
  | "channelColor"
  | "maSan"
  | "customerName"
  | "orderedAt"
  | "statusChangedAt"
  | "syncedAt"
>;

const NUT_ICON =
  "inline-grid size-11 place-items-center rounded-lg border border-border bg-white text-tq-chu hover:bg-tq-nen sm:size-[34px] [&_svg]:size-4";

/** Sao chép văn bản; `navigator.clipboard` bị chặn (http, quyền) thì rơi về `execCommand` qua textarea. */
async function saoChepVanBan(chu: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(chu);
    return true;
  } catch {
    try {
      const o = document.createElement("textarea");
      o.value = chu;
      o.setAttribute("readonly", "");
      o.style.position = "fixed";
      o.style.opacity = "0";
      document.body.appendChild(o);
      o.select();
      const xong = document.execCommand("copy");
      o.remove();
      return xong;
    } catch {
      return false;
    }
  }
}

function NutDieuHuong({
  href,
  huong,
}: {
  href: string | null;
  huong: "truoc" | "sau";
}) {
  const nhan = huong === "truoc" ? "Đơn trước" : "Đơn sau";
  const icon = huong === "truoc" ? <ChevronLeft aria-hidden /> : <ChevronRight aria-hidden />;
  if (!href) {
    return (
      <button type="button" disabled aria-label={nhan} className={cn(NUT_ICON, "text-muted-foreground/50")}>
        {icon}
      </button>
    );
  }
  return (
    <Link href={href} scroll={false} aria-label={nhan} className={NUT_ICON}>
      {icon}
    </Link>
  );
}

export function DrawerDauDon({
  order,
  dieuHuong,
  onDong,
  refNutDong,
}: {
  order: DonDauDrawer;
  dieuHuong: DieuHuongDon | null;
  onDong: () => void;
  /** Vỏ drawer đặt focus đầu vào nút ✕ (không phải nút sao chép đứng đầu thứ tự Tab). */
  refNutDong?: Ref<HTMLButtonElement>;
}) {
  const tt = trangThaiHienThi(order.status);
  const [daChep, setDaChep] = useState(false);
  const hen = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (hen.current && clearTimeout(hen.current)), []);

  async function chep() {
    if (!(await saoChepVanBan(order.code))) return;
    setDaChep(true);
    if (hen.current) clearTimeout(hen.current);
    hen.current = setTimeout(() => setDaChep(false), 2600);
  }

  const banTaiShop = order.channelId === KENH_BAN_TRUC_TIEP;

  return (
    <div className="border-b border-border bg-white px-3.5 pt-3 pb-2.5 sm:px-5 sm:pt-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <SheetTitle className="font-sans text-lg font-semibold tracking-tight break-all text-tq-chu-dam tabular-nums">
          {order.code}
        </SheetTitle>
        <button
          type="button"
          onClick={chep}
          aria-label="Sao chép mã đơn"
          title="Sao chép mã đơn"
          className="inline-grid size-9 place-items-center rounded-lg text-tq-chu hover:bg-tq-nen sm:size-7 [&_svg]:size-4"
        >
          <Copy aria-hidden />
        </button>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium"
          style={{ backgroundColor: tt.nen, color: tt.chu }}
        >
          <i className="size-1.5 rounded-full" style={{ backgroundColor: tt.mau }} />
          {tt.nhan}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-2.5 py-px text-[12px]">
          <i className="size-[7px] rounded-full" style={{ backgroundColor: order.channelColor }} />
          {order.channelName}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {dieuHuong && (
            <>
              <NutDieuHuong href={dieuHuong.hrefTruoc} huong="truoc" />
              <span className="hidden min-w-11 text-center text-[12px] text-tq-chu-phu sm:inline">
                {dieuHuong.viTri === null ? "ngoài lọc" : `${dieuHuong.viTri} / ${dieuHuong.tong}`}
              </span>
              <NutDieuHuong href={dieuHuong.hrefSau} huong="sau" />
            </>
          )}
          <button ref={refNutDong} type="button" onClick={onDong} aria-label="Đóng" className={NUT_ICON}>
            <X aria-hidden />
          </button>
        </div>
      </div>

      {/* Thông báo sao chép: vùng `role=status` luôn có mặt để trình đọc màn hình đọc được khi chữ xuất hiện. */}
      <p role="status" className="min-h-0 text-[12px] text-tq-loi-nhuan-chu empty:hidden">
        {daChep ? `Đã sao chép ${order.code}` : null}
      </p>

      <p className="mt-1.5 text-[12px] leading-relaxed text-tq-chu-phu">
        {order.maSan ? (
          <>
            Mã sàn <span className="text-tq-chu tabular-nums select-all">{order.maSan}</span> ·{" "}
          </>
        ) : banTaiShop ? (
          "Bán tại shop · "
        ) : null}
        đặt {formatNgayVn(order.orderedAt, "dd/MM HH:mm")}
        {order.statusChangedAt && <> · cập nhật {formatNgayVn(order.statusChangedAt, "dd/MM HH:mm")}</>} · đồng bộ{" "}
        {formatNgayVn(order.syncedAt, "dd/MM HH:mm")}
        {banTaiShop && order.customerName ? <> · khách: {order.customerName}</> : null}
      </p>
    </div>
  );
}
