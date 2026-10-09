"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Chọn ngày bật dự kiến (mốc M) cho trang chuẩn bị — CHỈ là tham số URL (`?m=`), không lưu đâu cả: mốc
 * chỉ được ghi ở bước xác nhận. Đổi ngày ⇒ checklist + tab Xác nhận tính lại theo ngày mới.
 */
export function BatChonNgayForm({ mocM, tab }: { mocM: string; tab: string }) {
  const router = useRouter();
  const [ngay, setNgay] = useState(mocM);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{4}-\d{2}-\d{2}$/.test(ngay)) router.push(`/tai-chinh/no-phai-tra?tab=${tab}&m=${ngay}`);
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="bat-ngay-m">
        Ngày bắt đầu theo dõi nợ phải trả
        <Input id="bat-ngay-m" type="date" value={ngay} onChange={(e) => setNgay(e.target.value)} className="w-44" />
      </label>
      <Button type="submit" variant="secondary" size="sm" disabled={ngay === mocM}>
        Đổi ngày
      </Button>
    </form>
  );
}
