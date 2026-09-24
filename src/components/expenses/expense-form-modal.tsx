"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format, getDate } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { createExpense, stopRecurring, updateExpense } from "@/lib/actions/expenses";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";
import { formatVnd } from "@/lib/format";

const NONE = "__none__"; // sentinel: Select không nhận value="" cho "Không gắn kênh"
// Danh mục Lãi vay — server (`src/lib/actions/expenses.ts`) chặn MỌI dòng danh mục này mang kênh.
const DANH_MUC_LAI_VAY = "interest";
const QUERY_DATE_FORMAT = "yyyy-MM-dd";

const ADS_SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "META", label: "Meta" },
  { value: "TIKTOK_ADS", label: "TikTok Ads" },
  { value: "SHOPEE_ADS", label: "Shopee Ads" },
];

// Danh mục "ads" tự đề xuất kênh theo nguồn con — chỉ áp khi user chưa tự tay đổi Kênh.
const ADS_CHANNEL_SUGGESTION: Record<string, string> = {
  META: "facebook",
  TIKTOK_ADS: "tiktok",
  SHOPEE_ADS: "shopee",
};

export type ExpenseFormModalProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  categories: { id: string; name: string }[];
  channels: { id: string; name: string; color: string }[];
  expense?: ExpenseRow; // có = chế độ sửa (prefill)
  preset?: {
    categoryId?: string;
    channelId?: string;
    adsSource?: string;
    lockCategory?: boolean;
    lockChannel?: boolean;
  };
  /**
   * Ghi đè toast báo thành công khi TẠO MỚI (không áp dụng chế độ sửa — vẫn
   * "Đã cập nhật chi phí"). Optional, mặc định giữ nguyên toast chung
   * `Đã thêm chi phí {amount}`. Dùng bởi `/kenh/:id` ("+ Thêm chi phí ads cho
   * kênh này") để toast đúng ngữ cảnh kênh — thêm prop thay vì fork component,
   * giữ nguyên mọi hành vi cho các nơi gọi cũ (`/chi-phi`) không truyền prop này.
   */
  createSuccessMessage?: string;
};

type FormState = {
  date: string;
  categoryId: string;
  adsSource: string;
  amount: number;
  channelId: string | null;
  description: string;
  recurringMonthly: boolean;
};

function buildInitialState(expense: ExpenseRow | undefined, preset: ExpenseFormModalProps["preset"]): FormState {
  if (expense) {
    return {
      date: format(expense.date, QUERY_DATE_FORMAT),
      categoryId: expense.categoryId,
      adsSource: expense.adsSource ?? "",
      amount: expense.amount,
      channelId: expense.channelId,
      description: expense.description,
      recurringMonthly: false, // n/a ở chế độ sửa — toggle bị ẩn
    };
  }
  return {
    date: format(new Date(), QUERY_DATE_FORMAT),
    categoryId: preset?.categoryId ?? "",
    adsSource: preset?.adsSource ?? "",
    amount: 0,
    channelId: preset?.channelId ?? null,
    description: "",
    recurringMonthly: false,
  };
}

// Khớp trần server (createExpense/updateExpense .max 2 tỷ — Prisma Int int32).
// Clamp ở client chỉ là UX; guard thật nằm ở server action.
const MAX_AMOUNT = 2_000_000_000;

function parseAmountInput(raw: string): number {
  const digits = raw.replace(/\D/g, "");
  return digits ? Math.min(Number.parseInt(digits, 10), MAX_AMOUNT) : 0;
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

/**
 * Modal Thêm/Sửa khoản chi — dùng chung `/chi-phi` (Task 4) và phase 5 màn
 * 8.1 (qua `preset.lockCategory/lockChannel` khi mở từ trang Kênh). Ẩn toggle
 * "Lặp lại hàng tháng" khi danh mục `ads` (server đã chặn — đây là UX
 * complement) và ở chế độ sửa (thay bằng nút "Dừng lặp lại" nếu có `recurringId`).
 */
export function ExpenseFormModal({
  open,
  onOpenChange,
  categories,
  channels,
  expense,
  preset,
  createSuccessMessage,
}: ExpenseFormModalProps) {
  const router = useRouter();
  const isEdit = Boolean(expense);
  const todayStr = format(new Date(), QUERY_DATE_FORMAT);

  const [date, setDate] = useState(todayStr);
  const [categoryId, setCategoryId] = useState("");
  const [adsSource, setAdsSource] = useState("");
  const [amount, setAmount] = useState(0);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [recurringMonthly, setRecurringMonthly] = useState(false);
  const [channelTouched, setChannelTouched] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [stoppingRecurring, setStoppingRecurring] = useState(false);
  const initialSnapshotRef = useRef("");

  // Reset toàn bộ field mỗi khi modal mở (mới hoặc đổi dòng đang sửa) — không
  // reset khi đóng để tránh nháy UI lúc animation đóng.
  useEffect(() => {
    if (!open) return;
    const initial = buildInitialState(expense, preset);
    setDate(initial.date);
    setCategoryId(initial.categoryId);
    setAdsSource(initial.adsSource);
    setAmount(initial.amount);
    setChannelId(initial.channelId);
    setDescription(initial.description);
    setRecurringMonthly(initial.recurringMonthly);
    setChannelTouched(Boolean(preset?.lockChannel));
    setFieldErrors({});
    initialSnapshotRef.current = JSON.stringify(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense?.id]);

  function isDirty(): boolean {
    const current: FormState = { date, categoryId, adsSource, amount, channelId, description, recurringMonthly };
    return JSON.stringify(current) !== initialSnapshotRef.current;
  }

  function handleOpenChange(next: boolean) {
    if (!next && isDirty()) {
      if (!window.confirm("Bỏ thay đổi?")) return;
    }
    onOpenChange(next);
  }

  function handleCategoryChange(value: string | null) {
    setCategoryId(value ?? "");
    setFieldErrors((prev) => ({ ...prev, categoryId: "" }));
    if (value !== "ads") {
      setAdsSource("");
    } else {
      setRecurringMonthly(false); // "ads" không hỗ trợ lặp hàng tháng — force off
    }
  }

  function handleAdsSourceChange(value: string | null) {
    setAdsSource(value ?? "");
    setFieldErrors((prev) => ({ ...prev, adsSource: "" }));
    if (value && !channelTouched && !preset?.lockChannel) {
      const suggested = ADS_CHANNEL_SUGGESTION[value];
      if (suggested && channels.some((c) => c.id === suggested)) {
        setChannelId(suggested);
      }
    }
  }

  function handleChannelChange(value: string | null) {
    setChannelTouched(true);
    setChannelId(!value || value === NONE ? null : value);
  }

  async function handleStopRecurring() {
    if (!expense?.recurringId) return;
    setStoppingRecurring(true);
    try {
      const res = await stopRecurring(expense.recurringId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã dừng lặp lại");
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setStoppingRecurring(false);
    }
  }

  // Dòng lãi vay theo kỳ (`refId` `LOAN:…`): server khoá ngày + danh mục, mở số tiền. Khoá luôn 2 ô
  // ở đây để chủ shop thấy trước khi bấm Lưu, thay vì nhận câu lỗi đỏ sau khi đã gõ.
  const khoaTheoKyVay = isEdit && Boolean(expense?.refId?.startsWith("LOAN:"));
  // Lãi vay KHÔNG phân bổ kênh (bất biến #1): server chặn MỌI dòng danh mục này mang kênh, cả tạo
  // mới lẫn sửa — dòng theo kỳ ở trên đã khoá danh mục = Lãi vay nên cờ này bao trùm luôn nó. Chỉ
  // KHOÁ ô chứ không xoá state `channelId`: chủ shop lỡ chọn Lãi vay rồi đổi lại danh mục khác thì
  // kênh vừa chọn vẫn còn. Lúc gửi thì ép null — dòng lỡ mang kênh từ trước tự gỡ ở lượt Lưu này.
  const khoaKenhLaiVay = categoryId === DANH_MUC_LAI_VAY;

  async function handleSubmit() {
    // Ô Ngày trống ⇒ Invalid Date ⇒ server nhận null. Nút Lưu đã khoá (canSave) nên bình thường không tới
    // đây; nếu ai đó nới canSave sau này thì vẫn chặn và NÓI RÕ thay vì im lặng.
    if (!date) {
      setFieldErrors({ date: "Chọn ngày" });
      return;
    }
    setFieldErrors({});
    setSaving(true);
    const input = {
      date: new Date(`${date}T00:00:00+07:00`),
      categoryId,
      adsSource: categoryId === "ads" ? adsSource : undefined,
      amount,
      channelId: khoaKenhLaiVay ? null : channelId,
      description,
      ...(isEdit ? {} : { recurringMonthly }),
    };
    try {
      const res = isEdit && expense ? await updateExpense(expense.id, input) : await createExpense(input);
      if (!res.ok) {
        if (res.field) {
          setFieldErrors({ [res.field]: res.error });
        } else {
          toast.error(res.error);
        }
        return;
      }
      toast.success(isEdit ? "Đã cập nhật chi phí" : (createSuccessMessage ?? `Đã thêm chi phí ${formatVnd(amount)}`));
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  // Ô Ngày xoá trống ⇒ `date` rỗng ⇒ `new Date("T00:00:00+07:00")` là Invalid Date, React serialize
  // thành null và server coerce ra 01/01/1970: dòng ghi xong không hiện ở tháng nào mà toast vẫn xanh
  // (lúc SỬA thì dời luôn dòng thật về 1970). Server đã chặn bằng schema; đây là lớp UI, cùng điều kiện
  // `Boolean(date)` với cash-movement-form-modal.
  const canSave =
    Boolean(date) && Boolean(categoryId) && amount > 0 && (categoryId !== "ads" || Boolean(adsSource)) && !saving;
  const showRecurringToggle = !isEdit && categoryId !== "ads";
  const showStopRecurring = isEdit && Boolean(expense?.recurringId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa chi phí" : "Thêm chi phí"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Ngày" error={fieldErrors.date}>
            <Input
              type="date"
              value={date}
              max={todayStr}
              disabled={khoaTheoKyVay}
              onChange={(e) => {
                setDate(e.target.value);
                setFieldErrors((prev) => ({ ...prev, date: "" }));
              }}
            />
            <p className="text-xs text-muted-foreground">
              {khoaTheoKyVay
                ? "Dòng lãi vay theo kỳ — ngày và danh mục khoá theo kỳ; sửa được số tiền. Muốn bỏ thì xoá dòng (vào Thùng rác, khôi phục được)."
                : "Ngày ghi = ngày tiền rời tài khoản (quỹ trừ theo ngày này)."}
            </p>
          </Field>

          <Field label="Danh mục" error={fieldErrors.categoryId}>
            <Select
              value={categoryId}
              onValueChange={handleCategoryChange}
              disabled={preset?.lockCategory || khoaTheoKyVay}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Chọn danh mục" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {categoryId === "ads" && (
            <Field label="Nguồn ads" error={fieldErrors.adsSource}>
              <Select value={adsSource} onValueChange={handleAdsSourceChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Chọn nguồn" />
                </SelectTrigger>
                <SelectContent>
                  {ADS_SOURCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {categoryId === "ads" && (
            // Ads trả bằng thẻ tín dụng đã vào sổ theo từng ngày chạy (tự về mỗi đêm / import) — ghi thêm
            // khoản THANH TOÁN SAO KÊ thẻ ở đây là chi phí quảng cáo bị tính HAI LẦN (lãi hụt, quỹ tụt đôi).
            <p className="text-xs text-warning" data-testid="expense-canh-bao-the-tin-dung">
              KHÔNG ghi khoản thanh toán sao kê thẻ tín dụng ở đây — chi phí quảng cáo đã được ghi theo từng
              ngày chạy; ghi thêm là tính hai lần.
            </p>
          )}

          {categoryId === "shipping" && (
            <p className="text-xs text-muted-foreground">
              Nhập tổng phí ship shop chịu theo kỳ — app không theo dõi ship per đơn
            </p>
          )}

          <Field label="Số tiền" error={fieldErrors.amount}>
            <div className="relative">
              <Input
                inputMode="numeric"
                value={amount ? new Intl.NumberFormat("vi-VN").format(amount) : ""}
                onChange={(e) => setAmount(parseAmountInput(e.target.value))}
                placeholder="0"
                className="pr-8 text-right"
              />
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm text-muted-foreground">
                ₫
              </span>
            </div>
          </Field>

          <Field label="Kênh" error={fieldErrors.channelId}>
            <Select
              value={khoaKenhLaiVay ? NONE : (channelId ?? NONE)}
              onValueChange={handleChannelChange}
              disabled={preset?.lockChannel || khoaKenhLaiVay}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Chọn kênh" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Không gắn kênh</SelectItem>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {khoaKenhLaiVay && (
              <p className="text-xs text-muted-foreground">
                Lãi vay không phân bổ theo kênh bán — luôn để trống kênh.
              </p>
            )}
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

          {showRecurringToggle && (
            <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
              <div>
                <p className="text-sm text-ink">Lặp lại hàng tháng</p>
                {recurringMonthly && Boolean(date) && (
                  <p className="text-xs text-muted-foreground">
                    Tự ghi vào ngày {getDate(new Date(`${date}T00:00:00+07:00`))} hàng tháng
                  </p>
                )}
              </div>
              <Switch checked={recurringMonthly} onCheckedChange={setRecurringMonthly} />
            </div>
          )}

          {showStopRecurring && (
            <Button type="button" variant="destructive" disabled={stoppingRecurring} onClick={handleStopRecurring}>
              {stoppingRecurring ? "Đang dừng…" : "Dừng lặp lại"}
            </Button>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" disabled={!canSave} onClick={handleSubmit}>
            {saving ? "Đang lưu…" : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
