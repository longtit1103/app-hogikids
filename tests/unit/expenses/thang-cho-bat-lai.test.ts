import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KhoanChiDinhKySection } from "@/components/finance/khoan-chi-dinh-ky-section";
import { NutBatLaiKhoanChiDinhKy, type NutBatLaiKhoanChiDinhKyProps } from "@/components/finance/nut-bat-lai-khoan-chi-dinh-ky";
import type { RecurringExpenseRow } from "@/lib/expenses/expense-queries";
import { thangChoBatLai } from "@/lib/expenses/thang-cho-bat-lai";

/**
 * Hai tháng của hộp "Bật lại" khoản chi định kỳ: cặp nhãn `MM/yyyy` + khoá `yyyy-MM` sinh từ CÙNG một
 * mốc, và khối định kỳ truyền đúng cặp đó xuống nút. Khoá lệch nhãn (đảo tháng, sai định dạng) là chọn
 * "tháng sau" mà ghi mốc tháng này — sinh lại đúng khoản vừa xoá — hoặc nút hỏng hẳn; `tsc` không bắt.
 * Giờ VN: `tests/setup.ts` ép `TZ=Asia/Ho_Chi_Minh`.
 */
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const khoa = (bayGio: Date) => {
  const t = thangChoBatLai(bayGio);
  return [t.nay.khoa, t.sau.khoa];
};

describe("thangChoBatLai", () => {
  it("biên năm: 31/12/2026 23:59:59 giờ VN ⇒ tháng 12/2026 + 01/2027", () => {
    expect(khoa(new Date(2026, 11, 31, 23, 59, 59))).toEqual(["2026-12", "2027-01"]);
  });

  it("biên năm: 01/01/2027 00:00:00 giờ VN ⇒ tháng 01/2027 + 02/2027", () => {
    expect(khoa(new Date(2027, 0, 1, 0, 0, 0))).toEqual(["2027-01", "2027-02"]);
  });

  it("theo giờ VN, không theo UTC: 01/11/2026 06:59 VN (= 31/10 23:59 UTC) đã là tháng 11", () => {
    expect(khoa(new Date("2026-10-31T23:59:00Z"))).toEqual(["2026-11", "2026-12"]);
  });

  it("mỗi tháng: nhãn, khoá và đầu tháng cùng MỘT tháng", () => {
    const t = thangChoBatLai(new Date(2026, 9, 31, 23, 59, 59));
    expect(t.nay).toEqual({ nhan: "10/2026", khoa: "2026-10", dauThang: new Date(2026, 9, 1) });
    expect(t.sau).toEqual({ nhan: "11/2026", khoa: "2026-11", dauThang: new Date(2026, 10, 1) });
  });
});

/** Duyệt cây phần tử React (không render) tìm mọi phần tử có `type` cho trước. */
function timPhanTu<P>(nut: ReactNode, type: unknown): ReactElement<P>[] {
  if (Array.isArray(nut)) return nut.flatMap((n) => timPhanTu<P>(n, type));
  if (!isValidElement(nut)) return [];
  const self = nut.type === type ? [nut as ReactElement<P>] : [];
  return [...self, ...timPhanTu<P>((nut.props as { children?: ReactNode }).children, type)];
}

describe("KhoanChiDinhKySection — truyền đúng cặp tháng xuống nút Bật lại", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("31/12/2026 23:59:59 ⇒ nút nhận tháng này 12/2026 · 2026-12 và tháng sau 01/2027 · 2027-01", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
    const mauDaDung: RecurringExpenseRow = {
      id: "mau-da-dung",
      description: "Mặt bằng",
      categoryName: "Cố định",
      channelName: null,
      amount: 2_000_000,
      dayOfMonth: 1,
      active: false,
      activeFrom: null,
    };

    const cay = KhoanChiDinhKySection({ items: [mauDaDung], choPhepSua: true });
    const nut = timPhanTu<NutBatLaiKhoanChiDinhKyProps>(cay, NutBatLaiKhoanChiDinhKy);

    expect(nut).toHaveLength(1);
    expect(nut[0].props.thang.nay).toMatchObject({ nhan: "12/2026", khoa: "2026-12" });
    expect(nut[0].props.thang.sau).toMatchObject({ nhan: "01/2027", khoa: "2027-01" });

    // Thiếu `chi-phi:sua` (hoặc không truyền cờ) ⇒ không nút Bật lại — mặc định đóng.
    expect(timPhanTu(KhoanChiDinhKySection({ items: [mauDaDung], choPhepSua: false }), NutBatLaiKhoanChiDinhKy)).toHaveLength(0);
    expect(timPhanTu(KhoanChiDinhKySection({ items: [mauDaDung] }), NutBatLaiKhoanChiDinhKy)).toHaveLength(0);
  });
});
