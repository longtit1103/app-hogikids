// @vitest-environment jsdom
/**
 * Khối "Business Center TikTok" (Nợ phải trả): BC thiếu quyền finance hiện cảnh báo + nút "Không dùng thẻ"; xác nhận gửi
 * đúng `{ bcId, ghiChu }` lên action; BC đã đánh dấu hiện người/ngày xác nhận + nút "Bỏ đánh dấu". Dòng hiển thị dựng
 * ở server (`dongBcTiktokChoKhoi`) với ngày theo giờ VN.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hanhDong = vi.hoisted(() => ({
  danhDauBcTiktokKhongDung: vi.fn(async () => ({ ok: true as const, data: { daDoi: true } })),
  boDanhDauBcTiktokKhongDung: vi.fn(async () => ({ ok: true as const, data: { daDoi: true } })),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/actions/bc-tiktok-hoa-don", () => hanhDong);

import { dongBcTiktokChoKhoi } from "@/components/no-phai-tra/bc-tiktok-dong";
import { BcTiktokSection } from "@/components/no-phai-tra/bc-tiktok-section";

afterEach(cleanup);

const DONG = dongBcTiktokChoKhoi([
  {
    bcId: "7200000000000000002",
    ketQuaGanNhat: "khong-quyen-finance",
    lanCuoiDocDuoc: null,
    lanDauCoDau: new Date("2026-10-29T18:00:00Z"),
    khongDungTu: null,
    khongDungGhiChu: null,
    khongDungBoi: null,
  },
  {
    bcId: "7129545797879726081",
    ketQuaGanNhat: "xong",
    // 30/10 23:30 VN = 30/10 16:30Z — ngày hiển thị phải theo VN.
    lanCuoiDocDuoc: new Date("2026-10-30T16:30:00Z"),
    lanDauCoDau: new Date("2026-10-29T18:00:00Z"),
    khongDungTu: new Date("2026-10-30T17:30:00Z"),
    khongDungGhiChu: "BC agency cũ",
    khongDungBoi: "chu@hogikids.test",
  },
]);

describe("dongBcTiktokChoKhoi", () => {
  it("dịch kết quả lượt + ngày theo giờ VN", () => {
    expect(DONG[0]).toMatchObject({ trangThai: "Lượt kéo gần nhất: TikTok báo THIẾU QUYỀN finance", canhBao: true, lanCuoiDocDuoc: null });
    expect(DONG[1]).toMatchObject({ canhBao: false, lanCuoiDocDuoc: "30/10/2026", khongDungTu: "31/10/2026" });
  });
});

describe("BcTiktokSection", () => {
  it("đánh dấu BC thiếu quyền: mở hộp xác nhận, gửi bcId + ghi chú", async () => {
    render(<BcTiktokSection dong={DONG} />);
    expect(screen.getByText(/THIẾU QUYỀN finance/)).toBeTruthy();
    expect(screen.getByText(/chưa từng đọc được hoá đơn/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Không dùng thẻ" }));
    fireEvent.change(screen.getByLabelText("Ghi chú (tuỳ chọn)"), { target: { value: "BC test" } });
    fireEvent.click(screen.getByRole("button", { name: "Xác nhận" }));

    await waitFor(() =>
      expect(hanhDong.danhDauBcTiktokKhongDung).toHaveBeenCalledWith({ bcId: "7200000000000000002", ghiChu: "BC test" }),
    );
  });

  it("BC đã đánh dấu: hiện người + ngày xác nhận, bỏ đánh dấu gọi đúng BC", async () => {
    render(<BcTiktokSection dong={DONG} />);
    expect(screen.getByText(/chu@hogikids.test xác nhận 31\/10\/2026 · BC agency cũ/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Bỏ đánh dấu" }));

    await waitFor(() => expect(hanhDong.boDanhDauBcTiktokKhongDung).toHaveBeenCalledWith("7129545797879726081"));
  });
});
