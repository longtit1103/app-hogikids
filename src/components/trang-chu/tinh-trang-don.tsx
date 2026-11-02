import type { OrderStatus } from "@/generated/prisma/client";
import { LinkNeuDuocVao } from "@/components/dashboard/link-neu-duoc-vao";
import { MAU_CHU_DAM, MAU_CHU_PHU, MAU_KY_TRUOC, MAU_TRANG_THAI } from "@/components/trang-chu/mau-trang-chu";
import { TheKhoi } from "@/components/trang-chu/the-khoi";
import { formatPercent, formatSoDem } from "@/lib/format";
import { ORDER_STATUS_META } from "@/lib/orders/order-status-meta";
import type { TinhTrangDon as DuTinhTrangDon } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

/**
 * Nhãn + thứ tự RIÊNG trang chủ (lời chủ shop): Thành công · Đang giao · Chờ xử lý · Hoàn · Hủy.
 * Không đụng `ORDER_STATUS_META` (nhãn dùng chung "Hoàn thành/Hoàn hàng/Hủy/Bom"); chỉ mượn `slug` cho link.
 */
const THU_TU: ReadonlyArray<{ trangThai: OrderStatus; nhan: string }> = [
  { trangThai: "COMPLETED", nhan: "Thành công" },
  { trangThai: "SHIPPING", nhan: "Đang giao" },
  { trangThai: "PENDING", nhan: "Chờ xử lý" },
  { trangThai: "RETURNED", nhan: "Hoàn" },
  { trangThai: "CANCELLED", nhan: "Hủy" },
];

/** Vòng tròn SVG thuần: r = 15.915 ⇒ chu vi = 100 ⇒ `stroke-dasharray` đọc thẳng bằng phần trăm. */
const BAN_KINH = 15.915;

/** Tỷ lệ (0..100) của một trạng thái; tổng 0 ⇒ 0 (không chia 0). */
const phanTramCua = (n: number, tong: number) => (tong > 0 ? (n / tong) * 100 : 0);

/**
 * Khối "Tình trạng đơn" (spec trang chủ §4.4): tâm = tổng đơn ĐẶT trong kỳ (mọi trạng thái), chú thích
 * kèm số đơn + %. Mỗi dòng link sang `/don-hang` lọc theo trạng thái + kỳ đang xem, CHỈ khi vào được trang.
 */
export function TinhTrangDon({
  du,
  ky,
  hrefDuocPhep,
}: {
  du: DuTinhTrangDon;
  ky: { tu: string; den: string };
  hrefDuocPhep: readonly string[];
}) {
  const { tong, theoTrangThai } = du;

  // Các phần nối tiếp từ 12 giờ: `dashoffset = 25 − (tổng % các phần trước)`.
  let daDung = 0;
  const phan = THU_TU.map((m) => {
    const p = phanTramCua(theoTrangThai[m.trangThai], tong);
    const offset = 25 - daDung;
    daDung += p;
    return { ...m, p, offset };
  });

  return (
    <TheKhoi tieuDe="Tình trạng đơn" phu="đặt trong kỳ" data-testid="khoi-tinh-trang-don">
      {/* flex-wrap: cột 1/3 trang ở khổ 1024 chỉ ~250px, không đủ cho vòng + chú thích cạnh nhau ⇒ chú thích xuống dưới vòng. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-[18px]">
        <svg
          viewBox="0 0 42 42"
          className="size-[110px] shrink-0 sm:size-[132px]"
          role="img"
          aria-label={`Tổng ${formatSoDem(tong)} đơn đặt trong kỳ`}
        >
          {tong === 0 ? (
            <circle cx="21" cy="21" r={BAN_KINH} fill="none" stroke={MAU_KY_TRUOC} strokeWidth="6" />
          ) : (
            phan
              .filter((x) => x.p > 0)
              .map((x) => (
                <circle
                  key={x.trangThai}
                  cx="21"
                  cy="21"
                  r={BAN_KINH}
                  fill="none"
                  stroke={MAU_TRANG_THAI[x.trangThai]}
                  strokeWidth="6"
                  strokeDasharray={`${x.p} ${100 - x.p}`}
                  strokeDashoffset={x.offset}
                />
              ))
          )}
          <text x="21" y="21" textAnchor="middle" className="tabular-nums" fontSize="8" fontWeight="700" fill={MAU_CHU_DAM}>
            {formatSoDem(tong)}
          </text>
          <text x="21" y="27" textAnchor="middle" fontSize="3.4" fill={MAU_CHU_PHU}>
            tổng đơn
          </text>
        </svg>

        <ul className="min-w-[160px] flex-1">
          {phan.map((x) => {
            const n = theoTrangThai[x.trangThai];
            const href =
              `/don-hang?trang_thai=${ORDER_STATUS_META[x.trangThai].slug}` +
              `&ngay_tu=${ky.tu}&ngay_den=${ky.den}`;
            return (
              <li key={x.trangThai} className="border-b border-black/[0.06] last:border-b-0">
                <LinkNeuDuocVao
                  href={href}
                  hrefDuocPhep={hrefDuocPhep}
                  khoi
                  className="grid grid-cols-[1fr_auto_44px] items-center gap-2 py-1.5 text-[13px] hover:bg-tq-nen"
                  classNameTinh="grid grid-cols-[1fr_auto_44px] items-center gap-2 py-1.5 text-[13px]"
                >
                  <span className="flex items-center text-tq-chu">
                    <span
                      className="mr-2 inline-block size-2.5 shrink-0 rounded-[3px]"
                      style={{ background: MAU_TRANG_THAI[x.trangThai] }}
                    />
                    {x.nhan}
                  </span>
                  <span className="text-right tabular-nums text-tq-chu-phu">{formatSoDem(n)}</span>
                  {/* Làm tròn nguyên như bản mẫu duyệt (40%, 38%…); tổng 0 ⇒ "—". */}
                  <b className="text-right font-semibold tabular-nums text-tq-chu-dam">
                    {tong > 0 ? formatPercent(Math.round(x.p)) : "—"}
                  </b>
                </LinkNeuDuocVao>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-auto pt-3 text-[11.5px] text-tq-chu-phu">Gồm cả đơn hoàn / hủy nên lớn hơn số Đơn hợp lệ.</p>
    </TheKhoi>
  );
}
