"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { importCostPrices, previewCostImport, type CostDiff } from "@/lib/actions/cost-price";
import {
  autoDetectCostColumns,
  normalizeCostRows,
  parseCostWorkbook,
  type CostImportRow,
} from "@/lib/import/cost-excel";
import { formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const NONE = "__none__"; // sentinel: Select không nhận value=""

type Step = 1 | 2 | 3;

export function CostImportModal() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const open = searchParams.get("import") === "1";

  const [step, setStep] = useState<Step>(1);
  const [fileError, setFileError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string | number>[]>([]);
  const [skuCol, setSkuCol] = useState<string | undefined>();
  const [costCol, setCostCol] = useState<string | undefined>();
  const [thresholdCol, setThresholdCol] = useState<string | undefined>();
  const [diffs, setDiffs] = useState<CostDiff[] | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);

  const normalized = useMemo(() => {
    if (!skuCol || !costCol) return null;
    return normalizeCostRows(rawRows, { sku: skuCol, costPrice: costCol, lowStockThreshold: thresholdCol ?? null });
  }, [rawRows, skuCol, costCol, thresholdCol]);

  function reset() {
    setStep(1);
    setFileError(null);
    setHeaders([]);
    setRawRows([]);
    setSkuCol(undefined);
    setCostCol(undefined);
    setThresholdCol(undefined);
    setDiffs(null);
  }

  function setOpen(next: boolean) {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("import", "1");
    else params.delete("import");
    router.replace(params.size ? `${pathname}?${params.toString()}` : pathname);
    if (!next) reset();
  }

  async function handleFile(file: File) {
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      setFileError("Chỉ nhận file .xlsx hoặc .csv");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError("File quá lớn (tối đa 10MB)");
      return;
    }
    setFileError(null);
    const buf = await file.arrayBuffer();
    const parsed = parseCostWorkbook(buf);
    const detected = autoDetectCostColumns(parsed.headers);
    setHeaders(parsed.headers);
    setRawRows(parsed.rows);
    setSkuCol(detected.sku);
    setCostCol(detected.costPrice);
    setThresholdCol(detected.lowStockThreshold ?? undefined);
    setStep(2);
  }

  async function goToPreview() {
    if (!normalized || normalized.valid.length === 0) return;
    setLoadingPreview(true);
    const res = await previewCostImport(normalized.valid);
    setLoadingPreview(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setDiffs(res.data.diffs);
    setStep(3);
  }

  async function applyImport() {
    if (!normalized || !diffs) return;
    const notFoundSkus = new Set(diffs.filter((d) => d.status === "NOT_FOUND").map((d) => d.sku));
    const applicable = normalized.valid.filter((r) => !notFoundSkus.has(r.sku));
    if (applicable.length === 0) return;

    setApplying(true);
    const res = await importCostPrices(applicable);
    setApplying(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`Đã cập nhật giá vốn ${res.data.updatedVariants} biến thể`, {
      description: res.data.multiSkus.length
        ? `${res.data.multiSkus.length} SKU trùng nhiều biến thể đã áp cho tất cả`
        : undefined,
    });
    setOpen(false);
    router.refresh();
  }

  const updatedCount = diffs?.filter((d) => d.status !== "NOT_FOUND").reduce((s, d) => s + d.matchedVariants, 0) ?? 0;
  const multiCount = diffs?.filter((d) => d.status === "MULTI").length ?? 0;
  const notFoundCount = diffs?.filter((d) => d.status === "NOT_FOUND").length ?? 0;

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Import giá vốn Excel
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import giá vốn — Bước {step}/3</DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <label
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-hairline bg-surface-soft p-10 text-center text-sm text-muted-foreground hover:border-primary"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) void handleFile(file);
              }}
            >
              <span>Kéo-thả file .xlsx/.csv vào đây, hoặc bấm để chọn</span>
              <input
                type="file"
                accept=".xlsx,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </label>
            {fileError && <p className="text-sm text-error">{fileError}</p>}
            <a href="/api/export/gia-von" className="text-sm text-primary hover:underline">
              Tải file mẫu (kèm SKU hiện có)
            </a>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ColumnPicker label="SKU *" headers={headers} value={skuCol} onChange={setSkuCol} />
              <ColumnPicker label="Giá vốn *" headers={headers} value={costCol} onChange={setCostCol} />
              <ColumnPicker
                label="Ngưỡng (tùy chọn)"
                headers={headers}
                value={thresholdCol}
                onChange={setThresholdCol}
                allowNone
              />
            </div>

            {normalized && normalized.errors.length > 0 && (
              <div className="rounded-lg border border-error/40 bg-error/5 p-3 text-sm text-error">
                <p className="font-medium">{normalized.errors.length} dòng lỗi:</p>
                <ul className="mt-1 list-inside list-disc">
                  {normalized.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>
                      Dòng {e.rowIndex}: {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {normalized && normalized.duplicateSkus.length > 0 && (
              <p className="text-sm text-warning">
                ⚠ {normalized.duplicateSkus.length} SKU lặp trong file — giữ dòng cuối: {normalized.duplicateSkus.join(", ")}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                Quay lại
              </Button>
              <Button
                type="button"
                disabled={!skuCol || !costCol || loadingPreview}
                onClick={goToPreview}
              >
                {loadingPreview ? "Đang tải…" : "Tiếp tục"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 3 && diffs && (
          <div className="flex flex-col gap-4">
            <div className="max-h-96 overflow-y-auto rounded-lg border border-hairline">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Giá vốn</TableHead>
                    <TableHead>Ngưỡng</TableHead>
                    <TableHead>Ghi chú</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diffs.map((d) => {
                    const unchanged = d.oldCost === d.newCost && d.oldThreshold === d.newThreshold;
                    return (
                      <TableRow key={d.sku} className={cn(unchanged && "opacity-50")}>
                        <TableCell className="font-mono text-sm">{d.sku}</TableCell>
                        <TableCell className="text-sm">
                          {formatVnd(d.oldCost)} → {formatVnd(d.newCost)}
                        </TableCell>
                        <TableCell className="text-sm">
                          {d.newThreshold === null
                            ? "giữ nguyên"
                            : `${d.oldThreshold ?? "—"} → ${d.newThreshold}`}
                        </TableCell>
                        <TableCell>
                          {d.status === "MULTI" && (
                            <Badge className="bg-warning/15 text-warning">
                              áp cho {d.matchedVariants} biến thể
                            </Badge>
                          )}
                          {d.status === "NOT_FOUND" && (
                            <Badge className="bg-error/15 text-error">Không có trong hệ thống</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <p className="text-sm text-muted-foreground">
              Cập nhật {updatedCount} biến thể · {multiCount} SKU trùng nhiều biến thể · {notFoundCount} SKU không tìm
              thấy
            </p>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep(2)}>
                Quay lại
              </Button>
              <Button type="button" disabled={updatedCount === 0 || applying} onClick={applyImport}>
                {applying ? "Đang áp…" : "Áp giá vốn"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
      </Dialog>
    </>
  );
}

function ColumnPicker({
  label,
  headers,
  value,
  onChange,
  allowNone,
}: {
  label: string;
  headers: string[];
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  allowNone?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(!v || v === NONE ? undefined : v)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Chọn cột…" />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>(không dùng)</SelectItem>}
          {headers.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
