import { describe, expect, it } from "vitest";

import {
  mocCapNhatHong,
  soThuTuCapNhatDon,
  updatedAtCuaPayload,
} from "@/lib/ingest/thu-tu-cap-nhat-don";

/**
 * So mốc `updated_at` Pancake giữa bản sắp ghi và bản Silver đang giữ — hàm thuần, không DB.
 * Naive datetime Pancake là giờ UTC (bất biến #3); so theo THỜI ĐIỂM, không so chuỗi.
 */
describe("soThuTuCapNhatDon", () => {
  it("mới hơn / cũ hơn / bằng", () => {
    expect(soThuTuCapNhatDon("2026-07-01T06:00:00.000000", "2026-07-01T05:00:00.000000")).toBe("MOI_HON");
    expect(soThuTuCapNhatDon("2026-07-01T05:00:00.000000", "2026-07-01T06:00:00.000000")).toBe("CU_HON");
    expect(soThuTuCapNhatDon("2026-07-01T05:00:00.000000", "2026-07-01T05:00:00.000000")).toBe("BANG");
  });

  it("khác separator / phần lẻ giây nhưng cùng thời điểm ⇒ BANG", () => {
    expect(soThuTuCapNhatDon("2026-07-01 05:00:00", "2026-07-01T05:00:00.000000")).toBe("BANG");
  });

  it("so theo thời điểm chứ không theo ký tự (khoảng trắng < 'T' trong bảng mã)", () => {
    // So chuỗi sẽ kết luận vế trái mới hơn — sai 1 tiếng rưỡi.
    expect(soThuTuCapNhatDon("2026-07-01T05:00:00", "2026-07-01 06:30:00")).toBe("CU_HON");
  });

  it("phần lẻ giây ở mức mili-giây được tính; lệch dưới 1ms coi là BANG", () => {
    expect(soThuTuCapNhatDon("2026-07-01T05:00:00.124", "2026-07-01T05:00:00.123")).toBe("MOI_HON");
    expect(soThuTuCapNhatDon("2026-07-01T05:00:00.123999", "2026-07-01T05:00:00.123001")).toBe("BANG");
  });

  it("naive (UTC) so được với bản có TZ tường minh", () => {
    // 12:00 +07:00 = 05:00 UTC.
    expect(soThuTuCapNhatDon("2026-07-01T05:00:00", "2026-07-01T12:00:00+07:00")).toBe("BANG");
  });

  it("thiếu hoặc sai khuôn ở một bên ⇒ KHONG_SO_DUOC (giữ luật mốc land cũ)", () => {
    expect(soThuTuCapNhatDon(null, "2026-07-01T05:00:00")).toBe("KHONG_SO_DUOC");
    expect(soThuTuCapNhatDon("2026-07-01T05:00:00", null)).toBe("KHONG_SO_DUOC");
    expect(soThuTuCapNhatDon("01/07/2026 05:00", "2026-07-01T05:00:00")).toBe("KHONG_SO_DUOC");
    expect(soThuTuCapNhatDon("2026-02-31T05:00:00", "2026-07-01T05:00:00")).toBe("KHONG_SO_DUOC");
  });
});

describe("updatedAtCuaPayload", () => {
  it("chỉ nhận chuỗi không rỗng", () => {
    expect(updatedAtCuaPayload({ updated_at: "2026-07-01T05:00:00" })).toBe("2026-07-01T05:00:00");
    expect(updatedAtCuaPayload({ updated_at: "" })).toBeNull();
    expect(updatedAtCuaPayload({ updated_at: "   " })).toBeNull();
    expect(updatedAtCuaPayload({ updated_at: 1751346000 })).toBeNull();
    expect(updatedAtCuaPayload({})).toBeNull();
    expect(updatedAtCuaPayload(null)).toBeNull();
  });
});

describe("mocCapNhatHong", () => {
  it("chỉ kêu khi mốc CÓ MẶT mà không đọc được", () => {
    expect(mocCapNhatHong("01/07/2026 05:00")).toBe(true);
    expect(mocCapNhatHong("2026-07-01T05:00:00.000000")).toBe(false);
    expect(mocCapNhatHong(null)).toBe(false);
  });
});
