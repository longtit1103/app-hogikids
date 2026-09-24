"use client";

import { format, parse } from "date-fns";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatVnd, formatVndShort } from "@/lib/format";
import type { DiemSoDu } from "@/lib/so-quy/du-bao-quy-types";

/**
 * Biểu đồ quỹ: 90 ngày gần nhất (đường liền, số ĐÃ xảy ra) nối tiếp dự báo 30 ngày (đường đứt) +
 * đường ngang ngưỡng "Quỹ tối thiểu". Nối liền tại hôm nay bằng cách lặp lại điểm CUỐI của `lichSu`
 * làm điểm NEO đầu tiên của nhánh dự báo — hai đường san sẻ đúng một toạ độ nên recharts vẽ liền
 * mạch, không có khoảng hở giữa nét liền và nét đứt.
 */

const MAU_THUC = "#141413"; // --ink — số đã xảy ra
const MAU_DU_BAO = "#cc785c"; // --primary — nhánh dự báo
const MAU_NGUONG = "#c64545"; // --error — ngưỡng quỹ tối thiểu

type DiemBieuDo = { ngay: string; thuc?: number; duBao?: number };

function ngayNganNgay(ngay: string): string {
  return format(parse(ngay, "yyyy-MM-dd", new Date()), "dd/MM");
}

/** Gộp một điểm vào mảng: cùng ngày với điểm cuối thì merge field, khác ngày thì đẩy thêm dòng mới —
 * giữ mảng luôn theo thứ tự thời gian tăng dần vì cả 3 nguồn (`lichSu`, neo, `duBao`) đã sẵn tăng dần. */
function ganDiem(danhSach: DiemBieuDo[], moi: DiemBieuDo): void {
  const cuoi = danhSach[danhSach.length - 1];
  if (cuoi && cuoi.ngay === moi.ngay) {
    Object.assign(cuoi, moi);
  } else {
    danhSach.push({ ...moi });
  }
}

function buildDiem(lichSu: DiemSoDu[], duBao: DiemSoDu[]): DiemBieuDo[] {
  const diem: DiemBieuDo[] = [];
  for (const p of lichSu) ganDiem(diem, { ngay: p.ngay, thuc: p.soDu });
  const neo = lichSu[lichSu.length - 1];
  if (neo) ganDiem(diem, { ngay: neo.ngay, duBao: neo.soDu });
  for (const p of duBao) ganDiem(diem, { ngay: p.ngay, duBao: p.soDu });
  return diem;
}

/** Props tối thiểu Recharts truyền vào `Tooltip content=` — khai lỏng thay vì kiểu generic nội bộ
 * của recharts, cùng khuôn `channel-trend-tooltip.tsx`. */
type ChartTooltipPayloadItem = { dataKey?: unknown; value?: unknown };

function TooltipNoiDung({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: readonly ChartTooltipPayloadItem[];
  label?: unknown;
}) {
  if (!active || !payload || payload.length === 0) return null;
  // Điểm neo (hôm nay) mang CẢ HAI key `thuc` + `duBao` — ưu tiên `thuc` trước để không gắn nhầm
  // "(dự báo)" cho đúng con số thật của hôm nay.
  const diem =
    payload.find((p) => p.dataKey === "thuc" && typeof p.value === "number") ??
    payload.find((p) => p.dataKey === "duBao" && typeof p.value === "number");
  if (!diem) return null;
  const laDuBao = diem.dataKey === "duBao";

  return (
    <div className="rounded-lg border border-hairline bg-canvas p-2.5 text-xs shadow-sm">
      <p className="font-medium text-ink">{ngayNganNgay(String(label))}</p>
      <p className="mt-0.5 text-ink">
        {formatVnd(Number(diem.value))}
        {laDuBao ? " (dự báo)" : ""}
      </p>
    </div>
  );
}

export function SoQuyBieuDoDuBao({
  lichSu,
  duBao,
  nguong,
  nguongDaDat,
}: {
  lichSu: DiemSoDu[];
  duBao: DiemSoDu[];
  nguong: number;
  nguongDaDat: boolean;
}) {
  const diem = buildDiem(lichSu, duBao);
  if (diem.length === 0) return null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: MAU_THUC }} />
          Đã xảy ra
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-0.5 w-4 rounded-full"
            style={{ backgroundImage: `repeating-linear-gradient(90deg, ${MAU_DU_BAO} 0 4px, transparent 4px 7px)` }}
          />
          Dự báo
        </span>
        {nguongDaDat && (
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: MAU_NGUONG }} />
            Quỹ tối thiểu
          </span>
        )}
      </div>

      <div className="mt-2 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={diem} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e6dfd8" vertical={false} />
            <XAxis
              dataKey="ngay"
              tickFormatter={(v) => ngayNganNgay(String(v))}
              tick={{ fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v) => formatVndShort(Number(v))}
              tick={{ fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip content={TooltipNoiDung} />
            {nguongDaDat && (
              <ReferenceLine
                y={nguong}
                stroke={MAU_NGUONG}
                strokeDasharray="4 4"
                // Mặc định recharts `ifOverflow="discard"` — mọi điểm dữ liệu dưới ngưỡng thì trục Y tự
                // co giãn theo dữ liệu và đường ngưỡng biến mất đúng lúc cảnh báo gắt nhất (quỹ thấp hơn
                // ngưỡng RẤT NHIỀU). `extendDomain` ép trục Y luôn kéo dài đủ để đường này luôn hiện.
                ifOverflow="extendDomain"
                label={{ value: "Quỹ tối thiểu", position: "insideTopLeft", fill: MAU_NGUONG, fontSize: 11 }}
              />
            )}
            {/* Tắt hiệu ứng vẽ: đường "chạy" dần ~1,5s khiến khung trông TRỐNG ngay lúc trang hiện ra (và
                ảnh chụp/e2e bắt nhầm lúc trống) — số dư quỹ cần đọc ngay, không cần diễn hoạt. Bậc thang
                (`stepAfter`) chứ không cong mượt: số dư đổi theo TỪNG khoản, đường cong vẽ ra những số dư
                trung gian chưa từng có. */}
            <Line
              type="stepAfter"
              dataKey="thuc"
              name="Đã xảy ra"
              stroke={MAU_THUC}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="duBao"
              name="Dự báo"
              stroke={MAU_DU_BAO}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
