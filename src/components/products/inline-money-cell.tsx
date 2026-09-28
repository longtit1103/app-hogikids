"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/actions/action-result";
import { cn } from "@/lib/utils";

type InlineMoneyCellProps = {
  value: number | null;
  placeholder?: string;
  formatDisplay: (value: number) => string;
  /** Chuỗi nhập → giá trị lưu. `undefined` = không hợp lệ (revert, không lưu). `null` = xoá về mặc định (nếu cột cho phép). */
  parseInput: (raw: string) => number | null | undefined;
  onSave: (value: number | null) => Promise<ActionResult>;
  warn?: boolean;
  warnTooltip?: string;
  testId?: string;
};

/** Ô tiền/số sửa inline: click → input, blur/Enter lưu (optimistic), Esc hủy. Dùng cho cột Giá vốn + Ngưỡng. */
export function InlineMoneyCell({
  value,
  placeholder,
  formatDisplay,
  parseInput,
  onSave,
  warn,
  warnTooltip,
  testId,
}: InlineMoneyCellProps) {
  const [display, setDisplay] = useState(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // Đồng bộ lại khi prop đổi từ bên ngoài (ví dụ sau import Excel) — không đè lúc đang sửa/lưu.
  useEffect(() => {
    if (!editing && !saving) setDisplay(value);
  }, [value, editing, saving]);

  function startEdit() {
    setDraft(display !== null ? String(display) : "");
    setEditing(true);
  }

  async function commit() {
    const parsed = parseInput(draft);
    setEditing(false);
    if (parsed === undefined || parsed === display) return; // không hợp lệ hoặc không đổi

    const prev = display;
    setDisplay(parsed);
    setSaving(true);
    try {
      const res = await onSave(parsed);
      if (!res.ok) {
        setDisplay(prev);
        toast.error(res.error);
      }
    } catch {
      // RPC reject (mất mạng/transport) — KHÔNG được kẹt spinner + hiển thị giá trị chưa lưu như đã lưu.
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
        className="h-8 w-28 text-right"
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
        "inline-flex h-8 min-w-20 items-center justify-end rounded-md border border-transparent px-2 text-sm text-ink hover:border-hairline hover:bg-surface-soft",
        warn && "border-warning/60 text-warning",
        saving && "opacity-60",
      )}
    >
      {saving ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : display !== null ? (
        formatDisplay(display)
      ) : (
        <span className="text-muted-foreground">{placeholder}</span>
      )}
    </button>
  );
}
