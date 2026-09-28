"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { importAdsExpenses, previewAdsImport } from "@/lib/actions/ads-import";
import { formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Preset = "META" | "TIKTOK";
type Channel = { id: string; name: string; color: string };
type PreviewData = {
  rows: { date: string; campaignName: string; amount: number }[];
  invalid: { line: number; reason: string }[];
  apiConflicts: { date: string; adsSource: string; apiAmount: number }[];
};

const PRESET_META: { value: Preset; label: string; desc: string; channel: string }[] = [
  { value: "META", label: "Meta Ads", desc: "Facebook / Instagram", channel: "facebook" },
  { value: "TIKTOK", label: "TikTok Ads", desc: "TikTok ad-account", channel: "tiktok" },
];

type Step = 1 | 2 | 3;

export type AdsImportModalProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channels: Channel[];
};

/**
 * Modal 3 bước import CSV ads (nút "Import CSV ads" ở `/chi-phi`):
 *  1. chọn nguồn Meta/TikTok + chọn file .csv/.xlsx (file hỏng → banner);
 *  2. preview 10 dòng đầu + Kênh (mặc định theo nguồn) + dòng lỗi + KHỐI CẢNH
 *     BÁO AMBER khi có ngày đã có số ADS_API (radio bỏ qua / ghi đè);
 *  3. xác nhận "Import N dòng" → `importAdsExpenses` → toast.
 */
export function AdsImportModal({ open, onOpenChange, channels }: AdsImportModalProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [channelId, setChannelId] = useState("");
  const [conflictMode, setConflictMode] = useState<"skip" | "overwrite">("skip");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [importing, setImporting] = useState(false);

  function reset() {
    setStep(1);
    setPreset(null);
    setFile(null);
    setFileError(null);
    setPreview(null);
    setChannelId("");
    setConflictMode("skip");
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) reset();
  }

  const conflictDays = useMemo(
    () => new Set((preview?.apiConflicts ?? []).map((c) => c.date)),
    [preview],
  );

  // Ước lượng số dòng sẽ import theo lựa chọn xung đột (số THẬT do action trả về ở toast).
  const estimatedImport = useMemo(() => {
    if (!preview) return 0;
    if (conflictMode === "overwrite") return preview.rows.length;
    return preview.rows.filter((r) => !conflictDays.has(r.date)).length;
  }, [preview, conflictMode, conflictDays]);

  async function handleFile(nextPreset: Preset, f: File) {
    if (!/\.(csv|xlsx)$/i.test(f.name)) {
      setPreset(nextPreset);
      setFile(null);
      setFileError("Không đọc được file — cần CSV/XLSX xuất từ Ads Manager");
      return;
    }
    const defaultChannel = PRESET_META.find((p) => p.value === nextPreset)?.channel ?? "";
    setPreset(nextPreset);
    setFile(f);
    setFileError(null);
    setChannelId(defaultChannel);

    setLoadingPreview(true);
    const fd = new FormData();
    fd.set("file", f);
    fd.set("preset", nextPreset);
    fd.set("channelId", defaultChannel);
    // `finally` tắt spinner cả khi lời gọi NÉM (mất mạng, server action lỗi): thiếu nó thì modal
    // kẹt ở "đang đọc file" mãi mãi và không có cách nào thử lại ngoài đóng modal.
    let res;
    try {
      res = await previewAdsImport(fd);
    } catch {
      setFileError("Không đọc được file — thử lại, hoặc kiểm tra kết nối");
      return;
    } finally {
      setLoadingPreview(false);
    }

    if (!res.ok) {
      setFileError(res.error ?? "Không đọc được file — cần CSV/XLSX xuất từ Ads Manager");
      return;
    }
    if (res.data.rows.length === 0) {
      setFileError("File không có dòng ads hợp lệ nào");
      return;
    }
    setPreview(res.data);
    setStep(2);
  }

  async function doImport() {
    if (!file || !preset) return;
    setImporting(true);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("preset", preset);
    fd.set("channelId", channelId);
    fd.set("conflictMode", conflictMode);
    let res;
    try {
      res = await importAdsExpenses(fd);
    } catch {
      toast.error("Import thất bại — thử lại, hoặc kiểm tra kết nối");
      return;
    } finally {
      setImporting(false);
    }

    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(
      `Đã import ${res.data.imported} khoản chi phí ads, bỏ qua ${res.data.skippedDuplicates} dòng trùng`,
    );
    handleOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import CSV ads — Bước {step}/3</DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {PRESET_META.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => {
                    setPreset(p.value);
                    setFileError(null);
                  }}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition",
                    preset === p.value ? "border-primary bg-surface-cream-strong" : "border-hairline hover:border-primary",
                  )}
                >
                  <span className="text-sm font-medium text-ink">{p.label}</span>
                  <span className="text-xs text-muted-foreground">{p.desc}</span>
                </button>
              ))}
            </div>

            <label
              className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center text-sm",
                preset
                  ? "cursor-pointer border-hairline bg-surface-soft text-muted-foreground hover:border-primary"
                  : "cursor-not-allowed border-hairline/60 bg-surface-soft/50 text-muted-foreground/50",
              )}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!preset) return;
                const f = e.dataTransfer.files?.[0];
                if (f) void handleFile(preset, f);
              }}
            >
              <span>
                {preset ? "Kéo-thả file .csv/.xlsx vào đây, hoặc bấm để chọn" : "Chọn nguồn ads ở trên trước"}
              </span>
              <input
                type="file"
                accept=".csv,.xlsx"
                className="hidden"
                disabled={!preset}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // Xoá value NGAY sau khi lấy file: trình duyệt không bắn `change` khi chọn lại
                  // ĐÚNG file cũ, nên sau một lần lỗi thì lời nhắn "thử lại" thành vô nghĩa —
                  // chủ shop bấm mà không có gì xảy ra.
                  e.target.value = "";
                  if (f && preset) void handleFile(preset, f);
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
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Kênh</label>
              <Select value={channelId} onValueChange={(v) => setChannelId(v ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Chọn kênh" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-hairline">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Chiến dịch</TableHead>
                    <TableHead className="text-right">Số tiền</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.slice(0, 10).map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{r.date}</TableCell>
                      <TableCell className="max-w-[280px] truncate text-sm" title={r.campaignName}>
                        {r.campaignName || "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm">{formatVnd(r.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              {preview.rows.length} dòng hợp lệ
              {preview.rows.length > 10 ? " (hiện 10 dòng đầu)" : ""}
            </p>

            {preview.invalid.length > 0 && (
              <div className="rounded-lg border border-error/40 bg-error/5 p-3 text-sm text-error">
                <p className="font-medium">{preview.invalid.length} dòng lỗi (bỏ qua):</p>
                <ul className="mt-1 list-inside list-disc">
                  {preview.invalid.slice(0, 5).map((e, i) => (
                    <li key={i}>
                      Dòng {e.line}: {e.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.apiConflicts.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
                <p className="font-medium text-warning">
                  ⚠ {preview.apiConflicts.length} ngày đã có số ads tự động từ API
                </p>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="conflict"
                    checked={conflictMode === "skip"}
                    onChange={() => setConflictMode("skip")}
                    className="mt-1"
                  />
                  <span className="text-ink">Bỏ qua các ngày đó (khuyên dùng)</span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="conflict"
                    checked={conflictMode === "overwrite"}
                    onChange={() => setConflictMode("overwrite")}
                    className="mt-1"
                  />
                  <span className="text-ink">Ghi đè số API bằng file</span>
                </label>
                <p className="text-xs text-muted-foreground">
                  Nếu kết nối API còn chạy, số API sẽ quay lại vào đêm sau.
                </p>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                Quay lại
              </Button>
              <Button type="button" disabled={!channelId} onClick={() => setStep(3)}>
                Tiếp tục
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 3 && preview && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink">
              Sẽ import <span className="font-medium">{estimatedImport}</span> dòng chi phí ads vào kênh{" "}
              <span className="font-medium">{channels.find((c) => c.id === channelId)?.name ?? channelId}</span>.
            </p>
            {conflictMode === "skip" && preview.apiConflicts.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Bỏ qua {preview.apiConflicts.length} ngày đã có số API.
              </p>
            )}
            {conflictMode === "overwrite" && preview.apiConflicts.length > 0 && (
              <p className="text-xs text-warning">
                Ghi đè {preview.apiConflicts.length} ngày số API — dòng API cũ sẽ bị xoá.
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep(2)}>
                Quay lại
              </Button>
              <Button type="button" disabled={importing} onClick={doImport}>
                {importing ? "Đang import…" : `Import ${estimatedImport} dòng`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
