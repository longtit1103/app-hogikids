"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { importShopeeWallet, previewShopeeWalletImport } from "@/lib/actions/shopee-wallet-import";
import { formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Summary = { totalIn: number; totalOut: number; countIn: number; countOut: number };
type Preview = {
  summary: Summary | null;
  computed: Summary;
  checksumOk: boolean;
  checksumDetail: string | null;
  rowCount: number;
  invalid: { line: number; reason: string }[];
  warnings: string[];
};

export type ShopeeImportModalProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
};

/**
 * Modal 2 bước import file ví Shopee ("Tiền đã về"):
 *  1. chọn file .xlsx ví (Transaction Report);
 *  2. preview: tổng tiền vào/ra + TRẠNG THÁI 3 CỔNG CHẶN (còn dòng lỗi / lệch block
 *     "Tóm tắt" / trùng khoá) + dòng lỗi. Import CHỈ bật khi qua cả 3 — `preview.checksumOk`
 *     là cờ TỔNG chứ không riêng checksum (cổng chặn thật nằm ở server action).
 */
export function ShopeeImportModal({ open, onOpenChange }: ShopeeImportModalProps) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [importing, setImporting] = useState(false);

  function reset() {
    setStep(1);
    setFile(null);
    setFileError(null);
    setPreview(null);
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) reset();
  }

  async function handleFile(f: File) {
    if (!/\.xlsx$/i.test(f.name)) {
      setFile(null);
      setFileError("Cần file .xlsx ví Shopee (Transaction Report / my_balance_transaction)");
      return;
    }
    setFile(f);
    setFileError(null);
    setLoadingPreview(true);
    try {
      const fd = new FormData();
      fd.set("file", f);
      const res = await previewShopeeWalletImport(fd);
      if (!res.ok) {
        setFileError(res.error ?? "Không đọc được file ví");
        return;
      }
      setPreview(res.data);
      setStep(2);
    } catch {
      setFileError("Không đọc được file ví — thử lại hoặc chọn file khác");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function doImport() {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await importShopeeWallet(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Nói THẬT theo từng ca: có dòng cứu từ lượt hỏng trước thì nói rõ; file nhập lại mà không
      // có gì mới thì nói "đã nhập trước đó" thay vì "Đã import 0 dòng" gây hoang mang.
      if (res.data.recovered > 0) {
        toast.success(
          `Đã import ${res.data.transformed} dòng ví — trong đó dựng lại ${res.data.recovered} dòng còn thiếu từ lượt trước`,
        );
      } else if (res.data.landed === 0 && res.data.rowCount > 0) {
        toast.success("File này đã được nhập trước đó — không có dòng mới, số liệu giữ nguyên");
      } else {
        toast.success(`Đã import ${res.data.transformed} dòng ví (${res.data.landed} dòng mới)`);
      }
      handleOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lỗi khi import file ví Shopee — thử lại");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import file ví Shopee — Bước {step}/2</DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Tải file ví <span className="font-medium text-ink">Transaction Report</span> từ Shopee (Số dư → Lịch sử
              giao dịch → Xuất). File nuôi &quot;Tiền đã về&quot; — KHÔNG đụng doanh thu/P&amp;L.
            </p>
            {/* Màn xuất của Shopee CÓ ô lọc theo loại giao dịch (chủ shop xác nhận 2026-08-13). Lọc bớt
                loại là file thiếu dòng, mà app KHÔNG chắc bắt được: cổng checksum chỉ so Σ dòng dữ liệu
                với block "Tóm tắt" của CHÍNH file đó — nếu Shopee tính lại Tóm tắt theo bộ lọc thì hai
                vế vẫn khớp và số "Tiền đã về" hụt trong im lặng. Nhắc ở đây là cách chặn rẻ và chắc
                nhất; KHÔNG đoán mò thêm cổng chặn khi chưa có file lọc thật để đo. */}
            <p className="rounded-lg border border-hairline bg-surface-soft p-3 text-sm text-body">
              ⚠️ Lúc xuất, để <span className="font-medium text-ink">Loại giao dịch = Tất cả</span>. Lọc bớt loại thì
              file thiếu dòng, &quot;Tiền đã về&quot; hụt theo mà app có thể không phát hiện được.
            </p>
            <label
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-hairline bg-surface-soft p-10 text-center text-sm text-muted-foreground hover:border-primary"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) void handleFile(f);
              }}
            >
              <span>Kéo-thả file .xlsx vào đây, hoặc bấm để chọn</span>
              <input
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
            </label>
            {loadingPreview && <p className="text-sm text-muted-foreground">Đang đọc file…</p>}
            {fileError && (
              <div className="rounded-lg border border-error/40 bg-error/5 p-3 text-sm text-error">{fileError}</div>
            )}
          </div>
        )}

        {step === 2 && preview && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-hairline p-3">
                <p className="text-xs text-muted-foreground">Tổng tiền vào ({preview.computed.countIn} gd)</p>
                <p className="mt-1 font-serif text-lg text-ink">{formatVnd(preview.computed.totalIn)}</p>
              </div>
              <div className="rounded-lg border border-hairline p-3">
                <p className="text-xs text-muted-foreground">Tổng tiền ra ({preview.computed.countOut} gd)</p>
                <p className="mt-1 font-serif text-lg text-ink">{formatVnd(preview.computed.totalOut)}</p>
              </div>
            </div>

            <div
              className={cn(
                "rounded-lg border p-3 text-sm",
                preview.checksumOk
                  ? "border-success/40 bg-success/5 text-ink"
                  : "border-error/40 bg-error/5 text-error",
              )}
            >
              {preview.checksumOk ? (
                <p>✓ Checksum khớp block &quot;Tóm tắt&quot; — {preview.rowCount} dòng sẵn sàng import.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  <p className="font-medium">✗ Chưa import được (tránh thiếu/lệch số).</p>
                  {preview.checksumDetail && <p className="text-xs">{preview.checksumDetail}</p>}
                </div>
              )}
            </div>

            {preview.invalid.length > 0 && (
              <div className="rounded-lg border border-error/40 bg-error/5 p-3 text-sm text-error">
                <p className="font-medium">{preview.invalid.length} dòng lỗi:</p>
                <ul className="mt-1 list-inside list-disc">
                  {preview.invalid.slice(0, 5).map((e, i) => (
                    <li key={i}>
                      Dòng {e.line}: {e.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.warnings.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-muted-foreground">
                {preview.warnings.slice(0, 5).map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={reset}>
                Chọn file khác
              </Button>
              <Button type="button" disabled={importing || !preview.checksumOk} onClick={doImport}>
                {importing ? "Đang import…" : `Import ${preview.rowCount} dòng`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
