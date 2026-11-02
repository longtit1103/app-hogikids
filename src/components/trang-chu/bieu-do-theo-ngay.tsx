"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type XAxisTickContentProps } from "recharts";

import { useChiSoDangChon } from "@/components/trang-chu/chi-so-dang-chon";
import { MAU_CHI_SO, MAU_CHU_PHU, MAU_KY_TRUOC, MAU_NEN_THE } from "@/components/trang-chu/mau-trang-chu";
import { formatSoDem, formatVnd, formatVndShort } from "@/lib/format";
import type { ChiSoBieuDo, DiemBieuDo } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

type Diem = DiemBieuDo<Record<string, number>>;

/** Tên chỉ số hiển thị (tiêu đề khối, tooltip) — một nguồn cho cả thẻ số lẫn biểu đồ. */
export const TEN_CHI_SO: Record<ChiSoBieuDo, string> = {
  doanhSo: "Doanh số",
  chiPhi: "Chi phí",
  loiNhuan: "Lợi nhuận",
  donHang: "Đơn hợp lệ",
};

const laDon = (chiSo: ChiSoBieuDo) => chiSo === "donHang";
const dinhDang = (chiSo: ChiSoBieuDo, n: number) => (laDon(chiSo) ? `${formatSoDem(n)} đơn` : formatVnd(n));
/** "yyyy-MM-dd" → "dd/MM" bằng cắt chuỗi (không qua Date ⇒ không lệch múi giờ). */
const nhanNgay = (ngay: string) => `${ngay.slice(8, 10)}/${ngay.slice(5, 7)}`;

/**
 * Nội dung tooltip dựng bằng hàm THUẦN (test được không cần hover). Dòng kỳ trước bỏ khi kỳ 1 ngày hoặc
 * điểm không có kỳ trước (kỳ trước ngắn hơn).
 */
export function noiDungTooltip(
  diem: Diem,
  chiSo: ChiSoBieuDo,
  motNgay: boolean,
): { tieuDe: string; dong: Array<{ nhan: string; giaTri: string }> } {
  const ten = TEN_CHI_SO[chiSo];
  const dong = [{ nhan: `${ten} kỳ này`, giaTri: dinhDang(chiSo, diem.hienTai[chiSo]) }];
  if (!motNgay && diem.kyTruoc) dong.push({ nhan: `${ten} kỳ trước`, giaTri: dinhDang(chiSo, diem.kyTruoc[chiSo]) });
  return { tieuDe: nhanNgay(diem.ngay), dong };
}

export type DiemVe = { ngay: string; laNgayDangXem: boolean; hien: number; truoc: number | null; goc: Diem };

/**
 * Tooltip Recharts: chỉ render kết quả `noiDungTooltip`. Chỉ số lấy THẲNG từ context của `ChiSoProvider`
 * (cùng nguồn với thẻ số) — không nhận qua prop riêng nên không thể lệch với thẻ đang chọn.
 */
export function TooltipBieuDo(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: DiemVe }>;
  label?: string | number;
  motNgay: boolean;
}) {
  const { chiSo } = useChiSoDangChon();
  const diem = props.payload?.[0]?.payload;
  if (!props.active || !diem) return null;
  const nd = noiDungTooltip(diem.goc, chiSo, props.motNgay);
  return (
    <div data-testid="tooltip-bieu-do" className="rounded-lg bg-tq-the px-3 py-2 text-[12px] shadow-tq-the">
      <div className="mb-1 font-semibold text-tq-chu-dam">{nd.tieuDe}</div>
      {nd.dong.map((d) => (
        <div key={d.nhan} className="flex justify-between gap-4 text-tq-chu">
          <span>{d.nhan}</span>
          <span className="font-medium tabular-nums">{d.giaTri}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Biểu đồ đường theo ngày của chỉ số đang chọn (spec trang chủ §4.4): kỳ này liền màu chỉ số, kỳ trước nét
 * đứt xám. `motNgay` ⇒ 7 ngày gần nhất, chấm to + nhãn đậm ở ngày đang xem, không có đường kỳ trước.
 */
export function BieuDoTheoNgay(props: { diem: Diem[]; chiSo: ChiSoBieuDo; motNgay: boolean; nhanKySoSanh: string }) {
  const { diem, chiSo, motNgay, nhanKySoSanh } = props;
  const mau = MAU_CHI_SO[chiSo];
  const du: DiemVe[] = diem.map((d) => ({
    ngay: d.ngay,
    laNgayDangXem: d.laNgayDangXem,
    hien: d.hienTai[chiSo],
    truoc: d.kyTruoc ? d.kyTruoc[chiSo] : null,
    goc: d,
  }));
  const veKyTruoc = !motNgay && du.some((d) => d.truoc !== null);

  return (
    <div>
      <div className="mb-2 text-[12px] text-tq-chu-phu">
        <span style={{ color: mau }}>━</span> kỳ này
        {motNgay ? null : (
          <>
            {" "}
            <span style={{ color: MAU_KY_TRUOC }}>┅</span> {nhanKySoSanh}
          </>
        )}
      </div>
      <div className="h-[160px] w-full sm:h-[220px]" data-testid="bieu-do-theo-ngay">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={du} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={MAU_KY_TRUOC} />
            <XAxis
              dataKey="ngay"
              tickLine={false}
              axisLine={false}
              tick={(p: XAxisTickContentProps) => {
                const ngay = String(p.payload.value);
                const dam = motNgay && du.find((d) => d.ngay === ngay)?.laNgayDangXem;
                return (
                  <text x={p.x} y={Number(p.y) + 12} textAnchor="middle" fontSize={11} fontWeight={dam ? 700 : 400} fill={MAU_CHU_PHU}>
                    {nhanNgay(ngay)}
                  </text>
                );
              }}
            />
            <YAxis
              width={56}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: MAU_CHU_PHU }}
              tickFormatter={(v: number) => (laDon(chiSo) ? formatSoDem(v) : formatVndShort(v).replace(" ₫", ""))}
            />
            <Tooltip content={<TooltipBieuDo motNgay={motNgay} />} />
            {veKyTruoc ? (
              <Line type="monotone" dataKey="truoc" stroke={MAU_KY_TRUOC} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={false} connectNulls={false} isAnimationActive={false} />
            ) : null}
            <Line
              type="monotone"
              dataKey="hien"
              stroke={mau}
              strokeWidth={2.5}
              isAnimationActive={false}
              dot={
                motNgay
                  ? (p: { cx?: number; cy?: number; payload?: DiemVe; index?: number }) =>
                      p.payload?.laNgayDangXem && p.cx !== undefined && p.cy !== undefined ? (
                        <circle key={`dot-${p.index}`} cx={p.cx} cy={p.cy} r={6} fill={mau} stroke={MAU_NEN_THE} strokeWidth={2} />
                      ) : (
                        <g key={`dot-${p.index}`} />
                      )
                  : false
              }
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
