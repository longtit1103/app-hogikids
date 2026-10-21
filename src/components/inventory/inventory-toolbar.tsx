"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { useOTimKiemUrl } from "@/components/shell/use-o-tim-kiem-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Search debounce 300ms + toggle "Chỉ hiện sắp hết" + nút Xuất CSV (giữ filter hiện tại qua query).
 * Nút xuất chỉ hiện khi có quyền `xuat-du-lieu` — route `/api/export/ton-kho` vẫn tự kiểm (403).
 */
export function InventoryToolbar({ choPhepXuat }: { choPhepXuat: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { q, setQ } = useOTimKiemUrl();
  const lowOnly = searchParams.get("loc") === "sap_het";

  function toggleLowOnly() {
    const params = new URLSearchParams(searchParams);
    if (lowOnly) params.delete("loc");
    else params.set("loc", "sap_het");
    params.delete("trang");
    router.replace(`${pathname}?${params.toString()}`);
  }

  const exportHref = `/api/export/ton-kho?${searchParams.toString()}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm SKU, tên sản phẩm…"
          className="pr-8"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ("")}
            aria-label="Xóa tìm kiếm"
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-ink"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <Button type="button" variant={lowOnly ? "default" : "outline"} size="sm" onClick={toggleLowOnly}>
        ⚠ Chỉ hiện sắp hết
      </Button>
      {choPhepXuat && (
        <a href={exportHref}>
          <Button type="button" variant="secondary" size="sm">
            Xuất CSV
          </Button>
        </a>
      )}
    </div>
  );
}
