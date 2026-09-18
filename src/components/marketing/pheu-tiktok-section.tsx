"use client";

import Link from "next/link";
import { format, parse } from "date-fns";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatPct1 } from "@/components/kenh/channel-format";
import { ChuThichDoTuoiVaThieu } from "@/components/marketing/canh-bao-do-tuoi-du-lieu";
import { SoSanBao } from "@/components/marketing/so-san-bao";
import { formatVnd } from "@/lib/format";
import type { ChuThichDoTuoi } from "@/lib/reports/marketing/cau-do-tuoi-du-lieu";
import type { DongNguonDoanhSo, NguonDoanhSoTiktok } from "@/lib/reports/marketing/nguon-doanh-so-tiktok";
import type { PheuTiktok } from "@/lib/reports/marketing/pheu-tiktok";
import { cn } from "@/lib/utils";

/**
 * Khối "Tổng quan" của tab `tong-quan` — Hàng KPI + "Nguồn doanh số (sàn báo)" + Xu hướng ngày.
 * Đặt TRÊN `TongQuanP1Section` (P1) trong `page.tsx`, KHÔNG lồng vào trong.
 *
 * "use client" vì chart Xu hướng ngày dùng recharts (như `channel-revenue-ads-chart.tsx`) — kéo cả
 * KPI/bar theo cùng file cho gọn, page.tsx (server) render thẳng component client này với data đã
 * resolve sẵn (không có state/hiệu ứng nào khác cần client ở đây).
 *
 * BẤT BIẾN #2: `pheu`/`nguon` là số SÀN TỰ NHẬN CÔNG — mọi ô đọc từ đó bọc `<SoSanBao>`.
 * `donPancake`/`doanhThuGopPancake`/`chiQuangCao` là số THẬT (từ `calcPnl`, kênh tiktok) — KHÔNG bọc.
 */

function soGon(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

function dayLabel(dateStr: string): string {
  return format(parse(dateStr, "yyyy-MM-dd", new Date()), "dd/MM");
}

function fullDayLabel(dateStr: string): string {
  return format(parse(dateStr, "yyyy-MM-dd", new Date()), "dd/MM/yyyy");
}

function OChiSo({
  nhan,
  giaTri,
  phu,
  href,
  title,
}: {
  nhan: string;
  giaTri: React.ReactNode;
  phu?: React.ReactNode;
  href?: string;
  title?: string;
}) {
  const noiDung = (
    <div className="h-full rounded-xl bg-surface-card p-4" title={title}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{nhan}</p>
      <p className="mt-1 font-serif text-2xl tabular-nums text-ink">{giaTri}</p>
      {phu && <p className="mt-1 text-[11px] text-muted-foreground">{phu}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block hover:opacity-80">
      {noiDung}
    </Link>
  ) : (
    noiDung
  );
}

/** Khoá GMV Max — chèn vào cùng danh sách 6 khối `KHOI_NGUON` không `gopChong` (spec §5.1). */
type HangNguon = {
  khoa: string;
  nhan: string;
  ghiChu?: string;
  gopChong: boolean;
  gmvSan: number | null;
  donSan: number | null;
  /** false ⇒ nguồn này KHÔNG có khái niệm "đơn" — UI ẨN HẲN badge "đơn" (không phải hiện "—") để
   *  không đọc lầm thành "kỳ này thiếu dữ liệu" (fix vòng B-2, việc #3). */
  coDon: boolean;
};

function ThanhNganNguon({ hang, maxGmv }: { hang: HangNguon; maxGmv: number }) {
  const pct = hang.gmvSan !== null && hang.gmvSan > 0 && maxGmv > 0 ? Math.max(2, (hang.gmvSan / maxGmv) * 100) : 0;
  return (
    <div className={cn("flex flex-col gap-1 rounded-lg p-2", hang.gopChong && "bg-surface-soft/60")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
        <span className="text-ink">
          {hang.nhan}
          {hang.gopChong && (
            <span className="ml-1 text-[10px] text-muted-foreground">
              (gộp — chồng với các dòng trên, không cộng vào)
            </span>
          )}
          {hang.ghiChu && <span className="ml-1 text-[10px] text-muted-foreground">({hang.ghiChu})</span>}
        </span>
        <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
          {hang.gmvSan === null ? "—" : <SoSanBao>{formatVnd(hang.gmvSan)}</SoSanBao>}
          {hang.coDon && (hang.donSan === null ? "—" : <SoSanBao>{soGon(hang.donSan)} đơn</SoSanBao>)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-soft">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Chuẩn hoá nhãn + ghi chú của MỘT dòng nguồn — chạy MỘT LẦN cho `nguon.dong` trước khi tách
 * `gopChong`/không, để phép đổi nhãn không thể "vá nhầm nhánh" như hồi quy đã dính (commit trước
 * đổi nhãn TRONG `nonGopChong.map`, nhưng dòng `total` có `gopChong:true` nên rơi vào NHÁNH KHÁC
 * — nhãn cũ "Tổng (sàn)" không bao giờ được thay). Tách hàm riêng ⇒ chỉ MỘT nơi quyết định nhãn,
 * dùng chung cho cả hai nhóm hiển thị bên dưới.
 */
function chuanHoaHangNguon(d: DongNguonDoanhSo): HangNguon {
  return {
    khoa: d.khoi,
    // Ruling P2-R32: "Tổng (sàn)" đọc dễ hiểu lầm là tổng CẢ SHOP — thực ra khối `total` cộng từ
    // DANH SÁCH SẢN PHẨM, khác nguồn với khối "Phễu TikTok" phía trên.
    nhan: d.khoi === "total" ? "Tổng theo sản phẩm (sàn)" : d.nhan,
    // Fix vòng B-2, việc #6: bản cũ nói "endpoint sản phẩm"/"endpoint phễu" (thuật ngữ kỹ thuật) và
    // trỏ tới một con số KHÔNG hiện cạnh đó (khối "Phễu TikTok" phía trên không hiện "GMV" trần).
    // Giữ đúng Ý — độ phủ 148/162 sản phẩm (đo 25/08) khiến số này có thể lệch khối phía trên — bằng
    // lời chủ shop đọc được, không cần biết "endpoint" là gì.
    ghiChu:
      d.khoi === "total"
        ? "cộng từ danh sách sản phẩm, chỉ phủ 148/162 sản phẩm — có thể không khớp khối phía trên, lệch là bình thường"
        : undefined,
    gopChong: d.gopChong,
    gmvSan: d.gmvSan,
    donSan: d.donSan,
    coDon: !d.khongCoDon,
  };
}

/** Nhãn Việt cho từng khối nguồn — dùng lại `KHOI_NGUON` của reader, KHÔNG chép tên trường ra đây. */
function NguonDoanhSoBlock({
  nguon,
  chuThich,
}: {
  nguon: NguonDoanhSoTiktok;
  /** Câu chú thích ĐỘ TƯƠI đã tính SẴN ở `page.tsx` (ruling P2-R38) — component KHÔNG tự tính. */
  chuThich: ChuThichDoTuoi;
}) {
  const dongChuan = nguon.dong.map(chuanHoaHangNguon);
  const nonGopChong = dongChuan.filter((d) => !d.gopChong);
  const gopChongRows = dongChuan.filter((d) => d.gopChong);
  const gmvMaxRow: HangNguon = {
    khoa: "gmv_max",
    nhan: "GMV Max",
    gopChong: false,
    gmvSan: nguon.gmvMax.gmvSan,
    donSan: nguon.gmvMax.donSan,
    coDon: true,
  };
  const hangChinh: HangNguon[] = [...nonGopChong, gmvMaxRow].sort(
    (a, b) => (b.gmvSan ?? -1) - (a.gmvSan ?? -1)
  );
  const maxGmv = Math.max(1, ...[...hangChinh, ...gopChongRows].map((h) => h.gmvSan ?? 0));
  // Fix vòng B-2, việc #3: 3 khối (Affiliate video/live, Tab shop) không có badge "đơn" ở trên vì
  // SÀN không đo chỉ số này ở nguồn đó (mãi mãi, không phải riêng kỳ này) — nói rõ một lần ở đây thay
  // vì để người đọc tự đoán tại sao vài dòng "thiếu" badge so với dòng khác.
  const khoiKhongCoDon = [...nonGopChong, ...gopChongRows].filter((d) => !d.coDon).map((d) => d.nhan);

  return (
    <section className="rounded-xl border border-hairline p-4">
      <h2 className="text-sm text-muted-foreground">Nguồn doanh số (sàn báo)</h2>
      <div className="mt-3 flex flex-col gap-2">
        {hangChinh.map((h) => (
          <ThanhNganNguon key={h.khoa} hang={h} maxGmv={maxGmv} />
        ))}
      </div>
      {gopChongRows.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3">
          {gopChongRows.map((d) => (
            <ThanhNganNguon key={d.khoa} hang={d} maxGmv={maxGmv} />
          ))}
        </div>
      )}
      {khoiKhongCoDon.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {khoiKhongCoDon.join(", ")}: sàn không đo số đơn ở các nguồn này nên không có badge &quot;đơn&quot; — khác
          với dấu &quot;—&quot; ở GMV, vốn nghĩa là kỳ NÀY thiếu dữ liệu.
        </p>
      )}
      <ChuThichDoTuoiVaThieu cau1={chuThich.cau1} cau2={chuThich.cau2} />
    </section>
  );
}

type ChartTooltipPayloadItem = { dataKey?: unknown; value?: unknown };

function XuHuongTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: readonly ChartTooltipPayloadItem[];
  label?: unknown;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const luotTruyCap = payload.find((p) => p.dataKey === "luotTruyCap")?.value;
  const donPancake = Number(payload.find((p) => p.dataKey === "donPancake")?.value ?? 0);
  return (
    <div className="rounded-lg border border-hairline bg-canvas p-2.5 text-xs shadow-sm">
      <p className="font-medium text-ink">{fullDayLabel(String(label))}</p>
      <div className="mt-1 flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-4 text-ink">
          <span>Lượt truy cập (sàn)</span>
          <span>{luotTruyCap === null || luotTruyCap === undefined ? "—" : soGon(Number(luotTruyCap))}</span>
        </div>
        <div className="flex items-center justify-between gap-4 text-ink">
          <span>Đơn (Pancake)</span>
          <span>{soGon(donPancake)}</span>
        </div>
      </div>
    </div>
  );
}

type DiemXuHuong = { date: string; luotTruyCap: number | null; donPancake: number };

function XuHuongNgayChart({ diem }: { diem: DiemXuHuong[] }) {
  return (
    <div className="rounded-xl border border-hairline bg-canvas p-4">
      <h3 className="font-serif text-lg text-ink">Xu hướng ngày</h3>
      <p className="text-xs text-muted-foreground">Lượt truy cập (sàn) vs Đơn (Pancake)</p>
      <div className="mt-4 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={diem} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e6dfd8" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(v) => dayLabel(String(v))}
              tick={{ fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis yAxisId="traffic" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} width={56} />
            <YAxis
              yAxisId="orders"
              orientation="right"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip content={XuHuongTooltip} />
            {/* --primary (globals.css) — HEX trực tiếp: CSS custom property không resolve nhất quán
                qua thuộc tính SVG `stroke` (cùng lý do đã ghi ở channel-revenue-ads-chart.tsx). */}
            <Line
              yAxisId="traffic"
              type="monotone"
              dataKey="luotTruyCap"
              name="Lượt truy cập (sàn)"
              stroke="#cc785c"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
            <Line
              yAxisId="orders"
              type="monotone"
              dataKey="donPancake"
              name="Đơn (Pancake)"
              stroke="#5db8a6"
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Trục trái: lượt truy cập do sàn báo (đứt quãng ở ngày chưa có số). Trục phải: số đơn hợp lệ Pancake.
      </p>
    </div>
  );
}

export function PheuTiktokSection({
  pheu,
  nguon,
  donPancake,
  doanhThuGopPancake,
  chiQuangCao,
  donTheoNgayPancake,
  chuThichPheu,
  chuThichNguon,
}: {
  pheu: PheuTiktok;
  nguon: NguonDoanhSoTiktok;
  donPancake: number;
  doanhThuGopPancake: number;
  chiQuangCao: number;
  donTheoNgayPancake: { date: string; orderCount: number }[];
  /** Câu chú thích ĐỘ TƯƠI của khối "Phễu TikTok" — tính SẴN ở `page.tsx` bằng `tinhChuThichDoTuoi`
   *  (đọc `SyncLog` stream `tiktok/analytics_shop`, ruling P2-R35 + P2-R40). Component "use client"
   *  này CHỈ RENDER chuỗi — không tự gọi Prisma, không tự tính lại (ruling P2-R38, xem
   *  `cau-do-tuoi-du-lieu.ts`). */
  chuThichPheu: ChuThichDoTuoi;
  /** Như trên, cho khối "Nguồn doanh số (sàn báo)" — đọc stream `tiktok/analytics_products` (khác
   *  stream với `chuThichPheu`, ruling P2-R40). */
  chuThichNguon: ChuThichDoTuoi;
}) {
  const luotTruyCapTheoNgay = new Map(pheu.chuoiNgay.map((p) => [p.ngay, p.luotTruyCap]));
  const diem: DiemXuHuong[] = donTheoNgayPancake.map((d) => ({
    date: d.date,
    luotTruyCap: luotTruyCapTheoNgay.get(d.date) ?? null,
    donPancake: d.orderCount,
  }));

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-hairline p-4">
        <h2 className="text-sm text-muted-foreground">Phễu TikTok</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <OChiSo
            nhan="Lượt truy cập"
            giaTri={pheu.luotTruyCap === null ? "—" : <SoSanBao>{soGon(pheu.luotTruyCap)}</SoSanBao>}
          />
          <OChiSo
            nhan="Lượt xem trang"
            giaTri={pheu.luotXemTrang === null ? "—" : <SoSanBao>{soGon(pheu.luotXemTrang)}</SoSanBao>}
          />
          <OChiSo
            nhan="Tỉ lệ chuyển đổi"
            giaTri={pheu.tiLeChuyenDoi === null ? "—" : <SoSanBao>{formatPct1(pheu.tiLeChuyenDoi * 100)}</SoSanBao>}
            title="Đơn sàn ÷ lượt truy cập — app tính lại từ hai số sàn, sàn không báo thẳng con số này cho cả kỳ."
          />
          <OChiSo nhan="Đơn (Pancake)" giaTri={`${soGon(donPancake)} đơn`} />
          <OChiSo
            nhan="Doanh thu gộp (Pancake)"
            giaTri={formatVnd(doanhThuGopPancake)}
            href="/kenh/tiktok"
          />
          <OChiSo nhan="Chi quảng cáo (sổ, gồm VAT)" giaTri={formatVnd(chiQuangCao)} />
          {pheu.soNgayCoDoanhSo > 0 && (
            <OChiSo
              nhan="Tỉ trọng doanh số từ GMV Max (sàn)"
              giaTri={
                pheu.tiTrongGmvMax === null ? "—" : <SoSanBao>{formatPct1(pheu.tiTrongGmvMax * 100)}</SoSanBao>
              }
              title={`Tính trên ${pheu.soNgayCoDoanhSo} ngày có doanh số trong kỳ.`}
            />
          )}
        </div>
        <ChuThichDoTuoiVaThieu cau1={chuThichPheu.cau1} cau2={chuThichPheu.cau2} />
      </section>

      <NguonDoanhSoBlock nguon={nguon} chuThich={chuThichNguon} />

      <XuHuongNgayChart diem={diem} />
    </div>
  );
}
