"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type LuaChonHoSo = { id: string; nhan: string };

/** Giá trị gác cho mục "không chọn hồ sơ" — Select không nhận `value=""` làm một mục chọn được. */
const KHONG_CHON = "__khong_chon__";

/**
 * Ô chọn HỒ SƠ NỢ cho dòng tiền nợ phải trả (thẻ / phiếu nhập / ví ads) trong form "Nhập quỹ / rút
 * quỹ". Danh sách đã lọc sẵn theo luật server (thẻ đóng, phiếu huỷ) ở form — ô này chỉ hiển thị.
 * Rỗng ⇒ nói thẳng lý do (`emptyMessage`) thay vì ô chọn trống không ai hiểu.
 */
export function HoSoNoSelect({
  label,
  placeholder,
  options,
  value,
  onChange,
  error,
  emptyMessage,
  mucKhongChon,
}: {
  label: string;
  placeholder: string;
  options: LuaChonHoSo[];
  value: string;
  onChange: (id: string) => void;
  error?: string;
  emptyMessage: string;
  /**
   * Ô TUỲ CHỌN (vd thẻ của "Nạp ví quảng cáo"): nhãn của mục đầu "không chọn hồ sơ" ⇒ `onChange("")`.
   * Có mục này thì bỏ chọn được sau khi đã chọn, và danh sách rỗng vẫn hiện ô (mục này là lựa chọn hợp lệ).
   */
  mucKhongChon?: string;
}) {
  const coMucKhong = mucKhongChon !== undefined;
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {options.length === 0 && !coMucKhong ? (
        <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">{emptyMessage}</p>
      ) : (
        <Select
          value={coMucKhong && value === "" ? KHONG_CHON : value}
          onValueChange={(v) => onChange(typeof v === "string" && v !== KHONG_CHON ? v : "")}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={coMucKhong ? mucKhongChon : placeholder} />
          </SelectTrigger>
          <SelectContent>
            {coMucKhong && <SelectItem value={KHONG_CHON}>{mucKhongChon}</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.nhan}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
