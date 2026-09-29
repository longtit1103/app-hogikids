// @vitest-environment jsdom
/**
 * Hợp đồng bộ chọn khoảng ngày toàn cục (#254, chủ shop chốt 29/09):
 *   - Thứ tự: URL (`?tu=&den=` > `?range=`) → lựa chọn đã lưu (cookie, prop từ layout) → "Tháng này".
 *   - Lựa chọn SUY RA NGAY KHI RENDER: HTML server đã mang đúng nhãn (không effect khởi động).
 *   - URL/drill KHÔNG BAO GIỜ ghi; chỉ chọn có chủ ý (selectPreset/applyCustomRange) mới gọi action
 *     ghi cookie. Nhãn KHÔNG đổi lạc quan: đổi khi server trả prop mới (cùng commit với số liệu).
 *   - Không còn localStorage (khoá cũ chỉ bị dọn).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DateRangeProvider, useDateRange } from "@/components/shell/date-range-provider";
import { serializeDateRange } from "@/lib/date-range";
import type { ActionResult } from "@/lib/actions/action-result";
import type { LuaChonDaLuu } from "@/lib/date-range-cookie";

// Điều hướng giả: `search` là thứ `useSearchParams()` trả (URL router đang giữ), tách khỏi
// `window.location` để dựng được khe "router đã đổi URL, trang còn URL cũ" của race #246.
const nav = vi.hoisted(() => ({
  pathname: "/tai-chinh",
  search: "",
  replace: vi.fn(),
  refresh: vi.fn(),
  cache: new Map<string, URLSearchParams>(),
}));
const routerGia = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  // Cùng một object router cho mọi lượt render (như Next) — effect nghe kênh tab không bị dựng lại.
  useRouter: () => (routerGia.value ??= { replace: nav.replace, push: vi.fn(), refresh: nav.refresh }),
  // Cùng chuỗi ⇒ cùng object (như Next).
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
}));

const action = vi.hoisted(() => ({
  luu: vi.fn(async (_giaTri: string): Promise<ActionResult<null>> => ({ ok: true, data: null })),
}));
vi.mock("@/lib/actions/khoang-ngay", () => ({ luuLuaChonKhoangNgay: action.luu }));

const toastLoi = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastLoi } }));

function HienThi() {
  const { preset, range, selectPreset, applyCustomRange, dangCapNhat } = useDateRange();
  const { tu, den } = serializeDateRange(range);
  return (
    <>
      <output data-testid="lua-chon">{`${preset}|${tu}|${den}`}</output>
      <output data-testid="dang-cap-nhat">{String(dangCapNhat)}</output>
      <button onClick={() => selectPreset("last_month")}>chon-thang-truoc</button>
      <button onClick={() => applyCustomRange({ from: new Date(2026, 6, 1), to: new Date(2026, 6, 31) })}>
        chon-tuy-chon
      </button>
    </>
  );
}

function cay(daLuu: LuaChonDaLuu | null) {
  return (
    <DateRangeProvider luaChonDaLuu={daLuu}>
      <HienThi />
    </DateRangeProvider>
  );
}

function datUrl(url: string, search?: string) {
  window.history.replaceState(null, "", url);
  nav.pathname = url.split("?")[0];
  nav.search = search ?? (url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
}

const luaChon = () => screen.getByTestId("lua-chon").textContent ?? "";

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockClear();
  nav.refresh.mockClear();
  action.luu.mockClear();
  action.luu.mockImplementation(async () => ({ ok: true, data: null }));
  toastLoi.mockClear();
});
afterEach(() => cleanup());

describe("suy ra lựa chọn khi render — URL → đã lưu → 'Tháng này'", () => {
  it("HTML SERVER đã mang lựa chọn đã lưu (không cần effect khởi động)", () => {
    datUrl("/");
    const html = renderToString(cay({ preset: "7d" }));
    expect(html).toContain("7d|");
  });

  it("lượt vẽ client đầu = HTML server (không lệch hydrate, không vẽ sai rồi tự sửa)", () => {
    datUrl("/kenh");
    const html = renderToString(cay({ preset: "last_month" }));
    render(cay({ preset: "last_month" }));
    expect(html).toContain(luaChon());
  });

  it("URL tu/den thắng lựa chọn đã lưu", () => {
    datUrl("/bao-cao?tab=san-pham&tu=2026-06-01&den=2026-06-30");
    render(cay({ preset: "7d" }));
    expect(luaChon()).toBe("custom|2026-06-01|2026-06-30");
  });

  it("URL ?range= thắng lựa chọn đã lưu", () => {
    datUrl("/marketing?range=last_month");
    render(cay({ preset: "7d" }));
    expect(luaChon().startsWith("last_month|")).toBe(true);
  });

  it("URL sạch + chưa lưu ⇒ 'Tháng này'", () => {
    datUrl("/");
    render(cay(null));
    expect(luaChon().startsWith("this_month|")).toBe(true);
  });

  it("lựa chọn đã lưu sai hình (lọt qua) ⇒ bỏ qua, về 'Tháng này'", () => {
    datUrl("/");
    render(cay({ preset: "custom", tu: "2026-06-30", den: "2026-06-01" }));
    expect(luaChon().startsWith("this_month|")).toBe(true);
  });
});

describe("URL/drill không bao giờ ghi", () => {
  it("race #246: router đã mang drill trong khi trang còn URL sạch ⇒ hiện drill, KHÔNG ghi gì", () => {
    datUrl("/tai-chinh?tab=loi-lo", "tab=loi-lo&tu=2026-09-01&den=2026-09-30");
    render(cay({ preset: "7d" }));
    expect(luaChon()).toBe("custom|2026-09-01|2026-09-30");
    expect(action.luu).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("drill rồi về URL sạch (bấm menu) ⇒ về lựa chọn đã lưu, không ghi gì", () => {
    datUrl("/bao-cao?tab=san-pham&tu=2026-06-01&den=2026-06-30");
    const app = render(cay({ preset: "7d" }));
    datUrl("/kenh");
    app.rerender(cay({ preset: "7d" }));
    expect(luaChon().startsWith("7d|")).toBe(true);
    expect(action.luu).not.toHaveBeenCalled();
  });
});

describe("chọn có chủ ý ⇒ ghi cookie qua action", () => {
  it("chọn preset ⇒ gọi action; nhãn CHỈ đổi khi server trả lựa chọn mới (không lạc quan)", async () => {
    datUrl("/kenh");
    const app = render(cay({ preset: "7d" }));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(action.luu).toHaveBeenCalledWith("last_month");
    expect(luaChon().startsWith("7d|")).toBe(true); // server chưa trả prop mới ⇒ nhãn giữ nguyên
    expect(nav.replace).not.toHaveBeenCalled(); // URL đã sạch ⇒ không điều hướng thêm
    app.rerender(cay({ preset: "last_month" })); // server trả layout mới
    expect(luaChon().startsWith("last_month|")).toBe(true);
  });

  it("chọn khi đang ở link drill ⇒ sau khi lưu, bỏ tham số ngày khỏi URL (giữ tham số khác)", async () => {
    datUrl("/bao-cao?tab=san-pham&tu=2026-06-01&den=2026-06-30");
    render(cay(null));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(action.luu).toHaveBeenCalledWith("last_month");
    expect(nav.replace).toHaveBeenCalledWith("/bao-cao?tab=san-pham", { scroll: false });
  });

  it("chọn 'Tùy chọn' ⇒ gọi action với khoảng chuẩn yyyy-MM-dd..yyyy-MM-dd", async () => {
    datUrl("/kenh");
    render(cay(null));
    await act(async () => screen.getByText("chon-tuy-chon").click());
    expect(action.luu).toHaveBeenCalledWith("2026-07-01..2026-07-31");
  });

  it("action báo lỗi ⇒ báo lỗi, KHÔNG điều hướng", async () => {
    action.luu.mockImplementationOnce(async () => ({ ok: false, error: "Khoảng ngày không hợp lệ — chọn lại." }));
    datUrl("/bao-cao?tu=2026-06-01&den=2026-06-30");
    render(cay(null));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(toastLoi).toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe("action lỗi / mất mạng — thoát trạng thái bận an toàn", () => {
  it("action NÉM (mất mạng) ⇒ báo lỗi, hết bận, nhãn giữ lựa chọn cũ, không điều hướng, không vỡ trang", async () => {
    action.luu.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    datUrl("/bao-cao?tab=san-pham&tu=2026-06-01&den=2026-06-30");
    render(cay({ preset: "7d" }));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(toastLoi).toHaveBeenCalled();
    expect(screen.getByTestId("dang-cap-nhat").textContent).toBe("false");
    expect(luaChon()).toBe("custom|2026-06-01|2026-06-30");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("action trả lỗi ⇒ hết bận, nhãn giữ nguyên", async () => {
    action.luu.mockImplementationOnce(async () => ({ ok: false, error: "Khoảng ngày không hợp lệ — chọn lại." }));
    datUrl("/kenh");
    render(cay({ preset: "7d" }));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(screen.getByTestId("dang-cap-nhat").textContent).toBe("false");
    expect(luaChon().startsWith("7d|")).toBe(true);
  });
});

describe("trạng thái bận, hết phiên, điều hướng giữa chừng, nhiều tab", () => {
  it("cờ bận BẬT trong lúc chờ server rồi TẮT khi xong (không chỉ 'false' từ đầu)", async () => {
    let xong!: (v: ActionResult<null>) => void;
    action.luu.mockImplementationOnce(() => new Promise((r) => (xong = r)));
    datUrl("/kenh");
    render(cay(null));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(screen.getByTestId("dang-cap-nhat").textContent).toBe("true");
    await act(async () => xong({ ok: true, data: null }));
    expect(screen.getByTestId("dang-cap-nhat").textContent).toBe("false");
  });

  it("hết phiên (action redirect) ⇒ KHÔNG báo 'mất mạng' — router tự sang trang đăng nhập", async () => {
    action.luu.mockImplementationOnce(async () => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/dang-nhap;307;" });
    });
    datUrl("/kenh");
    render(cay(null));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(toastLoi).not.toHaveBeenCalled();
    expect(screen.getByTestId("dang-cap-nhat").textContent).toBe("false");
  });

  it("đã bấm sang link drill KHÁC trong lúc chờ ⇒ không kéo về trang cũ, không xoá ngữ cảnh drill mới", async () => {
    action.luu.mockImplementationOnce(async () => {
      // người dùng bấm một link drill khác (mang tu/den) khi action đang chạy
      window.history.replaceState(null, "", "/tai-chinh?tab=loi-lo&tu=2026-05-01&den=2026-05-31");
      return { ok: true, data: null };
    });
    datUrl("/bao-cao?tab=san-pham&tu=2026-06-01&den=2026-06-30");
    render(cay(null));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("lưu xong ⇒ báo các tab khác; tab nhận tin ⇒ dựng lại (router.refresh)", async () => {
    const nghe = new BroadcastChannel("hogikids_khoang_ngay");
    const nhan = vi.fn();
    nghe.onmessage = (e) => nhan(e.data);
    datUrl("/kenh");
    render(cay(null));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    await vi.waitFor(() => expect(nhan).toHaveBeenCalledWith("last_month"));
    expect(nav.refresh).not.toHaveBeenCalled(); // tab tự gửi không tự refresh

    nghe.postMessage("7d"); // tab khác vừa lưu
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
    nghe.close();
  });
});

describe("không còn localStorage", () => {
  it("KHÔNG BAO GIỜ đọc localStorage (khoá cũ không được dùng làm lựa chọn)", async () => {
    window.localStorage.setItem("hogikids_date_range_v2", '{"preset":"last_month"}');
    const doc = vi.spyOn(Storage.prototype, "getItem");
    datUrl("/");
    render(cay(null));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(doc).not.toHaveBeenCalled();
    expect(luaChon().startsWith("this_month|")).toBe(true);
    doc.mockRestore();
  });

  it("khoá cũ bị dọn, không khoá nào được ghi", async () => {
    window.localStorage.setItem("hogikids_date_range", '{"preset":"custom","tu":"2026-09-01","den":"2026-09-30"}');
    window.localStorage.setItem("hogikids_date_range_v2", '{"preset":"7d"}');
    datUrl("/kenh");
    render(cay(null));
    await act(async () => screen.getByText("chon-thang-truoc").click());
    expect(window.localStorage.length).toBe(0);
  });
});
