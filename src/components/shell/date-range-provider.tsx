"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { luuLuaChonKhoangNgay } from "@/lib/actions/khoang-ngay";
import {
  clampDateRange,
  normalizeCustomRange,
  resolveRangePreset,
  selectionFromQuery,
  serializeDateRange,
  type DateRange,
  type DateRangeSelection,
  type RangePreset,
} from "@/lib/date-range";
import { luaChonTuDangChuan, type LuaChonDaLuu } from "@/lib/date-range-cookie";

const DEFAULT_PRESET: RangePreset = "this_month";

/** Khoá localStorage của các bản trước #254 — chỉ còn để dọn một lần, KHÔNG đọc/ghi nữa. */
const KHOA_LOCAL_STORAGE_CU = ["hogikids_date_range", "hogikids_date_range_v2"];

/** Tham số ngày trên URL = ngữ cảnh tạm (drill/link chia sẻ); thắng lựa chọn đã lưu khi có mặt. */
const THAM_SO_NGAY = ["tu", "den", "range"] as const;

/**
 * Kênh báo các TAB KHÁC của app rằng lựa chọn đã lưu vừa đổi. Layout `(app)` dùng chung nên không
 * render lại khi soft-nav: tab khác giữ prop `luaChonDaLuu` cũ trong khi server đã đọc cookie mới ⇒
 * nhãn lệch số (đúng loại lỗi #254). Nhận tin ⇒ `router.refresh()` dựng lại layout + trang.
 */
const KENH_DONG_BO_TAB = "hogikids_khoang_ngay";

/** Lỗi chuyển hướng của Next — router tự điều hướng, không phải lỗi mạng. (Hết phiên thì action trả `ok: false`.) */
function laLoiChuyenHuong(loi: unknown): boolean {
  return (
    typeof loi === "object" &&
    loi !== null &&
    "digest" in loi &&
    typeof (loi as { digest: unknown }).digest === "string" &&
    (loi as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

type DateRangeContextValue = {
  /** Currently selected preset, or "custom" when a manual range is applied. */
  preset: RangePreset | "custom";
  /** Resolved concrete [from, to] for the current selection. */
  range: DateRange;
  /** Whether the current route is one that shows the global picker (Dashboard, Tài chính, Kênh*, Báo cáo, Marketing). */
  isApplicableRoute: boolean;
  /** Người dùng CHỌN preset (today/7d/this_month/last_month…) — lưu làm lựa chọn đã lưu. */
  selectPreset: (preset: RangePreset) => void;
  /**
   * Người dùng CHỌN khoảng tuỳ chọn ("Tùy chọn" / bộ chọn tháng Lãi/Lỗ) — lưu làm lựa chọn đã lưu.
   * Tự chuẩn hoá biên ngày + kẹp độ dài (see `normalizeCustomRange`).
   */
  applyCustomRange: (range: DateRange) => void;
  /** Đang lưu lựa chọn mới (chờ server dựng lại nhãn + số liệu cùng lúc). */
  dangCapNhat: boolean;
};

const DateRangeContext = createContext<DateRangeContextValue | null>(null);

// Routes that show the global date-range picker: "/", "/tai-chinh",
// "/kenh" (+ nested "/kenh/*"), "/bao-cao", "/marketing". "/" is checked exactly elsewhere.
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
 * Bộ chọn khoảng ngày toàn cục — HỢP ĐỒNG #254 (chủ shop chốt 29/09):
 *
 * - Lựa chọn hiển thị được SUY RA NGAY KHI RENDER theo cùng thứ tự server dựng số liệu:
 *   **URL (`?tu=&den=` > `?range=`) → lựa chọn đã lưu (cookie, prop `luaChonDaLuu` từ layout) →
 *   "Tháng này"**. `useSearchParams` và prop đều có sẵn ở SSR ⇒ HTML server và lượt vẽ client đầu
 *   giống hệt; không effect khởi động, không `startTransition` khởi động, không cờ đồng bộ — lớp lỗi
 *   race của #246 (cờ bị tiêu nhầm giữa hai effect) không còn chỗ tồn tại.
 * - URL/drill là ngữ cảnh tạm: đổi nhãn theo URL nhưng KHÔNG BAO GIỜ ghi. Sang URL sạch (menu, mở
 *   lại app) ⇒ về lựa chọn đã lưu.
 * - Chỉ `selectPreset`/`applyCustomRange` (người dùng chọn) ghi — qua Server Action set cookie. Nhãn
 *   KHÔNG đổi lạc quan trước khi server trả: action dựng lại layout (prop mới) + trang (số liệu mới)
 *   trong CÙNG lượt trả về ⇒ nhãn và số đổi cùng một commit. Đang chờ thì `dangCapNhat`.
 * - Đang đứng ở URL có tham số ngày mà chọn mới ⇒ bỏ tham số ngày khỏi URL (không thì URL vẫn thắng).
 */
export function DateRangeProvider({
  children,
  luaChonDaLuu,
}: {
  children: React.ReactNode;
  /** Lựa chọn đã lưu (cookie) server đã đọc + kiểm hình — cùng nguồn 6 trang dựng số liệu. */
  luaChonDaLuu?: LuaChonDaLuu | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [dangCapNhat, startTransition] = useTransition();

  const selection = useMemo<DateRangeSelection>(
    () =>
      selectionFromQuery({
        tu: searchParams.get("tu") ?? undefined,
        den: searchParams.get("den") ?? undefined,
        range: searchParams.get("range") ?? undefined,
      }) ??
      (luaChonDaLuu ? luaChonTuDangChuan(luaChonDaLuu) : null) ?? {
        preset: DEFAULT_PRESET,
        range: resolveRangePreset(DEFAULT_PRESET),
      },
    [searchParams, luaChonDaLuu]
  );

  // Dọn khoá localStorage của bản cũ đúng một lần. CHỈ xoá, không set state ⇒ không ảnh hưởng render.
  useEffect(() => {
    try {
      for (const khoa of KHOA_LOCAL_STORAGE_CU) window.localStorage.removeItem(khoa);
    } catch {
      // storage bị chặn — không có gì để dọn.
    }
  }, []);

  // Tab khác vừa lưu lựa chọn mới ⇒ dựng lại tab này (layout + trang) để nhãn khớp số.
  // MỘT object kênh cho cả gửi lẫn nghe: BroadcastChannel không trả tin về chính object gửi, nhưng
  // CÓ trả cho object khác cùng tên trong cùng tab ⇒ tách hai object là tab vừa lưu tự refresh thừa.
  const kenhRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const kenh = new BroadcastChannel(KENH_DONG_BO_TAB);
    kenh.onmessage = () => router.refresh();
    kenhRef.current = kenh;
    return () => {
      kenhRef.current = null;
      kenh.close();
    };
  }, [router]);

  const luuLuaChon = useCallback(
    (giaTri: string) => {
      const pathnameLucBam = window.location.pathname;
      startTransition(async () => {
        // Action có thể NÉM (mất mạng, server lỗi): lỗi thoát khỏi transition bất đồng bộ sẽ bị React
        // đẩy lên error boundary ⇒ cả trang thành màn lỗi. Bắt tại đây: báo lỗi, transition kết thúc ⇒
        // hết `dangCapNhat`; cookie + prop không đổi ⇒ nhãn và số liệu vẫn cùng lựa chọn CŨ.
        let kq: Awaited<ReturnType<typeof luuLuaChonKhoangNgay>>;
        try {
          kq = await luuLuaChonKhoangNgay(giaTri);
        } catch (loi) {
          // Lượt chuyển hướng của Next: router tự điều hướng, không báo "mất mạng".
          if (!laLoiChuyenHuong(loi)) toast.error("Không lưu được khoảng ngày — kiểm tra mạng rồi chọn lại.");
          return;
        }
        if (!kq.ok) {
          toast.error(kq.error);
          return;
        }
        try {
          kenhRef.current?.postMessage(giaTri);
        } catch {
          // Không báo được tab khác — tab này vẫn đúng; tab kia khớp lại ở lần tải kế tiếp.
        }
        // Đọc URL HIỆN TẠI sau `await` (không dùng pathname/searchParams chụp lúc bấm): người dùng có
        // thể đã bấm sang trang khác trong lúc chờ — thay URL cũ vào là kéo họ quay về.
        const hienTai = new URL(window.location.href);
        if (hienTai.pathname !== pathnameLucBam) return;
        if (!THAM_SO_NGAY.some((k) => hienTai.searchParams.has(k))) return;
        for (const k of THAM_SO_NGAY) hienTai.searchParams.delete(k);
        const qs = hienTai.searchParams.toString();
        router.replace(qs ? `${hienTai.pathname}?${qs}` : hienTai.pathname, { scroll: false });
      });
    },
    [router]
  );

  const selectPreset = useCallback((nextPreset: RangePreset) => luuLuaChon(nextPreset), [luuLuaChon]);

  const applyCustomRange = useCallback(
    (nextRange: DateRange) => {
      const { tu, den } = serializeDateRange(clampDateRange(normalizeCustomRange(nextRange)));
      luuLuaChon(`${tu}..${den}`);
    },
    [luuLuaChon]
  );

  const value = useMemo<DateRangeContextValue>(
    () => ({
      preset: selection.preset,
      range: selection.range,
      isApplicableRoute: isApplicablePathname(pathname),
      selectPreset,
      applyCustomRange,
      dangCapNhat,
    }),
    [selection, pathname, selectPreset, applyCustomRange, dangCapNhat]
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
