import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

// Thay hàm đếm bằng bản LUÔN NÉM. `vi.mock` được hoist lên trước mọi import nên route nhận đúng bản
// giả này ở import tĩnh của nó — khác với `vi.spyOn` trên namespace module (không đổi được binding
// đã gắn). File riêng vì mock áp cho cả file.
vi.mock("@/lib/gia-von/doc-de-xuat-gia-von", () => ({
  demLechGiaVon: vi.fn().mockRejectedValue(new Error("Bronze không đọc được")),
  docDeXuatGiaVon: vi.fn(),
}));

import { POST } from "@/app/api/ingest/resync-products/route";
import { KEY_MOC_KIEM_GIA_VON, KEY_SO_LECH_GIA_VON } from "@/lib/gia-von/trang-thai-lech-gia-von";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * ĐÁNH ĐỔI ĐÃ CHỐT: vá tồn kho quan trọng hơn đếm lệch giá vốn.
 *
 * Vá tồn là thứ giữ cho "API là chuẩn" đúng với tồn kho — hỏng nó là trang Tồn kho báo sai hàng
 * loạt. Đếm lệch chỉ là tín hiệu nhắc việc, và nó đã có lưới riêng: mốc không được ghi ⇒ trạng thái
 * tự chuyển "tre" sau 26 giờ, chủ shop vẫn thấy có gì đó không ổn.
 *
 * Nếu ai đó bỏ `try/catch` quanh bước đếm, một lỗi đọc Bronze sẽ làm cả lượt đêm đỏ và tồn kho ngừng
 * được vá — file này là chốt chặn cho đúng ca đó.
 */

const VARIATION_ID = "ea8b07f0-6d00-44fc-974f-fe96702a4071";
const PRODUCT_ID = "158ef5f1-6083-4b60-b5e0-c4fe95a07327";

const post = () =>
  POST(
    new Request("http://localhost/api/ingest/resync-products", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.syncLog.deleteMany();
  // `Setting` là dữ liệu cấu hình nên KHÔNG nằm trong `truncateBusinessTables` ⇒ hai key này có
  // thể còn sót từ file test khác chạy trước. Dọn tay để phép kiểm "không ghi gì" nói đúng sự thật.
  await prisma.setting.deleteMany({ where: { key: { in: [KEY_SO_LECH_GIA_VON, KEY_MOC_KIEM_GIA_VON] } } });

  await prisma.syncLog.create({
    data: {
      kind: "PANCAKE",
      status: "OK",
      startedAt: new Date(),
      finishedAt: new Date(),
      stats: { stream: "products", shopId: SHOP_KHO, landed: 0, mode: "land+transform" },
    },
  });
  await prisma.rawPancakeProduct.create({
    data: {
      shopId: SHOP_KHO,
      externalId: PRODUCT_ID,
      payloadHash: "hash-1",
      payload: {
        id: PRODUCT_ID,
        name: "Áo Sơ Mi",
        variations: [
          {
            id: VARIATION_ID,
            display_id: "SP000426",
            retail_price: 100_000,
            remain_quantity: 5,
            average_imported_price: 60_000,
            fields: [{ name: "Size", value: "90" }],
          },
        ],
      },
    },
  });
});

describe("đếm lệch giá vốn HỎNG", () => {
  it("lượt vá tồn VẪN chạy trọn và trả OK, chỉ đẩy cảnh báo", async () => {
    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats.mode).toBe("resynced");
    // Tồn vẫn được dựng từ Bronze — đây là phần không được phép mất.
    const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
    expect(v.stock).toBe(5);
  });

  it("báo rõ đếm hỏng, KHÔNG ghi con số nào vào Setting (thà trống còn hơn số sai)", async () => {
    const res = await post();
    const body = await res.json();

    expect(body.stats.soLechGiaVon).toBeNull();
    expect(JSON.stringify(body)).toContain("Đếm lệch giá vốn hỏng");
    // Không có mốc mới ⇒ trạng thái sẽ tự chuyển "tre" sau 26 giờ.
    expect(await prisma.setting.findUnique({ where: { key: KEY_SO_LECH_GIA_VON } })).toBeNull();
  });
});
