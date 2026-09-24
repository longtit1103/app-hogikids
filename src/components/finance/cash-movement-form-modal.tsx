"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format, startOfDay } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import {
  CASH_MOVEMENT_KIND_META,
  CASH_MOVEMENT_KINDS,
  isCashMovementKind,
  isInflow,
  type CashMovementKind,
} from "@/lib/cash-movements/cash-movement-kinds";
import type { CashMovementRow } from "@/lib/cash-movements/cash-movement-queries";
import { formatVnd } from "@/lib/format";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { KhoanVaySelect } from "./khoan-vay-select";
import { SoTietKiemSelect, type SoTietKiemChon } from "./so-tiet-kiem-select";

const QUERY_DATE_FORMAT = "yyyy-MM-dd";

const KINDS_IN = CASH_MOVEMENT_KINDS.filter(isInflow);
const KINDS_OUT = CASH_MOVEMENT_KINDS.filter((k) => !isInflow(k));

type FormState = {
  date: string;
  kind: CashMovementKind | "";
  amount: number;
  description: string;
  loanId: string;
  savingsId: string;
};

function buildInitialState(row: CashMovementRow | undefined): FormState {
  if (row) {
    return {
      date: format(row.date, QUERY_DATE_FORMAT),
      kind: row.kind,
      amount: row.amount,
      description: row.description,
      loanId: row.loanId ?? "",
      savingsId: row.savingsId ?? "",
    };
  }
  return {
    date: format(new Date(), QUERY_DATE_FORMAT),
    kind: "",
    amount: 0,
    description: "",
    loanId: "",
    savingsId: "",
  };
}

/**
 * Khoản chọn được, cùng luật với action để chủ shop không chọn xong mới bị từ chối:
 *  - `LOAN_IN` chỉ nhận khoản CHƯA giải ngân;
 *  - `DEPOSIT_OUT`/`DEPOSIT_IN` chỉ nhận khoản BULLET — sổ tiết kiệm bắt buộc là thuộc tính của
 *    riêng loại vay đó (đường tất toán của loại khác KHÔNG hoàn tiền gửi, tiền mất dấu khỏi quỹ);
 *  - `LOAN_REPAY` chỉ cần khoản còn hiệu lực.
 * Khoản của chính dòng đang sửa luôn giữ lại, nếu không nó biến mất khỏi ô ngay lúc mở form Sửa.
 */
function locKhoanVay(loans: KhoanVayRow[], kind: CashMovementKind | "", loanIdDangSua: string | null) {
  const laTienGui = kind === "DEPOSIT_OUT" || kind === "DEPOSIT_IN";
  return loans.filter(
    (l) =>
      l.id === loanIdDangSua ||
      (l.closedAt === null &&
        (kind !== "LOAN_IN" || (l.duNoMoSo === 0 && l.giaiNgan === 0)) &&
        (!laTienGui || l.kind === "BULLET"))
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

export type CashMovementFormModalProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Có = chế độ sửa (prefill). */
  row?: CashMovementRow;
  /** Khoản vay để chọn khi loại là Vay vốn / Trả nợ gốc (page đọc `listKhoanVay()`). */
  loans: KhoanVayRow[];
  /** Sổ tiết kiệm cho ô chọn khi loại dòng là `SAVINGS_OUT`/`SAVINGS_IN` (cửa 6). */
  soTietKiem: SoTietKiemRow[];
  /** Ngày mở sổ quỹ (`soQuy.d0`); null = chưa mở sổ. */
  d0: Date | null;
};

/**
 * Modal Thêm/Sửa "khoản tiền khác" (vay/góp/rút vốn, trả nợ gốc, bán trực tiếp, thu khác) — tab Dòng
 * tiền. Rút gọn từ `expense-form-modal.tsx`: không danh mục động, không kênh, không lặp tháng. Loại
 * khoản chia 2 nhóm Tiền vào / Tiền ra; câu gợi ý theo loại lấy từ MỘT định nghĩa
 * (`cash-movement-kinds.ts`) — gợi ý "Bán trực tiếp" nhắc thẳng: chỉ dòng tiền, không vào Lãi/Lỗ.
 */
/**
 * Sổ còn chọn được cho loại dòng đang ghi — PHẢI khớp đúng luật server (`kiemSoTietKiem` ở
 * `cash-movements.ts`), nếu không chủ shop chọn được rồi bấm Lưu mới ăn lỗi:
 *  - sổ đã tất toán: không nhận dòng mới (`kiemSoTietKiemConHieuLuc`);
 *  - `SAVINGS_OUT`: sổ đã có dòng gửi thì thôi — "1 sổ = ĐÚNG 1 dòng gửi", gửi thêm là tạo sổ mới.
 *    Lọc theo SỐ DÒNG (`soDongGui`) chứ không theo số TIỀN (`dangGui`): server đếm dòng, nên sổ đã
 *    nhận lại hết gốc bằng dòng ghi tay có `dangGui = 0` mà vẫn bị server từ chối — lọc bằng tiền là
 *    client và server nói hai luật khác nhau (review đối kháng 17/09).
 * Luôn giữ lại sổ ĐANG SỬA (`savingsIdDangSua`) kẻo mở form sửa mà ô chọn trống trơn.
 */
function locSoTietKiem(
  sos: SoTietKiemRow[],
  kind: CashMovementKind | "",
  savingsIdDangSua: string | null
): SoTietKiemChon[] {
  return sos
    .filter(
      (s) =>
        s.id === savingsIdDangSua ||
        (s.closedAt === null && (kind !== "SAVINGS_OUT" || s.soDongGui === 0))
    )
    .map((s) => ({ id: s.id, name: s.name, dangGui: s.dangGui }));
}

export function CashMovementFormModal({
  open,
  onOpenChange,
  row,
  loans,
  soTietKiem,
  d0,
}: CashMovementFormModalProps) {
  const router = useRouter();
  const isEdit = Boolean(row);
  const todayStr = format(new Date(), QUERY_DATE_FORMAT);

  const [date, setDate] = useState(todayStr);
  const [kind, setKind] = useState<CashMovementKind | "">("");
  const [amount, setAmount] = useState(0);
  const [description, setDescription] = useState("");
  const [loanId, setLoanId] = useState("");
  const [savingsId, setSavingsId] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Đã bấm Lưu một lần trên một ngày sớm hơn D0 ⇒ lượt bấm sau mới thật sự gửi (xem `handleSubmit`).
  const [hoiTruocD0, setHoiTruocD0] = useState(false);
  const initialSnapshotRef = useRef("");

  // Reset field mỗi khi mở (mới hoặc đổi dòng đang sửa) — không reset khi đóng để tránh nháy lúc animation.
  useEffect(() => {
    if (!open) return;
    const initial = buildInitialState(row);
    setDate(initial.date);
    setKind(initial.kind);
    setAmount(initial.amount);
    setDescription(initial.description);
    setLoanId(initial.loanId);
    setSavingsId(initial.savingsId);
    setFieldErrors({});
    setHoiTruocD0(false);
    initialSnapshotRef.current = JSON.stringify(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row?.id]);

  function isDirty(): boolean {
    const current: FormState = { date, kind, amount, description, loanId, savingsId };
    return JSON.stringify(current) !== initialSnapshotRef.current;
  }

  function handleOpenChange(next: boolean) {
    if (!next && isDirty() && !window.confirm("Bỏ thay đổi?")) return;
    onOpenChange(next);
  }

  function handleKindChange(value: string | null) {
    setKind(isCashMovementKind(value) ? value : "");
    setFieldErrors((prev) => ({ ...prev, kind: "" }));
  }

  // Ô Ngày xoá trống ⇒ `date` rỗng ⇒ `new Date("T00:00:00+07:00")` là Invalid Date, React serialize
  // thành null và server coerce ra 01/01/1970: dòng ghi xong không hiện ở tháng nào mà toast vẫn xanh.
  //
  // Cả 4 loại đều BẮT BUỘC `loanId` (CHECK `CashMovement_loan_bat_buoc` ở DB) — thiếu nhánh nào ở
  // đây thì ô chọn khoản vay không hiện ra, chủ shop bấm Lưu mới thấy lỗi thô từ DB.
  const laLoaiVay =
    kind === "LOAN_IN" || kind === "LOAN_REPAY" || kind === "DEPOSIT_OUT" || kind === "DEPOSIT_IN";
  const laTienGui = kind === "DEPOSIT_OUT" || kind === "DEPOSIT_IN";
  const dsKhoanVay = locKhoanVay(loans, kind, row?.loanId ?? null);
  // Hai loại gắn SỔ TIẾT KIỆM (CHECK `CashMovement_savings_bat_buoc` ở DB) — cùng lý do với
  // `laLoaiVay`: thiếu nhánh này thì ô chọn sổ không hiện, bấm Lưu mới thấy lỗi thô từ DB.
  const laSoTietKiem = kind === "SAVINGS_OUT" || kind === "SAVINGS_IN";
  const dsSoTietKiem = locSoTietKiem(soTietKiem, kind, row?.savingsId ?? null);
  const canSave =
    Boolean(date) &&
    Boolean(kind) &&
    amount > 0 &&
    (!laLoaiVay || Boolean(loanId)) &&
    (!laSoTietKiem || Boolean(savingsId)) &&
    !saving;
  const ngayTruocD0 = d0 !== null && Boolean(date) && new Date(`${date}T00:00:00+07:00`) < startOfDay(d0);

  async function handleSubmit() {
    if (!kind || !date) return;
    // D0 = MIN(CashMovement.date) toàn bảng, KHÔNG cấu hình ở Cài đặt: một dòng ghi lùi ngày kéo D0
    // lùi theo và MỌI số Đầu kỳ/Cuối kỳ của các tháng đã xem đổi im lặng. Hỏi lại bằng chính nút Lưu
    // (bấm lần hai mới gửi) — `window.confirm` bị trình duyệt chặn/nuốt và không dịch được.
    if (ngayTruocD0 && !hoiTruocD0) {
      setHoiTruocD0(true);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    // Neo +07:00 như expense-form-modal — server parse cùng một cách với Expense.
    const input = {
      date: new Date(`${date}T00:00:00+07:00`),
      kind,
      amount,
      description,
      loanId: loanId || null,
      savingsId: savingsId || null,
    };
    try {
      const res = isEdit && row ? await updateCashMovement(row.id, input) : await createCashMovement(input);
      if (!res.ok) {
        if (res.field) setFieldErrors({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      toast.success(
        isEdit ? "Đã cập nhật khoản tiền" : `Đã ghi ${CASH_MOVEMENT_KIND_META[kind].label} ${formatVnd(amount)}`,
      );
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa khoản tiền" : "Nhập quỹ / rút quỹ"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Ngày" error={fieldErrors.date}>
            <Input
              type="date"
              value={date}
              max={todayStr}
              onChange={(e) => {
                setDate(e.target.value);
                setFieldErrors((prev) => ({ ...prev, date: "" }));
                // Đổi ngày ⇒ câu hỏi cũ hết hiệu lực, bắt xác nhận lại từ đầu.
                setHoiTruocD0(false);
              }}
            />
            {d0 === null && (
              <p className="text-xs text-muted-foreground">
                Đây là khoản đầu tiên — quỹ sẽ tính từ ngày này.
              </p>
            )}
            {hoiTruocD0 && d0 !== null && (
              <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                Ngày này sớm hơn ngày mở sổ ({format(d0, "dd/MM/yyyy")}). Quỹ sẽ tính lại từ ngày
                mới; dòng số dư mở sổ có thể phải sửa lại.
              </p>
            )}
          </Field>

          <Field label="Loại khoản" error={fieldErrors.kind}>
            <Select value={kind} onValueChange={handleKindChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Chọn loại khoản" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Tiền vào</SelectLabel>
                  {KINDS_IN.map((k) => (
                    <SelectItem key={k} value={k}>
                      {CASH_MOVEMENT_KIND_META[k].label}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Tiền ra</SelectLabel>
                  {KINDS_OUT.map((k) => (
                    <SelectItem key={k} value={k}>
                      {CASH_MOVEMENT_KIND_META[k].label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {kind && <p className="text-xs text-muted-foreground">{CASH_MOVEMENT_KIND_META[kind].hint}</p>}
          </Field>

          {laLoaiVay && (
            <KhoanVaySelect
              loans={dsKhoanVay}
              coKhoanVay={loans.length > 0}
              laTienGui={laTienGui}
              // Lý do rỗng thứ tư của ô: khoản trả gốc cuối kỳ CÓ, nhưng đã tất toán nên `locKhoanVay`
              // lọc hết. Bảng Khoản vay ngay trên vẫn in nó kèm dấu "Đã tất toán" — đường đi đúng là
              // Mở lại, không phải tạo khoản mới.
              coBulletDaTatToan={loans.some((l) => l.kind === "BULLET" && l.closedAt !== null)}
              value={loanId}
              onChange={(id) => {
                setLoanId(id);
                setFieldErrors((prev) => ({ ...prev, loanId: "" }));
              }}
              error={fieldErrors.loanId}
              onTaoMoi={() => {
                onOpenChange(false);
                document.getElementById("khoan-vay")?.scrollIntoView({ behavior: "smooth" });
              }}
            />
          )}

          {laSoTietKiem && (
            <SoTietKiemSelect
              sos={dsSoTietKiem}
              value={savingsId}
              onChange={(id) => {
                setSavingsId(id);
                setFieldErrors((prev) => ({ ...prev, savingsId: "" }));
              }}
              error={fieldErrors.savingsId}
              // Ba lý do rỗng KHÁC NHAU, nói thẳng cái đang đúng — câu chung chung thì chủ shop
              // không biết phải làm gì tiếp.
              emptyMessage={
                soTietKiem.length === 0
                  ? "Chưa có sổ tiết kiệm nào — tạo sổ ở khối Sổ tiết kiệm bên dưới trước."
                  : kind === "SAVINGS_OUT"
                    ? "Mọi sổ đang mở đều đã có dòng gửi rồi — gửi thêm thì tạo sổ tiết kiệm MỚI."
                    : "Không còn sổ nào đang gửi — sổ đã tất toán phải Mở lại trước khi ghi thêm dòng."
              }
              onTaoMoi={() => {
                onOpenChange(false);
                document.getElementById("tiet-kiem")?.scrollIntoView({ behavior: "smooth" });
              }}
            />
          )}

          <Field label="Số tiền" error={fieldErrors.amount}>
            <div className="relative">
              <Input
                inputMode="numeric"
                value={formatAmountInput(amount)}
                onChange={(e) => setAmount(parseAmountInput(e.target.value))}
                placeholder="0"
                className="pr-8 text-right"
              />
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm text-muted-foreground">
                ₫
              </span>
            </div>
          </Field>

          <Field label="Ghi chú" error={fieldErrors.description}>
            <textarea
              value={description}
              maxLength={200}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <p className="text-right text-xs text-muted-foreground">{description.length}/200</p>
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" disabled={!canSave} onClick={handleSubmit}>
            {saving ? "Đang lưu…" : hoiTruocD0 ? "Xác nhận ghi trước ngày mở sổ" : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
