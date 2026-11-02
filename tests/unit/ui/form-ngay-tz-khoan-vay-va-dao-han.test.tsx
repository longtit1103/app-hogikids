// @vitest-environment jsdom
/**
 * Phần còn lại của nhóm "ngày theo giờ VN, không theo múi giờ trình duyệt": form khoản vay, "đã tới hạn"
 * / "trễ" của sổ tiết kiệm đáo hạn, và ngày mặc định của hộp "Tính lại phí kỳ này". Cùng khuôn
 * `form-ngay-tz.test.tsx`: đổi `process.env.TZ` giữa test là đổi múi giờ thật của `Date`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hanhDong = vi.hoisted(() => ({
  suaKhoanVay: vi.fn(),
  taoKhoanVay: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("@/lib/actions/khoan-vay", () => ({
  suaKhoanVay: hanhDong.suaKhoanVay,
  taoKhoanVay: hanhDong.taoKhoanVay,
}));
vi.mock("@/lib/actions/so-tiet-kiem", () => ({ suaSoTietKiem: vi.fn(), taoSoTietKiem: vi.fn(), xoaSoTietKiem: vi.fn() }));
vi.mock("@/lib/actions/tat-toan-so-tiet-kiem", () => ({ tatToanSoTietKiem: vi.fn(), moLaiSoTietKiem: vi.fn() }));
vi.mock("@/lib/actions/settings-channels", () => ({
  countRecomputableOrders: vi.fn().mockResolvedValue({ ok: true, data: { count: 0 } }),
  recomputeFeesInRange: vi.fn(),
}));

import { KhoanVayFormModal } from "@/components/finance/khoan-vay-form-modal";
import { laDaoHanTre } from "@/components/finance/so-dao-han-card";
import { soDaDenHan } from "@/components/finance/so-tiet-kiem-row-actions";
import { RecomputeFeesDialog, thangVnHienTai } from "@/components/settings/recompute-fees-dialog";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

const TZ_GOC = process.env.TZ;
const MUI_GIO = ["America/New_York", "Asia/Ho_Chi_Minh", "Pacific/Honolulu"] as const;

beforeEach(() => {
  for (const f of Object.values(hanhDong)) f.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.env.TZ = TZ_GOC;
});

const vn = (s: string) => new Date(`${s}+07:00`);

const khoanVay = {
  id: "l1",
  name: "Vay A",
  lender: "NH",
  kind: "TERM",
  duNoMoSo: 0,
  giaiNgan: 50_000_000,
  giaiNganNgay: vn("2026-10-15T00:00:00"),
  startDate: vn("2026-10-15T00:00:00"),
  firstDueDate: vn("2026-11-15T00:00:00"),
  termMonths: 12,
  annualRateBp: 1000,
  note: "ghi chú cũ",
  laiCoDinhMoiKy: null,
  tienGuiBatBuocMoiKy: 0,
  laiNhapGoc: false,
  lastDueHandled: null,
  coTraGoc: false,
  closedAt: null,
  traGoc: [],
  nhapGoc: [],
  duNo: 50_000_000,
  laiTamTinh: null,
  kyCho: null,
  tienGuiDangGiu: 0,
  coDongTienGui: false,
  ngayTatToanSomNhat: vn("2026-10-15T00:00:00"),
} as unknown as KhoanVayRow;

describe.each(MUI_GIO)("sửa khoản vay, chỉ đổi ghi chú — múi giờ trình duyệt %s", (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
  });

  it("ngày giải ngân và ngày trả kỳ đầu gửi đi vẫn là 0h VN của ngày gốc", async () => {
    render(<KhoanVayFormModal open onOpenChange={() => {}} loan={khoanVay} d0={null} />);
    fireEvent.change(screen.getByDisplayValue("ghi chú cũ"), { target: { value: "ghi chú mới" } });
    fireEvent.click(screen.getByRole("button", { name: /^Lưu$/ }));
    await waitFor(() => expect(hanhDong.suaKhoanVay).toHaveBeenCalledTimes(1));
    const [, input] = hanhDong.suaKhoanVay.mock.calls[0] as [
      string,
      { ngayGiaiNgan: Date; firstDueDate: Date; note: string },
    ];
    expect(input.note).toBe("ghi chú mới");
    expect(input.ngayGiaiNgan.getTime()).toBe(khoanVay.startDate.getTime());
    expect(input.firstDueDate.getTime()).toBe((khoanVay.firstDueDate as Date).getTime());
  });
});

describe.each(MUI_GIO)("sổ tiết kiệm đáo hạn — 'đã tới hạn' và 'trễ' theo ngày VN, trình duyệt ở %s", (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
  });

  it("đáo hạn 00:00 ngày 16 VN, bây giờ 23:00 ngày 15 VN ⇒ CHƯA tới hạn (ô ngày max=15 không chọn được ngày 16)", () => {
    // Ở New York hai mốc cùng rơi vào ngày 15 theo giờ máy ⇒ bản cắt-theo-giờ-máy báo 'đã tới hạn'.
    expect(soDaDenHan(vn("2026-10-16T00:00:00"), vn("2026-10-15T23:00:00"))).toBe(false);
  });

  it("đáo hạn ngày 15 VN, bây giờ 00:30 ngày 15 VN ⇒ đã tới hạn", () => {
    expect(soDaDenHan(vn("2026-10-15T00:00:00"), vn("2026-10-15T00:30:00"))).toBe(true);
  });

  it("trễ đúng 7 ngày VN ⇒ chưa trễ; 8 ngày VN ⇒ trễ", () => {
    // Bây giờ 23:30 ngày 15 VN: giờ New York vẫn là 12:30 ngày 15 nhưng đáo hạn 00:00 ngày 8 VN
    // là 13:00 ngày 7 ⇒ bản theo giờ máy đếm 8 ngày thay vì 7.
    expect(laDaoHanTre(vn("2026-10-08T00:00:00"), vn("2026-10-15T23:30:00"))).toBe(false);
    expect(laDaoHanTre(vn("2026-10-07T00:00:00"), vn("2026-10-15T23:30:00"))).toBe(true);
  });
});

describe.each(MUI_GIO)("hộp 'Tính lại phí kỳ này' — tháng mặc định theo giờ VN, trình duyệt ở %s", (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
  });

  it("thangVnHienTai: 03:00 ngày 1/11 VN (còn là 31/10 ở New York) ⇒ cả tháng 11", () => {
    expect(thangVnHienTai(new Date("2026-10-31T20:00:00Z"))).toEqual({ tu: "2026-11-01", den: "2026-11-30" });
  });

  it("thangVnHienTai: tháng 2 năm nhuận lấy đủ 29 ngày", () => {
    expect(thangVnHienTai(new Date("2028-02-10T05:00:00Z"))).toEqual({ tu: "2028-02-01", den: "2028-02-29" });
  });

  it("mở hộp: ô Từ/Đến mặc định là đầu/cuối tháng VN", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T20:00:00Z"));
    render(<RecomputeFeesDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Tính lại phí kỳ này" }));
    expect((screen.getByLabelText("Từ ngày") as HTMLInputElement).value).toBe("2026-11-01");
    expect((screen.getByLabelText("Đến ngày") as HTMLInputElement).value).toBe("2026-11-30");
  });
});
