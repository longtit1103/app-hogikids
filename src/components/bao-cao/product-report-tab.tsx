"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { ProductReportRow, type GiaVonDongSanPham } from "@/components/bao-cao/product-report-row";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProductReport, ProductReportRowChe } from "@/lib/reports/product-report";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const ALL_CHANNELS = "__all__";

type SubTab = "ban_chay" | "cham_ban" | "lai_gop";
const SUB_TABS: { key: SubTab; label: string; canGiaVon?: true }[] = [
  { key: "ban_chay", label: "Bán chạy" },
  { key: "cham_ban", label: "Chậm bán" },
  { key: "lai_gop", label: "Lãi gộp theo SP", canGiaVon: true },
];

type Dong = { row: ProductReportRowChe; giaVon: GiaVonDongSanPham | null };

/** Narrow union MỘT lần — nhánh che không có COGS/lãi nào để tách. */
function ghepGiaVon(bang: ProductReport): Dong[] {
  if (!bang.coQuyenGiaVon) return bang.rows.map((row) => ({ row, giaVon: null }));
  return bang.rows.map((row) => ({
    row,
    giaVon: {
      cogs: row.cogs,
      grossProfit: row.grossProfit,
      marginPct: row.marginPct,
      skus: row.skus.map((s) => ({ cogs: s.cogs, grossProfit: s.grossProfit })),
    },
  }));
}

/** Thiếu quyền giá vốn: không cột COGS/LN gộp/Biên, không sub-tab "Lãi gộp theo SP" (dữ liệu che từ server). */
export function ProductReportTab({
  bang,
  channels,
  slowSellerMaxOrders,
}: {
  bang: ProductReport;
  channels: { id: string; name: string; color: string }[];
  slowSellerMaxOrders: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [subTab, setSubTab] = useState<SubTab>("ban_chay");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const coGiaVon = bang.coQuyenGiaVon;
  const dong = useMemo(() => ghepGiaVon(bang), [bang]);
  const subTabs = SUB_TABS.filter((t) => coGiaVon || !t.canGiaVon);
  const filterProductId = searchParams.get("sp") ?? undefined;
  const selectedChannel = searchParams.get("kenh") ?? undefined;

  // Debounce 300ms: chỉ lọc CLIENT (rows đã tải hết cho range toàn cục) —
  // không round-trip server cho mỗi phím gõ.
  useEffect(() => {
    const handle = setTimeout(() => setQ(qInput.trim().toLowerCase()), 300);
    return () => clearTimeout(handle);
  }, [qInput]);

  useEffect(() => {
    setPage(1);
  }, [subTab, q, filterProductId, dong]);

  function setUrlParam(key: string, value: string | undefined) {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    router.replace(`${pathname}?${params.toString()}`);
  }

  function toggleExpanded(productId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

  const filteredProductName = filterProductId
    ? dong.find((d) => d.row.productId === filterProductId)?.row.name
    : undefined;

  const baseRows = useMemo(() => {
    let list = dong;
    if (filterProductId) list = list.filter((d) => d.row.productId === filterProductId);
    if (q) {
      list = list.filter(
        (d) => d.row.name.toLowerCase().includes(q) || d.row.skus.some((s) => s.sku.toLowerCase().includes(q))
      );
    }
    return list;
  }, [dong, filterProductId, q]);

  const sortedRows = useMemo(() => {
    const list = [...baseRows];
    if (subTab === "cham_ban") {
      return list
        .filter((d) => d.row.orderCount <= slowSellerMaxOrders)
        .sort((a, b) => b.row.currentStock - a.row.currentStock);
    }
    if (subTab === "lai_gop" && coGiaVon) {
      return list.sort((a, b) => (b.giaVon?.grossProfit ?? 0) - (a.giaVon?.grossProfit ?? 0));
    }
    return list.sort((a, b) => b.row.revenue - a.row.revenue);
  }, [baseRows, subTab, slowSellerMaxOrders, coGiaVon]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const pageRows = sortedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {subTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSubTab(t.key)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm transition-colors",
              subTab === t.key
                ? "border-primary bg-surface-soft text-ink"
                : "border-hairline text-muted-foreground hover:bg-surface-soft"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Tìm tên SP hoặc SKU…"
          className="w-full max-w-xs"
        />
        <Select
          value={selectedChannel ?? ALL_CHANNELS}
          onValueChange={(v) => setUrlParam("kenh", !v || v === ALL_CHANNELS ? undefined : v)}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Tất cả kênh" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CHANNELS}>Tất cả kênh</SelectItem>
            {channels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filteredProductName && (
          <Badge variant="secondary" className="gap-1">
            Đang lọc: {filteredProductName}
            <button type="button" aria-label="Bỏ lọc sản phẩm" onClick={() => setUrlParam("sp", undefined)}>
              <X className="size-3" />
            </button>
          </Badge>
        )}
      </div>

      {pageRows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Không có sản phẩm phù hợp</p>
      ) : (
        <div className="rounded-xl border border-hairline">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sản phẩm</TableHead>
                <TableHead className="text-right">SL bán</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                {coGiaVon && <TableHead className="text-right">COGS</TableHead>}
                {coGiaVon && <TableHead className="text-right">LN gộp</TableHead>}
                {coGiaVon && <TableHead className="text-right">Biên %</TableHead>}
                <TableHead className="text-right">Tồn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map(({ row: r, giaVon }) => (
                <ProductReportRow
                  key={r.productId}
                  row={r}
                  giaVon={giaVon}
                  expanded={expanded.has(r.productId)}
                  onToggle={() => toggleExpanded(r.productId)}
                />
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between border-t border-hairline px-4 py-3 text-sm text-muted-foreground">
            <span>{sortedRows.length} sản phẩm</span>
            <div className="flex items-center gap-1 print:hidden">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-md px-2 py-1 hover:bg-surface-soft disabled:pointer-events-none disabled:opacity-40"
              >
                ‹ Trước
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="rounded-md px-2 py-1 hover:bg-surface-soft disabled:pointer-events-none disabled:opacity-40"
              >
                Sau ›
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
