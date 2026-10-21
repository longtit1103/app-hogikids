import { describe, expect, it } from "vitest";

import { chuanHoaChiTiet, hauToPhanBiet, khoaViShopee } from "@/lib/import/shopee-wallet-khoa-phan-biet";
import { parseShopeeWalletFile } from "@/lib/import/shopee-wallet-xlsx";
import { dungFileViShopee, HEADER_VI_SHOPEE, tomTatTuDong } from "./helpers/file-vi-shopee-tong-hop";

/**
 * Parser ví Shopee — dòng VA CHẠM khoá `txnTime|type|orderCode|amount` trong cùng file.
 *
 * Ca thật file 01/01 (báo cáo 13/10): 2 điều chỉnh phí ship cùng giây, cùng −1.620, cột "Mã đơn hàng"
 * = "-", mã đơn chỉ nằm trong "Chi tiết" ⇒ cổng DUPLICATE_KEY chặn oan cả file. Luật mới: cột
 * "Chi tiết" phân biệt được thì dòng hậu tố nhỏ nhất GIỮ khoá gốc, dòng còn lại mang `khoaPhu`.
 */

const GOC = "2026-01-25T09:09:52+07:00|ADJUSTMENT|-|-1620";
const CT_A = "Điều chỉnh phí vận chuyển đơn hàng 260121KK741DX4";
const CT_B = "Điều chỉnh phí vận chuyển đơn hàng 260116805KMNGF";

// Mới → cũ như file Shopee xuất; số dư hai dòng va chạm lệch đúng 1.620.
const DONG_TRUOC: (string | number)[] = ["2026-01-25 10:00:00", "Doanh Thu Đơn Hàng", "Doanh thu", "260120REV00001", "Tiền vào", "100000", "Giao dịch thành công", "296760"];
const DONG_A: (string | number)[] = ["2026-01-25 09:09:52", "Điều chỉnh", CT_A, "-", "Tiền ra", "-1620", "Giao dịch thành công", "196760"];
const DONG_B: (string | number)[] = ["2026-01-25 09:09:52", "Điều chỉnh", CT_B, "-", "Tiền ra", "-1620", "Giao dịch thành công", "198380"];
const DONG_SAU: (string | number)[] = ["2026-01-24 08:00:00", "Doanh Thu Đơn Hàng", "Doanh thu", "260120REV00002", "Tiền vào", "200000", "Giao dịch thành công", "200000"];

function parse(rows: (string | number)[][], header = HEADER_VI_SHOPEE) {
  return parseShopeeWalletFile(dungFileViShopee(rows, tomTatTuDong(rows), header));
}

const khoaCua = (r: ReturnType<typeof parse>) => r.rows.map(khoaViShopee);

describe("parser ví Shopee — dòng va chạm khoá phân biệt bằng cột Chi tiết", () => {
  it("cặp điều chỉnh khác đơn (mã đơn trong Chi tiết) ⇒ KHÔNG chặn, 2 khoá khác nhau, dòng mã nhỏ hơn giữ khoá gốc", () => {
    const r = parse([DONG_TRUOC, DONG_A, DONG_B, DONG_SAU]);
    expect(r.errors).toEqual([]);
    expect(r.duplicateKeys).toEqual([]);
    expect(r.computed).toEqual(r.summary); // checksum vẫn là cổng — vẫn khớp
    // "260116805KMNGF" < "260121KK741DX4" ⇒ dòng B giữ khoá gốc, dòng A mang hậu tố = mã đơn của nó.
    expect(r.rows[2]).not.toHaveProperty("khoaPhu");
    expect(r.rows[1].khoaPhu).toBe("260121KK741DX4");
    expect(khoaCua(r)).toEqual([
      "2026-01-25T10:00:00+07:00|REVENUE|260120REV00001|100000",
      `${GOC}|260121KK741DX4`,
      GOC,
      "2026-01-24T08:00:00+07:00|REVENUE|260120REV00002|200000",
    ]);
    // Có cảnh báo (không chặn) để chủ shop biết nhóm nào được phân biệt.
    expect(r.warnings.some((w) => w.includes(GOC) && w.includes("Chi tiết"))).toBe(true);
  });

  it("đảo thứ tự dòng (trong cặp, và đảo cả file) ⇒ CÙNG tập khoá, cùng dòng giữ khoá gốc", () => {
    const goc = khoaCua(parse([DONG_TRUOC, DONG_A, DONG_B, DONG_SAU])).sort();
    expect(khoaCua(parse([DONG_TRUOC, DONG_B, DONG_A, DONG_SAU])).sort()).toEqual(goc);
    const dao = parse([DONG_SAU, DONG_B, DONG_A, DONG_TRUOC]);
    expect(khoaCua(dao).sort()).toEqual(goc);
    expect(dao.rows.find((x) => x.runningBalance === 198380)).not.toHaveProperty("khoaPhu");
  });

  it("dòng KHÔNG va chạm: không có field khoaPhu, payload JSON + khoá y hệt bản 4 thành phần", () => {
    const r = parse([DONG_TRUOC, DONG_SAU]);
    expect(r.duplicateKeys).toEqual([]);
    expect(r.rows.every((x) => !("khoaPhu" in x))).toBe(true);
    // Payload land vào Bronze = JSON của từng dòng — đúng 6 field cũ, đúng thứ tự cũ ⇒ payloadHash không đổi.
    expect(JSON.stringify(r.rows[0])).toBe(
      '{"txnTime":"2026-01-25T10:00:00+07:00","type":"REVENUE","orderCode":"260120REV00001","amount":100000,"status":"Giao dịch thành công","runningBalance":296760}',
    );
    expect(khoaCua(r)).toEqual([
      "2026-01-25T10:00:00+07:00|REVENUE|260120REV00001|100000",
      "2026-01-24T08:00:00+07:00|REVENUE|260120REV00002|200000",
    ]);
  });

  it("dòng giữ khoá gốc trong nhóm cũng có payload thường (không field mới)", () => {
    const r = parse([DONG_TRUOC, DONG_A, DONG_B, DONG_SAU]);
    expect(Object.keys(r.rows[2])).toEqual(["txnTime", "type", "orderCode", "amount", "status", "runningBalance"]);
  });

  it("Chi tiết GIỐNG HỆT (kể cả khác khoảng trắng) ⇒ VẪN chặn như cũ", () => {
    const b = [...DONG_B];
    b[2] = `  ${CT_A.replace(/ /g, "   ")} `;
    const r = parse([DONG_TRUOC, DONG_A, b, DONG_SAU]);
    expect(r.duplicateKeys).toEqual([GOC]);
  });

  it("file THIẾU cột Chi tiết ⇒ không phân biệt được ⇒ VẪN chặn", () => {
    const boCot = (row: (string | number)[]) => row.filter((_, i) => i !== 2);
    const header = HEADER_VI_SHOPEE.filter((h) => h !== "Chi tiết");
    const rows = [DONG_TRUOC, DONG_A, DONG_B, DONG_SAU].map(boCot);
    const r = parseShopeeWalletFile(
      dungFileViShopee(rows, tomTatTuDong([DONG_TRUOC, DONG_A, DONG_B, DONG_SAU]), header),
    );
    expect(r.errors).toEqual([]);
    expect(r.duplicateKeys).toEqual([GOC]);
  });

  it("Chi tiết khác chữ nhưng CÙNG mã đơn ⇒ hậu tố theo dòng trùng nhau ⇒ VẪN chặn", () => {
    const a = [...DONG_A];
    const b = [...DONG_B];
    a[2] = "Điều chỉnh phí vận chuyển đơn hàng 260121KK741DX4";
    b[2] = "Hoàn phí vận chuyển đơn hàng 260121KK741DX4";
    expect(parse([DONG_TRUOC, a, b, DONG_SAU]).duplicateKeys).toEqual([GOC]);
  });

  it("Chi tiết không có mã đơn, khác chữ ⇒ hậu tố băm ct:… theo từng dòng, phân biệt được", () => {
    const a = [...DONG_A];
    const b = [...DONG_B];
    a[2] = "Điều chỉnh phí vận chuyển";
    b[2] = "Phí dịch vụ hiển thị";
    const r = parse([DONG_TRUOC, a, b, DONG_SAU]);
    expect(r.duplicateKeys).toEqual([]);
    // "ct:49c3…" < "ct:4e7b…" ⇒ dòng a giữ khoá gốc, dòng b mang hậu tố băm của CHÍNH nó.
    expect(r.rows[1]).not.toHaveProperty("khoaPhu");
    expect(r.rows[2].khoaPhu).toBe("ct:4e7ba65d55c3759c");
  });

  it("hậu tố theo DÒNG: nhóm X,Y có mã + Z không mã — mọi tập con của nhóm cho hợp tập khoá ≤ 3 giao dịch thật", () => {
    // Cùng giây, cùng tiền; số dư liền mạch không quan trọng ở mức parser.
    const dong = (chiTiet: string, soDu: string): (string | number)[] =>
      ["2026-01-25 09:09:52", "Điều chỉnh", chiTiet, "-", "Tiền ra", "-1620", "Giao dịch thành công", soDu];
    const X = dong("Điều chỉnh đơn 260101AAAAAAAA", "1000");
    const Y = dong("Điều chỉnh đơn 260101BBBBBBBB", "2620");
    const Z = dong("Điều chỉnh phí vận chuyển", "4240");
    const tapCon = [[X, Y, Z], [X, Y], [Y, Z], [X, Z], [X], [Y], [Z], [Z, Y, X]];
    const hop = new Set<string>();
    for (const t of tapCon) {
      const r = parse(t);
      expect(r.duplicateKeys).toEqual([]);
      for (const k of khoaCua(r)) hop.add(k);
    }
    expect([...hop].sort()).toEqual([GOC, `${GOC}|260101BBBBBBBB`, `${GOC}|ct:49c359cb5cdef353`].sort());
  });

  it("nhóm 3 dòng: 2 phân biệt được, 1 trùng hệt Chi tiết ⇒ chặn cả nhóm", () => {
    const c = [...DONG_A];
    c[7] = "195140";
    const r = parse([DONG_TRUOC, DONG_A, c, DONG_B, DONG_SAU]);
    expect(r.duplicateKeys).toEqual([GOC]);
  });

  it("khoaViShopee: khoaPhu vắng ⇒ đúng khoá 4 thành phần (Rút Tiền orderCode null ⇒ '-')", () => {
    expect(khoaViShopee({ txnTime: "2026-05-05T19:36:02+07:00", type: "WITHDRAWAL", orderCode: null, amount: -2097069 })).toBe(
      "2026-05-05T19:36:02+07:00|WITHDRAWAL|-|-2097069",
    );
  });
});

/**
 * TEST VÀNG — hậu tố `khoaPhu` là định danh LƯU VĨNH VIỄN ở Bronze/Silver. Giá trị dưới đây dán cứng
 * (tính độc lập bằng Node + Python). Đỏ ở đây = đổi luật hậu tố ⇒ dòng đã land bị đếm 2 lần khi nhập lại
 * — KHÔNG sửa con số cho xanh; phải kèm script chuyển khoá Bronze/Silver.
 */
describe("hauToPhanBiet — giá trị vàng (hợp đồng lưu trữ)", () => {
  const f = (raw: string) => hauToPhanBiet(chuanHoaChiTiet(raw));

  it("băm Chi tiết cố định ⇒ chuỗi ct: cụ thể", () => {
    expect(f("Điều chỉnh phí vận chuyển")).toBe("ct:49c359cb5cdef353");
    expect(f("Phí dịch vụ hiển thị")).toBe("ct:4e7ba65d55c3759c");
  });

  it("Chi tiết dạng NFD / khoảng trắng thừa ⇒ cùng hậu tố bản NFC", () => {
    const nfd = "Điều chỉnh phí vận chuyển".normalize("NFD");
    expect(nfd).not.toBe("Điều chỉnh phí vận chuyển".normalize("NFC"));
    expect(f(nfd)).toBe("ct:49c359cb5cdef353");
    expect(f("  Điều   chỉnh phí\tvận chuyển ")).toBe("ct:49c359cb5cdef353");
  });

  it("mã đơn ⇒ đúng mã; nhiều mã ⇒ nối '+' theo thứ tự xuất hiện, mã lặp một lần", () => {
    expect(f("Điều chỉnh phí vận chuyển đơn hàng 260121KK741DX4")).toBe("260121KK741DX4");
    expect(f("Bù đơn 260121KK741DX4 và 260116805KMNGF, lại 260121KK741DX4")).toBe("260121KK741DX4+260116805KMNGF");
    expect(f("Bù đơn 260116805KMNGF và 260121KK741DX4")).toBe("260116805KMNGF+260121KK741DX4");
  });

  it("mã dính trong token dài (mã vận đơn) KHÔNG bị bắt ⇒ rơi về băm", () => {
    const h = f("Vận đơn SPXVN0461234567890ABCD");
    expect(h).toMatch(/^ct:[0-9a-f]{16}$/);
    expect(f("Vận đơn X260121KK741DX4")).toMatch(/^ct:/);
    expect(f("Vận đơn 260121KK741DX4Z")).toMatch(/^ct:/);
  });

  it("Chi tiết rỗng ⇒ không có hậu tố", () => {
    expect(f("   ")).toBe("");
  });
});
