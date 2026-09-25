"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changePassword } from "@/lib/actions/security";
import type { ActionResult } from "@/lib/actions/action-result";

type FieldKey = "currentPassword" | "newPassword" | "confirmPassword";

const INITIAL_VALUES: Record<FieldKey, string> = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

const INITIAL_VISIBILITY: Record<FieldKey, boolean> = {
  currentPassword: false,
  newPassword: false,
  confirmPassword: false,
};

const FIELDS: { key: FieldKey; label: string; autoComplete: string }[] = [
  { key: "currentPassword", label: "Mật khẩu hiện tại", autoComplete: "current-password" },
  { key: "newPassword", label: "Mật khẩu mới", autoComplete: "new-password" },
  { key: "confirmPassword", label: "Xác nhận mật khẩu mới", autoComplete: "new-password" },
];

/**
 * Section 7 "Bảo mật": đổi mật khẩu đăng nhập qua `changePassword` (xác thực
 * scrypt mật khẩu hiện tại).
 *
 * Đổi thành công THU HỒI phiên trên MỌI thiết bị khác (mốc phiên trong bảng `Setting`), riêng thiết
 * bị đang thao tác được cấp lại cookie ngay nên không bị đá ra. Ngoại lệ một lần: cookie cấp TRƯỚC
 * bản có mốc phiên chưa mang lựa chọn "ghi nhớ đăng nhập", nên lần đổi mật khẩu đầu tiên sau khi
 * nâng cấp sẽ hạ nó xuống cookie-phiên (đóng trình duyệt là hết). CỐ Ý chọn phía an toàn hơn: người
 * ta đổi mật khẩu thường vì nghi bị lộ, tự ý cấp cookie 30 ngày mới là sai. Lần đăng nhập kế tiếp
 * ghi lại lựa chọn thật nên chuyện này không lặp lại.
 */
export function SecuritySection() {
  const [values, setValues] = useState<Record<FieldKey, string>>(INITIAL_VALUES);
  const [visible, setVisible] = useState<Record<FieldKey, boolean>>(INITIAL_VISIBILITY);
  const [fieldError, setFieldError] = useState<{ field: FieldKey; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = FIELDS.some((f) => values[f.key] !== "");
  const canSubmit = FIELDS.every((f) => values[f.key].trim() !== "") && !saving;

  function handleChange(key: FieldKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (fieldError?.field === key) setFieldError(null);
  }

  function toggleVisible(key: FieldKey) {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    setFieldError(null);

    const formData = new FormData();
    formData.set("currentPassword", values.currentPassword);
    formData.set("newPassword", values.newPassword);
    formData.set("confirmPassword", values.confirmPassword);

    try {
      const res: ActionResult = await changePassword(formData);
      if (!res.ok) {
        if (res.field === "currentPassword" || res.field === "newPassword" || res.field === "confirmPassword") {
          setFieldError({ field: res.field, message: res.error });
        } else {
          toast.error(res.error);
        }
        return;
      }
      // Nói RÕ hệ quả: đổi mật khẩu nay thu hồi phiên trên mọi thiết bị khác. Im lặng thì chủ shop
      // mở máy khác thấy bị đăng xuất sẽ tưởng hỏng. Máy đang dùng thì vẫn đăng nhập bình thường.
      toast.success("Đã đổi mật khẩu — các thiết bị khác phải đăng nhập lại");
      setValues(INITIAL_VALUES);
      setVisible(INITIAL_VISIBILITY);
    } catch {
      toast.error("Đổi mật khẩu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid max-w-sm grid-cols-1 gap-4">
        {FIELDS.map(({ key, label, autoComplete }) => (
          <div key={key} className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor={`security-${key}`}>
              {label}
            </label>
            <div className="relative">
              <Input
                id={`security-${key}`}
                type={visible[key] ? "text" : "password"}
                autoComplete={autoComplete}
                value={values[key]}
                aria-invalid={fieldError?.field === key}
                onChange={(e) => handleChange(key, e.target.value)}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => toggleVisible(key)}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-ink"
                aria-label={visible[key] ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
              >
                {visible[key] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {fieldError?.field === key && <p className="text-xs text-error">{fieldError.message}</p>}
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Mật khẩu mới tối thiểu 12 ký tự, gồm cả chữ và số. Đăng xuất: dropdown khối user cuối sidebar.
      </p>

      <div className="flex justify-end">
        <Button type="button" disabled={!dirty || !canSubmit} onClick={handleSubmit}>
          {saving ? "Đang lưu…" : "Đổi mật khẩu"}
        </Button>
      </div>
    </div>
  );
}
