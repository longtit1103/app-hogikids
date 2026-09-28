"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { ArrowDown, ArrowUp, ChevronsUpDown, Pencil, Trash2 } from "lucide-react";

import { ExpenseDeleteDialog } from "@/components/expenses/expense-delete-dialog";
import { ExpenseFormModal } from "@/components/expenses/expense-form-modal";
import { ExpenseTableToolbar } from "@/components/expenses/expense-table-toolbar";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ExpenseListParams, ExpenseRow } from "@/lib/expenses/expense-queries";
import { formatVnd } from "@/lib/format";
import { docSoTrang } from "@/lib/pagination";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

/** Route "Xem log" cho dòng ADS_API — mục Kết nối màn Cài đặt (SyncLog, phase 6). */
const ADS_LOG_HREF = "/cai-dat#ket-noi";

const ADS_SOURCE_LABEL: Record<string, string> = {
  META: "Meta",
  TIKTOK_ADS: "TikTok Ads",
  SHOPEE_ADS: "Shopee Ads",
};

const VALID_SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"] as const;

function isValidSort(v: string | null): v is ExpenseListParams["sort"] {
  return (VALID_SORTS as readonly string[]).includes(v ?? "");
}

function sourceBadge(source: string) {
  switch (source) {
    case "ADS_API":
      return <Badge className="bg-surface-cream-strong text-ink">Ads API</Badge>;
    case "RECURRING":
      return <Badge variant="outline">Định kỳ</Badge>;
    case "IMPORT":
      return <Badge variant="outline">Import</Badge>;
    default:
      return null; // MANUAL — trống theo brief
  }
}

function categoryLabelFor(row: ExpenseRow): string {
  if (row.categoryId === "ads" && row.adsSource) {
    return `${row.categoryName} · ${ADS_SOURCE_LABEL[row.adsSource] ?? row.adsSource}`;
  }
  return row.categoryName;
}

/**
 * `ExpenseTable` = filter hiện tại đọc thẳng từ URL (nguồn chuẩn duy nhất,
 * cùng cơ chế `ExpenseTableToolbar`/chart legend) — không cần props filter
 * từ RSC vì mọi client component ở trang này đều đọc chung `useSearchParams`.
 * "Không tìm thấy khoản chi phù hợp" dùng `hasAnyFilter` tính riêng ở đây
 * (trùng logic nhỏ với toolbar — chấp nhận vì 2 component độc lập qua URL,
 * giống cách `expense-structure-chart.tsx` cũng tự đọc `danh_muc`).
 */
type ExpenseTableProps = {
  rows: ExpenseRow[];
  count: number;
  totalAmount: number;
  categories: { id: string; name: string }[];
  channels: { id: string; name: string; color: string }[];
};

export function ExpenseTable({ rows, count, totalAmount, categories, channels }: ExpenseTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [editingRow, setEditingRow] = useState<ExpenseRow | null>(null);
  const [deletingRow, setDeletingRow] = useState<ExpenseRow | null>(null);

  const rawSort = searchParams.get("sap_xep");
  const sort: ExpenseListParams["sort"] = isValidSort(rawSort) ? rawSort : "date_desc";
  const page = docSoTrang(searchParams.get("trang"));

  const hasAnyFilter = Boolean(
    searchParams.get("q") || searchParams.get("danh_muc") || searchParams.get("kenh") || searchParams.get("nguon"),
  );

  function setSort(next: ExpenseListParams["sort"]) {
    const params = new URLSearchParams(searchParams);
    if (next === "date_desc") params.delete("sap_xep");
    else params.set("sap_xep", next);
    params.delete("trang");
    router.replace(`${pathname}?${params.toString()}`);
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams);
    for (const key of ["q", "danh_muc", "kenh", "nguon", "trang"]) params.delete(key);
    router.replace(`${pathname}?${params.toString()}`);
  }

  function pageHref(nextPage: number): string {
    const params = new URLSearchParams(searchParams);
    params.set("trang", String(nextPage));
    return `${pathname}?${params.toString()}`;
  }

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  // Gọi như hàm thường (`{renderX()}`) — KHÔNG dùng thẻ JSX `<RenderX />` —
  // khai báo bên trong thân component nên nếu dùng dạng thẻ, React sẽ coi
  // mỗi lần re-render là 1 component type mới và unmount/remount subtree.
  function renderDateSortHead() {
    const active = sort === "date_desc" || sort === "date_asc";
    return (
      <button
        type="button"
        onClick={() => setSort(sort === "date_desc" ? "date_asc" : "date_desc")}
        className="flex items-center gap-1 hover:text-ink"
      >
        Ngày
        {active ? (
          sort === "date_desc" ? (
            <ArrowDown className="size-3.5" />
          ) : (
            <ArrowUp className="size-3.5" />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 opacity-40" />
        )}
      </button>
    );
  }

  function renderAmountSortHead() {
    const active = sort === "amount_desc" || sort === "amount_asc";
    return (
      <button
        type="button"
        onClick={() => setSort(sort === "amount_desc" ? "amount_asc" : "amount_desc")}
        className="flex w-full items-center justify-end gap-1 hover:text-ink"
      >
        Số tiền
        {active ? (
          sort === "amount_desc" ? (
            <ArrowDown className="size-3.5" />
          ) : (
            <ArrowUp className="size-3.5" />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 opacity-40" />
        )}
      </button>
    );
  }

  function renderRowActions(row: ExpenseRow) {
    if (row.source === "ADS_API") {
      return (
        <div className="flex items-center justify-end gap-3">
          <Link href={ADS_LOG_HREF} className="text-sm text-primary hover:underline">
            Xem log
          </Link>
          <button
            type="button"
            disabled
            title="Số ads tự về mỗi đêm từ Meta/TikTok — không xóa tay"
            className="cursor-not-allowed text-muted-foreground opacity-50"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          aria-label="Sửa"
          onClick={() => setEditingRow(row)}
          className="text-muted-foreground hover:text-ink"
        >
          <Pencil className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Xóa"
          onClick={() => setDeletingRow(row)}
          className="text-muted-foreground hover:text-error"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ExpenseTableToolbar categories={categories} channels={channels} />

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-hairline bg-canvas px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">Không tìm thấy khoản chi phù hợp</p>
          {hasAnyFilter && (
            <button type="button" onClick={clearFilters} className="text-sm text-primary hover:underline">
              Xóa lọc
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-hairline">
          {/* Desktop: bảng */}
          <Table className="hidden md:table">
            <TableHeader>
              <TableRow>
                <TableHead>{renderDateSortHead()}</TableHead>
                <TableHead>Danh mục</TableHead>
                <TableHead>Mô tả</TableHead>
                <TableHead>Kênh</TableHead>
                <TableHead className="text-right">{renderAmountSortHead()}</TableHead>
                <TableHead>Nguồn</TableHead>
                <TableHead className="text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-sm">{format(row.date, "dd/MM/yyyy")}</TableCell>
                  <TableCell>
                    <Badge
                      variant={row.categoryIsHidden ? "outline" : "secondary"}
                      className={cn(row.categoryIsHidden && "text-muted-foreground")}
                    >
                      {categoryLabelFor(row)}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate" title={row.description}>
                    {row.description || "—"}
                  </TableCell>
                  <TableCell>
                    {row.channelName ? (
                      <span className="flex items-center gap-1.5 text-sm">
                        <span className="size-2 rounded-full" style={{ backgroundColor: row.channelColor ?? undefined }} />
                        {row.channelName}
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm">{formatVnd(row.amount)}</TableCell>
                  <TableCell>{sourceBadge(row.source)}</TableCell>
                  <TableCell>{renderRowActions(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Mobile: card dọc */}
          <div className="flex flex-col gap-2 p-3 md:hidden">
            {rows.map((row) => (
              <div key={row.id} className="flex flex-col gap-1.5 rounded-lg border border-hairline p-3">
                <div className="flex items-center justify-between">
                  <Badge
                    variant={row.categoryIsHidden ? "outline" : "secondary"}
                    className={cn(row.categoryIsHidden && "text-muted-foreground")}
                  >
                    {categoryLabelFor(row)}
                  </Badge>
                  <span className="text-sm font-medium text-ink">{formatVnd(row.amount)}</span>
                </div>
                <p className="text-sm text-ink">{row.description || "—"}</p>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{format(row.date, "dd/MM/yyyy")}</span>
                  <span className="flex items-center gap-1.5">
                    {row.channelName && (
                      <span className="size-2 rounded-full" style={{ backgroundColor: row.channelColor ?? undefined }} />
                    )}
                    {row.channelName ?? "Không gắn kênh"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  {sourceBadge(row.source) ?? <span />}
                  {renderRowActions(row)}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 border-t border-hairline px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              Tổng: {count} khoản — {formatVnd(totalAmount)}
            </span>
            <div className="flex items-center gap-1">
              <Link
                href={pageHref(Math.max(1, page - 1))}
                aria-disabled={page <= 1}
                className={cn("rounded-md px-2 py-1 hover:bg-surface-soft", page <= 1 && "pointer-events-none opacity-40")}
              >
                ‹ Trước
              </Link>
              <Link
                href={pageHref(Math.min(totalPages, page + 1))}
                aria-disabled={page >= totalPages}
                className={cn(
                  "rounded-md px-2 py-1 hover:bg-surface-soft",
                  page >= totalPages && "pointer-events-none opacity-40",
                )}
              >
                Sau ›
              </Link>
            </div>
          </div>
        </div>
      )}

      <ExpenseFormModal
        open={Boolean(editingRow)}
        onOpenChange={(o) => !o && setEditingRow(null)}
        categories={categories}
        channels={channels}
        expense={editingRow ?? undefined}
      />
      <ExpenseDeleteDialog
        open={Boolean(deletingRow)}
        onOpenChange={(o) => !o && setDeletingRow(null)}
        expense={deletingRow}
      />
    </div>
  );
}
