import { format } from "date-fns";

import { taiKhoiChiTietDashboard } from "@/lib/dashboard/khoi-chi-tiet-theo-quyen";
import { clampRangeEndToNow, khoangServerThuocTinh, serializeDateRange, type DateRange } from "@/lib/date-range";
import { ensureRecurringExpensesForMonths, monthStartsInRange } from "@/lib/expenses/ensure-recurring-expenses";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { docSanPhamCoBienTheTonThap } from "@/lib/queries/variants";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { DailyPoint } from "@/lib/reports/daily-series";
import { computeDailySeries } from "@/lib/reports/daily-series";
import { calcPnl, computeChannelPnl } from "@/lib/reports/pnl";
import { channelPnlTheoQuyen, chePnl, cheDailySeries, type DailyPointChe, type PnlCheTruong } from "@/lib/reports/pnl-che";
import { UNMATCHED_PRODUCT_ID } from "@/lib/reports/product-report";
import { chiaChiPhi } from "@/lib/trang-chu/chia-chi-phi";
import {
  SO_DONG_KHOI_DUOI,
  type DiemBieuDo,
  type DuLieuTheVaBieuDo,
  type DuLieuTrangChu,
  type SoSanh,
  type TheoKenh,
} from "@/lib/trang-chu/kieu-du-lieu-trang-chu";
import { ghepKyTruoc, kySoSanh, nhanKySoSanh, phanTramThayDoi, rangeBieuDo } from "@/lib/trang-chu/so-sanh-ky";
import { demTrangThaiDon } from "@/lib/trang-chu/dem-trang-thai-don";
import { xepHangLaiSanPham } from "@/lib/trang-chu/xep-hang-lai-san-pham";

/**
 * Loader trang chủ (spec trang chủ §4–§5): MỘT kỳ (bộ chọn toàn cục) điều khiển MỌI số trên trang.
 * Mọi số tiền lấy từ `calcPnl`/`computeDailySeries`/`computeChannelPnl` (nguồn duy nhất `pnl.ts`); ở đây
 * chỉ gộp field (`chiaChiPhi`) và chia tỉ số hiển thị.
 *
 * Che giá vốn: nhánh thiếu `gia-von-loi-nhuan:xem` dựng TỪ DTO che (`chePnl`/`cheDailySeries`/
 * `channelPnlTheoQuyen`) — không đọc `cogs/grossProfit/netProfit/marginPct`, không dựng chi phí (gồm giá vốn).
 *
 * ⚠️ GHI DB: `ensureRecurringExpensesForMonths` sinh chi phí định kỳ còn thiếu — chỉ gọi từ page thật /
 * test có mock, KHÔNG chạy thử bằng script nối `DATABASE_URL` mặc định (production).
 */

const BAN_CHAY_GIOI_HAN = SO_DONG_KHOI_DUOI;

const soSanh = (hienTai: number, kyTruoc: number): SoSanh => ({ hienTai, kyTruoc, phanTram: phanTramThayDoi(hienTai, kyTruoc) });

/** Hoàn/hủy % = hoàn hủy / (hợp lệ + hoàn hủy) — cùng công thức `returnBomRatePct` của hàng KPI cũ. */
function tyLeHoanHuy(b: Pick<PnlCheTruong, "orderCount" | "returnBomOrderCount">): number | null {
  const mau = b.orderCount + b.returnBomOrderCount;
  return mau > 0 ? (b.returnBomOrderCount / mau) * 100 : null;
}

const tbMoiDon = (b: Pick<PnlCheTruong, "revenue" | "orderCount">): number | null =>
  b.orderCount > 0 ? Math.round(b.revenue / b.orderCount) : null;

/** Ghép chuỗi kỳ này ↔ kỳ trước theo thứ tự rồi chiếu từng điểm sang giá trị hiển thị. */
function dungBieuDo<P extends { date: string }, G>(
  hienTai: readonly P[],
  kyTruoc: readonly P[] | null,
  ngayDangXem: string | null,
  chieu: (p: P) => G
): DiemBieuDo<G>[] {
  return ghepKyTruoc(hienTai, kyTruoc).map((d) => ({
    ngay: d.hienTai.date,
    laNgayDangXem: d.hienTai.date === ngayDangXem,
    hienTai: chieu(d.hienTai),
    kyTruoc: d.kyTruoc ? chieu(d.kyTruoc) : null,
  }));
}

export async function taiDuLieuTrangChu(nd: NguoiDung, range: DateRange, now: Date): Promise<DuLieuTrangChu> {
  const quyen = quyenGiaVonCua(nd);
  const kyTinh = clampRangeEndToNow(range, now);
  // Cả ba nhận range GỐC của bộ chọn: "kỳ 1 ngày" phải xét cùng một tiêu chí (ngày 01 chọn "Tháng này"
  // kẹp còn 1 ngày nhưng vẫn là kỳ tháng — so cùng kỳ tháng trước, biểu đồ không chuyển sang 7 ngày).
  const kyTruoc = kySoSanh(range, now);
  const bd = rangeBieuDo(range, now);
  // Biểu đồ nhiều ngày = đúng kỳ đã kẹp ⇒ kỳ trước của biểu đồ trùng kỳ so của thẻ.
  const bdTruoc = bd.motNgay ? null : kyTruoc;

  // Backfill chi phí định kỳ cho MỌI tháng sắp tính TRƯỚC khi tính P&L — thiếu là tháng đó hụt chi phí
  // định kỳ, lợi nhuận cao ảo. Hàm tự bỏ tháng trùng.
  await ensureRecurringExpensesForMonths(
    [kyTinh, kyTruoc, bd.range, ...(bdTruoc ? [bdTruoc] : [])].flatMap((r) => monthStartsInRange(r))
  );

  const [pnl, pnlTruoc, chuoi, chuoiTruoc, kenh, dem, khoi] = await Promise.all([
    calcPnl(kyTinh),
    calcPnl(kyTruoc),
    computeDailySeries(bd.range),
    bdTruoc ? computeDailySeries(bdTruoc) : Promise.resolve(null),
    computeChannelPnl(kyTinh),
    demTrangThaiDon(kyTinh),
    taiKhoiChiTietDashboard(nd, kyTinh, quyen),
  ]);
  const { productReport, lowStock } = khoi;
  // Tô đỏ cột Tồn của "Lãi nhiều – nên đẩy" — chỉ cần khi khối đó có mặt (đủ bao-cao + giá vốn).
  const tonThap = productReport?.coQuyenGiaVon ? await docSanPhamCoBienTheTonThap() : null;

  const ngayDangXem = bd.motNgay ? format(range.from, "yyyy-MM-dd") : null;
  const chung = { nhanKySoSanh: nhanKySoSanh(range, now), motNgay: bd.motNgay };

  let theVaBieuDo: DuLieuTheVaBieuDo;
  if (quyen.coQuyenGiaVon) {
    const c = chiaChiPhi(pnl);
    const cTruoc = chiaChiPhi(pnlTruoc);
    const chieu = (p: DailyPoint) => ({ doanhSo: p.revenue, chiPhi: p.chiPhi, loiNhuan: p.netProfit, donHang: p.orderCount });
    theVaBieuDo = {
      ...chung,
      coQuyenGiaVon: true,
      the: {
        doanhSo: soSanh(pnl.revenue, pnlTruoc.revenue),
        chiPhi: soSanh(c.chiPhi, cTruoc.chiPhi),
        loiNhuan: soSanh(pnl.netProfit, pnlTruoc.netProfit),
        donHang: soSanh(pnl.orderCount, pnlTruoc.orderCount),
        tbMoiDon: tbMoiDon(pnl),
        quangCao: pnl.ads,
        bienLai: c.mauSo > 0 ? (pnl.netProfit / c.mauSo) * 100 : null,
        tyLeHoanHuy: tyLeHoanHuy(pnl),
      },
      bieuDo: dungBieuDo(chuoi, chuoiTruoc, ngayDangXem, chieu),
    };
  } else {
    const che = chePnl(pnl);
    const cheTruoc = chePnl(pnlTruoc);
    const chieu = (p: DailyPointChe) => ({ doanhSo: p.revenue, donHang: p.orderCount });
    theVaBieuDo = {
      ...chung,
      coQuyenGiaVon: false,
      the: {
        doanhSo: soSanh(che.revenue, cheTruoc.revenue),
        donHang: soSanh(che.orderCount, cheTruoc.orderCount),
        tbMoiDon: tbMoiDon(che),
        tyLeHoanHuy: tyLeHoanHuy(che),
      },
      bieuDo: dungBieuDo(cheDailySeries(chuoi), chuoiTruoc ? cheDailySeries(chuoiTruoc) : null, ngayDangXem, chieu),
    };
  }

  // Theo kênh: kênh có phát sinh bán xếp trước (doanh số giảm), rồi kênh CHỈ có chi tiêu quảng cáo (chưa ra đơn,
  // `ads > 0`, ads giảm) — kênh đang lỗ vì ads vẫn phải lên khối này. Kênh không bán, không ads: bỏ.
  const kenhQ = channelPnlTheoQuyen(kenh, quyen);
  const dongKenhHienThi = <K extends { revenue: number; orderCount: number; ads: number }>(rows: K[]) => {
    const ban = rows.filter((k) => k.revenue > 0 || k.orderCount > 0).sort((a, b) => b.revenue - a.revenue);
    const chiAds = rows.filter((k) => k.revenue <= 0 && k.orderCount <= 0 && k.ads > 0).sort((a, b) => b.ads - a.ads);
    return [...ban, ...chiAds];
  };
  const theoKenh: TheoKenh = kenhQ.coQuyenGiaVon
    ? {
        coQuyenGiaVon: true,
        rows: dongKenhHienThi(kenhQ.rows).map((k) => ({
          channelId: k.channelId,
          ten: k.name,
          doanhSo: k.revenue,
          donHang: k.orderCount,
          loiNhuan: k.netProfit,
        })),
      }
    : {
        coQuyenGiaVon: false,
        rows: dongKenhHienThi(kenhQ.rows).map((k) => ({ channelId: k.channelId, ten: k.name, doanhSo: k.revenue, donHang: k.orderCount })),
      };

  const tong = Object.values(dem).reduce((s, n) => s + n, 0);

  return {
    khoangServer: khoangServerThuocTinh(range),
    kyDangXem: serializeDateRange(kyTinh),
    theVaBieuDo,
    tinhTrangDon: { tong, theoTrangThai: dem },
    tienDiDau: quyen.coQuyenGiaVon ? chiaChiPhi(pnl) : null,
    theoKenh,
    banChay: productReport
      ? [...productReport.rows]
          .filter((r) => r.productId !== UNMATCHED_PRODUCT_ID)
          // Cột hiển thị là SỐ LƯỢNG bán ⇒ xếp theo số lượng (đồng hạng: doanh số cao trước).
          .sort((a, b) => b.soldQty - a.soldQty || b.revenue - a.revenue)
          .slice(0, BAN_CHAY_GIOI_HAN)
          .map((r) => ({ productId: r.productId, ten: r.name, soLuong: r.soldQty, doanhSo: r.revenue }))
      : null,
    laiNenDay: productReport?.coQuyenGiaVon && tonThap ? xepHangLaiSanPham(productReport.rows, tonThap, SO_DONG_KHOI_DUOI) : null,
    sapHet: lowStock ? { rows: lowStock.rows, total: lowStock.total } : null,
  };
}
