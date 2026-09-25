import Link from "next/link";
import { endOfMonth, format, startOfMonth, subMonths } from "date-fns";

import { PnlTab } from "@/components/bao-cao/pnl-tab";
import { ReportExportButtons } from "@/components/bao-cao/report-export-buttons";
import { CashFlowTab } from "@/components/finance/cash-flow-tab";
import { ExpenseLedgerTab } from "@/components/finance/expense-ledger-tab";
import { listCashMovements } from "@/lib/cash-movements/cash-movement-queries";
import { resolveRangeFromParams } from "@/lib/date-range";
import { ensureRecurringExpensesForMonths } from "@/lib/expenses/ensure-recurring-expenses";
import { isPnlMonthEmpty } from "@/lib/reports/pnl-line-items";
import { calcPnl } from "@/lib/reports/pnl";
import { computeBackfilledPlatformFee, computePlatformFeeComponents } from "@/lib/reports/platform-fee-breakdown";
import { computeVoucherBreakdown } from "@/lib/reports/voucher-breakdown";
import { computeCashFlow, sumGmv } from "@/lib/reports/cash-flow";
import { doiSoatTienVe } from "@/lib/reports/doi-soat-tien-ve";
import { doiSoatTienVeShopee } from "@/lib/reports/doi-soat-tien-ve-shopee";
import { requireUser } from "@/lib/session";
import { listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";
import { docSoDuChot, ghepDoiChieuSoDuChot, tinhKhoanCauTruc } from "@/lib/so-quy/doi-chieu-so-du-chot";
import { docDuBaoQuy } from "@/lib/so-quy/du-bao-quy-queries";
import { docSoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { docViTiktokConLaiToiThieu } from "@/lib/vi-san/vi-tiktok-con-lai-toi-thieu-queries";
import { demKhoanVayCoKyCho } from "@/components/finance/dem-khoan-vay-co-ky-cho";
import { SoQuyDongChayTab } from "@/components/finance/so-quy-dong-chay-tab";
import {
  listSoTietKiem,
  tongDangGui,
  tongLaiDaNhanTrongKy,
} from "@/lib/tiet-kiem/so-tiet-kiem-queries";
import { cn } from "@/lib/utils";

type FinanceTab = "loi-lo" | "dong-tien" | "so-quy" | "so-chi-phi";

const TAB_ITEMS: { key: FinanceTab; label: string }[] = [
  { key: "loi-lo", label: "Lãi/Lỗ" },
  { key: "dong-tien", label: "Dòng tiền" },
  { key: "so-quy", label: "Sổ quỹ" },
  { key: "so-chi-phi", label: "Sổ chi phí" },
];

function isFinanceTab(value: string | undefined): value is FinanceTab {
  return value === "loi-lo" || value === "dong-tien" || value === "so-quy" || value === "so-chi-phi";
}

// Sổ chi phí dùng thêm nhiều param riêng; chuyển tab chỉ giữ range toàn cục.
type SearchParams = {
  tu?: string;
  den?: string;
  range?: string;
  tab?: string;
  danh_muc?: string;
  kenh?: string;
  nguon?: string;
  q?: string;
  sap_xep?: string;
  trang?: string;
};

/**
 * `/tai-chinh` — hub Tài chính, 4 lăng kính (Lãi/Lỗ · Dòng tiền · Sổ quỹ · Sổ chi phí)
 * chọn qua `?tab=`, mặc định `loi-lo`. Lãi/Lỗ theo THÁNG (chứa `range.to`, dời
 * nguyên từ `/bao-cao`); Sổ chi phí theo range toàn cục. Dòng tiền theo THÁNG, mở đầu bằng thẻ Quỹ
 * còn lại + khối Khoản vay (trục tiền THẬT) rồi mới tới các số dự kiến. Sổ quỹ CHI TIẾT từng dòng
 * của đúng con số thẻ Quỹ đó — cùng kỳ + cùng thứ tự ensureRecurring→đọc với tab Dòng tiền.
 */

/** Tháng chứa `monthStart` có phải tháng hiện tại — dùng chung cho tab Dòng tiền lẫn Sổ quỹ (cả hai
 * đổi nhãn/số theo cùng một luật "đang xem tháng đang chạy" của `so-quy-card.tsx`). */
function laThangHienTai(monthStart: Date): boolean {
  const now = new Date();
  return monthStart.getFullYear() === now.getFullYear() && monthStart.getMonth() === now.getMonth();
}

export default async function TaiChinhPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();

  const sp = await searchParams;
  const tab: FinanceTab = isFinanceTab(sp.tab) ? sp.tab : "loi-lo";
  // Range chung: ?tu=&den= (Tùy chọn) → ?range=<preset> → this_month.
  const range = resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range });

  // Chuyển tab giữ range đang xem (tu/den HOẶC preset), bỏ filter riêng của sổ.
  function tabHref(target: FinanceTab): string {
    const params = new URLSearchParams();
    if (target !== "loi-lo") params.set("tab", target);
    if (sp.tu && sp.den) {
      params.set("tu", sp.tu);
      params.set("den", sp.den);
    } else if (sp.range) {
      params.set("range", sp.range);
    }
    const qs = params.toString();
    return qs ? `/tai-chinh?${qs}` : "/tai-chinh";
  }

  let content: React.ReactNode;
  if (tab === "loi-lo") {
    // Tab P&L theo THÁNG dương lịch chứa `range.to`. prevMonth dùng `subMonths`
    // (KHÔNG `previousRange` — tháng dài ngắn khác nhau, xem lịch sử bao-cao).
    const monthRange = { from: startOfMonth(range.to), to: endOfMonth(range.to) };
    const prevMonthStart = startOfMonth(subMonths(monthRange.from, 1));
    const prevMonthRange = { from: prevMonthStart, to: endOfMonth(prevMonthStart) };
    // Backfill chi phí định kỳ cho ĐÚNG 2 tháng render (xem + liền trước) TRƯỚC
    // khi tính — thiếu sẽ báo netProfit cao ảo ở tháng quá khứ.
    await ensureRecurringExpensesForMonths([monthRange.from, prevMonthRange.from]);
    // feeComponents/voucher = chi tiết dòng "Phí sàn" và "Voucher" (diễn giải,
    // KHÔNG đổi tổng — xem platform-fee-breakdown.ts, voucher-breakdown.ts).
    // Tính cho cả tháng trước để dòng con cũng có cột so sánh.
    const [
      monthPnl,
      prevMonthPnl,
      gmv,
      feeComponents,
      prevFeeComponents,
      voucher,
      prevVoucher,
      backfilledFee,
      prevBackfilledFee,
    ] = await Promise.all([
      calcPnl(monthRange),
      calcPnl(prevMonthRange),
      sumGmv(monthRange),
      computePlatformFeeComponents(monthRange),
      computePlatformFeeComponents(prevMonthRange),
      computeVoucherBreakdown(monthRange),
      computeVoucherBreakdown(prevMonthRange),
      computeBackfilledPlatformFee(monthRange),
      computeBackfilledPlatformFee(prevMonthRange),
    ]);
    const printPeriodLabel = `Tháng ${monthRange.from.getMonth() + 1}/${monthRange.from.getFullYear()}`;
    // Cổng bật nút Xuất Excel / In. Hỏi THẲNG `isPnlMonthEmpty` chứ không chép lại phép cộng
    // danh mục ở đây: chép tay thì thêm danh mục thứ 9 phải nhớ sửa hai chỗ, quên một chỗ là
    // tháng có phát sinh mà nút xuất vẫn tắt (hoặc ngược lại) — không lưới nào bắt được.
    const hasData = !isPnlMonthEmpty(monthPnl);

    content = (
      <div className="flex flex-col gap-4">
        {/* Chỉ hiện khi in (@media print ẩn topbar) — trang in tự giới thiệu ngữ cảnh. */}
        <div className="hidden print:block">
          <p className="font-serif text-xl text-ink">HogiKids</p>
          <p className="text-sm text-muted-foreground">Lãi/Lỗ — {printPeriodLabel}</p>
        </div>
        <div className="flex justify-end print:hidden">
          <ReportExportButtons
            ky={format(monthRange.from, "yyyy-MM")}
            hasData={hasData}
            data={{
              tab: "pnl",
              monthPnl,
              prevMonthPnl,
              feeComponents,
              prevFeeComponents,
              voucher,
              prevVoucher,
              backfilledFee,
              prevBackfilledFee,
            }}
          />
        </div>
        <PnlTab
          monthPnl={monthPnl}
          prevMonthPnl={prevMonthPnl}
          month={monthRange.from}
          gmv={gmv}
          feeComponents={feeComponents}
          prevFeeComponents={prevFeeComponents}
          voucher={voucher}
          prevVoucher={prevVoucher}
          backfilledFee={backfilledFee}
          prevBackfilledFee={prevBackfilledFee}
        />
      </div>
    );
  } else if (tab === "so-chi-phi") {
    content = <ExpenseLedgerTab sp={sp} range={range} />;
  } else if (tab === "so-quy") {
    // Sổ quỹ theo THÁNG — CÙNG kỳ + CÙNG thứ tự ensureRecurring→đọc với tab Dòng tiền, không thì
    // "Cuối kỳ" của hai tab lệch nhau.
    const monthRange = { from: startOfMonth(range.to), to: endOfMonth(range.to) };
    await ensureRecurringExpensesForMonths([monthRange.from]);
    // `docDuBaoQuy` ĐỘC LẬP `monthRange` (luôn neo hôm nay) — vẫn gọi cùng lượt `Promise.all` để
    // không mở thêm round-trip DB tuần tự. `docDuBaoQuy` cố ý NÉM lỗi khi hai lượt đọc DB của chính nó
    // (aggregate + findMany) lệch nhau do một khoản ghi xen giữa — cô lập lỗi Ở ĐÂY bằng `.catch` chứ
    // KHÔNG bọc thử/bắt trong lib: dòng chạy + cảnh báo lệch sẵn có của `docSoQuyDongChay` không được
    // phép mất theo. `null` báo cho tab hiện hộp nhẹ mời tải lại, sổ tháng vẫn render bình thường.
    const [dongChay, loans, duBaoQuy] = await Promise.all([
      docSoQuyDongChay(monthRange),
      listKhoanVay(),
      docDuBaoQuy().catch((e: unknown) => {
        console.error("[tai-chinh] docDuBaoQuy lỗi — tab Sổ quỹ vẫn hiện sổ tháng, chỉ ẩn khối dự báo", e);
        return null;
      }),
    ]);
    content = (
      <SoQuyDongChayTab
        dongChay={dongChay}
        duBaoQuy={duBaoQuy}
        hrefDongTien={tabHref("dong-tien")}
        isCurrentMonth={laThangHienTai(monthRange.from)}
        soKhoanVayCoKyCho={demKhoanVayCoKyCho(loans)}
      />
    );
  } else {
    // Dòng tiền theo THÁNG (khớp kỳ tab Lãi/Lỗ). ensureRecurring TRƯỚC khi tính
    // (getExpenseSummary trong computeCashFlow không tự backfill chi phí định kỳ).
    const monthRange = { from: startOfMonth(range.to), to: endOfMonth(range.to) };
    await ensureRecurringExpensesForMonths([monthRange.from]);
    const [
      flow,
      doiSoat,
      doiSoatShopee,
      movements,
      soQuy,
      loans,
      tietKiemTong,
      soTietKiem,
      laiTietKiemTrongKy,
      banChot,
      banChotThangTruoc,
      viTiktok,
    ] = await Promise.all([
      computeCashFlow(monthRange),
      doiSoatTienVe(monthRange),
      doiSoatTienVeShopee(monthRange),
      listCashMovements(monthRange),
      // Quỹ luỹ kế từ ngày mở sổ; KHÔNG ensure chi phí định kỳ toàn lịch sử (spec §5.6 — mỗi tháng
      // là một transaction và luật Path A còn sinh lùi, tức đổi P&L quá khứ âm thầm).
      tinhSoQuyThang(monthRange),
      listKhoanVay(),
      // 5 số cho footnote thẻ Quỹ, LUỸ KẾ tới hôm nay chứ không theo `monthRange`: câu chú thích nói
      // "đang gửi bao nhiêu, đáo hạn ngày nào" — đó là trạng thái HIỆN TẠI, không phải số của tháng
      // đang xem. Bốn số sau đều nói về CHÍNH sổ đáo hạn sớm nhất nên không tự ghép từ hai nguồn.
      tongDangGui(),
      // Danh sách sổ cho bảng + thẻ đến hạn, và Σ lãi đã nhận TRONG KỲ cho dòng tổng. Cùng một
      // lượt `Promise.all` với các nguồn khác — không mở thêm vòng đọc DB nào.
      listSoTietKiem(),
      tongLaiDaNhanTrongKy(monthRange),
      // Bản chốt số dư THẬT của tháng đang xem + tháng liền trước (để nhắc "tháng trước chưa chốt") —
      // đọc ở đây, ghép với `soQuy` bằng hàm thuần bên dưới (hàm ghép cần `soQuy` nên không thể tự
      // nằm trong cùng lượt này).
      docSoDuChot(monthRange.from),
      docSoDuChot(subMonths(monthRange.from, 1)),
      // Ô thông tin "Còn ở ví TikTok" — ĐỘC LẬP `monthRange` (luôn là trạng thái hiện tại) và KHÔNG
      // bao giờ vào số quỹ. Lỗi đọc chỉ ẩn ô, không được kéo sập cả tab Dòng tiền.
      docViTiktokConLaiToiThieu().catch((e: unknown) => {
        console.error("[tai-chinh] docViTiktokConLaiToiThieu lỗi — ẩn ô Còn ở ví TikTok", e);
        return null;
      }),
    ]);
    // Thấu chi + tiền đang gửi: hai khoản làm tiền thật lệch sổ mà KHÔNG phải sai sổ — cùng phép
    // lọc với footnote thẻ Quỹ, nhưng thẻ chốt cần chúng dưới dạng SỐ để tự cộng/loại trừ.
    const doiChieu = ghepDoiChieuSoDuChot(
      monthRange,
      soQuy,
      { thangNay: banChot, thangTruoc: banChotThangTruoc },
      tinhKhoanCauTruc(loans, tietKiemTong.tong)
    );
    const isCurrentMonth = laThangHienTai(monthRange.from);
    content = (
      <CashFlowTab
        flow={flow}
        isCurrentMonth={isCurrentMonth}
        doiSoat={doiSoat}
        doiSoatShopee={doiSoatShopee}
        movements={movements}
        soQuy={soQuy}
        doiChieu={doiChieu}
        loans={loans}
        tietKiem={{
          tong: tietKiemTong.tong,
          daoHanGanNhat: tietKiemTong.daoHanGanNhat,
          gocDaoHan: tietKiemTong.gocDaoHanGanNhat,
          laiDuKienDaoHan: tietKiemTong.laiDaoHanGanNhat,
        }}
        soTietKiem={soTietKiem}
        laiTietKiemTrongKy={laiTietKiemTrongKy}
        viTiktok={viTiktok}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="print:hidden">
        <h1 className="font-serif text-2xl text-ink">Tài chính</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Lãi/lỗ · dòng tiền vào–ra · sổ quỹ · sổ chi phí — toàn cảnh tiền của shop
        </p>
      </div>

      <nav className="flex gap-1 rounded-lg bg-surface-soft p-1 print:hidden" aria-label="Lăng kính tài chính">
        {TAB_ITEMS.map((t) => (
          <Link
            key={t.key}
            href={tabHref(t.key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === t.key ? "bg-canvas text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {content}
    </div>
  );
}
