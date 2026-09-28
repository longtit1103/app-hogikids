"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Search debounce 300ms + toggle "Chỉ hiện sắp hết" + nút Xuất CSV (giữ filter hiện tại qua query). */
export function InventoryToolbar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const lowOnly = searchParams.get("loc") === "sap_het";

  useEffect(() => {
    const initial = searchParams.get("q") ?? "";
    if (q === initial) return;
    const handle = setTimeout(() => {
      const params = new URLSearchParams(searchParams);
      if (q) params.set("q", q);
      else params.delete("q");
      params.delete("trang");
      router.replace(`${pathname}?${params.toString()}`);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

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
      <a href={exportHref}>
        <Button type="button" variant="secondary" size="sm">
          Xuất CSV
        </Button>
      </a>
    </div>
  );
}
