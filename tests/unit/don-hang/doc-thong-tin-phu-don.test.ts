import { describe, expect, it } from "vitest";

import { docThongTinPhuDon } from "@/lib/orders/doc-thong-tin-phu-don";
import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";

/** Dòng thời gian đọc từ `raw.status_history`: mốc naive của Pancake là UTC, hiển thị giờ VN. */
describe("docThongTinPhuDon", () => {
  const RAW_MAU = {
    status_history: [
      { status: 0, updated_at: "2026-11-25T02:12:00" },
      { status: 1, updated_at: "2026-11-25T03:00:00" },
      { status: 2, updated_at: "2026-11-25T09:40:00" },
      { status: 3, updated_at: "2026-11-27T03:05:00" },
    ],
    note: "Giao giờ hành chính",
  };

  it("gộp cụm liền nhau cùng trạng thái, giữ mốc sớm nhất, đổi sang giờ VN", () => {
    const kq = docThongTinPhuDon(RAW_MAU, "COMPLETED");
    expect(kq.dongThoiGian.map((m) => [m.status, formatNgayVn(m.luc, "dd/MM HH:mm"), m.hienTai])).toEqual([
      ["PENDING", "25/11 09:12", false],
      ["SHIPPING", "25/11 16:40", false],
      ["COMPLETED", "27/11 10:05", true],
    ]);
  });

  it("kết quả chỉ có khoá dongThoiGian; ghi chú đầu vào không lọt ra", () => {
    const kq = docThongTinPhuDon(RAW_MAU, "COMPLETED");
    expect(Object.keys(kq)).toEqual(["dongThoiGian"]);
    expect(JSON.stringify(kq)).not.toContain("Giao giờ hành chính");
  });

  it("mốc mã lạ bị bỏ (không đoán thành Hủy), ngày hỏng bị bỏ, mã dạng chuỗi được nhận", () => {
    const kq = docThongTinPhuDon(
      {
        status_history: [
          { status: 99, updated_at: "2026-11-25T02:00:00" },
          { status: 0, updated_at: "rác" },
          { status: "2", updated_at: "2026-11-25T09:40:00" },
        ],
      },
      "SHIPPING",
    );
    expect(kq.dongThoiGian.map((m) => [m.status, m.hienTai])).toEqual([["SHIPPING", true]]);
  });

  it("đầu vào đảo thứ tự vẫn ra tăng dần", () => {
    const kq = docThongTinPhuDon(
      { status_history: [...RAW_MAU.status_history].reverse() },
      "COMPLETED",
    );
    expect(kq.dongThoiGian.map((m) => m.status)).toEqual(["PENDING", "SHIPPING", "COMPLETED"]);
    const luc = kq.dongThoiGian.map((m) => m.luc.getTime());
    expect([...luc].sort((a, b) => a - b)).toEqual(luc);
  });

  it("mốc cuối khác trạng thái hiện tại thì không mốc nào là hiện tại", () => {
    const kq = docThongTinPhuDon(
      { status_history: RAW_MAU.status_history.slice(0, 3) },
      "COMPLETED",
    );
    expect(kq.dongThoiGian.at(-1)?.status).toBe("SHIPPING");
    expect(kq.dongThoiGian.some((m) => m.hienTai)).toBe(false);
  });

  it.each([
    ["null", null],
    ["chuỗi", "x"],
    ["mảng rỗng", []],
    ["status_history là chuỗi", { status_history: "x" }],
    ["mục không phải object", { status_history: [null, 1, {}] }],
    ["status_history thiếu", {}],
  ])("raw %s ⇒ rỗng và không ném", (_ten, raw) => {
    expect(docThongTinPhuDon(raw, "PENDING")).toEqual({ dongThoiGian: [] });
  });

  it("tên khoá nguy hiểm trong status không làm sập", () => {
    const kq = docThongTinPhuDon(
      { status_history: [{ status: "__proto__", updated_at: "2026-11-25T02:00:00" }] },
      "PENDING",
    );
    expect(kq).toEqual({ dongThoiGian: [] });
  });

  it("30 mục xen kẽ hai trạng thái ⇒ giữ 20 mốc cuối", () => {
    const status_history = Array.from({ length: 30 }, (_, i) => ({
      status: i % 2 === 0 ? 0 : 2,
      updated_at: `2026-11-${String(1 + i).padStart(2, "0")}T02:00:00`,
    }));
    const kq = docThongTinPhuDon({ status_history }, "SHIPPING");
    expect(kq.dongThoiGian).toHaveLength(20);
    // 20 mốc CUỐI: mốc đầu là mục thứ 11 (i = 10 ⇒ ngày 11), mốc cuối là ngày 30.
    expect(formatNgayVn(kq.dongThoiGian[0].luc, "dd/MM")).toBe("11/11");
    expect(formatNgayVn(kq.dongThoiGian[19].luc, "dd/MM")).toBe("30/11");
    expect(kq.dongThoiGian[19].hienTai).toBe(true);
  });

  it("mỗi mốc chỉ có status, luc, hienTai dù đầu vào mang tên người sửa", () => {
    const kq = docThongTinPhuDon(
      { status_history: [{ status: 0, updated_at: "2026-11-25T02:12:00", editor: "Tên NV", name: "Tên NV", editor_fb: "x" }] },
      "PENDING",
    );
    expect(Object.keys(kq.dongThoiGian[0]).sort()).toEqual(["hienTai", "luc", "status"]);
    expect(JSON.stringify(kq)).not.toContain("Tên NV");
  });
});
