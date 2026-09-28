import { describe, expect, it } from "vitest";

import { docSoTrang, urlTrangCuoiNeuVuot } from "@/lib/pagination";

/**
 * `?trang=` vượt quá số trang thật là NGÕ CỤT: OFFSET quá cuối bảng trả danh sách rỗng, mà thanh
 * phân trang cũng tính theo trang hiện tại nên biến mất luôn — không còn nút nào để bấm về.
 *
 * Test phần THUẦN (dựng URL); phần chuyển hướng chỉ là `redirect(url)` một dòng.
 */
describe("urlTrangCuoiNeuVuot", () => {
  it("trang vượt cuối → về trang cuối, GIỮ NGUYÊN bộ lọc đang áp", () => {
    const url = urlTrangCuoiNeuVuot({
      duongDan: "/don-hang",
      sp: { trang: "999", trang_thai: "hoan", q: "áo" },
      trang: 999,
      tong: 45, // 45 dòng / 20 = 3 trang
      soDongMoiTrang: 20,
    });

    expect(url).not.toBeNull();
    expect(url!.startsWith("/don-hang?")).toBe(true);
    const qs = new URLSearchParams(url!.split("?")[1]);
    expect(qs.get("trang")).toBe("3");
    expect(qs.get("trang_thai")).toBe("hoan"); // mất bộ lọc = đưa người dùng tới một danh sách khác
    expect(qs.get("q")).toBe("áo");
  });

  it("trang còn trong tầm → null (không chuyển hướng)", () => {
    expect(
      urlTrangCuoiNeuVuot({ duongDan: "/san-pham", sp: { trang: "3" }, trang: 3, tong: 45, soDongMoiTrang: 20 })
    ).toBeNull();
  });

  it("bộ lọc lọc hết sạch (tổng 0) → về trang 1, URL KHÔNG gắn ?trang=1 thừa", () => {
    expect(
      urlTrangCuoiNeuVuot({
        duongDan: "/ton-kho",
        sp: { trang: "5", loc: "sap_het" },
        trang: 5,
        tong: 0,
        soDongMoiTrang: 20,
      })
    ).toBe("/ton-kho?loc=sap_het");
  });

  it("không còn tham số nào khác → URL sạch, không có dấu ?", () => {
    expect(
      urlTrangCuoiNeuVuot({ duongDan: "/ton-kho", sp: { trang: "9" }, trang: 9, tong: 5, soDongMoiTrang: 20 })
    ).toBe("/ton-kho");
  });

  it("đúng bội số trang (40 dòng, 20/trang = 2 trang): trang 2 hợp lệ, trang 3 thì không", () => {
    expect(
      urlTrangCuoiNeuVuot({ duongDan: "/don-hang", sp: {}, trang: 2, tong: 40, soDongMoiTrang: 20 })
    ).toBeNull();
    expect(
      urlTrangCuoiNeuVuot({ duongDan: "/don-hang", sp: {}, trang: 3, tong: 40, soDongMoiTrang: 20 })
    ).toBe("/don-hang?trang=2");
  });

  it("tham số rỗng bị bỏ khỏi URL (không đẻ ra `?q=` vô nghĩa)", () => {
    expect(
      urlTrangCuoiNeuVuot({
        duongDan: "/don-hang",
        sp: { q: "", kenh: "shopee" },
        trang: 7,
        tong: 10,
        soDongMoiTrang: 20,
      })
    ).toBe("/don-hang?kenh=shopee");
  });
});

describe("docSoTrang", () => {
  it("giá trị bình thường đi qua nguyên vẹn", () => {
    expect(docSoTrang("1")).toBe(1);
    expect(docSoTrang("7")).toBe(7);
  });

  it("thiếu / rác / âm / 0 → trang 1", () => {
    for (const v of [undefined, null, "", "abc", "1e999", "Infinity", "-5", "0"]) {
      expect(docSoTrang(v)).toBe(1);
    }
  });

  it("chuỗi toàn chữ số quá dài bị kẹp về trần, KHÔNG lọt xuống OFFSET", () => {
    // Không kẹp thì `skip = (trang − 1) × 20` vượt tầm số nguyên DB nhận ⇒ trang lỗi 500.
    const trang = docSoTrang("999999999999999999999");
    expect(Number.isSafeInteger(trang)).toBe(true);
    expect(trang).toBe(1_000_000);
    expect(docSoTrang("9007199254740993")).toBe(1_000_000);
  });
});
