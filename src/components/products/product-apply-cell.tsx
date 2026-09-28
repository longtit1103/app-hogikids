"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/actions/action-result";
import { cn } from "@/lib/utils";

type ProductApplyCellProps = {
  /** Giá trị chung của mẫu (khi mọi biến thể bằng nhau). null = trống/mặc định. */
  value: number | null;
  /** Biến thể LỆCH nhau → hiển thị mixedLabel (khác hẳn null=trống/mặc định). */
  isMixed?: boolean;
  placeholder: string;
  /** Nhãn khi biến thể lệch giá (vd "Nhiều mức"). */
  mixedLabel: string;
  formatDisplay: (value: number) => string;
  parseInput: (raw: string) => number | null | undefined;
  /** Thông điệp confirm trước khi áp (vd "Ghi đè 3 biến thể có giá khác?"); null = áp thẳng. */
  getConfirmMessage?: (next: number | null) => string | null;
  onApply: (value: number | null) => Promise<ActionResult<unknown>>;
  warn?: boolean;
  warnTooltip?: string;
  testId?: string;
};

/**
 * Ô sửa inline CẤP SẢN PHẨM — áp giá trị cho tất cả biến thể của mẫu. Giống InlineMoneyCell nhưng
 * thêm bước confirm khi ghi đè biến thể đang có giá khác (không toast khi user hủy confirm).
 */
export function ProductApplyCell({
  value,
  isMixed,
  placeholder,
  mixedLabel,
  formatDisplay,
  parseInput,
  getConfirmMessage,
  onApply,
  warn,
  warnTooltip,
  testId,
}: ProductApplyCellProps) {
  const [display, setDisplay] = useState<number | null>(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // Sau khi user áp 1 giá trị, mọi biến thể thành đồng nhất → không còn "nhiều mức".
  const [touched, setTouched] = useState(false);

  // Đồng bộ khi prop đổi từ ngoài (sau revalidate) — không đè lúc đang sửa/lưu.
  useEffect(() => {
    if (!editing && !saving) {
      setDisplay(value);
      setTouched(false);
    }
  }, [value, isMixed, editing, saving]);

  const showMixed = isMixed && !touched;

  function startEdit() {
    setDraft(!showMixed && display !== null ? String(display) : "");
    setEditing(true);
  }

  async function commit() {
    const parsed = parseInput(draft);
    setEditing(false);
    if (parsed === undefined) return; // không hợp lệ → revert
    // Không đổi (và không ở trạng thái "nhiều mức" cần đồng bộ lại) → bỏ qua, khỏi ghi + revalidate thừa.
    if (!showMixed && parsed === display) return;

    const confirmMsg = getConfirmMessage?.(parsed);
    if (confirmMsg && !window.confirm(confirmMsg)) return; // user hủy → revert, không toast

    const prev = display;
    setDisplay(parsed);
    setTouched(true);
    setSaving(true);
    try {
      const res = await onApply(parsed);
      if (!res.ok) {
        setDisplay(prev);
        toast.error(res.error);
      }
    } catch {
      setDisplay(prev);
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <Input
        autoFocus
        data-testid={testId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        placeholder={placeholder}
        className="h-8 w-32 text-right"
      />
    );
  }

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={startEdit}
      disabled={saving}
      title={warn ? warnTooltip : undefined}
      className={cn(
        "inline-flex h-8 min-w-24 items-center justify-end rounded-md border px-2 text-sm text-ink",
        "border-hairline bg-canvas hover:border-primary/60 hover:bg-surface-soft",
        warn && "border-warning bg-warning/10 text-ink",
        saving && "opacity-60",
      )}
    >
      {saving ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : showMixed ? (
        <span className="text-muted-foreground">{mixedLabel}</span>
      ) : display !== null ? (
        formatDisplay(display)
      ) : (
        <span className={cn(warn ? "text-ink" : "text-muted-foreground")}>{placeholder}</span>
      )}
    </button>
  );
}
