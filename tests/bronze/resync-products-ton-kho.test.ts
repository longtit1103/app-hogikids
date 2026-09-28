import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/resync-products/route";
import {
  KEY_MOC_KIEM_GIA_VON,
  KEY_SO_LECH_GIA_VON,
} from "@/lib/gia-von/trang-thai-lech-gia-von";
import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Vá tồn kho từ Bronze — bước làm cho câu "API là CHUẨN" đúng với tồn kho.
 *
 * Vì sao tồn tại: `/api/ingest/raw` chỉ transform entity vừa land, mà Bronze dedupe theo hash ⇒
 * sản phẩm không đổi payload thì không bao giờ được dựng lại. Một giá trị tồn sai do webhook ghi sẽ
 * nằm đó vĩnh viễn nếu bên Pancake món đó không đổi gì thêm.
 */

const VARIATION_ID = "ea8b07f0-6d00-44fc-974f-fe96702a4071";
const PRODUCT_ID = "158ef5f1-6083-4b60-b5e0-c4fe95a07327";

/** Payload products shop kho — shape thật (giá vốn + tồn nằm ở biến thể). */
const SAN_PHAM_BRONZE = {
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
};

const post = () =>
  POST(
    new Request("http://localhost/api/ingest/resync-products", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );

/**
 * Nhật ký "lượt kéo products shop kho" — thứ mà chốt chặn dùng để biết sync API còn sống.
 * KHÔNG dùng `fetchedAt` của Bronze: nó chỉ nhích khi payload sản phẩm đổi (đo prod 2026-07-27),
 * nên đêm nào không ai mua gì cũng sẽ bị kết luận nhầm là "sync hỏng".
 */
async function ghiNhatKySync(startedAt = new Date()): Promise<void> {
  await prisma.syncLog.create({
    data: {
      kind: "PANCAKE",
      status: "OK",
      startedAt,
      finishedAt: startedAt,
      stats: { stream: "products", shopId: SHOP_KHO, landed: 0, mode: "land+transform" },
    },
  });
}

/** Dòng Bronze products với mốc `fetchedAt` chỉ định. */
async function landBronze(fetchedAt: Date): Promise<void> {
  await prisma.rawPancakeProduct.create({
    data: {
      shopId: SHOP_KHO,
      externalId: PRODUCT_ID,
      payloadHash: `hash-${fetchedAt.getTime()}`,
      payload: SAN_PHAM_BRONZE,
      fetchedAt,
    },
  });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.syncLog.deleteMany();
});

describe("POST /api/ingest/resync-products", () => {
  it("từ chối khi thiếu bearer", async () => {
    const res = await POST(new Request("http://localhost/api/ingest/resync-products", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("dựng lại tồn từ Bronze và trả quyền quyết định về cho API", async () => {
    await ghiNhatKySync();
    await landBronze(new Date());
    await post();
    // Webhook ghi tồn 2 từ 1 tiếng trước; ảnh Bronze chụp SAU đó vẫn nói 5 ⇒ API đã nhìn Pancake
    // muộn hơn webhook, nên số API thắng.
    await prisma.variant.update({
      where: { pancakeId: VARIATION_ID },
      data: { stock: 2, stockUpdatedAt: new Date(Date.now() - 3_600_000) },
    });

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats.mode).toBe("resynced");
    expect(body.stats.stockMocXoa).toBe(1);
    const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
    expect(v.stock).toBe(5); // số API thắng
    expect(v.stockUpdatedAt).toBeNull(); // mốc webhook đã trả về cho API
  });

  it("GIỮ tồn webhook khi nó mới hơn lần API đi nhìn (bán ngay trước lượt vá — không kéo tồn lùi)", async () => {
    // API kéo products lúc 30 phút trước; SAU đó có đơn nên webhook ghi tồn 4 lúc 5 phút trước.
    // Thước đo là mốc API ĐI NHÌN, KHÔNG phải `fetchedAt` của Bronze: `fetchedAt` chỉ nhích khi
    // payload đổi, còn webhook bắn 2 sự kiện/dòng đơn (sự kiện 2 trùng `remain_quantity`) ⇒ so với
    // `fetchedAt` sẽ có biến thể nằm trong nhóm "giữ" vĩnh viễn, API mất quyền sửa tồn nó.
    await ghiNhatKySync(new Date(Date.now() - 30 * 60_000));
    await landBronze(new Date(Date.now() - 30 * 60_000));
    await post();
    const mocWebhook = new Date(Date.now() - 5 * 60_000);
    await prisma.variant.update({
      where: { pancakeId: VARIATION_ID },
      data: { stock: 4, stockUpdatedAt: mocWebhook },
    });

    const res = await post();
    const body = await res.json();

    expect(body.stats.stockGiuWebhook).toBe(1);
    const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
    expect(v.stock).toBe(4); // KHÔNG lùi về 5 của ảnh Bronze cũ hơn
    expect(v.stockUpdatedAt?.toISOString()).toBe(mocWebhook.toISOString()); // guard còn mốc để so
  });

  it("mốc webhook cũ hơn lần API đi nhìn → API lấy lại quyền (không chiếm tồn vĩnh viễn)", async () => {
    // Ca thật: Pancake bắn 2 sự kiện cho một dòng đơn, sự kiện thứ hai trùng `remain_quantity` nên
    // `stockUpdatedAt` nhích mà nội dung Bronze không đổi. Nếu thước đo là `fetchedAt` từng sản phẩm
    // thì biến thể này nằm trong nhóm "giữ" ở MỌI đêm và API không bao giờ sửa được tồn của nó.
    await ghiNhatKySync(new Date(Date.now() - 10 * 60_000));
    await landBronze(new Date(Date.now() - 20 * 3_600_000)); // ảnh Bronze CŨ, không đổi từ lâu
    await post();
    await prisma.variant.update({
      where: { pancakeId: VARIATION_ID },
      data: { stock: 2, stockUpdatedAt: new Date(Date.now() - 30 * 60_000) }, // webhook TRƯỚC lượt API
    });

    const res = await post();
    const body = await res.json();

    expect(body.stats.stockGiuWebhook).toBe(0);
    const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
    expect(v.stock).toBe(5); // API lấy lại quyền
    expect(v.stockUpdatedAt).toBeNull();
  });

  it("KHÔNG đụng giá vốn APP-OWNED khi dựng lại", async () => {
    await ghiNhatKySync();
    await landBronze(new Date());
    await post();
    await prisma.variant.update({ where: { pancakeId: VARIATION_ID }, data: { costPrice: 123_456 } });

    await post();

    const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
    expect(v.costPrice).toBe(123_456);
  });

  it("lượt sync API đã chết → KHÔNG đè tồn, và KÊU TO (500 + SyncLog ERROR để banner đỏ bật)", async () => {
    await ghiNhatKySync();
    await landBronze(new Date());
    await post();
    await prisma.variant.update({
      where: { pancakeId: VARIATION_ID },
      data: { stock: 2, stockUpdatedAt: new Date() },
    });
    // Lượt kéo products gần nhất đã 5 tiếng trước ⇒ sync coi như chết.
    await prisma.syncLog.deleteMany();
    await ghiNhatKySync(new Date(Date.now() - 5 * 3_600_000));

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("KHÔNG vá được tồn kho");
    const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
    expect(v.stock).toBe(2); // số webhook được giữ nguyên
    expect(v.stockUpdatedAt).not.toBeNull();
    // ERROR mới là thứ `getRecentErrorKinds()` soi được ⇒ banner đỏ toàn app bật. Trả OK ở đây là
    // hỏng âm thầm: card Tình trạng đồng bộ vẫn xanh với mốc tươi trong khi tồn không ai đối chiếu.
    const log = await prisma.syncLog.findFirst({ orderBy: { startedAt: "desc" } });
    expect(log?.status).toBe("ERROR");
    // Thông điệp phải chỉ ĐÚNG chỗ cần xem: từ 2026-07-28 lượt vá chỉ được gọi ở cuối
    // `pancake-nightly` (lịch 30' đã tắt), nên lỗi này = bước kéo products trong lượt đêm trượt.
    expect(log?.error).toContain("pancake-nightly");
  });

  it("ảnh Bronze cũ NHƯNG sync còn sống → VẪN chạy (đêm yên ả không ai mua gì)", async () => {
    // Ca thật đo trên prod 2026-07-27: lượt kéo products chạy 7,7 phút trước với `landed: 0`,
    // còn dòng Bronze mới nhất đã 1,13 giờ tuổi (dedupe theo hash nên không đẻ dòng mới).
    // Lấy Bronze làm thước đo "sync còn sống" thì lượt vá sẽ không bao giờ chạy.
    await ghiNhatKySync();
    await landBronze(new Date(Date.now() - 20 * 3_600_000));

    const res = await post();
    const body = await res.json();

    expect(body.stats.mode).toBe("resynced");
    expect(await prisma.variant.count()).toBe(1);
  });

  it("nhật ký trống → coi như sync hỏng, không chạy", async () => {
    await landBronze(new Date());

    const res = await post();

    expect(res.status).toBe(500);
    expect(await prisma.variant.count()).toBe(0);
  });

  it("lượt chạy của CHÍNH endpoint này không tự chứng nhận là sync còn sống", async () => {
    await landBronze(new Date());

    await post(); // đẻ ra một SyncLog PANCAKE nhưng stats KHÔNG có `stream`
    const res = await post();

    expect(res.status).toBe(500);
  });

  it("BRONZE_ONLY → bỏ qua (Silver đang cố ý đứng yên)", async () => {
    await ghiNhatKySync();
    await landBronze(new Date());
    process.env.BRONZE_ONLY = "true";
    try {
      const res = await post();
      const body = await res.json();

      expect(body.stats.mode).toBe("skipped");
      expect(body.stats.reason).toBe("bronze-only");
      expect(await prisma.variant.count()).toBe(0);
    } finally {
      delete process.env.BRONZE_ONLY;
    }
  });
});

/**
 * Đếm lệch giá vốn — nối vào cuối lượt vá vì đúng lúc Bronze products tươi nhất trong đêm.
 * Con số này là thứ đẩy lên banner nhắc việc, thay cho việc chủ shop phải NHỚ mà chạy CLI.
 */
describe("POST /api/ingest/resync-products — đếm lệch giá vốn", () => {
  it("ghi số lệch + mốc vào Setting sau khi vá tồn", async () => {
    await ghiNhatKySync();
    await landBronze(new Date());
    await post(); // lượt đầu tạo Variant (prefill costPrice = 60.000 lúc CREATE)

    // Chủ shop sửa giá vốn tay xuống 50.000 ⇒ lệch với Pancake (60.000).
    await prisma.variant.update({ where: { pancakeId: VARIATION_ID }, data: { costPrice: 50_000 } });

    const res = await post();
    const body = await res.json();

    expect(body.stats.soLechGiaVon).toBe(1);
    const soLech = await prisma.setting.findUnique({ where: { key: KEY_SO_LECH_GIA_VON } });
    const moc = await prisma.setting.findUnique({ where: { key: KEY_MOC_KIEM_GIA_VON } });
    expect(soLech?.value).toBe("1");
    expect(Number.isNaN(new Date(moc!.value).getTime())).toBe(false);
  });

  it("app khớp Pancake ⇒ ghi 0 (KHÁC hẳn với 'chưa đếm lần nào')", async () => {
    await ghiNhatKySync();
    await landBronze(new Date());
    await post();

    const res = await post();
    const body = await res.json();

    expect(body.stats.soLechGiaVon).toBe(0);
    expect((await prisma.setting.findUnique({ where: { key: KEY_SO_LECH_GIA_VON } }))?.value).toBe("0");
  });

});
