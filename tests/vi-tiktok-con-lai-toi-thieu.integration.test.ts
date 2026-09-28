import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { docViTiktokConLaiToiThieu } from "@/lib/vi-san/vi-tiktok-con-lai-toi-thieu-queries";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration ô "Còn ở ví TikTok" trên `hogikids_test`: đọc đúng cột/mốc thời gian ở hai bảng rồi
 * giao hàm thuần. Mỗi ca khoá MỘT lựa chọn đọc mà hàm thuần không tự thấy được: mốc tiền vào
 * (`paymentTime`, lùi `statementTime`), mốc tiền rút (`raw.create_time` chứ không phải `paidTime`),
 * bỏ lệnh FAILED, KHÔNG trừ bảng ads trừ ví, D0 = ngày dòng ghi tay đầu tiên, chỉ statement SETTLED.
 */

const SHOP = "100975192";
const epoch = (d: Date) => String(Math.floor(d.getTime() / 1000));

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

function statement(
  id: string,
  statementTime: Date,
  paymentTime: Date | null,
  settlementAmount: number,
  paymentStatus = "SETTLED"
) {
  return {
    statementId: id,
    shopId: SHOP,
    statementTime,
    paymentTime,
    paymentStatus,
    settlementAmount,
    revenueAmount: settlementAmount,
    feeAmount: 0,
    adjustmentAmount: 0,
    netSalesAmount: settlementAmount,
    shippingCostAmount: 0,
  };
}

describe("docViTiktokConLaiToiThieu", () => {
  it("chưa có statement ⇒ null", async () => {
    expect(await docViTiktokConLaiToiThieu()).toBeNull();
  });

  it("đọc đúng mốc hai chuỗi, bỏ FAILED, không trừ ads trừ ví, tăng-từ-D0 theo dòng ghi tay đầu tiên", async () => {
    await prisma.tiktokSettlement.createMany({
      data: [
        statement("vt-s1", new Date(2026, 0, 15), new Date(2026, 0, 16), 100_000_000),
        // paymentTime NULL ⇒ lùi về statementTime (10/05, TRƯỚC D0).
        statement("vt-s2", new Date(2026, 4, 10), null, 4_000_000),
        // statementTime TRƯỚC D0 nhưng tiền vào ví (paymentTime) SAU D0 ⇒ tính vào tăng-từ-D0.
        statement("vt-s3", new Date(2026, 4, 11), new Date(2026, 4, 13), 6_000_000),
        statement("vt-s4", new Date(2026, 5, 1), new Date(2026, 5, 2), 2_000_000),
      ],
    });
    await prisma.tiktokPayment.createMany({
      data: [
        // Lệnh rút lớn đầu kỳ: tạo 20/01, bank trả 25/01 — rút quá số đã có ⇒ đáy chuỗi −30tr (B0).
        {
          paymentId: "vt-p1",
          shopId: SHOP,
          status: "PAID",
          paidTime: new Date(2026, 0, 25),
          settlementValue: 130_000_000,
          amountValue: 130_000_000,
          raw: { create_time: epoch(new Date(2026, 0, 20)) },
        },
        // FAILED ⇒ tiền không rời ví.
        {
          paymentId: "vt-p2",
          shopId: SHOP,
          status: "FAILED",
          paidTime: null,
          settlementValue: 50_000_000,
          amountValue: 50_000_000,
          raw: { create_time: epoch(new Date(2026, 4, 20)) },
        },
        // Tạo lệnh 11/05 23h (TRƯỚC D0) dù bank trả 13/05 (SAU D0) ⇒ KHÔNG vào tăng-từ-D0.
        {
          paymentId: "vt-p3",
          shopId: SHOP,
          status: "PAID",
          paidTime: new Date(2026, 4, 13),
          settlementValue: 1_000_000,
          amountValue: 1_000_000,
          raw: { create_time: epoch(new Date(2026, 4, 11, 23)) },
        },
        // Đang xử lý, không có raw ⇒ lùi paidTime (null) ⇒ syncedAt (hôm nay, SAU D0) — vẫn trừ.
        {
          paymentId: "vt-p4",
          shopId: SHOP,
          status: "PROCESSING",
          paidTime: null,
          settlementValue: 500_000,
          amountValue: 500_000,
        },
      ],
    });
    // Ads trừ ví ĐÃ nằm trong settlementAmount — đọc thêm bảng này là đếm 2 lần.
    await prisma.tiktokAdsSettlement.create({
      data: {
        transactionId: "vt-ads1",
        shopId: SHOP,
        orderCreateTime: new Date(2026, 4, 15),
        settlementAmount: -9_000_000,
      },
    });
    // D0 = 12/05/2026 (dòng ghi tay đầu tiên).
    await prisma.cashMovement.create({
      data: { date: new Date(2026, 4, 12), kind: "CAPITAL_IN", amount: 1_000_000, description: "Mở sổ" },
    });

    // Chuỗi: 16/01 +100 → 20/01 −130 (đáy −30) → 10/05 +4 → 11/05 −1 (−27) → 13/05 +6 → 02/06 +2
    //        → hôm nay −0,5 ⇒ cuối −19,5 ⇒ B0 = 30, ví = 10,5.
    // Từ D0 12/05: +6 + 2 − 0,5 = 7,5.
    expect(await docViTiktokConLaiToiThieu()).toEqual({
      b0ToiThieu: 30_000_000,
      viHienTai: 10_500_000,
      tangTuD0: 7_500_000,
    });
  });

  it("statement chưa SETTLED chưa vào ví ⇒ không tính, cả khoản dương lẫn âm", async () => {
    await prisma.tiktokSettlement.createMany({
      data: [
        statement("vt-s10", new Date(2026, 6, 1), new Date(2026, 6, 1), 10_000_000),
        // Net ÂM chưa chốt: tính vào là chuỗi xuống −20tr ⇒ B0 20tr, ví còn 5tr thay vì 10tr.
        statement("vt-s11", new Date(2026, 6, 2), null, -30_000_000, "PROCESSING"),
        // Sàn không báo trạng thái (mapping ghi chuỗi rỗng) cũng chưa phải tiền đã vào ví.
        statement("vt-s12", new Date(2026, 6, 3), null, 5_000_000, ""),
      ],
    });
    expect(await docViTiktokConLaiToiThieu()).toEqual({
      b0ToiThieu: 0,
      viHienTai: 10_000_000,
      tangTuD0: null,
    });
  });

  it("chỉ có statement chưa SETTLED ⇒ null như chưa đồng bộ (không in 0 ₫ như thật)", async () => {
    await prisma.tiktokSettlement.create({
      data: statement("vt-s13", new Date(2026, 6, 1), null, 7_000_000, "PROCESSING"),
    });
    expect(await docViTiktokConLaiToiThieu()).toBeNull();
  });

  it("chưa mở sổ quỹ ⇒ tangTuD0 null, ví vẫn tính", async () => {
    await prisma.tiktokSettlement.create({
      data: statement("vt-s9", new Date(2026, 6, 1), new Date(2026, 6, 1), 3_000_000),
    });
    expect(await docViTiktokConLaiToiThieu()).toEqual({
      b0ToiThieu: 0,
      viHienTai: 3_000_000,
      tangTuD0: null,
    });
  });
});
