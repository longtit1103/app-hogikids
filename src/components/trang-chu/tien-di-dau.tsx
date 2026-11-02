import Link from "next/link";

import { TheKhoi } from "@/components/trang-chu/the-khoi";
import { formatPercent, formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { tinhThanhTienDiDau, type ChiaChiPhi, type KhoaDoan } from "@/lib/trang-chu/chia-chi-phi";

/** Lớp nền theo đoạn thanh; nhãn dòng bảng. Khoá `KhoaDoan` lấy từ phase 01 (một nguồn hình học). */
const DOAN: Record<KhoaDoan, { nhan: string; nen: string }> = {
  giaVon: { nhan: "Giá vốn hàng", nen: "bg-tq-gia-von" },
  quangCao: { nhan: "Quảng cáo", nen: "bg-tq-quang-cao" },
  phiSan: { nhan: "Phí sàn", nen: "bg-tq-phi-san" },
  vanHanhKhac: { nhan: "Vận hành, khác", nen: "bg-tq-van-hanh" },
  loiNhuan: { nhan: "Lợi nhuận", nen: "bg-tq-loi-nhuan" },
};

const THU_TU_DONG: readonly KhoaDoan[] = ["giaVon", "quangCao", "phiSan", "vanHanhKhac"];

/** Lớp sọc đỏ (độ mờ ~35%) phủ từ vạch "hết tiền vào" tới cuối thanh khi LỖ. */
const NEN_SOC_LO = "repeating-linear-gradient(135deg, var(--tq-huy) 0 4px, transparent 4px 8px)";

/** Cột % chữ luôn `x / mauSo` (cùng Lãi/Lỗ); mẫu số 0 ⇒ "—". Có thể cộng khác 100% — đúng nghĩa P&L. */
const phanTram = (x: number, mauSo: number) => (mauSo === 0 ? "—" : formatPercent((x / mauSo) * 100));

function DongBang({
  chamClass,
  nhan,
  soTien,
  phanTramChu,
  dam,
  xau,
}: {
  chamClass: string;
  nhan: string;
  soTien: string;
  phanTramChu: string;
  dam?: boolean;
  xau?: boolean;
}) {
  const mauChu = xau ? "text-tq-xau-chu" : dam ? "text-tq-loi-nhuan-chu" : "";
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_auto_52px] items-center gap-2.5 border-b border-black/[0.06] py-2 text-[13px] last:border-b-0",
        dam && "font-semibold text-tq-chu-dam",
      )}
    >
      <span className="flex items-center">
        <span className={cn("mr-2 inline-block size-2.5 shrink-0 rounded-[3px]", chamClass)} />
        {nhan}
      </span>
      <span className={cn("text-right tabular-nums", mauChu)}>{soTien}</span>
      <span className={cn("text-right tabular-nums", mauChu || "text-tq-chu-phu")}>{phanTramChu}</span>
    </div>
  );
}

/**
 * Khối "Tiền bán hàng đi đâu" (spec trang chủ §4.3): thanh ngang vẽ THẲNG từ `tinhThanhTienDiDau` (không
 * tự tính độ rộng), bảng dưới là cột % chữ. Chỉ render cho người có quyền giá vốn — nhánh che không gọi.
 */
export function TienDiDau({ du, choPhepXemLoiLo }: { du: ChiaChiPhi; choPhepXemLoiLo: boolean }) {
  const thanh = tinhThanhTienDiDau(du);
  const lo = du.loiNhuan < 0;

  return (
    <TheKhoi
      tieuDe="Tiền bán hàng đi đâu"
      phu="% trên doanh số sau voucher"
      data-testid="khoi-tien-di-dau"
      hanhDong={
        choPhepXemLoiLo ? (
          <Link href="/tai-chinh?tab=loi-lo" className="text-tq-doanh-so hover:underline">
            Xem Lãi/Lỗ
          </Link>
        ) : undefined
      }
    >
      <div className="flex items-baseline justify-between border-b border-black/[0.06] pb-2 text-[13px]">
        <span className="text-tq-chu-phu">Doanh số</span>
        <b className="font-semibold tabular-nums text-tq-chu-dam">{formatVnd(du.doanhSo)}</b>
      </div>
      {du.voucher !== 0 ? (
        <div className="flex items-baseline justify-between pt-2 text-[13px]">
          <span className="text-tq-chu-phu">− Voucher shop</span>
          <span className="tabular-nums text-tq-chu">{formatVnd(du.voucher)}</span>
        </div>
      ) : null}

      {thanh.thang > 0 ? (
        <div className="mt-3">
          <div className="relative">
            <div className="flex h-3 gap-0.5 overflow-hidden rounded-md">
              {thanh.doan
                .filter((d) => d.rong > 0)
                .map((d) => (
                  <i
                    key={d.khoa}
                    data-doan={d.khoa}
                    className={cn("block h-full", DOAN[d.khoa].nen)}
                    style={{ width: `${d.rong}%` }}
                  />
                ))}
            </div>
            {thanh.vachTongVao !== null ? (
              <>
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-0 rounded-r-md opacity-35"
                  style={{ left: `${thanh.vachTongVao}%`, backgroundImage: NEN_SOC_LO }}
                />
                <div
                  aria-hidden
                  className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 bg-tq-chu-dam"
                  style={{ left: `${thanh.vachTongVao}%` }}
                />
              </>
            ) : null}
          </div>
          {lo ? (
            <p className="mt-1.5 text-[12px] font-medium text-tq-xau-chu">
              Lỗ {formatVnd(thanh.lo)} — chi phí vượt tiền vào
            </p>
          ) : null}
          {du.thuNhapTaiChinh !== 0 ? (
            <p className="mt-1.5 text-[12px] text-tq-chu-phu">
              Gồm thu nhập tài chính {du.thuNhapTaiChinh > 0 ? "+" : ""}
              {formatVnd(du.thuNhapTaiChinh)}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2">
        {THU_TU_DONG.map((k) => (
          <DongBang
            key={k}
            chamClass={DOAN[k].nen}
            nhan={DOAN[k].nhan}
            soTien={formatVnd(du[k])}
            phanTramChu={phanTram(du[k], du.mauSo)}
          />
        ))}
        {du.thuNhapTaiChinh !== 0 ? (
          <DongBang
            chamClass="bg-tq-loi-nhuan/40"
            nhan="Thu nhập tài chính"
            soTien={`${du.thuNhapTaiChinh > 0 ? "+" : ""}${formatVnd(du.thuNhapTaiChinh)}`}
            phanTramChu={phanTram(du.thuNhapTaiChinh, du.mauSo)}
          />
        ) : null}
        <DongBang
          chamClass={DOAN.loiNhuan.nen}
          nhan={DOAN.loiNhuan.nhan}
          soTien={formatVnd(du.loiNhuan)}
          phanTramChu={phanTram(du.loiNhuan, du.mauSo)}
          dam
          xau={lo}
        />
      </div>
    </TheKhoi>
  );
}
