// @vitest-environment jsdom
/**
 * Hợp đồng lưu lựa chọn của bộ chọn khoảng ngày toàn cục (chủ shop chốt 29/09):
 *   - URL (`?tu=&den=`, `?range=`) là NGỮ CẢNH điều hướng/chia sẻ: quyết định nhãn đang hiển thị
 *     cho lần mở này (kể cả F5 khi URL còn tham số) nhưng KHÔNG BAO GIỜ ghi `localStorage`.
 *   - `localStorage` CHỈ phản ánh lựa chọn CÓ CHỦ Ý trong bộ chọn (preset / "Tùy chọn" / chọn tháng).
 *   - Mở lại app URL sạch ⇒ lựa chọn đã lưu, chưa lưu gì ⇒ "Tháng này".
 * Test đầu tái hiện TẤT ĐỊNH lỗi race của #246: URL đổi (drill soft-nav) trước khi lượt khởi động
 * (startTransition) commit ⇒ bản cũ ghi khoảng ngày drill vào localStorage.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DateRangeProvider, useDateRange } from "@/components/shell/date-range-provider";
import { serializeDateRange } from "@/lib/date-range";

const KHOA = "hogikids_date_range_v2";
const KHOA_CU = "hogikids_date_range";

// Điều hướng giả: `search` là thứ `useSearchParams()` trả (URL router đang giữ), tách khỏi
// `window.location` để dựng được đúng khe "router đã đổi URL, lượt khởi động còn đọc URL cũ".
const nav = vi.hoisted(() => ({
  pathname: "/tai-chinh",
  search: "",
  replace: vi.fn(),
  cache: new Map<string, URLSearchParams>(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
  // Cùng chuỗi ⇒ cùng object (như Next): tránh effect đồng bộ chạy lại vô cớ mỗi render.
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
}));

function HienThi() {
  const { preset, range, selectPreset, applyCustomRange } = useDateRange();
  const { tu, den } = serializeDateRange(range);
  return (
    <>
      <output data-testid="lua-chon">{`${preset}|${tu}|${den}`}</output>
      <button onClick={() => selectPreset("last_month")}>chon-thang-truoc</button>
      <button onClick={() => applyCustomRange({ from: new Date(2026, 6, 1), to: new Date(2026, 6, 31) })}>
        chon-tuy-chon
      </button>
    </>
  );
}

function moApp({ url, search }: { url: string; search?: string }) {
  window.history.replaceState(null, "", url);
  const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  nav.pathname = url.split("?")[0];
  nav.search = search ?? q;
  return render(
    <DateRangeProvider>
      <HienThi />
    </DateRangeProvider>,
  );
}

const luaChon = () => screen.getByTestId("lua-chon").textContent;
const daLuu = () => window.localStorage.getItem(KHOA);

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockClear();
});
afterEach(() => cleanup());

describe("bộ chọn khoảng ngày — URL là ngữ cảnh, localStorage chỉ giữ lựa chọn có chủ ý", () => {
  it("drill soft-nav đổi URL TRƯỚC khi lượt khởi động commit: hiện khoảng drill, KHÔNG ghi localStorage", () => {
    // window.location còn sạch (lượt khởi động đọc ra "không có gì"), router đã mang tu/den của drill.
    moApp({ url: "/tai-chinh?tab=loi-lo", search: "tab=loi-lo&tu=2026-09-01&den=2026-09-30" });
    expect(luaChon()).toBe("custom|2026-09-01|2026-09-30");
    expect(daLuu()).toBeNull();
  });

  it("mở trang có ?tu=&den=: hiện đúng khoảng đó, KHÔNG ghi localStorage; F5 còn tham số vẫn hiện", () => {
    const lan1 = moApp({ url: "/bao-cao?tab=san-pham&tu=2026-08-01&den=2026-08-31" });
    expect(luaChon()).toBe("custom|2026-08-01|2026-08-31");
    lan1.unmount();
    moApp({ url: "/bao-cao?tab=san-pham&tu=2026-08-01&den=2026-08-31" }); // F5
    expect(luaChon()).toBe("custom|2026-08-01|2026-08-31");
    expect(daLuu()).toBeNull();
  });

  it("mở lại app URL sạch sau một lần drill: về lựa chọn ĐÃ LƯU, không kẹt khoảng drill", () => {
    window.localStorage.setItem(KHOA, JSON.stringify({ preset: "7d" }));
    const drill = moApp({ url: "/bao-cao?tab=san-pham&tu=2026-08-01&den=2026-08-31" });
    expect(luaChon()).toBe("custom|2026-08-01|2026-08-31");
    drill.unmount();
    moApp({ url: "/" });
    expect(luaChon()?.startsWith("7d|")).toBe(true);
    expect(daLuu()).toBe(JSON.stringify({ preset: "7d" }));
  });

  it("chưa từng chọn + URL sạch ⇒ 'Tháng này', và không tự ghi gì", () => {
    moApp({ url: "/" });
    expect(luaChon()?.startsWith("this_month|")).toBe(true);
    expect(daLuu()).toBeNull();
  });

  it("chọn preset trong bộ chọn ⇒ LƯU + đẩy ?range= lên URL", () => {
    moApp({ url: "/kenh" });
    act(() => screen.getByText("chon-thang-truoc").click());
    expect(daLuu()).toBe(JSON.stringify({ preset: "last_month" }));
    expect(nav.replace).toHaveBeenCalledWith("/kenh?range=last_month", { scroll: false });
  });

  it("chọn 'Tùy chọn' trong bộ chọn ⇒ LƯU khoảng ngày", () => {
    moApp({ url: "/kenh" });
    act(() => screen.getByText("chon-tuy-chon").click());
    expect(daLuu()).toBe(JSON.stringify({ preset: "custom", tu: "2026-07-01", den: "2026-07-31" }));
  });

  it("mở link mang ?range=: hiện đúng preset đó, KHÔNG ghi localStorage", () => {
    moApp({ url: "/marketing?range=last_month" });
    expect(luaChon()?.startsWith("last_month|")).toBe(true);
    expect(daLuu()).toBeNull();
  });

  it("soft-nav đổi ?range= sau khi đã khởi động: đổi nhãn, giữ nguyên lựa chọn đã lưu", () => {
    window.localStorage.setItem(KHOA, JSON.stringify({ preset: "today" }));
    const app = moApp({ url: "/kenh" });
    expect(luaChon()?.startsWith("today|")).toBe(true);
    nav.search = "range=7d";
    app.rerender(
      <DateRangeProvider>
        <HienThi />
      </DateRangeProvider>,
    );
    expect(luaChon()?.startsWith("7d|")).toBe(true);
    expect(daLuu()).toBe(JSON.stringify({ preset: "today" }));
  });

  it("khoá cũ (có thể giữ khoảng drill ghi nhầm trước bản vá) bị bỏ qua và xoá ⇒ về 'Tháng này'", () => {
    window.localStorage.setItem(KHOA_CU, JSON.stringify({ preset: "custom", tu: "2026-09-01", den: "2026-09-30" }));
    moApp({ url: "/" });
    expect(luaChon()?.startsWith("this_month|")).toBe(true);
    expect(window.localStorage.getItem(KHOA_CU)).toBeNull();
  });
});
