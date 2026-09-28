"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { updateChannels } from "@/lib/actions/settings-channels";
import { cn } from "@/lib/utils";
import { RecomputeFeesDialog } from "./recompute-fees-dialog";
import { useUnsavedGuard } from "./use-unsaved-guard";

const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;
const COLOR_PRESETS = [
  "#cc785c", "#141413", "#5db8a6", "#e8a55a",
  "#6a8fd8", "#b07fd0", "#4f9d69", "#d06b7f",
];

export type ChannelConfig = {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  platformFeePct: number;
  paymentFeePct: number;
};

/** State hàng bàn: pct là string để cho gõ dở ("3.", "10.5"), parse khi lưu. */
type Row = {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  platformFeePct: string;
  paymentFeePct: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function toRows(channels: ChannelConfig[]): Row[] {
  return channels.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    isActive: c.isActive,
    platformFeePct: String(c.platformFeePct),
    paymentFeePct: String(c.paymentFeePct),
  }));
}

/** Giữ chỉ số + tối đa 1 dấu chấm. */
function sanitizePct(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [head, ...rest] = cleaned.split(".");
  return rest.length ? `${head}.${rest.join("")}` : cleaned;
}

const GRID = "md:grid md:grid-cols-[1.4fr_5rem_1fr_1fr_3.5rem] md:items-center md:gap-4";

function ColorSwatch({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger
        className="size-7 rounded-full border border-hairline"
        style={{ backgroundColor: color }}
        aria-label="Chọn màu kênh"
      />
      <PopoverContent className="w-56">
        <div className="grid grid-cols-4 gap-2">
          {COLOR_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => onChange(preset)}
              className={cn(
                "size-8 rounded-full border transition-transform hover:scale-105",
                preset.toLowerCase() === color.toLowerCase()
                  ? "border-ring ring-2 ring-ring/40"
                  : "border-hairline",
              )}
              style={{ backgroundColor: preset }}
              aria-label={`Màu ${preset}`}
            />
          ))}
        </div>
        <Input
          value={color}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
            if (HEX_REGEX.test(v)) onChange(v.toLowerCase());
            else onChange(e.target.value); // cho gõ dở; chỉ lưu khi hợp lệ (server validate)
          }}
          className="font-mono text-xs"
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Section 2 "Kênh bán": 4 hàng cố định (bật/tắt, phí sàn %, phí thanh toán %,
 * màu). % chỉ áp cho kênh KHÔNG có phí sàn thật (Facebook/Website) — Shopee/
 * TikTok luôn dùng phí THẬT Pancake. Kênh bật cuối cùng khóa toggle (phải còn
 * ≥1 kênh hoạt động). Nút "Tính lại phí kỳ này" áp % mới cho đơn cũ (chỉ FB/Web).
 */
export function ChannelsSection({ channels }: { channels: ChannelConfig[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => toRows(channels));
  const [saved, setSaved] = useState<Row[]>(() => toRows(channels));
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  useUnsavedGuard(dirty);

  const activeCount = rows.filter((r) => r.isActive).length;

  function patch(id: string, next: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)));
  }

  async function handleSave() {
    const payload = rows.map((r) => ({
      id: r.id,
      isActive: r.isActive,
      platformFeePct: r.platformFeePct === "" ? 0 : Number(r.platformFeePct),
      paymentFeePct: r.paymentFeePct === "" ? 0 : Number(r.paymentFeePct),
      color: r.color,
    }));

    for (const p of payload) {
      const bad =
        Number.isNaN(p.platformFeePct) || Number.isNaN(p.paymentFeePct) ||
        p.platformFeePct < 0 || p.platformFeePct > 100 ||
        p.paymentFeePct < 0 || p.paymentFeePct > 100;
      if (bad) {
        toast.error("Phí phải trong khoảng 0–100%");
        return;
      }
      if (!HEX_REGEX.test(p.color)) {
        toast.error("Màu không hợp lệ");
        return;
      }
    }

    setSaving(true);
    try {
      const res = await updateChannels(payload);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Đồng bộ hiển thị với giá trị đã làm tròn server-side.
      const normalized: Row[] = payload.map((p) => ({
        id: p.id,
        name: rows.find((r) => r.id === p.id)!.name,
        color: p.color,
        isActive: p.isActive,
        platformFeePct: String(round2(p.platformFeePct)),
        paymentFeePct: String(round2(p.paymentFeePct)),
      }));
      setRows(normalized);
      setSaved(normalized);
      toast.success("Đã lưu cấu hình kênh");
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={cn("hidden px-3 text-xs text-muted-foreground", GRID)}>
        <span>Kênh</span>
        <span>Hoạt động</span>
        <span>Phí sàn %</span>
        <span>Phí thanh toán %</span>
        <span>Màu</span>
      </div>

      {rows.map((r) => {
        const lockToggle = r.isActive && activeCount === 1;
        return (
          <div
            key={r.id}
            className={cn(
              "flex flex-col gap-3 rounded-lg border border-hairline p-4",
              GRID,
              "md:rounded-none md:border-0 md:border-b md:border-hairline md:p-3",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
              <span className="text-sm text-ink">{r.name}</span>
            </div>

            <div className="flex items-center justify-between md:justify-start">
              <span className="text-xs text-muted-foreground md:hidden">Hoạt động</span>
              <span title={lockToggle ? "Phải có ít nhất 1 kênh hoạt động" : undefined}>
                <Switch
                  checked={r.isActive}
                  disabled={lockToggle}
                  onCheckedChange={(v) => patch(r.id, { isActive: v })}
                  aria-label={`Bật/tắt kênh ${r.name}`}
                />
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 md:block">
              <span className="text-xs text-muted-foreground md:hidden">Phí sàn %</span>
              <Input
                inputMode="decimal"
                value={r.platformFeePct}
                disabled={!r.isActive}
                onChange={(e) => patch(r.id, { platformFeePct: sanitizePct(e.target.value) })}
                className="w-24 text-right md:w-full"
              />
            </div>

            <div className="flex items-center justify-between gap-2 md:block">
              <span className="text-xs text-muted-foreground md:hidden">Phí thanh toán %</span>
              <Input
                inputMode="decimal"
                value={r.paymentFeePct}
                disabled={!r.isActive}
                onChange={(e) => patch(r.id, { paymentFeePct: sanitizePct(e.target.value) })}
                className="w-24 text-right md:w-full"
              />
            </div>

            <div className="flex items-center justify-between md:justify-start">
              <span className="text-xs text-muted-foreground md:hidden">Màu</span>
              <ColorSwatch color={r.color} onChange={(c) => patch(r.id, { color: c })} />
            </div>
          </div>
        );
      })}

      <p className="text-xs text-muted-foreground">
        % chỉ dùng cho kênh KHÔNG có phí sàn thật (Facebook, Website). Shopee/TikTok lấy phí THẬT từ
        Pancake mỗi lần đồng bộ — đổi % không ảnh hưởng đơn của 2 kênh này. Phí sàn không ghi vào sổ
        chi phí.
      </p>

      <div className="flex flex-wrap justify-end gap-2">
        <RecomputeFeesDialog />
        <Button type="button" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? "Đang lưu…" : "Lưu cấu hình"}
        </Button>
      </div>
    </div>
  );
}
