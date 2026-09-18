import { describe, expect, it } from "vitest";

import { tinhAnhHuongCogs, thangVn } from "@/lib/gia-von/anh-huong-cogs";
import type { DeXuatGiaVon } from "@/lib/gia-von/doi-chieu-gia-von";

/**
 * Bảng "áp giá vốn thì lãi tháng nào đổi bao nhiêu" — con số chủ shop dựa vào để bấm duyệt.
 * Sai ở đây nghĩa là màn hình hứa một đằng, P&L ra một nẻo, mà chủ shop đã bấm mất rồi.
 */

function deXuat(over: Partial<DeXuatGiaVon> & { variantId: string }): DeXuatGiaVon {
  return {
    pancakeId: `pc-${over.variantId}`,
    sku: `SKU-${over.variantId}`,
    ten: "Sản phẩm test · size M",
    giaHienTai: 120_000,
    giaDeXuat: 100_000,
    nguon: "trung-binh",
    ...over,
  };
}

/** Dòng đã bán giả lập — bơm qua tham số `docLichSuBan` nên test không cần DB. */
function ban(variantId: string, status: string, iso: string, quantity = 1) {
  return { variantId, status: status as never, orderedAt: new Date(iso), quantity };
}

describe("thangVn — cắt tháng theo giờ VN (bất biến #3)", () => {
  it("đơn 00:30 ngày 01/09 giờ VN (= 31/08 17:30 UTC) thuộc tháng 09, KHÔNG phải 08", () => {
    // Đây là ca vỡ kinh điển: neo nhầm UTC thì cả đêm đầu tháng bị đẩy về tháng trước,
    // chủ shop nhìn bảng thấy tháng 8 đổi trong khi thực tế tháng 9 mới đổi.
    expect(thangVn(new Date("2026-08-31T17:30:00.000Z"))).toBe("2026-09");
  });

  it("đơn 23:30 ngày 30/09 giờ VN vẫn thuộc tháng 09", () => {
    expect(thangVn(new Date("2026-09-30T16:30:00.000Z"))).toBe("2026-09");
  });
});

describe("tinhAnhHuongCogs", () => {
  it("đơn HOÀN/HUỶ không vào bảng tháng và không vào tổng P&L, nhưng có ở tổng mọi đơn", async () => {
    const d = [deXuat({ variantId: "v1", giaHienTai: 120_000, giaDeXuat: 100_000 })]; // chênh −20.000
    const kq = await tinhAnhHuongCogs(d, async () => [
      ban("v1", "COMPLETED", "2026-09-10T03:00:00.000Z", 2), // −40.000 vào P&L
      ban("v1", "RETURNED", "2026-09-11T03:00:00.000Z", 1), // −20.000 KHÔNG vào P&L
      ban("v1", "CANCELLED", "2026-09-12T03:00:00.000Z", 1), // −20.000 KHÔNG vào P&L
    ]);

    expect(kq.tongDonHopLe).toBe(-40_000);
    expect(kq.tongMoiDon).toBe(-80_000);
    expect(kq.theoThang).toEqual([{ thang: "2026-09", deltaCogs: -40_000, soDonViDaBan: 2 }]);
  });

  it("biến thể CHƯA TỪNG BÁN ⇒ không sinh dòng tháng, đếm vào soBienTheChuaBan", async () => {
    const d = [deXuat({ variantId: "v1" }), deXuat({ variantId: "v2" })];
    const kq = await tinhAnhHuongCogs(d, async () => [ban("v1", "COMPLETED", "2026-09-10T03:00:00.000Z")]);

    expect(kq.soBienTheChuaBan).toBe(1);
    expect(kq.theoThang).toHaveLength(1);
  });

  it("giá đề xuất CAO hơn giá hiện tại ⇒ ΔCOGS DƯƠNG (lãi giảm)", async () => {
    const d = [deXuat({ variantId: "v1", giaHienTai: 120_000, giaDeXuat: 120_833 })];
    const kq = await tinhAnhHuongCogs(d, async () => [ban("v1", "SHIPPING", "2026-09-06T03:00:00.000Z")]);

    expect(kq.tongDonHopLe).toBe(833);
  });

  it("gom nhiều tháng, sắp xếp tháng GẦN NHẤT lên đầu", async () => {
    const d = [deXuat({ variantId: "v1", giaHienTai: 120_000, giaDeXuat: 110_000 })]; // chênh −10.000
    const kq = await tinhAnhHuongCogs(d, async () => [
      ban("v1", "COMPLETED", "2026-03-10T03:00:00.000Z"),
      ban("v1", "COMPLETED", "2026-09-10T03:00:00.000Z", 2),
      ban("v1", "COMPLETED", "2026-05-10T03:00:00.000Z"),
    ]);

    expect(kq.theoThang.map((t) => t.thang)).toEqual(["2026-09", "2026-05", "2026-03"]);
    expect(kq.theoThang[0]).toEqual({ thang: "2026-09", deltaCogs: -20_000, soDonViDaBan: 2 });
    expect(kq.tongDonHopLe).toBe(-40_000);
  });

  it("danh sách đề xuất RỖNG ⇒ không gọi DB, trả 0", async () => {
    let goi = 0;
    const kq = await tinhAnhHuongCogs([], async () => {
      goi++;
      return [];
    });

    expect(goi).toBe(0);
    expect(kq).toEqual({ theoThang: [], tongDonHopLe: 0, tongMoiDon: 0, soBienTheChuaBan: 0 });
  });

  it("bỏ qua dòng bán của biến thể KHÔNG nằm trong đề xuất", async () => {
    const d = [deXuat({ variantId: "v1" })];
    const kq = await tinhAnhHuongCogs(d, async () => [
      ban("v1", "COMPLETED", "2026-09-10T03:00:00.000Z"),
      ban("v-la", "COMPLETED", "2026-09-10T03:00:00.000Z", 99),
    ]);

    expect(kq.tongDonHopLe).toBe(-20_000);
    expect(kq.theoThang[0].soDonViDaBan).toBe(1);
  });

  it("TÁI HIỆN ca thật 07/09: 8 mã Áo Dài Lụa ⇒ ΔCOGS đơn hợp lệ −433.530đ", async () => {
    // Số đo prod 2026-09-07 (báo cáo do-b2-phieu-nhap-pancake-260907-0942-...). Giữ nguyên vì đây
    // là lần duy nhất có cả dự đoán lẫn kết quả thật để đối chiếu.
    const GIA_MOI: Record<string, number> = {
      SP000416: 82_386,
      SP000417: 116_935,
      SP000418: 120_833,
      SP000419: 120_833,
      SP000425: 86_309,
      SP000426: 100_694,
      SP000427: 120_833,
      SP000428: 120_833,
    };
    const d = Object.entries(GIA_MOI).map(([sku, gia]) =>
      deXuat({ variantId: sku, sku, giaHienTai: 120_000, giaDeXuat: gia }),
    );

    const kq = await tinhAnhHuongCogs(d, async () => [
      ban("SP000416", "COMPLETED", "2026-08-15T03:00:00.000Z", 7), // −263.298
      ban("SP000417", "COMPLETED", "2026-04-15T03:00:00.000Z", 1), // −3.065
      ban("SP000417", "CANCELLED", "2026-04-16T03:00:00.000Z", 1), // ngoài P&L
      ban("SP000425", "COMPLETED", "2026-05-15T03:00:00.000Z", 1), // −33.691
      ban("SP000425", "RETURNED", "2026-05-16T03:00:00.000Z", 1), // ngoài P&L
      ban("SP000426", "SHIPPING", "2026-09-02T03:00:00.000Z", 2), // −38.612
      ban("SP000426", "COMPLETED", "2026-03-15T03:00:00.000Z", 5), // −96.530
      ban("SP000426", "CANCELLED", "2026-03-16T03:00:00.000Z", 1), // ngoài P&L
      ban("SP000428", "SHIPPING", "2026-09-06T03:00:00.000Z", 1), // +833
      ban("SP000418", "PENDING", "2026-09-07T02:59:55.000Z", 1), // +833 (đơn 09:59 giờ VN 07/09)
    ]);

    // −433.530 = số ĐO THẬT lúc 10:30 (đã gồm đơn SP000418 bán 09:59). Bản dự đoán lúc 09:45 là
    // −434.363, chưa có đơn đó — chênh đúng 833đ, đã truy ra nguyên nhân.
    expect(kq.tongDonHopLe).toBe(-433_530);
    expect(kq.tongMoiDon).toBe(-489_592);
    // Tháng 5 là tháng nặng nhất theo tỉ lệ — đúng phát hiện của lượt đo.
    expect(kq.theoThang.find((t) => t.thang === "2026-05")?.deltaCogs).toBe(-33_691);
    // Tháng 9 = −36.946đ — khớp TỪNG ĐỒNG với ΔCOGS T9 đo trên P&L thật (1.440.000 → 1.403.054).
    expect(kq.theoThang.find((t) => t.thang === "2026-09")?.deltaCogs).toBe(-36_946);
  });
});
