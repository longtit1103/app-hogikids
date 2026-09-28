"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { ShopeeImportModal } from "./shopee-import-modal";

/**
 * Nút mở modal import file ví Shopee — đặt cạnh card "Tiền đã về" (tab Dòng tiền).
 * `cash-flow-tab` là server component nên phần onClick tách ra client wrapper này.
 *
 * `nhan` để chỗ thứ hai (cảnh báo "ví Shopee mới nhập tới …" trên thẻ Quỹ) mang tên KHÁC. Bắt buộc
 * khác, và khác theo kiểu KHÔNG chứa tên gốc: `getByRole("button", { name })` của Playwright mặc
 * định khớp CHUỖI CON, nên một cái tên dài hơn kiểu "Import file ví Shopee từ …" vẫn dính vào phép
 * tìm nút gốc và làm `tien-da-ve-shopee.spec.ts` vỡ strict-mode.
 */
export function ShopeeImportButton({ nhan = "Import file ví Shopee" }: { nhan?: string } = {}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {nhan}
      </Button>
      <ShopeeImportModal open={open} onOpenChange={setOpen} />
    </>
  );
}
