"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateDefaultLowStockThreshold } from "@/lib/actions/settings-low-stock";
import { useUnsavedGuard } from "./use-unsaved-guard";

const MIN = 0;
const MAX = 999;

/**
 * Section 4 "Ngưỡng cảnh báo tồn": áp cho SKU chưa có `lowStockThreshold`
 * riêng (Tồn kho cho ghi đè per-SKU). Lưu qua `updateDefaultLowStockThreshold`
 * → server `revalidatePath("/", "layout")` + `/ton-kho` nên badge "Sắp hết"
 * tính lại ngay, không cần F5.
 */
export function StockThresholdSection({ defaultLowStockThreshold }: { defaultLowStockThreshold: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(defaultLowStockThreshold));
  const [saved, setSaved] = useState(defaultLowStockThreshold);
  const [saving, setSaving] = useState(false);

  const parsed = value.trim() === "" ? NaN : Number(value);
  const isValid = Number.isInteger(parsed) && parsed >= MIN && parsed <= MAX;
  const dirty = value.trim() !== String(saved);
  useUnsavedGuard(dirty);

  async function handleSave() {
    if (!isValid) return;
    setSaving(true);
    try {
      const res = await updateDefaultLowStockThreshold(parsed);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã cập nhật ngưỡng cảnh báo tồn");
      setSaved(parsed);
      setValue(String(parsed));
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-w-[220px] flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="stock-threshold-input">
          Ngưỡng tồn tối thiểu
        </label>
        <Input
          id="stock-threshold-input"
          inputMode="numeric"
          value={value}
          aria-invalid={value.trim() !== "" && !isValid}
          onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
        />
        {value.trim() !== "" && !isValid && (
          <p className="text-xs text-error">Ngưỡng phải là số nguyên từ {MIN} đến {MAX}</p>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Biến thể có tồn ≤ ngưỡng sẽ hiện badge &quot;Sắp hết hàng&quot; ở Tồn kho &amp; Dashboard; tồn = 0
        hiện badge &quot;Hết hàng&quot;. Có thể ghi đè ngưỡng riêng cho từng SKU trong màn Tồn kho.
      </p>

      <div className="flex justify-end">
        <Button type="button" disabled={!dirty || !isValid || saving} onClick={handleSave}>
          {saving ? "Đang lưu…" : "Lưu ngưỡng"}
        </Button>
      </div>
    </div>
  );
}
