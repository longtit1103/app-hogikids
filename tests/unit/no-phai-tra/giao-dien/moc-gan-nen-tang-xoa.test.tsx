// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { xoaGanNenTang, toast } = vi.hoisted(() => ({
  xoaGanNenTang: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/actions/the-tin-dung", () => ({ xoaGanNenTang }));

import { MocGanNenTang } from "@/components/no-phai-tra/moc-gan-nen-tang";
import type { MocGanThe } from "@/lib/no-phai-tra/the-tin-dung-queries";

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);
const HOM_NAY = new Date("2026-10-10T08:00:00+07:00");

beforeEach(() => {
  xoaGanNenTang.mockReset().mockResolvedValue({ ok: true, data: undefined });
  refresh.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

/** Ca đổi thẻ: thẻ này có mốc 01/08 (xoá được), thẻ B nhận từ 13/09. */
const GAN: MocGanThe[] = [
  { id: "g1", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-08-01"), xoaDuoc: true, denNgay: vn("2026-09-12"), theKeTiep: "Thẻ B" },
];

function dung(daBat: boolean) {
  render(<MocGanNenTang gan={GAN} choPhepSua daBat={daBat} homNay={HOM_NAY} />);
}

describe("MocGanNenTang — xoá mốc", () => {
  it("CHƯA bật: bấm 'xoá' chỉ mở hộp xác nhận (nói đúng sự thật), CHƯA gọi action; xác nhận mới gọi", async () => {
    dung(false);
    expect(screen.getByTestId("moc-gan-khoang").textContent).toBe("TikTok Ads từ 01/08/2026 đến 12/09/2026 (sau đó: Thẻ B)");

    fireEvent.click(screen.getByRole("button", { name: "xoá" }));
    const noiDung = await screen.findByTestId("moc-gan-xac-nhan-noi-dung");
    expect(noiDung.textContent).toContain("Sau khi bật");
    expect(noiDung.textContent).toContain("tính theo mốc liền trước");
    expect(noiDung.textContent).toContain("trừ thẳng vào quỹ");
    expect(noiDung.textContent).not.toContain("không còn tính vào thẻ này");
    expect(noiDung.textContent).toContain("từ 01/08/2026 đến 12/09/2026");
    expect(noiDung.textContent).toContain("Chỉ xoá mốc nhập NHẦM");
    expect(noiDung.textContent).not.toContain("chưa ảnh hưởng quỹ");
    expect(xoaGanNenTang).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Xoá" }));
    await waitFor(() => expect(xoaGanNenTang).toHaveBeenCalledWith("g1"));
    expect(xoaGanNenTang).toHaveBeenCalledTimes(1);
  });

  it("CHƯA bật: 'Huỷ' đóng hộp, không gọi action", async () => {
    dung(false);
    fireEvent.click(screen.getByRole("button", { name: "xoá" }));
    await screen.findByTestId("moc-gan-xac-nhan-noi-dung");
    fireEvent.click(screen.getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByTestId("moc-gan-xac-nhan-noi-dung")).toBeNull());
    expect(xoaGanNenTang).not.toHaveBeenCalled();
  });

  it("ĐÃ bật: bấm 'xoá' gọi action ngay, KHÔNG hộp xác nhận (hành vi cũ)", async () => {
    const tuongLai: MocGanThe[] = [{ id: "g9", nenTang: "META", tuNgay: vn("2026-11-01"), xoaDuoc: true, denNgay: null, theKeTiep: null }];
    render(<MocGanNenTang gan={tuongLai} choPhepSua daBat homNay={HOM_NAY} />);
    fireEvent.click(screen.getByRole("button", { name: "xoá" }));
    await waitFor(() => expect(xoaGanNenTang).toHaveBeenCalledWith("g9"));
    expect(screen.queryByTestId("moc-gan-xac-nhan-noi-dung")).toBeNull();
  });
});
