// @vitest-environment jsdom
/**
 * Ô tìm kiếm đồng bộ `?q=` (Sản phẩm, Tồn kho, Đơn hàng, Đơn của kênh, Sổ chi phí dùng chung một hook):
 *  - hết 300ms chờ gõ thì dựng URL từ URL HIỆN TẠI — bộ lọc bấm trong lúc chờ không bị ghi đè;
 *  - URL đổi `q` từ ngoài (Back/Forward) kéo ô nhập theo;
 *  - URL chạy chậm hơn người gõ không được ghi đè chữ đang gõ.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKhiDoiQ, useOTimKiemUrl } from "@/components/shell/use-o-tim-kiem-url";

const nav = vi.hoisted(() => ({
  search: "",
  cache: new Map<string, URLSearchParams>(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/san-pham",
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
}));

/** Đặt URL của trình duyệt (và bản `useSearchParams` giả) — mô phỏng người dùng/Next đổi URL. */
function datUrl(search: string) {
  nav.search = search;
  window.history.replaceState(null, "", `/san-pham${search ? `?${search}` : ""}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  nav.replace.mockClear();
  datUrl("");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("queryKhiDoiQ", () => {
  it("giữ bộ lọc khác, đặt q và bỏ trang", () => {
    expect(queryKhiDoiQ("loc=sap_het&trang=3", "áo")).toBe(`loc=sap_het&q=${encodeURIComponent("áo")}`);
  });

  it("q rỗng thì xoá q", () => {
    expect(queryKhiDoiQ("q=abc&loc=x", "")).toBe("loc=x");
  });
});

describe("useOTimKiemUrl", () => {
  it("URL tại lúc hết giờ chờ, không phải URL lúc bắt đầu gõ: bộ lọc bấm trong 300ms được giữ", () => {
    datUrl("loc=sap_het");
    const { result } = renderHook(() => useOTimKiemUrl());
    act(() => result.current.setQ("ao"));
    // Giữa lúc chờ, người dùng bấm thêm bộ lọc ⇒ URL đã đổi, hook chưa kịp render lại.
    window.history.replaceState(null, "", "/san-pham?loc=sap_het&trang_thai=huy_bom");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith("/san-pham?loc=sap_het&trang_thai=huy_bom&q=ao");
  });

  it("đổi q luôn đưa về trang 1", () => {
    datUrl("trang=4");
    const { result } = renderHook(() => useOTimKiemUrl());
    act(() => result.current.setQ("ao"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(nav.replace).toHaveBeenCalledWith("/san-pham?q=ao");
  });

  it("chưa đủ 300ms thì chưa ghi URL; gõ tiếp thì đếm lại", () => {
    const { result } = renderHook(() => useOTimKiemUrl());
    act(() => result.current.setQ("a"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => result.current.setQ("ab"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(nav.replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith("/san-pham?q=ab");
  });

  it("scroll: false được chuyển cho router.replace", () => {
    const { result } = renderHook(() => useOTimKiemUrl({ scroll: false }));
    act(() => result.current.setQ("a"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(nav.replace).toHaveBeenCalledWith("/san-pham?q=a", { scroll: false });
  });

  it("Back/Forward đổi q trên URL ⇒ ô nhập theo", () => {
    datUrl("q=ao");
    const { result, rerender } = renderHook(() => useOTimKiemUrl());
    expect(result.current.q).toBe("ao");
    datUrl("");
    rerender();
    expect(result.current.q).toBe("");
    datUrl("q=quan");
    rerender();
    expect(result.current.q).toBe("quan");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("URL đuổi kịp lần đẩy cũ trong khi người dùng gõ tiếp ⇒ KHÔNG ghi đè chữ đang gõ", () => {
    const { result, rerender } = renderHook(() => useOTimKiemUrl());
    act(() => result.current.setQ("a"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(nav.replace).toHaveBeenCalledWith("/san-pham?q=a");
    // Người dùng gõ tiếp trước khi URL kịp cập nhật…
    act(() => result.current.setQ("ab"));
    // …rồi URL của lần đẩy trước mới tới.
    datUrl("q=a");
    rerender();
    expect(result.current.q).toBe("ab");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(nav.replace).toHaveBeenLastCalledWith("/san-pham?q=ab");
  });

  it("sau khi URL đuổi kịp, Back về đúng giá trị đã đẩy vẫn kéo ô nhập theo", () => {
    const { result, rerender } = renderHook(() => useOTimKiemUrl());
    act(() => result.current.setQ("a"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    datUrl("q=a");
    rerender();
    act(() => result.current.setQ("ab"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    datUrl("q=ab");
    rerender();
    // Back về q=a: không còn là lần đẩy đang chờ ⇒ phải đồng bộ.
    datUrl("q=a");
    rerender();
    expect(result.current.q).toBe("a");
  });

  it("giá trị đẩy trước bị lần đẩy sau gộp mất (URL nhảy thẳng sang giá trị sau) không nuốt nhầm lần Back về nó", () => {
    const { result, rerender } = renderHook(() => useOTimKiemUrl());
    act(() => result.current.setQ("a"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // URL chưa kịp hiện q=a thì người dùng gõ tiếp và lần đẩy thứ hai tới.
    act(() => result.current.setQ("ab"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(nav.replace).toHaveBeenLastCalledWith("/san-pham?q=ab");
    // URL nhảy thẳng tới q=ab (q=a chưa từng hiện ra).
    datUrl("q=ab");
    rerender();
    expect(result.current.q).toBe("ab");
    // Back về q=a là thay đổi từ ngoài ⇒ ô nhập phải theo, không bị coi là lần đẩy còn sót.
    datUrl("q=a");
    rerender();
    expect(result.current.q).toBe("a");
  });
});
