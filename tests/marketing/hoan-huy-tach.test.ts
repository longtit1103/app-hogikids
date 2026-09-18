import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hoanHuyTach } from "@/lib/reports/marketing/hoan-huy-tach";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";
import { taoDon } from "./tao-don-gia";

/**
 * Tách "hoàn" khỏi "hủy/bom" — `/kenh` gộp hai thứ này làm một, mà chúng là hai vấn đề kinh doanh
 * khác nhau. Lời khai phải giữ: tổng 3 nhóm PHẢI bằng số hoàn/bom của `/kenh` cùng kỳ + kênh ⇒
 * đơn không đọc được mã gốc KHÔNG được biến mất, phải rơi vào `khongRoMa`.
 */
const RANGE = { from: new Date("2026-05-01T00:00:00+07:00"), to: new Date("2026-05-31T00:00:00+07:00") };
const TRONG_KY = new Date("2026-05-15T00:00:00+07:00");
const NGOAI_KY = new Date("2026-04-15T00:00:00+07:00");

beforeAll(async () => {
  await seedReference();
}, 60_000);
beforeEach(async () => {
  await truncateBusinessTables();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("hoanHuyTach", () => {
  it("tách mã 4/5 (hoàn) khỏi mã 6/7 (hủy) — đơn + tiền tuyệt đối", async () => {
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 500_000, status: "RETURNED", raw: { status: 4 } });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 300_000, status: "RETURNED", raw: { status: "5" } });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 200_000, status: "CANCELLED", raw: { status: 6 } });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 900_000 }); // COMPLETED — không thuộc bảng này

    const r = await hoanHuyTach(RANGE);
    expect(r.hoan).toEqual({ soDon: 2, tien: 800_000 });
    expect(r.huy).toEqual({ soDon: 1, tien: 200_000 });
    expect(r.khongRoMa).toEqual({ soDon: 0, tien: 0 });
  });

  it("mã lạ / thiếu mã rơi vào khongRoMa — KHÔNG được biến mất khỏi bảng", async () => {
    // Pancake KHÔNG công khai bảng mã số; mapping có nhánh "mã lạ → CANCELLED". Đo prod 24/08 là 0 đơn,
    // nhưng đường đó sống ⇒ phải có chỗ chứa, nếu không tổng của bảng < tổng hoàn/hủy của /kenh.
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 111_000, status: "CANCELLED", raw: { status: 99 } });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 222_000, status: "CANCELLED", raw: {} });

    const r = await hoanHuyTach(RANGE);
    expect(r.khongRoMa).toEqual({ soDon: 2, tien: 333_000 });
  });

  it("mã lạ NHƯNG có status_name đọc được ⇒ đi theo tên, đúng đường fallback của mapStatus", async () => {
    // `mapStatus()` xếp đơn này vào RETURNED nhờ TÊN chứ không nhờ mã. Bảng phải nói cùng một chuyện:
    // để nó rơi vào "không rõ mã gốc" là khai "app không biết" về đơn mà app thừa biết là đơn hoàn.
    await taoDon({
      orderedAt: TRONG_KY,
      itemsTotal: 400_000,
      status: "RETURNED",
      raw: { status: 99, status_name: "returning" },
    });
    // Chuẩn hoá y hệt mapStatus (`.trim().toLowerCase()`) — hoa/thường + khoảng trắng thừa vẫn khớp.
    await taoDon({
      orderedAt: TRONG_KY,
      itemsTotal: 100_000,
      status: "CANCELLED",
      raw: { status: "lạ", status_name: "  Cancelled " },
    });

    const r = await hoanHuyTach(RANGE);
    expect(r.hoan).toEqual({ soDon: 1, tien: 400_000 });
    expect(r.huy).toEqual({ soDon: 1, tien: 100_000 });
    expect(r.khongRoMa).toEqual({ soDon: 0, tien: 0 });
  });

  it("lọc theo kênh", async () => {
    await taoDon({ channelId: "tiktok", orderedAt: TRONG_KY, itemsTotal: 100_000, status: "RETURNED", raw: { status: 4 } });
    await taoDon({ channelId: "shopee", orderedAt: TRONG_KY, itemsTotal: 700_000, status: "CANCELLED", raw: { status: 6 } });
    expect((await hoanHuyTach(RANGE, { channelId: "shopee" })).huy).toEqual({ soDon: 1, tien: 700_000 });
    expect((await hoanHuyTach(RANGE, { channelId: "shopee" })).hoan).toEqual({ soDon: 0, tien: 0 });
  });

  it("đơn ngoài kỳ KHÔNG lọt vào (cùng biên kỳ với calcPnl)", async () => {
    await taoDon({ orderedAt: NGOAI_KY, itemsTotal: 999_000, status: "RETURNED", raw: { status: 4 } });
    // Biên PHẢI là hết ngày `to`, không phải 00:00 — đơn 23:30 ngày cuối kỳ phải được tính.
    await taoDon({
      orderedAt: new Date("2026-05-31T23:30:00+07:00"),
      itemsTotal: 50_000,
      status: "CANCELLED",
      raw: { status: 6 },
    });

    const r = await hoanHuyTach(RANGE);
    expect(r.hoan).toEqual({ soDon: 0, tien: 0 });
    expect(r.huy).toEqual({ soDon: 1, tien: 50_000 });
  });
});
