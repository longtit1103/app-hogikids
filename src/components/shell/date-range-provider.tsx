"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  clampDateRange,
  isRangePreset,
  normalizeCustomRange,
  parseDateRange,
  resolveRangePreset,
  serializeDateRange,
  type DateRange,
  type RangePreset,
} from "@/lib/date-range";

const STORAGE_KEY = "hogikids_date_range";
const DEFAULT_PRESET: RangePreset = "this_month";

/** Shape persisted to localStorage — either a named preset or a custom range. */
type StoredSelection = { preset: RangePreset } | { preset: "custom"; tu: string; den: string };

type DateRangeContextValue = {
  /** Currently selected preset, or "custom" when a manual range is applied. */
  preset: RangePreset | "custom";
  /** Resolved concrete [from, to] for the current selection. */
  range: DateRange;
  /** Whether the current route is one that shows the global picker (Dashboard, Tài chính, Kênh*, Báo cáo, Marketing). */
  isApplicableRoute: boolean;
  /** Switches to a named preset (today/7d/this_month/last_month). */
  selectPreset: (preset: RangePreset) => void;
  /**
   * Applies a validated custom range from the "Tùy chọn" popover. Normalizes
   * `from`/`to` to full-day boundaries before applying — callers do not need
   * to pre-normalize (see `normalizeCustomRange`).
   */
  applyCustomRange: (range: DateRange) => void;
};

const DateRangeContext = createContext<DateRangeContextValue | null>(null);

// Routes that show the global date-range picker: "/", "/tai-chinh",
// "/kenh" (+ nested "/kenh/*"), "/bao-cao", "/marketing". "/" is checked exactly elsewhere.
// Hub Tài chính (/tai-chinh) MUST be here or its month/range picker is dead
// (selectPreset/applyCustomRange early-return without writing the URL).
const APPLICABLE_ROUTE_PREFIXES = ["/tai-chinh", "/kenh", "/bao-cao", "/marketing"];

function isApplicablePathname(pathname: string): boolean {
  if (pathname === "/") {
    return true;
  }
  return APPLICABLE_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Holds the single, app-wide date-range selection shared by every screen
 * that has the global picker. Mounted once in `(app)/layout.tsx` so
 * client-side navigation between applicable routes keeps the same
 * in-memory selection — no per-page state.
 *
 * Persistence strategy (deliberate, see Task 5 report for the "why"):
 * - Named presets (today/7d/this_month/last_month) persist to localStorage
 *   only. They resolve relative to "now", so the URL never needs to carry
 *   raw dates for them — and NOT touching the URL for the common case keeps
 *   a plain page load at "/" free of query-string noise.
 * - A custom ("Tùy chọn") range additionally syncs into `?tu=&den=`, since
 *   that's the one case with no named identity to fall back to — the raw
 *   dates in the URL make it shareable/bookmarkable and survive refresh.
 * - Switching FROM a custom range back to a named preset actively strips
 *   any `tu`/`den` left over in the URL, so a later refresh can't
 *   accidentally resurrect the stale custom dates over the preset.
 */
export function DateRangeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [preset, setPreset] = useState<RangePreset | "custom">(DEFAULT_PRESET);
  const [range, setRangeState] = useState<DateRange>(() => resolveRangePreset(DEFAULT_PRESET));
  const [hasHydrated, setHasHydrated] = useState(false);

  // Đánh dấu lần cập nhật state gần nhất là do ĐỒNG BỘ TỪ URL (điều hướng
  // client-side, vd drill-down) — KHÔNG phải user chủ động chọn ở picker. Effect
  // persist đọc cờ này để KHÔNG ghi range drill vào localStorage (tránh biến một
  // lần drill thoáng qua thành lựa chọn mặc định dính cho phiên sau). selectPreset
  // /applyCustomRange set state TRỰC TIẾP nên persist chạy trước echo-URL → vẫn lưu.
  const adoptedFromUrlRef = useRef(false);

  // Runs once on mount: `?tu=&den=` in the current URL wins over
  // localStorage, which wins over the "this_month" default. Deferred to an
  // effect (not the useState initializer) so the very first client render
  // matches the server-rendered default — no hydration mismatch — since
  // window/localStorage aren't available during SSR anyway. Deliberately
  // does NOT write back to the URL here — only explicit user actions
  // (selectPreset/applyCustomRange) do that; see file header.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const fromQuery = parseDateRange({
      tu: query.get("tu") ?? undefined,
      den: query.get("den") ?? undefined,
    });
    if (fromQuery) {
      setPreset("custom");
      setRangeState(fromQuery);
      setHasHydrated(true);
      return;
    }

    // `?range=<preset>` trong URL thắng localStorage (chia sẻ link/refresh giữ đúng preset).
    const rangeParam = query.get("range");
    if (isRangePreset(rangeParam)) {
      setPreset(rangeParam);
      setRangeState(resolveRangePreset(rangeParam));
      setHasHydrated(true);
      return;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as StoredSelection;
        if (stored.preset === "custom") {
          const parsed = parseDateRange({ tu: stored.tu, den: stored.den });
          if (parsed) {
            setPreset("custom");
            setRangeState(parsed);
            setHasHydrated(true);
            return;
          }
        } else {
          setPreset(stored.preset);
          setRangeState(resolveRangePreset(stored.preset));
          setHasHydrated(true);
          return;
        }
      }
    } catch {
      // Malformed localStorage payload — fall through to the default below.
    }

    setHasHydrated(true);
    // Intentionally mount-only (deps: []).
  }, []);

  // Sau mount: điều hướng client-side (soft) có thể đổi `?tu=&den=` hoặc
  // `?range=` mà KHÔNG đi qua selectPreset/applyCustomRange — điển hình là link
  // drill-down P&L → Sổ chi phí gắn sẵn tu/den (`resolvePnlDrillHref`). Effect
  // mount chỉ chạy 1 lần nên nhãn picker sẽ kẹt ở lựa chọn cũ. Đồng bộ lại state
  // theo URL mỗi khi query đổi để nhãn khớp dữ liệu đang hiển thị.
  //
  // QUAN TRỌNG: URL sạch (không tu/den, không range) thì GIỮ NGUYÊN lựa chọn
  // in-memory (tính "dính" khi điều hướng bằng nav thường giữa các trang có
  // picker) — chỉ nhận khi URL MANG tham số ngày rõ ràng. Idempotent với chính
  // selectPreset/applyCustomRange (chúng cũng ghi URL rồi effect này đọc lại ra
  // đúng lựa chọn đó) nên không tạo vòng lặp.
  useEffect(() => {
    if (!hasHydrated) {
      return; // để effect mount quyết trước (URL > localStorage > default).
    }
    const fromQuery = parseDateRange({
      tu: searchParams.get("tu") ?? undefined,
      den: searchParams.get("den") ?? undefined,
    });
    if (fromQuery) {
      adoptedFromUrlRef.current = true;
      setPreset("custom");
      setRangeState(fromQuery);
      return;
    }
    const rangeParam = searchParams.get("range");
    if (isRangePreset(rangeParam)) {
      adoptedFromUrlRef.current = true;
      setPreset(rangeParam);
      setRangeState(resolveRangePreset(rangeParam));
    }
    // URL sạch → không đụng state (giữ lựa chọn hiện tại).
  }, [searchParams, hasHydrated]);

  // Persists every selection to localStorage (never touches the URL —
  // see selectPreset/applyCustomRange for the URL-sync side of this).
  useEffect(() => {
    if (!hasHydrated) {
      return;
    }
    // Lựa chọn vừa đồng bộ TỪ URL (drill-down/link chia sẻ) không phải ý định
    // đổi range toàn cục của user → bỏ qua 1 lần, không ghi localStorage.
    if (adoptedFromUrlRef.current) {
      adoptedFromUrlRef.current = false;
      return;
    }
    const toStore: StoredSelection =
      preset === "custom" ? { preset: "custom", ...serializeDateRange(range) } : { preset };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  }, [preset, range, hasHydrated]);

  const selectPreset = useCallback(
    (nextPreset: RangePreset) => {
      setPreset(nextPreset);
      setRangeState(resolveRangePreset(nextPreset));

      if (!isApplicablePathname(pathname)) {
        return;
      }

      // Đẩy preset LÊN URL (`?range=`) để trang render-ở-server đọc được và
      // re-render theo lựa chọn — thiếu bước này mọi trang kẹt ở this_month.
      // Bỏ tu/den của range "Tùy chọn" cũ. Preset mặc định this_month ⇒ URL sạch
      // (xoá `range`). LUÔN router.replace ⇒ có điều hướng ⇒ server chạy lại.
      const params = new URLSearchParams(window.location.search);
      params.delete("tu");
      params.delete("den");
      if (nextPreset === DEFAULT_PRESET) {
        params.delete("range");
      } else {
        params.set("range", nextPreset);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router]
  );

  const applyCustomRange = useCallback(
    (nextRange: DateRange) => {
      const clamped = clampDateRange(normalizeCustomRange(nextRange));
      setPreset("custom");
      setRangeState(clamped);

      if (isApplicablePathname(pathname)) {
        const { tu, den } = serializeDateRange(clamped);
        const params = new URLSearchParams(window.location.search);
        params.set("tu", tu);
        params.set("den", den);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }
    },
    [pathname, router]
  );

  const value = useMemo<DateRangeContextValue>(
    () => ({
      preset,
      range,
      isApplicableRoute: isApplicablePathname(pathname),
      selectPreset,
      applyCustomRange,
    }),
    [preset, range, pathname, selectPreset, applyCustomRange]
  );

  return <DateRangeContext.Provider value={value}>{children}</DateRangeContext.Provider>;
}

export function useDateRange(): DateRangeContextValue {
  const ctx = useContext(DateRangeContext);
  if (!ctx) {
    throw new Error("useDateRange must be used within a DateRangeProvider");
  }
  return ctx;
}
