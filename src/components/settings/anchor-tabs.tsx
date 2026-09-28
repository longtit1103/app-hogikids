"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type AnchorTab = { id: string; label: string };

/**
 * Hàng anchor-tabs của `/cai-dat`: click cuộn mượt tới section; tab active
 * theo section đang chiếm phần lớn viewport (`IntersectionObserver`, không
 * đợi scroll event thủ công). Ẩn dưới 768px — mobile các section xếp dọc
 * cuộn tự nhiên, không có anchor-nav (design-spec 05, mục Page header).
 */
export function AnchorTabs({ tabs }: { tabs: AnchorTab[] }) {
  const [activeId, setActiveId] = useState(tabs[0]?.id ?? "");
  const ratiosRef = useRef(new Map<string, number>());

  useEffect(() => {
    const sections = tabs
      .map((tab) => document.getElementById(tab.id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    // rootMargin âm ở đáy: section chỉ tính "đang xem" khi phần trên của nó
    // nằm trong ~45% trên cùng viewport — tránh tab nhảy lung tung khi 2
    // section liền kề cùng lấp đầy màn hình.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratiosRef.current.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        let bestId: string | null = null;
        let bestRatio = 0;
        for (const tab of tabs) {
          const ratio = ratiosRef.current.get(tab.id) ?? 0;
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = tab.id;
          }
        }
        if (bestId) setActiveId(bestId);
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
    );

    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [tabs]);

  function handleClick(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav className="hidden flex-wrap gap-1 md:flex" aria-label="Điều hướng nhanh Cài đặt">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => handleClick(tab.id)}
          aria-current={activeId === tab.id ? "true" : undefined}
          className={cn(
            "rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
            activeId === tab.id
              ? "bg-primary text-on-primary"
              : "text-muted-foreground hover:bg-surface-soft hover:text-ink"
          )}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
