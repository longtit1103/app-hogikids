import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK } from "./helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";
import { doiChieuDonKhoVsSan } from "@/lib/reports/doi-chieu-don-kho";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Lưới an toàn "đơn sàn vs bản sao trong kho" (`hogikids_test`).
 *
 * Test phải chứng minh nó BẮT ĐƯỢC đơn thiếu, không chỉ chạy không lỗi: bản thân lỗ hổng nó canh
 * (thiếu 24 đơn Shopee tháng 3–4/2026) đã nằm im 4 tháng dưới một log đồng bộ toàn màu xanh. Một
 * phép kiểm luôn trả 0 còn tệ hơn không có, vì nó tạo cảm giác đã được canh.
 */

const NGAY = "2026-06-15T03:00:00.000000";

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  // `truncateBusinessTables` CỐ Ý không đụng kho thô (các suite Bronze tự quản phần đó), mà suite
  // này đọc thẳng `RawPancakeOrder` — không dọn thì bản sao của test trước dồn sang test sau.
  await prisma.rawPancakeOrder.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Bản sao trong shop kho: `AF<shopId sàn>O<mã đơn>`. */
async function taoBanSaoKho(opts: {
  shopSan: string;
  code: string;
  status: string;
  cod: number;
  ngay?: string;
}): Promise<void> {
  await prisma.rawPancakeOrder.create({
    data: {
      shopId: SHOP_KHO,
      externalId: `AF${opts.shopSan}O${opts.code}`,
      payloadHash: `h-${opts.shopSan}-${opts.code}`,
      payload: {
        id: `AF${opts.shopSan}O${opts.code}`,
        inserted_at: opts.ngay ?? NGAY,
        status_name: opts.status,
        cod: opts.cod,
        order_sources_name: "Affiliate",
        marketplace_id: opts.shopSan === SHOP_SHOPEE ? "-3" : "-9",
      },
    },
  });
}

async function taoDonSan(channelId: string, code: string): Promise<void> {
  await prisma.order.create({
    data: {
      pancakeId: `GOC-${channelId}-${code}`,
      code,
      channelId,
      status: "COMPLETED",
      orderedAt: new Date(2026, 5, 15),
      syncedAt: new Date(2026, 5, 15),
      itemsTotal: 100_000,
      discount: 0,
      platformFeeEst: 0,
    },
  });
}

describe("doiChieuDonKhoVsSan", () => {
  it("mọi bản sao đều có đơn gốc → không báo thiếu", async () => {
    await taoBanSaoKho({ shopSan: SHOP_SHOPEE, code: "10", status: "delivered", cod: 230_000 });
    await taoBanSaoKho({ shopSan: SHOP_TIKTOK, code: "20", status: "delivered", cod: 350_000 });
    await taoDonSan("shopee", "10");
    await taoDonSan("tiktok", "20");

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.tongBanSao).toBe(2);
    expect(kq.thieu).toHaveLength(0);
    expect(kq.tienThieuDaGiao).toBe(0);
  });

  it("BẮT ĐƯỢC đơn có bản sao mà thiếu đơn gốc, kèm tiền đang hụt", async () => {
    await taoBanSaoKho({ shopSan: SHOP_SHOPEE, code: "11", status: "delivered", cod: 230_000 });
    await taoBanSaoKho({ shopSan: SHOP_SHOPEE, code: "12", status: "delivered", cod: 490_000 });
    await taoDonSan("shopee", "11"); // chỉ đơn 11 có gốc

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu).toHaveLength(1);
    expect(kq.thieu[0]).toMatchObject({ kenh: "shopee", code: "12", trangThaiKho: "delivered" });
    expect(kq.tienThieuDaGiao).toBe(490_000);
  });

  it("chỉ đơn ĐÃ GIAO tính vào tiền hụt; hoàn/hủy vẫn liệt kê để tỉ lệ hoàn đúng", async () => {
    await taoBanSaoKho({ shopSan: SHOP_TIKTOK, code: "31", status: "delivered", cod: 300_000 });
    await taoBanSaoKho({ shopSan: SHOP_TIKTOK, code: "32", status: "canceled", cod: 900_000 });
    await taoBanSaoKho({ shopSan: SHOP_TIKTOK, code: "33", status: "returning", cod: 700_000 });

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu).toHaveLength(3);
    expect(kq.tienThieuDaGiao).toBe(300_000); // KHÔNG cộng đơn hủy/hoàn
  });

  it("cùng mã đơn nhưng KHÁC kênh là hai đơn khác nhau — không được coi là đã có", async () => {
    await taoBanSaoKho({ shopSan: SHOP_SHOPEE, code: "77", status: "delivered", cod: 230_000 });
    await taoDonSan("tiktok", "77"); // đơn TikTok trùng mã, KHÔNG phải đơn Shopee này

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu).toHaveLength(1);
    expect(kq.thieu[0].kenh).toBe("shopee");
  });

  it("bỏ qua bản sao của shop lạ thay vì đoán kênh", async () => {
    await taoBanSaoKho({ shopSan: "999999999", code: "5", status: "delivered", cod: 100_000 });

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.tongBanSao).toBe(0);
    expect(kq.thieu).toHaveLength(0);
  });

  it("ngày đơn là INSTANT đúng — inserted_at naive của Pancake là giờ UTC, không phải giờ VN", async () => {
    // Đơn đặt 23:34 UTC 31/03 = 06:34 SÁNG 01/04 giờ VN — hiểu naive theo giờ VN là lùi 7 tiếng,
    // trượt sang ngày (thậm chí tháng) trước: đúng loại sai lệch từng gặp khi nghiệm thu T3/T4.
    await taoBanSaoKho({
      shopSan: SHOP_SHOPEE,
      code: "90",
      status: "delivered",
      cod: 100_000,
      ngay: "2026-03-31T23:34:36.000000",
    });

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu[0].ngayDat?.getTime()).toBe(Date.parse("2026-03-31T23:34:36Z"));
  });

  it("payload dị (cod chuỗi rác, inserted_at hỏng) không đánh sập truy vấn — đơn vẫn được liệt kê", async () => {
    // Bronze là kho THÔ: hàm này chạy trong Promise.all của trang Cài đặt, một giá trị dị mà văng
    // cast là đổ NGUYÊN trang. Hai module anh em (voucher-breakdown, tiktok-quyet-toan-don) đều đã
    // guard trước cast — đây là chỗ duy nhất từng cast thẳng.
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_KHO,
        externalId: `AF${SHOP_SHOPEE}O91`,
        payloadHash: "h-di-91",
        payload: {
          id: `AF${SHOP_SHOPEE}O91`,
          inserted_at: "khong-phai-ngay",
          status_name: "delivered",
          cod: "N/A",
        },
      },
    });
    await taoBanSaoKho({ shopSan: SHOP_SHOPEE, code: "92", status: "delivered", cod: 200_000 });

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu).toHaveLength(2);
    const donDi = kq.thieu.find((d) => d.code === "91")!;
    expect(donDi.tienHang).toBe(0); // rác → 0, không văng lỗi, không bịa số
    expect(donDi.ngayDat).toBeNull();
    expect(kq.tienThieuDaGiao).toBe(200_000); // đơn lành vẫn được cộng đúng
  });

  it("inserted_at ĐÚNG HÌNH DẠNG nhưng không phải ngày thật (tháng 13) → ngày null, không văng", async () => {
    // Regex hình dạng không đủ: '2026-13-45T10:00' qua được regex nhưng cast timestamp vẫn ném
    // 'field value out of range' — regex không kiểm được lịch. Phải parse phía JS (parseVnDate).
    await taoBanSaoKho({
      shopSan: SHOP_SHOPEE,
      code: "93",
      status: "delivered",
      cod: 150_000,
      ngay: "2026-13-45T10:00:00.000000",
    });

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu[0].ngayDat).toBeNull();
    expect(kq.tienThieuDaGiao).toBe(150_000);
  });

  it("cod dài quá 15 chữ số (rác) → 0, không tràn bigint", async () => {
    await taoBanSaoKho({ shopSan: SHOP_SHOPEE, code: "94", status: "delivered", cod: 200_000 });
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_KHO,
        externalId: `AF${SHOP_SHOPEE}O95`,
        payloadHash: "h-tran-95",
        payload: {
          id: `AF${SHOP_SHOPEE}O95`,
          inserted_at: NGAY,
          status_name: "delivered",
          cod: "999999999999999999999",
        },
      },
    });

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu.find((d) => d.code === "95")?.tienHang).toBe(0);
    expect(kq.tienThieuDaGiao).toBe(200_000);
  });

  it("đơn ngày hỏng xếp CUỐI danh sách, không chiếm chỗ đơn thật ở đầu", async () => {
    // Giới hạn liệt kê 100 dòng: NULL nổi lên đầu (mặc định DESC của Postgres) là đơn rác đẩy đơn
    // thật ra khỏi bảng — người vận hành mất khả năng nhìn thấy đúng thứ cần xử lý trước.
    await taoBanSaoKho({
      shopSan: SHOP_SHOPEE,
      code: "96",
      status: "delivered",
      cod: 100_000,
      ngay: "khong-phai-ngay",
    });
    await taoBanSaoKho({ shopSan: SHOP_SHOPEE, code: "97", status: "delivered", cod: 100_000, ngay: "2026-06-20T03:00:00.000000" });
    await taoBanSaoKho({ shopSan: SHOP_SHOPEE, code: "98", status: "delivered", cod: 100_000, ngay: "2026-06-25T03:00:00.000000" });

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu.map((d) => d.code)).toEqual(["98", "97", "96"]);
  });

  it("chỉ soi bản MỚI NHẤT của mỗi đơn (trạng thái đổi không đếm thành hai)", async () => {
    // Hai lượt kéo của CÙNG một đơn: lượt sau thấy khách đã trả hàng. Mốc `fetchedAt` phải đặt
    // tường minh cả hai — để mặc định thì bản thứ hai lấy `now()` và so với mốc quá khứ sẽ ra
    // ngược thứ tự, test xanh/đỏ theo ngày chạy chứ không theo hành vi.
    const nen = {
      shopId: SHOP_KHO,
      externalId: `AF${SHOP_TIKTOK}O88`,
      payload: {
        id: `AF${SHOP_TIKTOK}O88`,
        inserted_at: NGAY,
        cod: 250_000,
        order_sources_name: "Affiliate",
        marketplace_id: "-9",
      },
    };
    await prisma.rawPancakeOrder.create({
      data: {
        ...nen,
        payloadHash: "h-88-v1",
        payload: { ...nen.payload, status_name: "delivered" },
        fetchedAt: new Date(2026, 5, 16),
      },
    });
    await prisma.rawPancakeOrder.create({
      data: {
        ...nen,
        payloadHash: "h-88-v2",
        payload: { ...nen.payload, status_name: "returning" },
        fetchedAt: new Date(2026, 5, 20),
      },
    });

    const kq = await doiChieuDonKhoVsSan();
    expect(kq.tongBanSao).toBe(1);
    expect(kq.thieu).toHaveLength(1);
    expect(kq.thieu[0].trangThaiKho).toBe("returning"); // bản mới nhất
    expect(kq.tienThieuDaGiao).toBe(0); // không còn là đơn đã giao
  });
});
