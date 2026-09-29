"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  clampDateRange,
  isSameDateRangeSelection,
  normalizeCustomRange,
  parseDateRange,
  resolveRangePreset,
  selectionFromQuery,
  serializeDateRange,
  type DateRange,
  type DateRangeSelection,
  type RangePreset,
} from "@/lib/date-range";

// `_v2` từ 29/09: khoá cũ có thể đang giữ khoảng ngày drill bị ghi nhầm (lỗi race sau #246, LIVE
// 28/09 17:2x → bản vá) — đổi khoá để mọi máy về "Tháng này" đúng một lần thay vì mang tiếp giá trị
// bẩn; khoá cũ bị xoá ở lượt khởi động.
const STORAGE_KEY = "hogikids_date_range_v2";
const STORAGE_KEY_CU = "hogikids_date_range";
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
   * to pre-normalize (see `normalizeCustomRange`). Chỉ gọi khi người dùng CHỌN
   * (bộ chọn chung, bộ chọn tháng P&L) — nó ghi localStorage.
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
 * Lựa chọn khởi động phía client: `?tu=&den=` > `?range=` > localStorage.
 * `null` = không nguồn nào nói gì ⇒ giữ mặc định. Chỉ gọi trong effect (cần window).
 */
function readInitialSelection(): DateRangeSelection | null {
  const query = new URLSearchParams(window.location.search);
  const fromUrl = selectionFromQuery({
    tu: query.get("tu") ?? undefined,
    den: query.get("den") ?? undefined,
    range: query.get("range") ?? undefined,
  });
  if (fromUrl) {
    return fromUrl;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const stored = JSON.parse(raw) as StoredSelection;
    if (stored.preset === "custom") {
      const parsed = parseDateRange({ tu: stored.tu, den: stored.den });
      return parsed ? { preset: "custom", range: parsed } : null;
    }
    return { preset: stored.preset, range: resolveRangePreset(stored.preset) };
  } catch {
    // Malformed localStorage payload — fall back to the default.
    return null;
  }
}

/** Ghi lựa chọn CÓ CHỦ Ý của người dùng. Chỉ gọi từ selectPreset/applyCustomRange. */
function ghiLuaChonCoChuY(toStore: StoredSelection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch {
    // Trình duyệt chặn storage (chế độ riêng tư…) — lựa chọn vẫn áp cho phiên này.
  }
}

/**
 * Holds the single, app-wide date-range selection shared by every screen
 * that has the global picker. Mounted once in `(app)/layout.tsx` so
 * client-side navigation between applicable routes keeps the same
 * in-memory selection — no per-page state.
 *
 * HỢP ĐỒNG LƯU (chủ shop chốt 29/09): URL là NGỮ CẢNH điều hướng/chia sẻ, localStorage
 * CHỈ phản ánh lựa chọn CÓ CHỦ Ý trong bộ chọn.
 * - `?tu=&den=` / `?range=` (link chia sẻ, drill, F5 khi URL còn tham số) quyết định nhãn
 *   đang hiển thị cho lần mở đó nhưng KHÔNG BAO GIỜ ghi localStorage ⇒ mở lại app URL sạch
 *   về lựa chọn đã lưu, chưa lưu gì thì "Tháng này".
 * - localStorage chỉ được ghi TRỰC TIẾP trong selectPreset/applyCustomRange (người dùng bấm),
 *   KHÔNG qua effect: effect lưu "mọi thay đổi selection" từng phải đoán thay đổi nào đến từ
 *   URL bằng cờ, và cờ đó bị tiêu nhầm khi drill bấm trước khi lượt khởi động (startTransition)
 *   commit ⇒ khoảng ngày drill dính sang phiên sau.
 *
 * Persistence strategy (deliberate, see Task 5 report for the "why"):
 * - Named presets (today/7d/this_month/last_month) persist to localStorage
 *   only (on explicit selection). They resolve relative to "now", so the URL never needs to carry
 *   raw dates for them — and NOT touching the URL for the common case keeps
 *   a plain page load at "/" free of query-string noise.
 * - A custom ("Tùy chọn") range additionally syncs into `?tu=&den=`, since
 *   that's the one case with no named identity to fall back to — the raw
 *   dates in the URL make it shareable/bookmarkable and survive refresh.
 * - Switching FROM a custom range back to a named preset actively strips
 *   any `tu`/`den` left over in the URL, so a later refresh can't
 *   accidentally resurrect the stale custom dates over the preset.
 *
 * Provider nằm TRÊN boundary `(app)/loading.tsx`. Mọi cập nhật do effect tự
 * phát (không phải người dùng bấm) CHỈ xảy ra khi giá trị THẬT SỰ khác
 * (`isSameDateRangeSelection`), và lượt khởi động đi qua `startTransition`:
 * context đổi bằng cập nhật thường khi boundary còn khử nước sẽ khiến React bỏ
 * HTML server và render lại cả trang ở client; cập nhật transition thì React
 * chờ boundary khử nước xong rồi mới áp.
 */
export function DateRangeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [selection, setSelection] = useState<DateRangeSelection>(() => ({
    preset: DEFAULT_PRESET,
    range: resolveRangePreset(DEFAULT_PRESET),
  }));
  const [hasHydrated, setHasHydrated] = useState(false);

  // Bản sao lựa chọn ĐÃ COMMIT, để các effect so giá trị mà không phải khai
  // `selection` vào deps (khai vào thì effect đồng bộ URL chạy lại mỗi lần user
  // chọn và kéo ngược về tham số URL cũ). Effect này khai TRƯỚC các effect đọc
  // nó ⇒ trong cùng một lượt commit, bản sao luôn mới trước khi bị đọc.
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  // Runs once on mount: `?tu=&den=` in the current URL wins over `?range=`,
  // which wins over localStorage, which wins over the "this_month" default.
  // Deferred to an effect (not the useState initializer) so the very first
  // client render matches the server-rendered default — no hydration
  // mismatch — since window/localStorage aren't available during SSR anyway.
  // Deliberately does NOT write back to the URL here — only explicit user
  // actions (selectPreset/applyCustomRange) do that; see file header. Cũng KHÔNG
  // ghi localStorage: lựa chọn đọc từ URL chỉ là ngữ cảnh của lần mở này.
  useEffect(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY_CU); // dọn khoá cũ (xem STORAGE_KEY)
    } catch {
      // storage bị chặn — không có gì để dọn.
    }
    const next = readInitialSelection();
    startTransition(() => {
      if (next && !isSameDateRangeSelection(selectionRef.current, next)) {
        setSelection(next);
      }
      // Cùng transition với lựa chọn ⇒ hai effect bên dưới (đều chờ cờ này)
      // thấy ngay lựa chọn khởi động, không thấy mặc định tạm.
      setHasHydrated(true);
    });
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
  // đúng lựa chọn đó ⇒ trùng giá trị ⇒ bỏ qua) nên không tạo vòng lặp.
  useEffect(() => {
    if (!hasHydrated) {
      return; // để effect mount quyết trước (URL > localStorage > default).
    }
    const next = selectionFromQuery({
      tu: searchParams.get("tu") ?? undefined,
      den: searchParams.get("den") ?? undefined,
      range: searchParams.get("range") ?? undefined,
    });
    if (!next || isSameDateRangeSelection(selectionRef.current, next)) {
      return; // URL sạch, hoặc đã khớp lựa chọn hiện tại → không đụng state.
    }
    setSelection(next); // chỉ hiển thị — KHÔNG ghi localStorage (hợp đồng lưu ở header).
  }, [searchParams, hasHydrated]);

  const selectPreset = useCallback(
    (nextPreset: RangePreset) => {
      setSelection({ preset: nextPreset, range: resolveRangePreset(nextPreset) });
      ghiLuaChonCoChuY({ preset: nextPreset });

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
      setSelection({ preset: "custom", range: clamped });
      ghiLuaChonCoChuY({ preset: "custom", ...serializeDateRange(clamped) });

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
      preset: selection.preset,
      range: selection.range,
      isApplicableRoute: isApplicablePathname(pathname),
      selectPreset,
      applyCustomRange,
    }),
    [selection, pathname, selectPreset, applyCustomRange]
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
