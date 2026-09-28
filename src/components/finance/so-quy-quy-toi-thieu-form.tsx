"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { datQuyToiThieu } from "@/lib/actions/so-quy-quy-toi-thieu";
import { formatVnd } from "@/lib/format";
import { formatAmountInput, parseSignedAmountInput } from "@/lib/format-amount-input";

/**
 * Ô "Quỹ tối thiểu" của khối dự báo — hiện ngưỡng đang dùng (đọc từ Setting qua `docDuBaoQuy`), bấm
 * "Sửa" để nhập số mới rồi gọi `datQuyToiThieu`.
 *
 * Ô CHO GÕ DẤU TRỪ (cùng khuôn `hienBank` của form Chốt số dư cuối tháng) dù ngưỡng không có nghĩa
 * âm trong thực tế: cổng thật nằm ở action (zod `soTien >= 0`, field `soTien`) — ô chặn câm dấu trừ ở
 * đây thì lỗi validate của server không bao giờ có đường vào UI để hiện, và request âm gõ nhầm (số dư
 * ngân hàng dán nhầm ô) sẽ bị nuốt thành số dương thay vì bị server từ chối rõ ràng.
 */

/** Hiện lại số trong ô: giữ dấu trừ đầu chuỗi nếu có — cùng khuôn `hienBank`. */
function hienNguong(raw: string): string {
  const dau = /^\s*[-−]/.test(raw) ? "-" : "";
  const so = Math.abs(parseSignedAmountInput(raw));
  // `formatAmountInput(0)` trả "" ⇒ gõ "0" là ô tự xoá trắng, và cổng "ô rỗng" ở `handleSave` chặn luôn
  // ⇒ không còn đường nào đặt ngưỡng về 0 qua UI. Ô CÓ chữ số mà giá trị 0 thì giữ "0".
  if (so === 0) return /\d/.test(raw) ? "0" : dau;
  return dau + formatAmountInput(so);
}

export function SoQuyQuyToiThieuForm({ nguong, nguongDaDat }: { nguong: number; nguongDaDat: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function moSua() {
    setRaw(nguongDaDat ? hienNguong(String(nguong)) : "");
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    // Ô rỗng hoặc chỉ gõ dấu trừ dở dang ("-", "−") không chứa CHỮ SỐ nào ⇒ `parseSignedAmountInput`
    // trả về 0, ghi đè ngưỡng thành 0 lặng lẽ. Chặn Ở ĐÂY trước khi gọi action — muốn đặt 0 thật thì
    // gõ "0" (`hienNguong` giữ nguyên ký tự đó nên `/\d/.test(raw)` đúng).
    if (!/\d/.test(raw)) {
      setError("Nhập số tiền quỹ tối thiểu");
      return;
    }
    const soTien = parseSignedAmountInput(raw);
    setError(null);
    setSaving(true);
    try {
      const res = await datQuyToiThieu({ soTien });
      if (!res.ok) {
        if (res.field === "soTien") setError(res.error);
        else toast.error(res.error);
        return;
      }
      toast.success("Đã đặt quỹ tối thiểu");
      setEditing(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          Quỹ tối thiểu:{" "}
          <span className="text-ink" data-testid="so-quy-quy-toi-thieu-hien-tai">
            {nguongDaDat ? formatVnd(nguong) : "chưa đặt — đang dùng 0 đ"}
          </span>
        </span>
        <Button type="button" variant="outline" size="sm" onClick={moSua} data-testid="so-quy-quy-toi-thieu-sua">
          Sửa
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          inputMode="numeric"
          autoFocus
          placeholder="0"
          value={raw}
          aria-label="Quỹ tối thiểu"
          aria-invalid={!!error}
          data-testid="so-quy-quy-toi-thieu-input"
          onChange={(e) => setRaw(hienNguong(e.target.value))}
        />
        <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
          {saving ? "Đang lưu…" : "Lưu"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)} disabled={saving}>
          Hủy
        </Button>
      </div>
      {error && (
        <p className="text-xs text-error" data-testid="so-quy-quy-toi-thieu-error">
          {error}
        </p>
      )}
    </div>
  );
}
