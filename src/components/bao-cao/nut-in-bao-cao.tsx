"use client";

import { Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/** Nút "Xuất PDF" = `window.print()` — phần DUY NHẤT của cụm nút xuất báo cáo cần chạy ở trình duyệt. */
export function NutInBaoCao({ hasData }: { hasData: boolean }) {
  function handlePrint() {
    try {
      window.print();
    } catch {
      toast.error("Xuất PDF thất bại, thử lại");
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handlePrint} disabled={!hasData}>
      <Printer className="size-4" />
      Xuất PDF
    </Button>
  );
}
