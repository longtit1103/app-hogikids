"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatVnd } from "@/lib/format";

/** Khoản vay còn chọn được — caller đã lọc theo luật của từng loại dòng (giải ngân vs trả gốc). */
export type KhoanVayChon = { id: string; name: string; duNo: number };

/**
 * Ô chọn khoản vay trong modal "Nhập quỹ / rút quỹ", hiện khi loại là Vay vốn / Trả nợ gốc / Gửi
 * (hoặc hoàn) tiết kiệm bắt buộc — các loại này BẮT BUỘC có `loanId` (zod + CHECK ở DB). Danh sách
 * rỗng thì nói thẳng đường tạo khoản vay, đừng để chủ shop bấm Lưu rồi mới biết là thiếu.
 *
 * BỐN lý do rỗng, KHÔNG gộp: chưa khai khoản nào · có khoản nhưng đều đã ghi giải ngân (hoặc tất
 * toán) nên không còn khoản nào nhận thêm dòng này · (riêng tiền gửi tiết kiệm) có khoản còn hiệu
 * lực thật nhưng không khoản nào là loại trả gốc cuối kỳ — sổ tiết kiệm bắt buộc chỉ gắn được vào
 * loại đó · (cũng riêng tiền gửi) CÓ khoản đúng loại nhưng nó đã tất toán, tức đường đi là MỞ LẠI
 * chứ không phải tạo khoản mới. Nói "Chưa có khoản vay nào" trong khi bảng ngay phía trên đang liệt
 * kê 3 khoản, hay nói "chưa có khoản trả gốc cuối kỳ nào" trong khi bảng đang in đúng khoản đó kèm
 * dấu "Đã tất toán", đều làm chủ shop tưởng app hỏng.
 */
export function KhoanVaySelect({
  loans,
  coKhoanVay,
  laTienGui = false,
  coBulletDaTatToan = false,
  value,
  onChange,
  error,
  onTaoMoi,
}: {
  loans: KhoanVayChon[];
  /** Bảng khoản vay có dòng nào không (TRƯỚC khi lọc theo loại dòng đang ghi). */
  coKhoanVay: boolean;
  /** true khi ô đang lọc cho dòng Gửi/Hoàn tiết kiệm bắt buộc — nhánh này có lý do rỗng RIÊNG. */
  laTienGui?: boolean;
  /**
   * Có khoản trả gốc cuối kỳ nào ĐÃ TẤT TOÁN không (chỉ dùng ở nhánh `laTienGui`). Đúng ca này thì
   * bảng Khoản vay ngay phía trên vẫn đang liệt kê khoản đó — bảo "chưa có khoản nào" là nói sai
   * chuyện, và "Tạo khoản vay mới" là chỉ sai đường (đẻ ra khoản thứ hai cho cùng một sổ tiết kiệm).
   */
  coBulletDaTatToan?: boolean;
  value: string;
  onChange: (id: string) => void;
  error?: string;
  /** Đóng modal rồi đưa mắt về khối Khoản vay — link `#khoan-vay` trần là ngõ cụt, xem ghi chú. */
  onTaoMoi: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">Khoản vay</label>
      {loans.length === 0 ? (
        laTienGui && coBulletDaTatToan ? (
          <p className="text-xs text-muted-foreground">
            Khoản vay trả gốc cuối kỳ đang có đều đã tất toán — mở lại khoản đó ở bảng Khoản vay
            (menu ⋯ → Mở lại) rồi ghi dòng này. Tạo khoản mới sẽ đẻ ra khoản thứ hai cho cùng một sổ
            tiết kiệm.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {laTienGui
              ? "Chưa có khoản vay trả gốc cuối kỳ nào — tiền gửi tiết kiệm bắt buộc chỉ gắn được vào loại vay đó. "
              : coKhoanVay
                ? "Mọi khoản vay đã ghi giải ngân — vay thêm thì "
                : "Chưa có khoản vay nào — "}
            {/* NÚT chứ không phải <a href="#khoan-vay">: modal đang mở che hết trang, bấm link chỉ
                đổi hash rồi đứng yên — lần đầu dùng là tắc ở đây. */}
            <button type="button" onClick={onTaoMoi} className="underline underline-offset-2">
              {laTienGui
                ? "Tạo khoản vay mới"
                : coKhoanVay
                  ? "tạo khoản vay mới"
                  : "Tạo khoản vay mới"}
            </button>
          </p>
        )
      ) : (
        <Select value={value} onValueChange={(v) => onChange(typeof v === "string" ? v : "")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Chọn khoản vay" />
          </SelectTrigger>
          <SelectContent>
            {loans.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name} — dư nợ {formatVnd(l.duNo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
