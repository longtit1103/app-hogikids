import { describe, expect, it } from "vitest";

import { quyetDinhCauDoTuoi } from "@/lib/reports/marketing/cau-do-tuoi-du-lieu";

/**
 * Hàm THUẦN — không Prisma, không React, KHÔNG bao giờ gọi `new Date()` trong test (mọi `bayGio`
 * truyền tay). Khoá ruling P2-R35: "app chưa kéo được" suy từ `lanChayOkGanNhat` (SyncLog OK), KHÔNG
 * suy từ `mocSanSang` (ngày dữ liệu) — lỗi vừa lọt ở review Task 8: ngưỡng phẳng "mốc cũ hơn N ngày"
 * bắn nhầm cảnh báo "app hỏng" khi hệ thống HOÀN TOÀN KHOẺ (mốc trôi khác nhau theo stream là chuyện
 * thường, xem `moc-du-lieu-san-sang.ts`).
 *
 * Mốc thời gian dựng bằng ISO có offset `+07:00` tường minh (= Asia/Ho_Chi_Minh, không DST) — đúng
 * INSTANT bất kể TZ tiến trình chạy test, khớp `tests/setup.ts` đã pin `TZ=Asia/Ho_Chi_Minh`.
 */

const BAY_GIO_KHOE = new Date("2026-08-25T19:00:00+07:00");

describe("quyetDinhCauDoTuoi", () => {
  it("soNgayChuaSanSang = 0 ⇒ không hiện câu nào (kể cả app vừa trượt sync)", () => {
    const cau = quyetDinhCauDoTuoi({
      mocSanSang: "2026-08-22",
      soNgayChuaSanSang: 0,
      lanChayOkGanNhat: null,
      bayGio: BAY_GIO_KHOE,
    });
    expect(cau).toBeNull();
  });

  it("HỆ THỐNG KHOẺ (ca lỗi vừa lọt): sync OK 25/08 02:35, mốc products 22/08 — PHẢI là câu phía sàn, không phải phía app", () => {
    // Đúng số đo thật 25/08 (docblock moc-du-lieu-san-sang.ts): shop=24/08, products=22/08 — mốc
    // trôi khác nhau giữa các stream trên một hệ thống hoàn toàn khoẻ.
    const cau = quyetDinhCauDoTuoi({
      mocSanSang: "2026-08-22",
      soNgayChuaSanSang: 3,
      lanChayOkGanNhat: new Date("2026-08-25T02:35:00+07:00"),
      bayGio: BAY_GIO_KHOE,
    });
    expect(cau).toBe("Sàn mới có số tới ngày 22/08/2026 — 3 ngày cuối kỳ chưa được tính.");
    expect(cau).not.toMatch(/App chưa kéo được/);
  });

  it("sync trượt (lượt OK gần nhất cách hơn 36h) ⇒ câu phía app, trỏ ĐÚNG khối 'Kết nối & Đồng bộ' (ruling P2-R39)", () => {
    const cau = quyetDinhCauDoTuoi({
      mocSanSang: "2026-08-22",
      soNgayChuaSanSang: 3,
      lanChayOkGanNhat: new Date("2026-08-23T02:35:00+07:00"), // 2 ngày 16h25 trước bayGio
      bayGio: BAY_GIO_KHOE,
    });
    expect(cau).toBe("App chưa kéo được dữ liệu mới — kiểm lượt đồng bộ đêm (Cài đặt → Kết nối & Đồng bộ).");
  });

  it("ranh giới 36h — 35h (chưa qua ngưỡng) và 37h (đã qua) PHẢI ra hai kết quả khác nhau", () => {
    const lanChayOkGanNhat = new Date("2026-08-24T00:00:00+07:00");
    const mocSanSang = "2026-08-24"; // trong 7 ngày ⇒ không dính backstop, tách bạch đúng ngưỡng 36h

    const ca35h = quyetDinhCauDoTuoi({
      mocSanSang,
      soNgayChuaSanSang: 2,
      lanChayOkGanNhat,
      bayGio: new Date("2026-08-25T11:00:00+07:00"), // +35h
    });
    const ca37h = quyetDinhCauDoTuoi({
      mocSanSang,
      soNgayChuaSanSang: 2,
      lanChayOkGanNhat,
      bayGio: new Date("2026-08-25T13:00:00+07:00"), // +37h
    });

    expect(ca35h).toBe("Sàn mới có số tới ngày 24/08/2026 — 2 ngày cuối kỳ chưa được tính.");
    expect(ca37h).toBe("App chưa kéo được dữ liệu mới — kiểm lượt đồng bộ đêm (Cài đặt → Kết nối & Đồng bộ).");
    expect(ca35h).not.toBe(ca37h);
  });

  it("backstop: sync OK mới tinh (1h trước) NHƯNG mốc cũ 10 ngày ⇒ vẫn câu phía app", () => {
    const cau = quyetDinhCauDoTuoi({
      mocSanSang: "2026-08-15", // 10 ngày trước bayGio, ngưỡng backstop là 7 ngày
      soNgayChuaSanSang: 2,
      lanChayOkGanNhat: new Date("2026-08-25T18:00:00+07:00"), // 1h trước bayGio — sync rất mới
      bayGio: BAY_GIO_KHOE,
    });
    expect(cau).toBe("App chưa kéo được dữ liệu mới — kiểm lượt đồng bộ đêm (Cài đặt → Kết nối & Đồng bộ).");
  });

  it("mocSanSang = null (chưa kết nối) — sync mới tinh, không dính backstop (không có ngày để so) ⇒ câu chưa chốt số", () => {
    const cau = quyetDinhCauDoTuoi({
      mocSanSang: null,
      soNgayChuaSanSang: 5,
      lanChayOkGanNhat: new Date("2026-08-25T18:00:00+07:00"),
      bayGio: BAY_GIO_KHOE,
    });
    expect(cau).toBe("5 ngày cuối kỳ sàn chưa chốt số. Không phải bằng 0.");
  });

  /**
   * Ruling P2-R41: "chưa từng chạy OK" ≠ "app hỏng". "Xoá dữ liệu giao dịch" (`data-admin.ts`) xoá
   * sạch SyncLog mà GIỮ NGUYÊN Bronze — ngay sau thao tác đó `lanChayOkGanNhat` là `null` dù hệ vẫn
   * khoẻ hoàn toàn. Câu cũ "App chưa kéo được dữ liệu mới" khẳng định sai; câu mới phải TRUNG TÍNH
   * (không nói "App chưa kéo được", không nói "app hỏng") và KHÔNG được trùng câu "sync trượt".
   */
  it("lanChayOkGanNhat = null (chưa từng chạy OK) ⇒ câu TRUNG TÍNH, KHÔNG khẳng định app hỏng", () => {
    const cau = quyetDinhCauDoTuoi({
      mocSanSang: "2026-08-25",
      soNgayChuaSanSang: 1,
      lanChayOkGanNhat: null,
      bayGio: BAY_GIO_KHOE,
    });
    expect(cau).toBe(
      "Chưa ghi nhận lượt đồng bộ nào của TikTok Shop Analytics — có thể do mới cài đặt hoặc vừa xoá dữ liệu giao dịch, chưa chắc app đang hỏng."
    );
    expect(cau).not.toMatch(/App chưa kéo được dữ liệu mới/);
  });

  it("null (chưa từng chạy) và stale (>36h) PHẢI ra hai câu KHÁC NHAU — không gộp chung một khẳng định", () => {
    const cauChuaTungChay = quyetDinhCauDoTuoi({
      mocSanSang: "2026-08-22",
      soNgayChuaSanSang: 3,
      lanChayOkGanNhat: null,
      bayGio: BAY_GIO_KHOE,
    });
    const cauStale = quyetDinhCauDoTuoi({
      mocSanSang: "2026-08-22",
      soNgayChuaSanSang: 3,
      lanChayOkGanNhat: new Date("2026-08-23T02:35:00+07:00"),
      bayGio: BAY_GIO_KHOE,
    });
    expect(cauChuaTungChay).not.toBe(cauStale);
  });
});
