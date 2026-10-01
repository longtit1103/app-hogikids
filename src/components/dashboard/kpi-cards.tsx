import Link from "next/link";

import { LinkNeuDuocVao } from "@/components/dashboard/link-neu-duoc-vao";
import { coTheVaoHref } from "@/components/shell/nav-config";
import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import { chuThichBienRongCoThuNhap } from "@/lib/reports/chu-thich-thu-nhap-tai-chinh";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";
import type { KetQuaChe } from "@/lib/queries/che-gia-von-types";
import type { PnlBreakdown } from "@/lib/reports/pnl";
import type { PnlChe } from "@/lib/reports/pnl-che";
import { cn } from "@/lib/utils";

/**
 * Dải 4 KPI đầu Dashboard — LUÔN Hôm nay/Tháng này, ĐỘC LẬP date-range picker
 * toàn cục (Task 4 brief). `today`/`thisMonth`/`lastMonthSameDays` được tính ở
 * `page.tsx` bằng `calcPnl` trên 3 range CỐ ĐỊNH riêng của hàng KPI này.
 */

const HREF_LOI_LO = "/tai-chinh?tab=loi-lo";

/** Khối `block` — link khi có `href`, khối tĩnh khi không. */
function LinkNeuCo({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href === null ? (
    <div>{children}</div>
  ) : (
    <Link href={href} className="block">
      {children}
    </Link>
  );
}

function pctChange(current: number, previous: number): number {
  return ((current - previous) / previous) * 100;
}

/** ▲ success khi tăng / ▼ error khi giảm — chỉ số "càng cao càng tốt" (doanh thu). Kỳ trước = 0 → badge "Mới". */
function RevenueDelta({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) {
    return <Badge variant="outline">Mới</Badge>;
  }
  const pct = pctChange(current, previous);
  if (Math.round(Math.abs(pct)) === 0) {
    return <span className="text-xs text-muted-foreground">0% so cùng kỳ tháng trước</span>;
  }
  const up = pct > 0;
  return (
    <span className={cn("text-xs", up ? "text-success" : "text-error")}>
      {up ? "▲" : "▼"} {Math.round(Math.abs(pct))}% so cùng kỳ tháng trước
    </span>
  );
}

function returnBomRatePct(b: Pick<PnlChe, "orderCount" | "returnBomOrderCount">): number | null {
  const denom = b.orderCount + b.returnBomOrderCount;
  return denom > 0 ? (b.returnBomOrderCount / denom) * 100 : null;
}

function rateTone(pct: number): "text-success" | "text-warning" | "text-error" {
  if (pct <= 5) return "text-success";
  if (pct <= 10) return "text-warning";
  return "text-error";
}

function formatPct1(pct: number): string {
  return `${pct.toFixed(1).replace(".", ",")}%`;
}

/**
 * Delta tỷ lệ hoàn/bom so tháng trước tính bằng ĐIỂM % (current − previous),
 * không phải % tương đối — so % của % dễ đọc sai (VD 2%→4% không phải
 * "tăng 100%" theo trực giác chủ shop). Tăng điểm % = xấu (error), giảm = tốt
 * (success). Không đủ dữ liệu tháng trước (0 đơn) → ẩn delta thay vì chia 0.
 */
function ReturnBomDelta({ current, previous }: { current: number | null; previous: number | null }) {
  if (current === null || previous === null) {
    return null;
  }
  const diff = current - previous;
  if (diff === 0) {
    return <span className="text-xs text-muted-foreground">0 điểm % so tháng trước</span>;
  }
  const up = diff > 0;
  return (
    <span className={cn("text-xs", up ? "text-error" : "text-success")}>
      {up ? "▲" : "▼"} {formatPct1(Math.abs(diff))} điểm so tháng trước
    </span>
  );
}

/** `href` null ⇒ thẻ tĩnh (không link) — người xem không được vào đích của nó. */
function CardShell({ href, className, children }: { href: string | null; className?: string; children: React.ReactNode }) {
  if (href === null) {
    return <div className={cn("rounded-xl bg-surface-card p-4", className)}>{children}</div>;
  }
  return (
    <Link
      href={href}
      className={cn("block rounded-xl bg-surface-card p-4 transition-colors hover:bg-surface-soft", className)}
    >
      {children}
    </Link>
  );
}

/** 3 kỳ cố định của hàng KPI — nhánh che (thiếu `gia-von-loi-nhuan:xem`) chỉ mang DTO `PnlChe`. */
export type KpiCardsDuLieu = KetQuaChe<
  { today: PnlBreakdown; thisMonth: PnlBreakdown; lastMonthSameDays: PnlBreakdown },
  { today: PnlChe; thisMonth: PnlChe; lastMonthSameDays: PnlChe }
>;

export function KpiCards({
  du,
  choPhepXemLoiLo = false,
  hrefDuocPhep = [],
}: {
  du: KpiCardsDuLieu;
  /**
   * Người xem vào được tab Lãi/Lỗ (`tai-chinh-loi-lo:xem` ∧ giá vốn — server tính). Thiếu ⇒ thẻ doanh thu
   * và thẻ LN ròng KHÔNG link sang `/tai-chinh?tab=loi-lo` (bấm vào chỉ gặp trang "không có quyền").
   */
  choPhepXemLoiLo?: boolean;
  /** Trang người xem được vào — thẻ Đơn/Hoàn-bom chỉ link sang `/don-hang` khi có `don-hang:xem`. */
  hrefDuocPhep?: readonly string[];
}) {
  const { today, thisMonth, lastMonthSameDays } = du;
  // Lãi/Lỗ đòi giá vốn (spec §1.1) ⇒ nhánh che KHÔNG BAO GIỜ link sang đó, kể cả khi cờ lỡ bật.
  const hrefLoiLo = du.coQuyenGiaVon && choPhepXemLoiLo ? HREF_LOI_LO : null;
  const hrefDonHang = (href: string) => (coTheVaoHref(hrefDuocPhep, href) ? href : null);
  const thisRate = returnBomRatePct(thisMonth);
  const prevRate = returnBomRatePct(lastMonthSameDays);

  return (
    <div className="flex flex-col gap-2">
      <div className={cn("grid grid-cols-2 gap-3", du.coQuyenGiaVon ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
        {/* ① Doanh thu gộp HÔM NAY — số lớn CỐ Ý là hôm nay (`buildKpiRanges`, độc lập bộ chọn kỳ);
            chữ "hôm nay" thêm 26/09 vì ảnh iPhone thật cho thấy nút "Tháng này" đang sáng mà số là
            hôm nay ⇒ dễ đọc nhầm. Mobile chiếm đủ 2 cột (số tiền dài không vừa nửa màn).
            Nhãn CỐ Ý giữ chữ "Doanh thu gộp" trùng dòng của bảng Lãi/Lỗ và dải tổng
            màn Đơn hàng: cùng một số (Σ itemsTotal) thì phải mang cùng một tên ở mọi màn, nếu
            không chủ shop đọc hai màn ra hai khái niệm.
            Dòng dưới là `netRevenue` = doanh thu gộp − phí sàn − voucher, mang ĐÚNG nhãn "Thực
            nhận từ sàn" đã dùng ở bảng Lãi/Lỗ. KHÔNG gọi "Sau phí sàn": kỳ nào voucher ≠ 0 là
            nhãn đó mô tả thiếu một vế của công thức.
            Nó đứng đây để đối chiếu Pancake POS: Pancake gọi "Doanh thu" cho Σ `cod` — phần sàn
            đã cắt phí — nên thiếu dòng này thì so hai màn luôn thấy lệch dù cả hai đều đúng (đo
            22/08: gộp 4.458.500 so Pancake 3.074.872).
            Cả hai số lấy THẲNG từ PnlBreakdown của `calcPnl` — KHÔNG cộng trừ lại ở UI, để định
            nghĩa tiền chỉ tồn tại một chỗ là `pnl.ts`. Hai dòng tháng đứng liền nhau (không chèn
            margin) để đọc thành một cặp: cả hai đều là số THÁNG NÀY, không phải hôm nay. */}
        <CardShell href={hrefLoiLo} className="col-span-2 sm:col-span-1">
          <p className="text-sm text-muted-foreground">Doanh thu gộp hôm nay</p>
          <p className="mt-1 font-serif text-2xl text-ink">{formatVnd(today.revenue)}</p>
          <p className="mt-1 text-xs text-muted-foreground">Tháng này: {formatVnd(thisMonth.revenue)}</p>
          <p className="text-xs text-muted-foreground">Thực nhận từ sàn: {formatVnd(thisMonth.netRevenue)}</p>
          <div className="mt-1">
            <RevenueDelta current={thisMonth.revenue} previous={lastMonthSameDays.revenue} />
          </div>
        </CardShell>

        {/* ② Đơn hợp lệ hôm nay */}
        <CardShell href={hrefDonHang("/don-hang")}>
          <p className="text-sm text-muted-foreground">Đơn hợp lệ hôm nay</p>
          <p className="mt-1 font-serif text-2xl text-ink">{today.orderCount.toLocaleString("vi-VN")}</p>
          <p className="mt-1 text-xs text-muted-foreground">Tháng: {thisMonth.orderCount.toLocaleString("vi-VN")}</p>
        </CardShell>

        {/* ③ Tỷ lệ hoàn/bom tháng — đứng TRƯỚC LN ròng trong DOM: mobile 2 cột thì thẻ này nằm cạnh
            "Đơn hôm nay" (cùng 1 cột), LN ròng rộng đủ hàng bên dưới. Thứ tự DOM = thứ tự nhìn ở MỌI
            khổ — KHÔNG `grid-flow-dense`/`order-*` (VoiceOver đọc theo DOM). */}
        <CardShell href={hrefDonHang("/don-hang?trang_thai=hoan_hang,huy_bom")}>
          <p className="text-sm text-muted-foreground">Tỷ lệ hoàn/bom tháng</p>
          <p className={cn("mt-1 font-serif text-2xl", thisRate === null ? "text-ink" : rateTone(thisRate))}>
            {thisRate === null ? "—" : formatPct1(thisRate)}
          </p>
          <div className="mt-1">
            <ReturnBomDelta current={thisRate} previous={prevRate} />
          </div>
        </CardShell>
        {/* ④ LN ròng — chỉ người có quyền giá vốn (nhánh che không có số lãi nào để hiện). */}
        {du.coQuyenGiaVon && (
          <TheLnRongThang thisMonth={du.thisMonth} hrefLoiLo={hrefLoiLo} hrefDuocPhep={hrefDuocPhep} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Các thẻ trên tính hôm nay / tháng này — bộ chọn kỳ chỉ áp dụng cho biểu đồ và phân tích bên dưới.
      </p>
    </div>
  );
}

/**
 * ④ LN ròng ước tính tháng — card dark nổi bật. Tách riêng để CHỈ dựng được khi có `PnlBreakdown` đầy đủ
 * (nhánh đủ quyền giá vốn) — kiểu props chặn truyền nhầm DTO che vào đây.
 */
function TheLnRongThang({
  thisMonth,
  hrefLoiLo,
  hrefDuocPhep,
}: {
  thisMonth: PnlBreakdown;
  hrefLoiLo: string | null;
  hrefDuocPhep: readonly string[];
}) {
  const marginPct = pnlPercentBase(thisMonth) > 0 ? (thisMonth.netProfit / pnlPercentBase(thisMonth)) * 100 : null;
  const isNegative = thisMonth.netProfit < 0;
  const ghiChuBienRong = chuThichBienRongCoThuNhap(thisMonth.financialIncome);
  // Body (label/value/biên) là 1 Link duy nhất; dòng cảnh báo SKU thiếu giá vốn là Link RIÊNG bên
  // ngoài — tránh lồng <a> trong <a> (HTML không hợp lệ).
  return (
    <div className="col-span-2 rounded-xl bg-surface-dark p-4 text-on-dark sm:col-span-1">
      <LinkNeuCo href={hrefLoiLo}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-on-dark/70">LN ròng ước tính tháng</p>
          <Badge className="border-none bg-on-dark/15 text-on-dark">tạm tính</Badge>
        </div>
        <p className={cn("mt-1 font-serif text-2xl", isNegative ? "text-error" : "text-on-dark")}>
          {formatVnd(thisMonth.netProfit)}
        </p>
        <p className="mt-1 text-xs text-on-dark/70">Biên ròng {marginPct === null ? "—" : formatPct1(marginPct)}</p>
        {/* Công thức biên ròng KHÔNG đổi (quyết định #10) — nhưng tháng tất toán sổ thì tử số có
            thêm lãi tiết kiệm, biên nhảy vọt. Thiếu câu này là đọc thành bán hàng lãi hơn. */}
        {ghiChuBienRong && <p className="text-xs text-on-dark/70">{ghiChuBienRong}</p>}
      </LinkNeuCo>
      {/* Link trỏ bộ lọc ĐÃ BÁN, không phải lọc thiếu-giá-vốn cả kho: cảnh báo này đếm SKU ĐÃ
          BÁN, nên dẫn sang danh sách cả kho (đo prod 12/08: 1391 biến thể, chỉ 38 từng bán) là
          bắt chủ shop mò trong đống không liên quan — nhập giá cho biến thể chưa bán ngày nào
          không làm đổi một đồng P&L.
          Hai nhánh CÓ CHỦ ĐÍCH: còn SKU có tên thì Link dẫn tới màn lọc nhập giá vốn; chỉ còn
          dòng KHÔNG rõ SKU thì hiện chữ thường KHÔNG link — nhóm này KHÔNG có Variant nên mọi
          màn Sản phẩm đều không chứa nó, dẫn sang đó chỉ ra danh sách rỗng trong khi cảnh báo
          vẫn đỏ; và nhập giá vốn cũng không sửa được (nguồn Pancake thiếu display_id). */}
      {thisMonth.skuMissingCount > 0 ? (
        <LinkNeuDuocVao
          href="/san-pham?loc=da_ban_thieu_gia_von"
          hrefDuocPhep={hrefDuocPhep}
          className="mt-2 inline-block text-xs text-warning hover:underline"
        >
          ⚠ {thisMonth.skuMissingCount} SKU thiếu giá vốn
          {thisMonth.skuUnknownLineCount > 0 && ` + ${thisMonth.skuUnknownLineCount} dòng không khớp SP`}
        </LinkNeuDuocVao>
      ) : thisMonth.skuUnknownLineCount > 0 ? (
        <span className="mt-2 inline-block text-xs text-warning">
          ⚠ {thisMonth.skuUnknownLineCount} dòng hàng không khớp sản phẩm nào — nhập giá vốn không sửa được COGS của chúng
        </span>
      ) : null}
    </div>
  );
}
