import { endOfDay, format } from "date-fns";
import Link from "next/link";

import { AdsImportButton } from "@/components/expenses/ads-import-button";
import { ExpenseAddButton } from "@/components/expenses/expense-add-button";
import { ExpenseKpiCards } from "@/components/expenses/expense-kpi-cards";
import { ExpenseStructureChart } from "@/components/expenses/expense-structure-chart";
import { ExpenseTable } from "@/components/expenses/expense-table";
import { type DateRange } from "@/lib/date-range";
import { ensureRecurringExpensesForMonths, monthStartsInRange } from "@/lib/expenses/ensure-recurring-expenses";
import {
  getExpenseSummary,
  getExpensesPage,
  sumPlatformFeeEst,
  type ExpenseListParams,
} from "@/lib/expenses/expense-queries";
import {
  KEY_MOC_KIEM_PHIEU_NHAP,
  KEY_SO_PHIEU_NHAP_CHUA_GHI,
  KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
  trangThaiPhieuNhapChuaGhi,
} from "@/lib/nhap-hang/trang-thai-phieu-nhap";
import { docSoTrang } from "@/lib/pagination";
import { prisma } from "@/lib/prisma";

type ExpenseSourceValue = NonNullable<ExpenseListParams["sources"]>[number];

/** `?nguon=` dùng slug tiếng Việt ở URL, map sang enum `ExpenseSource` của Prisma. */
const SOURCE_SLUG_MAP: Record<string, ExpenseSourceValue> = {
  nhap_tay: "MANUAL",
  dinh_ky: "RECURRING",
  import: "IMPORT",
  ads_api: "ADS_API",
};

const VALID_SORTS: ExpenseListParams["sort"][] = ["date_desc", "date_asc", "amount_desc", "amount_asc"];

function isValidSort(value: string | undefined): value is ExpenseListParams["sort"] {
  return VALID_SORTS.includes(value as ExpenseListParams["sort"]);
}

/** Các query param riêng của sổ chi phí (đọc từ URL của hub `/tai-chinh`). */
export type ExpenseLedgerParams = {
  danh_muc?: string;
  kenh?: string;
  nguon?: string;
  q?: string;
  sap_xep?: string;
  trang?: string;
};

/**
 * Tab "Sổ chi phí" của hub Tài chính — nguyên hành vi `/chi-phi` cũ (CRUD +
 * import ads + lọc). Async server component: nhận `range` toàn cục (đã resolve
 * ở page) + các filter riêng, tự backfill chi phí định kỳ + query rồi render
 * KPI / donut cơ cấu / bảng. Tách khỏi `tai-chinh/page.tsx` để page mỏng.
 */
export async function ExpenseLedgerTab({ sp, range }: { sp: ExpenseLedgerParams; range: DateRange }) {
  // Backfill chi phí định kỳ cho MỌI tháng giao với range đang xem TRƯỚC khi
  // query sổ chi phí (range "Tùy chọn" có thể là tháng quá khứ/đa tháng).
  await ensureRecurringExpensesForMonths(monthStartsInRange(range));

  const [categories, channels, mocPhieuNhap] = await Promise.all([
    prisma.expenseCategory.findMany({ where: { isHidden: false } }),
    prisma.channel.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    // Chỉ ĐỌC 3 ô `Setting` do lượt đêm chốt — KHÔNG đếm ở đây (phép đếm phải quét trọn Bronze).
    prisma.setting.findMany({
      where: {
        key: {
          in: [KEY_SO_PHIEU_NHAP_CHUA_GHI, KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP, KEY_MOC_KIEM_PHIEU_NHAP],
        },
      },
      select: { key: true, value: true },
    }),
  ]);

  const phieuNhapChuaGhi = trangThaiPhieuNhapChuaGhi(
    mocPhieuNhap.find((s) => s.key === KEY_SO_PHIEU_NHAP_CHUA_GHI)?.value,
    mocPhieuNhap.find((s) => s.key === KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP)?.value,
    mocPhieuNhap.find((s) => s.key === KEY_MOC_KIEM_PHIEU_NHAP)?.value,
  );

  const categoryIdSet = new Set(categories.map((c) => c.id));
  const categoryIds = (sp.danh_muc ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => categoryIdSet.has(id));
  // Chart chỉ tô viền coral khi ĐÚNG 1 danh mục đang lọc.
  const activeCategoryId = categoryIds.length === 1 ? categoryIds[0] : undefined;

  const channelId: ExpenseListParams["channelId"] = sp.kenh === "none" ? "none" : sp.kenh || undefined;

  const sources = (sp.nguon ?? "")
    .split(",")
    .map((slug) => SOURCE_SLUG_MAP[slug.trim()])
    .filter((s): s is ExpenseSourceValue => Boolean(s));

  const sort: ExpenseListParams["sort"] = isValidSort(sp.sap_xep) ? sp.sap_xep : "date_desc";
  const page = docSoTrang(sp.trang);

  const [summary, platformFeeEst, expensesPage, validOrderCount] = await Promise.all([
    getExpenseSummary(range),
    sumPlatformFeeEst(range),
    getExpensesPage({
      range,
      categoryIds: categoryIds.length ? categoryIds : undefined,
      channelId,
      sources: sources.length ? sources : undefined,
      q: sp.q,
      sort,
      page,
    }),
    // Đếm đơn hợp lệ trong kỳ — ẩn dòng phí sàn tham khảo khi kỳ không có đơn.
    prisma.order.count({
      where: {
        orderedAt: { gte: range.from, lte: endOfDay(range.to) },
        status: { notIn: ["RETURNED", "CANCELLED"] },
      },
    }),
  ]);

  const isEmpty = summary.total === 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Nhãn kỳ tự thân: vào tab này qua drill-down từ bảng P&L thì kỳ được neo
          theo tháng của dòng vừa bấm, trong khi picker topbar chỉ đọc URL lúc
          mount nên có thể còn hiện preset cũ. Số phải tự nói nó thuộc kỳ nào. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Kỳ: {format(range.from, "dd/MM/yyyy")} – {format(range.to, "dd/MM/yyyy")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {/*
            LỐI VÀO CỐ ĐỊNH, không phụ thuộc banner. Bài học 07/09: banner chỉ kêu khi lượt đêm đã
            chốt được số — ở mức `chua-kiem` nó cũng kêu, nhưng nếu ai chỉnh luật im lặng thì màn
            hình kia thành đảo hoang không đường tới. Số phiếu chờ chỉ hiện khi CHẮC CHẮN > 0.
          */}
          <Link href="/tai-chinh/chi-phi-nhap-hang" className="text-sm text-primary underline">
            Chi phí nhập hàng từ Pancake
            {/*
              HAI con số RIÊNG, không cộng lại: "chờ ghi" là việc duyệt, "cần kiểm lại" là phiếu ĐÃ
              ghi nay không khớp Pancake (bị huỷ / đổi số tiền / trạng thái lạ). Gộp một số là chủ
              shop mở màn ra không hiểu đang đếm cái gì.
            */}
            {phieuNhapChuaGhi.muc === "co-lech" && (
              <>
                {phieuNhapChuaGhi.soChoDuyet > 0 && <> ({phieuNhapChuaGhi.soChoDuyet} phiếu chờ)</>}
                {phieuNhapChuaGhi.soViecHauKiem > 0 && (
                  <> ({phieuNhapChuaGhi.soViecHauKiem} phiếu cần kiểm lại)</>
                )}
              </>
            )}
          </Link>
          <Link href="/tai-chinh/thung-rac" className="text-sm text-muted-foreground underline">
            Thùng rác
          </Link>
          <AdsImportButton channels={channels} />
          <ExpenseAddButton categories={categories} channels={channels} />
        </div>
      </div>

      <ExpenseKpiCards summary={summary} />

      {isEmpty ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-hairline bg-canvas px-6 py-16 text-center">
          <svg
            width="96"
            height="96"
            viewBox="0 0 96 96"
            fill="none"
            stroke="#cc785c"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <rect x="20" y="14" width="56" height="72" rx="4" />
            <path d="M32 32h32M32 44h32M32 56h20" />
            <circle cx="66" cy="66" r="14" />
            <path d="M66 60v6l4 4" />
          </svg>
          <h2 className="font-serif text-lg text-ink">Chưa có khoản chi nào trong kỳ này</h2>
          <div className="flex items-center gap-4">
            <ExpenseAddButton categories={categories} channels={channels} />
            <AdsImportButton channels={channels} variant="link" className="text-primary" />
          </div>
        </div>
      ) : (
        <>
          <ExpenseStructureChart
            breakdown={summary.breakdown}
            platformFeeEst={platformFeeEst}
            showPlatformFee={validOrderCount > 0}
            activeCategoryId={activeCategoryId}
          />
          <ExpenseTable
            rows={expensesPage.rows}
            count={expensesPage.count}
            totalAmount={expensesPage.totalAmount}
            categories={categories}
            channels={channels}
          />
        </>
      )}
    </div>
  );
}
