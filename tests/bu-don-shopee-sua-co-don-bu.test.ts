import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Script bù đơn phải TỰ LÀNH khi chạy lại (`hogikids_test`).
 *
 * Lỗ hổng đã có thật: `upsertOneOrder` và câu `update` gắn cờ `backfilledFromMirror` là hai bước
 * rời — chết giữa chừng thì đơn bù nằm lại với cờ `false`, và lượt chạy lại bỏ qua ngay vì "đã có".
 * Cờ `false` trên đơn bù NGUY HIỂM CHỦ ĐỘNG: `rebuild.ts` sẽ đếm nó vào nhóm "bị luật loại mà còn
 * trong Silver" rồi khuyên chủ shop XOÁ TAY — tức app tự xúi xoá doanh thu thật đã bù.
 *
 * Test chạy CHÍNH script (subprocess, DATABASE_URL trỏ DB test) thay vì chép điều kiện WHERE vào
 * test — chép lại là canh gác bản sao, script đổi thì test vẫn xanh.
 */

const SCRIPT = "scripts/bu-don-shopee-tu-don-kho.ts";

/** `spawnSync` (không phải exec ném lỗi): cần đọc CẢ stderr — cảnh báo nghi mirror đi đường đó. */
function chayScript(
  thamSo: string[],
  opts?: { choPhepThoatLoi?: boolean }
): { stdout: string; stderr: string; status: number | null } {
  const kq = spawnSync("./node_modules/.bin/tsx", [SCRIPT, ...thamSo], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (kq.error) throw kq.error;
  // spawnSync KHÔNG ném khi exit != 0 (khác execFileSync) — không chặn ở đây thì script crash giữa
  // chừng vẫn cho test xanh. Case chờ script thoát mã lỗi CHỦ ĐÍCH (nghi mirror, audit đếm đôi)
  // truyền `choPhepThoatLoi` rồi tự assert `status`.
  if (!opts?.choPhepThoatLoi && kq.status !== 0) {
    throw new Error(`Script thoát mã ${kq.status}\nstdout:\n${kq.stdout}\nstderr:\n${kq.stderr}`);
  }
  return { stdout: kq.stdout, stderr: kq.stderr, status: kq.status };
}

/**
 * Đơn tối thiểu. `danhDauBu` = có dấu vết `raw._buTuDonKho` — MỌI phiên bản script đều ghi dấu vết
 * này cùng đơn, nên "đơn bù chết giữa 2 bước" là (AF… + dấu vết + cờ false); còn (AF… KHÔNG dấu
 * vết) là hình dạng của mirror lọt vào Silver dưới luật cũ, tự lành KHÔNG được đụng.
 */
async function taoDonShopee(pancakeId: string, code: string, danhDauBu = false): Promise<void> {
  await prisma.order.create({
    data: {
      pancakeId,
      code,
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: new Date(2026, 2, 15),
      syncedAt: new Date(2026, 2, 15),
      itemsTotal: 100_000,
      discount: 0,
      platformFeeEst: 29_000,
      raw: danhDauBu ? { _buTuDonKho: { nguon: "test tự lành" } } : {},
    },
  });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  // `truncateBusinessTables` cố ý không đụng Bronze — không dọn thì bản sao kho của suite khác
  // (vd doi-chieu-don-kho trồng đúng id AF của shop Shopee) lọt vào lượt --ghi của script này.
  await prisma.rawPancakeOrder.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("bu-don-shopee-tu-don-kho — bù đơn mới từ bản sao kho", () => {
  it("--ghi: đơn bù được tạo VỚI cờ backfilledFromMirror ngay trong một lượt", { timeout: 60_000 }, async () => {
    // Cờ phải đi cùng đơn trong CÙNG transaction upsert — không có trạng thái trung gian "đơn đã
    // ghi mà cờ chưa gắn" để crash giữa chừng biến đơn bù thành mồi cho cảnh báo 'cần xoá tay'.
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: "714995134",
        externalId: "AF1942992175O30",
        payloadHash: "h-mirror-30",
        payload: {
          id: "AF1942992175O30",
          system_id: 12345,
          status: 3,
          inserted_at: "2026-03-20T03:00:00.000000",
          order_sources_name: "Affiliate",
          marketplace_id: "-3",
          total_price: 250_000,
          total_discount: 0,
          fee_marketplace: 0,
          cod: 250_000,
          items: [
            { quantity: 1, variation_id: "v-m", discount_each_product: 0, variation_info: { display_id: "SKU-M", name: "SP M", retail_price: 250_000 } },
          ],
        },
      },
    });

    chayScript(["--ghi"]);

    const don = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "AF1942992175O30" } });
    expect(don.backfilledFromMirror).toBe(true);
    expect(don.channelId).toBe("shopee");
    expect(don.code).toBe("30");
  });
});

describe("bu-don-shopee-tu-don-kho — bước tự sửa cờ đơn bù", () => {
  it("--ghi: đơn bù mất cờ được sửa lại true; đơn Shopee thường không bị đụng", { timeout: 60_000 }, async () => {
    await taoDonShopee("AF1942992175O21", "21", true); // đơn bù nhưng cờ false (chết giữa 2 bước)
    await taoDonShopee("9021384756", "22"); // đơn gốc bình thường

    chayScript(["--ghi"]);

    const [donBu, donThuong] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { pancakeId: "AF1942992175O21" } }),
      prisma.order.findUniqueOrThrow({ where: { pancakeId: "9021384756" } }),
    ]);
    expect(donBu.backfilledFromMirror).toBe(true);
    expect(donThuong.backfilledFromMirror).toBe(false);
  });

  it("--ghi: đơn AF… KHÔNG có dấu vết _buTuDonKho = nghi mirror lọt — KHÔNG tự gắn cờ, kêu to + thoát mã lỗi", { timeout: 60_000 }, async () => {
    // Gắn cờ cho nó là dạy rebuild ngừng cảnh báo "đếm 2 lần" đúng chỗ đang đếm 2 lần thật.
    // Exit 0 thì automation coi lượt chạy là sạch — cảnh báo chỉ nằm stderr dễ bị nuốt.
    await taoDonShopee("AF1942992175O9", "9");

    const { stderr, status } = chayScript(["--ghi"], { choPhepThoatLoi: true });

    expect(stderr).toContain("nghi mirror");
    expect(status).toBe(1);
    const don = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "AF1942992175O9" } });
    expect(don.backfilledFromMirror).toBe(false);
  });

  it("audit cuối lượt: đơn bù có bản KHÁC cùng (kênh, mã) → NGHI ĐẾM ĐÔI kèm bằng chứng + thoát mã lỗi", { timeout: 60_000 }, async () => {
    // Đơn bù hợp lệ (đủ cờ + dấu vết) do lượt trước tạo — rồi Pancake trả lại đơn gốc cùng mã.
    // Audit KHÔNG khẳng định xoá (mã Pancake không duy nhất trong kênh — đo prod 2026-08-07 có cặp
    // trùng hợp lệ cùng ngày) mà trình số tiền + thời điểm để người quyết.
    await prisma.order.create({
      data: {
        pancakeId: "AF1942992175O55",
        code: "55",
        channelId: "shopee",
        status: "COMPLETED",
        orderedAt: new Date(2026, 2, 15),
        syncedAt: new Date(2026, 2, 15),
        itemsTotal: 100_000,
        discount: 0,
        platformFeeEst: 29_000,
        backfilledFromMirror: true,
        raw: { _buTuDonKho: { nguon: "test audit" } },
      },
    });
    await taoDonShopee("5500112233", "55"); // đơn gốc quay lại — cùng (shopee, mã 55)

    const { stderr, status } = chayScript([], { choPhepThoatLoi: true }); // audit chạy cả ở dry-run

    expect(stderr).toContain("NGHI ĐẾM ĐÔI");
    expect(stderr).toContain("AF1942992175O55");
    expect(stderr).toContain("5500112233");
    expect(status).toBe(1);
  });

  it("chạy thử (không --ghi): chỉ ĐẾM và báo, không sửa gì", { timeout: 60_000 }, async () => {
    await taoDonShopee("AF1942992175O21", "21", true);

    const { stdout } = chayScript([]);

    expect(stdout).toMatch(/1 đơn bù.*cờ/);
    const don = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "AF1942992175O21" } });
    expect(don.backfilledFromMirror).toBe(false);
  });
});
