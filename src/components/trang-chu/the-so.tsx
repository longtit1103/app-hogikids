import { HuyHieuThayDoi } from "@/components/trang-chu/huy-hieu-thay-doi";
import { MAU_KY_TRUOC } from "@/components/trang-chu/mau-trang-chu";
import type { SoSanh } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";
import { cn } from "@/lib/utils";

const RONG = 96;
const CAO = 40;
const LE = 3;

/** Toạ độ SVG của một dãy theo thang chung [min, max] (kỳ này + kỳ trước dùng CHUNG thang để so được). */
function diemDuong(v: number[], min: number, max: number): string {
  const khoang = max - min || 1;
  const buoc = v.length > 1 ? (RONG - 2 * LE) / (v.length - 1) : 0;
  return v
    .map((y, i) => `${(LE + i * buoc).toFixed(1)},${(CAO - LE - ((y - min) / khoang) * (CAO - 2 * LE)).toFixed(1)}`)
    .join(" ");
}

/** Đường nhỏ 96×40: kỳ này liền màu chỉ số, kỳ trước nét đứt xám. Một điểm duy nhất ⇒ chấm. */
function DuongNho(props: { hienTai: number[]; kyTruoc: number[] | null; mau: string }) {
  const { hienTai, kyTruoc, mau } = props;
  const tatCa = [...hienTai, ...(kyTruoc ?? [])];
  if (tatCa.length === 0) return null;
  const min = Math.min(...tatCa);
  const max = Math.max(...tatCa);
  return (
    <svg width={RONG} height={CAO} viewBox={`0 0 ${RONG} ${CAO}`} aria-hidden="true" className="hidden shrink-0 sm:block">
      {kyTruoc && kyTruoc.length > 1 ? (
        <polyline points={diemDuong(kyTruoc, min, max)} fill="none" stroke={MAU_KY_TRUOC} strokeWidth={1.5} strokeDasharray="3 3" />
      ) : null}
      {hienTai.length > 1 ? (
        <polyline points={diemDuong(hienTai, min, max)} fill="none" stroke={mau} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      ) : (
        <circle cx={RONG / 2} cy={CAO / 2} r={3} fill={mau} />
      )}
    </svg>
  );
}

/**
 * Thẻ số (spec trang chủ §4.2): nhãn · số lớn · huy hiệu % · dòng phụ · đường nhỏ. Là nút chọn chỉ số cho
 * biểu đồ lớn; đang chọn ⇒ viền 2px đậm. Điện thoại ẩn dòng phụ + đường nhỏ.
 */
export function TheSo(props: {
  nhan: string;
  giaTri: string;
  giaTriAm?: boolean;
  /** Chữ xanh đậm cho số lớn (thẻ Lợi nhuận dương). */
  giaTriLoiNhuan?: boolean;
  soSanh: SoSanh;
  tangLaTot: boolean;
  dongPhu: string;
  duongNho: { hienTai: number[]; kyTruoc: number[] | null };
  mau: string;
  dangChon: boolean;
  onChon: () => void;
}) {
  const { nhan, giaTri, giaTriAm, giaTriLoiNhuan, soSanh, tangLaTot, dongPhu, duongNho, mau, dangChon, onChon } = props;
  return (
    <button
      type="button"
      aria-pressed={dangChon}
      onClick={onChon}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl bg-tq-the p-3 text-left shadow-tq-the transition-shadow sm:p-4",
        dangChon ? "ring-2 ring-tq-chu-dam" : "hover:ring-1 hover:ring-tq-ky-truoc",
      )}
    >
      <span className="text-[12px] font-medium text-tq-chu-phu">{nhan}</span>
      <span
        className={cn(
          "truncate text-lg font-semibold tabular-nums sm:text-2xl",
          giaTriAm ? "text-tq-xau-chu" : giaTriLoiNhuan ? "text-tq-loi-nhuan-chu" : "text-tq-chu-dam",
        )}
      >
        {giaTri}
      </span>
      <span className="flex items-end justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-1.5">
          <span>
            <HuyHieuThayDoi phanTram={soSanh.phanTram} tangLaTot={tangLaTot} />
          </span>
          <span className="hidden truncate text-[12px] text-tq-chu-phu sm:block">{dongPhu}</span>
        </span>
        <DuongNho hienTai={duongNho.hienTai} kyTruoc={duongNho.kyTruoc} mau={mau} />
      </span>
    </button>
  );
}
