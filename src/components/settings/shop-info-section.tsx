"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateShopInfo } from "@/lib/actions/settings-shop-info";
import { useUnsavedGuard } from "./use-unsaved-guard";

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB — client-check nhanh; server (settings-shop-info.ts) validate lại, không tin cái này
const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg"]);
const INVALID_LOGO_MESSAGE = "Ảnh phải là PNG/JPG dưới 2MB";
const PHONE_REGEX = /^0\d{9}$/;
const PHONE_ERROR = "Số điện thoại không hợp lệ";

/**
 * Logo giờ serve qua route handler `/api/uploads/<file>` (né lỗ hổng `next
 * start` chỉ build danh sách file `public/` servable lúc boot — xem
 * `src/app/api/uploads/[name]/route.ts`). Giá trị CŨ trong DB có thể còn dạng
 * static `/uploads/<file>` (ghi trước fix này) — map về route mới để logo cũ
 * không vỡ, không cần migration DB.
 */
function resolveLogoUrl(shopLogoPath: string | null): string | null {
  if (!shopLogoPath) return null;
  return shopLogoPath.startsWith("/uploads/") ? `/api${shopLogoPath}` : shopLogoPath;
}

/**
 * Section 1 "Thông tin shop": avatar (logo hoặc chữ cái đầu tên shop) + form
 * Tên shop/SĐT, lưu qua `updateShopInfo`. Chọn logo chỉ preview cục bộ (blob
 * URL) — chỉ thật sự ghi đĩa khi bấm "Lưu thông tin".
 */
export function ShopInfoSection({
  shopName: initialShopName,
  shopPhone: initialShopPhone,
  shopLogoPath,
}: {
  shopName: string;
  shopPhone: string | null;
  shopLogoPath: string | null;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [shopName, setShopName] = useState(initialShopName);
  const [shopPhone, setShopPhone] = useState(initialShopPhone ?? "");
  const [savedName, setSavedName] = useState(initialShopName);
  const [savedPhone, setSavedPhone] = useState(initialShopPhone ?? "");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = shopName !== savedName || shopPhone !== savedPhone || logoFile !== null;
  useUnsavedGuard(dirty);

  const avatarSrc = logoPreviewUrl ?? resolveLogoUrl(shopLogoPath);
  const avatarLetter = (shopName.trim().charAt(0) || "H").toUpperCase();

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // cho phép chọn lại đúng file cũ vẫn bắn onChange lần sau
    if (!file) return;
    if (!ALLOWED_LOGO_TYPES.has(file.type) || file.size > MAX_LOGO_BYTES) {
      toast.error(INVALID_LOGO_MESSAGE);
      return;
    }
    if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl);
    setLogoFile(file);
    setLogoPreviewUrl(URL.createObjectURL(file));
  }

  function handlePhoneChange(value: string) {
    setShopPhone(value);
    if (phoneError) setPhoneError(null);
  }

  function handlePhoneBlur() {
    const trimmed = shopPhone.trim();
    setPhoneError(trimmed && !PHONE_REGEX.test(trimmed) ? PHONE_ERROR : null);
  }

  async function handleSubmit() {
    const trimmedName = shopName.trim();
    const trimmedPhone = shopPhone.trim();

    if (!trimmedName) {
      toast.error("Tên shop không được để trống");
      return;
    }
    if (trimmedName.length > 50) {
      toast.error("Tên shop tối đa 50 ký tự");
      return;
    }
    if (trimmedPhone && !PHONE_REGEX.test(trimmedPhone)) {
      setPhoneError(PHONE_ERROR);
      return;
    }

    setSaving(true);
    const formData = new FormData();
    formData.set("shopName", trimmedName);
    formData.set("shopPhone", trimmedPhone);
    if (logoFile) formData.set("logo", logoFile);

    try {
      const res = await updateShopInfo(formData);
      if (!res.ok) {
        if (res.field === "shopPhone") setPhoneError(res.error);
        else toast.error(res.error);
        return;
      }
      toast.success("Đã lưu thông tin shop");
      setSavedName(trimmedName);
      setSavedPhone(trimmedPhone);
      setShopName(trimmedName);
      setShopPhone(trimmedPhone);
      setLogoFile(null);
      router.refresh(); // khối user cuối sidebar ((app)/layout.tsx) đọc lại User ngay
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        {avatarSrc ? (
          <Image
            src={avatarSrc}
            alt="Logo shop"
            width={64}
            height={64}
            unoptimized
            className="size-16 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary font-serif text-2xl text-on-primary">
            {avatarLetter}
          </span>
        )}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            Đổi logo
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="shop-name-input">
            Tên shop
          </label>
          <Input
            id="shop-name-input"
            value={shopName}
            maxLength={50}
            onChange={(e) => setShopName(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Tên shop là chuỗi xác nhận khi xóa dữ liệu giao dịch.</p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="shop-phone-input">
            Số điện thoại
          </label>
          <Input
            id="shop-phone-input"
            value={shopPhone}
            placeholder="090x xxx xxx"
            onChange={(e) => handlePhoneChange(e.target.value)}
            onBlur={handlePhoneBlur}
            aria-invalid={Boolean(phoneError)}
          />
          {phoneError && <p className="text-xs text-error">{phoneError}</p>}
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="button" disabled={!dirty || saving} onClick={handleSubmit}>
          {saving ? "Đang lưu…" : "Lưu thông tin"}
        </Button>
      </div>
    </div>
  );
}
