"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type LocFilter = "" | "da_ban_thieu_gia_von" | "thieu_gia_von" | "sap_het";

const PILLS: { value: LocFilter; label: string }[] = [
  { value: "", label: "Tất cả" },
  // Đứng TRƯỚC "Thiếu giá vốn": đây mới là tập cần nhập trước — biến thể đã bán mà giá vốn còn 0
  // là thứ DUY NHẤT làm lãi hiển thị sai. Lọc rộng bên cạnh giữ nguyên cho ai muốn soi cả kho.
  { value: "da_ban_thieu_gia_von", label: "⚠ Đã bán, thiếu giá vốn" },
  { value: "thieu_gia_von", label: "Thiếu giá vốn (cả kho)" },
  { value: "sap_het", label: "Sắp hết" },
];

/** Search debounce 300ms + 4 pill lọc. Cả 2 sync qua query, reset trang 1. */
export function ProductToolbar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const loc = (searchParams.get("loc") ?? "") as LocFilter;

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

  function selectLoc(next: LocFilter) {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("loc", next);
    else params.delete("loc");
    params.delete("trang");
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="relative w-full max-w-xs">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm SKU, tên sản phẩm…"
          className="px-8"
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

      <div className="flex items-center gap-1 rounded-lg border border-hairline bg-canvas p-1">
        {PILLS.map((pill) => (
          <button
            key={pill.value}
            type="button"
            aria-pressed={loc === pill.value}
            onClick={() => selectLoc(pill.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              loc === pill.value
                ? "bg-surface-card text-ink shadow-sm"
                : "text-muted-foreground hover:text-ink",
            )}
          >
            {pill.label}
          </button>
        ))}
      </div>
    </div>
  );
}
