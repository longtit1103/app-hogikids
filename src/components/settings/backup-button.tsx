"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { chayLuotSaoLuu, downloadBackup } from "./chay-luot-sao-luu";

/**
 * Nút "Sao lưu ngay" dùng chung: khối Sao lưu ở Cài đặt › Dữ liệu VÀ bước 1 của
 * dialog "Xóa toàn bộ". Tách riêng để cả hai tái dùng (tránh phụ thuộc vòng
 * giữa data-section ↔ delete-all-dialog).
 *
 * Component chỉ giữ cờ `loading` + nối dây; phần logic (kể cả bất biến "lỗi cũng phải làm mới
 * màn hình") nằm ở `chay-luot-sao-luu.ts` để test khoá được.
 */
export function BackupButton({
  variant = "default",
  label = "Sao lưu ngay",
}: {
  variant?: "default" | "outline";
  label?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await chayLuotSaoLuu({
        taiBanSaoLuu: downloadBackup,
        // Bọc arrow thay vì truyền thẳng `toast.success`: không phụ thuộc cách sonner bind `this`.
        baoThanhCong: (thongDiep) => toast.success(thongDiep),
        baoLoi: (thongDiep) => toast.error(thongDiep),
        lamMoiManHinh: () => router.refresh(),
      });
    } finally {
      // Mở khoá nút TRƯỚC khi chờ server render lại: `router.refresh()` không đồng bộ, để trong
      // nhánh chờ thì nút kẹt "Đang sao lưu…" lâu hơn thực tế.
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant={variant} disabled={loading} onClick={handleClick}>
      {loading ? "Đang sao lưu…" : label}
    </Button>
  );
}
