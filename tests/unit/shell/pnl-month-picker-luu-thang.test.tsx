// @vitest-environment jsdom
/**
 * Bộ chọn tháng Lãi/Lỗ (#254): chọn tháng = chọn CÓ CHỦ Ý ⇒ lưu; đúng tháng hiện tại ⇒ preset
 * "this_month" (chủ shop chốt 29/09); trong lúc chờ server mọi nút đổi tháng bị khoá — bấm ‹ hai lần
 * nhanh không được tính cả hai bước từ cùng tháng cũ.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { endOfMonth, format, startOfMonth, subMonths } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PnlMonthPicker } from "@/components/bao-cao/pnl-month-picker";
import { DateRangeProvider } from "@/components/shell/date-range-provider";
import type { ActionResult } from "@/lib/actions/action-result";

const nav = vi.hoisted(() => ({ search: "", cache: new Map<string, URLSearchParams>() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/tai-chinh",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
}));
const action = vi.hoisted(() => ({ luu: vi.fn(async (_g: string): Promise<ActionResult<null>> => ({ ok: true, data: null })) }));
vi.mock("@/lib/actions/khoang-ngay", () => ({ luuLuaChonKhoangNgay: action.luu }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const khoangThang = (d: Date) => `${format(startOfMonth(d), "yyyy-MM-dd")}..${format(endOfMonth(d), "yyyy-MM-dd")}`;

function moTaiThang(d: Date) {
  const [tu, den] = khoangThang(d).split("..");
  nav.search = `tab=loi-lo&tu=${tu}&den=${den}`;
  window.history.replaceState(null, "", `/tai-chinh?${nav.search}`);
  return render(
    <DateRangeProvider luaChonDaLuu={null}>
      <PnlMonthPicker />
    </DateRangeProvider>,
  );
}

beforeEach(() => {
  action.luu.mockClear();
  action.luu.mockImplementation(async () => ({ ok: true, data: null }));
});
afterEach(() => cleanup());

describe("PnlMonthPicker — lưu tháng có chủ ý", () => {
  it("‹ ⇒ lưu khoảng tháng trước; bấm ‹ lần hai khi đang chờ ⇒ bị khoá, KHÔNG lưu lần hai", async () => {
    let xong!: (v: ActionResult<null>) => void;
    action.luu.mockImplementationOnce(() => new Promise((r) => (xong = r)));
    const thangTruoc = subMonths(new Date(), 1);
    moTaiThang(thangTruoc);
    const lui = screen.getByLabelText("Tháng trước");
    await act(async () => lui.click());
    expect(action.luu).toHaveBeenCalledWith(khoangThang(subMonths(thangTruoc, 1)));
    expect((lui as HTMLButtonElement).disabled).toBe(true);
    await act(async () => lui.click());
    expect(action.luu).toHaveBeenCalledTimes(1);
    await act(async () => xong({ ok: true, data: null }));
    expect((lui as HTMLButtonElement).disabled).toBe(false);
  });

  it("› sang ĐÚNG tháng hiện tại ⇒ lưu preset 'this_month' (tự trôi sang tháng mới)", async () => {
    moTaiThang(subMonths(new Date(), 1));
    await act(async () => screen.getByLabelText("Tháng sau").click());
    expect(action.luu).toHaveBeenCalledWith("this_month");
  });
});
