"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Filter } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const SOURCE_OPTIONS: { slug: string; label: string }[] = [
  { slug: "nhap_tay", label: "Nhập tay" },
  { slug: "dinh_ky", label: "Định kỳ" },
  { slug: "import", label: "Import" },
  { slug: "ads_api", label: "Ads API" },
];

type ExpenseTableToolbarProps = {
  categories: { id: string; name: string }[];
  channels: { id: string; name: string; color: string }[];
};

/**
 * Toolbar lọc riêng của `ExpenseTable` (search + Danh mục/Kênh/Nguồn + Xóa
 * lọc), tách khỏi `expense-table.tsx` cho gọn (>200 dòng — quy ước
 * modularize). Đọc/ghi trực tiếp query string `?q=&danh_muc=&kenh=&nguon=` —
 * là 1 trong 2 sibling client component cùng đọc chung URL (như
 * `order-filters.tsx`/`order-table.tsx`), không cần props qua lại với
 * `ExpenseTable`. Đổi filter luôn xóa `trang` (reset về trang 1); KHÔNG đụng
 * `sap_xep` (thuộc bảng, không phải toolbar).
 */
export function ExpenseTableToolbar({ categories, channels }: ExpenseTableToolbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [mobileOpen, setMobileOpen] = useState(false);

  const selectedCategoryIds = (searchParams.get("danh_muc") ?? "").split(",").filter(Boolean);
  const selectedChannel = searchParams.get("kenh") ?? undefined;
  const selectedSources = (searchParams.get("nguon") ?? "").split(",").filter(Boolean);
  const hasAnyFilter = Boolean(q || selectedCategoryIds.length || selectedChannel || selectedSources.length);
  const activeFilterCount = [selectedCategoryIds.length > 0, Boolean(selectedChannel), selectedSources.length > 0].filter(
    Boolean,
  ).length;

  useEffect(() => {
    const initial = searchParams.get("q") ?? "";
    if (q === initial) return;
    const handle = setTimeout(() => setParams({ q: q || undefined }), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function setParams(updates: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    params.delete("trang");
    router.replace(`${pathname}?${params.toString()}`);
  }

  function toggleCategory(id: string) {
    const next = selectedCategoryIds.includes(id)
      ? selectedCategoryIds.filter((c) => c !== id)
      : [...selectedCategoryIds, id];
    setParams({ danh_muc: next.length ? next.join(",") : undefined });
  }

  function selectChannel(id: string) {
    setParams({ kenh: selectedChannel === id ? undefined : id });
  }

  function toggleSource(slug: string) {
    const next = selectedSources.includes(slug) ? selectedSources.filter((s) => s !== slug) : [...selectedSources, slug];
    setParams({ nguon: next.length ? next.join(",") : undefined });
  }

  function clearFilters() {
    setQ("");
    setParams({ q: undefined, danh_muc: undefined, kenh: undefined, nguon: undefined });
    setMobileOpen(false);
  }

  const categoryLabel = selectedCategoryIds.length ? `Danh mục · ${selectedCategoryIds.length}` : "Danh mục";
  const channelLabel = !selectedChannel
    ? "Kênh"
    : selectedChannel === "none"
      ? "Không gắn kênh"
      : (channels.find((c) => c.id === selectedChannel)?.name ?? "Kênh");
  const sourceLabel = selectedSources.length ? `Nguồn · ${selectedSources.length}` : "Nguồn";
  const popoverTriggerClass = cn(buttonVariants({ variant: "outline", size: "sm" }));

  // Gọi như hàm thường (`{renderX()}`) — KHÔNG dùng thẻ JSX `<RenderX />` —
  // xem ghi chú tương tự ở expense-table.tsx (tránh remount subtree mỗi
  // lần gõ phím tìm kiếm).
  function renderCategoryFilterList() {
    return (
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {categories.map((c) => (
          <label key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-soft">
            <Checkbox checked={selectedCategoryIds.includes(c.id)} onCheckedChange={() => toggleCategory(c.id)} />
            {c.name}
          </label>
        ))}
      </div>
    );
  }

  function renderChannelFilterList() {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => selectChannel("none")}
          className={cn(
            "rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-soft",
            selectedChannel === "none" && "bg-surface-soft font-medium",
          )}
        >
          Không gắn kênh
        </button>
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => selectChannel(c.id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-soft",
              selectedChannel === c.id && "bg-surface-soft font-medium",
            )}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} />
            {c.name}
          </button>
        ))}
      </div>
    );
  }

  function renderSourceFilterList() {
    return (
      <div className="flex flex-col gap-1">
        {SOURCE_OPTIONS.map((s) => (
          <label key={s.slug} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-soft">
            <Checkbox checked={selectedSources.includes(s.slug)} onCheckedChange={() => toggleSource(s.slug)} />
            {s.label}
          </label>
        ))}
      </div>
    );
  }

  return (
    <>
      {/* Toolbar desktop */}
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mô tả…" className="w-full max-w-xs" />
        <Popover>
          <PopoverTrigger className={popoverTriggerClass}>{categoryLabel}</PopoverTrigger>
          <PopoverContent className="w-56">{renderCategoryFilterList()}</PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger className={popoverTriggerClass}>{channelLabel}</PopoverTrigger>
          <PopoverContent className="w-56">{renderChannelFilterList()}</PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger className={popoverTriggerClass}>{sourceLabel}</PopoverTrigger>
          <PopoverContent className="w-48">{renderSourceFilterList()}</PopoverContent>
        </Popover>
        {hasAnyFilter && (
          <button type="button" onClick={clearFilters} className="text-sm text-primary hover:underline">
            Xóa lọc
          </button>
        )}
      </div>

      {/* Toolbar mobile */}
      <div className="flex items-center gap-2 md:hidden">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mô tả…" className="w-full" />
        <Button type="button" variant="outline" size="sm" onClick={() => setMobileOpen(true)}>
          <Filter className="size-4" />
          Lọc{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
        </Button>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Bộ lọc</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Danh mục</p>
              {renderCategoryFilterList()}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Kênh</p>
              {renderChannelFilterList()}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Nguồn</p>
              {renderSourceFilterList()}
            </div>
          </div>
          <SheetFooter>
            {hasAnyFilter && (
              <Button type="button" variant="ghost" onClick={clearFilters}>
                Xóa lọc
              </Button>
            )}
            <Button type="button" onClick={() => setMobileOpen(false)}>
              Xong
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
