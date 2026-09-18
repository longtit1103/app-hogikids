import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { doiSoatDonConDo, LoiDoiSoatKhongDangTinCay, QUA_HAN_PHUT } from "@/lib/bronze/doi-soat-don-con-do";
import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Phân biệt LỖI HỆ THỐNG với LỖI CỦA RIÊNG MỘT DÒNG.
 *
 * Lượt đối soát đêm đếm lượt thử theo từng dòng và đủ số lượt thì chôn dòng VĨNH VIỄN. Một sự cố hệ
 * thống dính vào MỌI đơn, nên nếu nó bị tính thành "dòng này hỏng" thì sau vài đêm toàn bộ đơn bị
 * chôn — dùng một sự cố tạm thời để vứt vĩnh viễn dữ liệu có tiền.
 *
 * Ca dựng ở đây là ca ĐÃ ĐO trong thực tế: phục hồi DB mà thiếu dữ liệu tham chiếu ⇒ bảng kênh
 * trống ⇒ MỌI `order.create` vi phạm khoá ngoại. Cố ý gây lỗi THẬT bên trong lượt ghi đơn — mock
 * cho `transformFromRaw` ném sẵn thì không phủ được đường này (nó nuốt lỗi rồi trả "đơn hỏng").
 */

const don = (id: string) => ({
  id,
  status: 3,
  inserted_at: "2026-07-01T10:00:00.000000",
  order_sources_name: "Shopee",
  marketplace_id: "-3",
  total_price: 200000,
  total_discount: 0,
  fee_marketplace: 15000,
  items: [
    {
      quantity: 2,
      discount_each_product: 0,
      variation_info: { display_id: "SKU-HT1", name: "SP", retail_price: 100000 },
    },
  ],
});

/** Dòng kho thô CHƯA đóng dấu và đã quá hạn — đúng thứ lượt đối soát đi nhặt. */
async function taoDongConDo(id: string): Promise<string> {
  const r = await prisma.rawPancakeOrder.create({
    data: {
      shopId: SHOP_SHOPEE,
      externalId: id,
      payloadHash: `h-${id}`,
      payload: don(id),
      fetchedAt: new Date(Date.now() - (QUA_HAN_PHUT + 5) * 60_000),
    },
  });
  return r.id;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
});

describe("lỗi hệ thống KHÔNG được tính thành lỗi của từng dòng", () => {
  it("thiếu dữ liệu kênh ⇒ báo KHÔNG đối soát được, và KHÔNG tăng lượt thử của dòng nào", async () => {
    const idA = await taoDongConDo("ORD-HT-A");
    const idB = await taoDongConDo("ORD-HT-B");

    // Xoá dữ liệu tham chiếu kênh: mọi lượt ghi đơn sẽ vi phạm khoá ngoại (đúng ca phục hồi DB
    // quên seed). Đơn của test này thuộc kênh "shopee".
    await prisma.channel.deleteMany({ where: { id: "shopee" } });

    try {
      const warnings: string[] = [];
      await expect(doiSoatDonConDo(warnings)).rejects.toBeInstanceOf(LoiDoiSoatKhongDangTinCay);

      // Cả hai dòng PHẢI còn nguyên ở "chưa xong" với 0 lượt thử — nếu không, ba đêm nữa là chúng
      // bị chuyển sang dừng-thử-lại và doanh thu biến mất vĩnh viễn.
      for (const id of [idA, idB]) {
        const raw = await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id } });
        expect(raw.silverOutcome).toBeNull();
        expect(raw.silverAttempts).toBe(0);
      }
    } finally {
      await seedReference();
    }
  });

  it("lỗi của RIÊNG một dòng vẫn được tính là một lượt thử (không nhầm sang hệ thống)", async () => {
    // Payload thiếu hẳn phần bắt buộc ⇒ hỏng shape ⇒ đóng dấu dừng-thử-lại ngay, đúng đường riêng
    // của lỗi dữ liệu. Ca này chứng minh phép phân loại KHÔNG nghiêng quá tay sang "hệ thống".
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "ORD-HT-SHAPE",
        payloadHash: "h-shape",
        payload: { id: "ORD-HT-SHAPE" },
        fetchedAt: new Date(Date.now() - (QUA_HAN_PHUT + 5) * 60_000),
      },
    });

    const warnings: string[] = [];
    const kq = await doiSoatDonConDo(warnings);

    expect(kq.failedShape).toBe(1);
    expect(kq.status).toBe("needs_attention");
  });
});
