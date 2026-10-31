import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { docDongVeMuonTruocM } from "@/lib/no-phai-tra/doc-dong-ve-muon-truoc-m";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Hồi quy: chốt phiên bản `nguonFetchedAt` của Silver TikTok KHÔNG được đổi nghĩa `syncedAt` ("chỉ đặt lúc TẠO").
 * `docDongVeMuonTruocM` (trang Nợ phải trả — gợi ý vì sao quỹ trước ngày bật trôi) coi `syncedAt > lúc bật` là "dòng
 * về muộn": lệnh rút đã có từ trước mà bị đóng dấu lại mỗi lần cập nhật sẽ thành báo động giả mỗi đêm.
 */

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

const lenhRut = (id: string, taiKhoan: string) =>
  `{"code":0,"message":"Success","data":{"payments":[{"id":"${id}","status":"PAID",` +
  `"paid_time":${epoch(vn("2026-10-15", "10:00:00"))},"create_time":${epoch(vn("2026-10-14"))},` +
  `"amount":{"value":"1800000","currency":"VND"},"settlement_amount":{"value":"1800000","currency":"VND"},` +
  `"reserve_amount":{"value":"0","currency":"VND"},"bank_account":"${taiKhoan}"}]}}`;

async function cleanup(): Promise<void> {
  await truncateBusinessTables();
  await prisma.rawTiktokShopPayment.deleteMany();
}

beforeAll(async () => {
  await seedReference();
}, 60_000);
beforeEach(async () => {
  await cleanup();
  // Mở sổ (D0) 01/10 — để khoảng [D0, M − 1] chứa ngày rút 15/10.
  await prisma.cashMovement.create({
    data: { date: vn("2026-10-01"), kind: "CAPITAL_IN", amount: 1, description: "mở sổ" },
  });
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("syncedAt chỉ đặt lúc tạo — người đọc 'dòng về muộn' không đổi kết quả", () => {
  it("cập nhật lệnh rút đã có (bản kho thô mới hơn) KHÔNG làm nó thành 'về muộn'; lệnh MỚI thì có", async () => {
    await landRaw("tiktok/payments", SHOP_TIKTOK_SHOP, lenhRut("PAY-CU", "****1111"));
    await transformFromRaw("tiktok/payments", []);
    const truoc = await prisma.tiktokPayment.findUniqueOrThrow({ where: { paymentId: "PAY-CU" } });

    const lucBat = new Date(Date.now() + 5);
    await new Promise((r) => setTimeout(r, 20));

    await landRaw("tiktok/payments", SHOP_TIKTOK_SHOP, lenhRut("PAY-CU", "****2222"));
    await landRaw("tiktok/payments", SHOP_TIKTOK_SHOP, lenhRut("PAY-MOI", "****1111"));
    const t = await transformFromRaw("tiktok/payments", []);
    expect(t).toMatchObject({ paymentsUpserted: 2, paymentsSkippedStale: 0, skipped: 0 });

    const sau = await prisma.tiktokPayment.findUniqueOrThrow({ where: { paymentId: "PAY-CU" } });
    expect(sau.bankAccount).toBe("****2222"); // bản mới hơn ĐÃ ghi
    expect(sau.syncedAt).toEqual(truoc.syncedAt); // mà mốc tạo giữ nguyên
    expect(sau.nguonFetchedAt!.getTime()).toBeGreaterThan(truoc.nguonFetchedAt!.getTime());

    const { dong } = await docDongVeMuonTruocM(vn("2026-11-01"), lucBat);
    expect(dong.filter((d) => d.nguon === "TIKTOK_VE_BANK").map((d) => d.moTa)).toEqual(["lệnh PAY-MOI"]);
  });
});
