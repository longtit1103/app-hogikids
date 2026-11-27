import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import {
  BANG_TIEN_SOI_THU_TU,
  canhBaoTrungMocBanner,
  canhBaoTrungMocLuot,
  demTongTrungMocBangTien,
  demTrungMoc,
  soiTrungMocCuaLuot,
} from "@/lib/bronze/dem-trung-moc-phien-ban-bang-tien";
import { prisma } from "@/lib/prisma";

/**
 * Phát hiện trùng mốc phiên bản ở BẢN ĐẦU của 4 bảng Bronze tiền + khoá lặp trong một lượt. Chạy trên DB test thật
 * (`TEST_DATABASE_URL`) vì nghĩa của phép đếm nằm ở câu SQL (cửa sổ theo khoá, mốc `fetchedAt` TIMESTAMP(3)).
 */

const SHOP = "SHOP-TM";
const T0 = new Date("2026-11-20T10:00:00.000Z");
const cong = (ms: number) => new Date(T0.getTime() + ms);

let dem = 0;
/** Chèn một dòng Bronze bằng SQL thô — dùng chung cho cả 4 bảng (cùng cột). `fetchedAt` do test quyết. */
async function chen(
  table: string,
  externalId: string,
  hash: string,
  fetchedAt: Date,
  syncLogId: string | null = null,
  shopId: string = SHOP,
): Promise<void> {
  dem += 1;
  await prisma.$executeRaw`
    INSERT INTO ${Prisma.raw(`"${table}"`)} ("id", "shopId", "externalId", "payload", "payloadHash", "fetchedAt", "syncLogId")
    VALUES (${`tm-${dem}`}, ${shopId}, ${externalId}, '{}'::jsonb, ${hash}, ${fetchedAt}, ${syncLogId})`;
}

beforeEach(async () => {
  for (const b of BANG_TIEN_SOI_THU_TU) await prisma.$executeRaw`DELETE FROM ${Prisma.raw(`"${b}"`)}`;
});

describe.each(BANG_TIEN_SOI_THU_TU)("demTrungMoc — %s", (table) => {
  it("bảng rỗng ⇒ 0/0", async () => {
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
  });

  it("một bản mỗi khoá, nhiều khoá ⇒ 0/0 (không báo giả)", async () => {
    await chen(table, "K1", "h1", cong(0));
    await chen(table, "K2", "h2", cong(0));
    await chen(table, "K3", "h3", cong(5));
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
  });

  it("hai hash cùng khoá cùng mili-giây ở bản đầu ⇒ trungMocDau = 1", async () => {
    await chen(table, "K1", "h1", cong(0));
    await chen(table, "K1", "h2", cong(0));
    await chen(table, "K2", "h3", cong(0)); // khoá khác, 1 bản — không tính
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 1, lapTrongLuot: 0 });
  });

  it("lệch 1 ms ⇒ 0 (có bản mới hơn thắng rõ ràng)", async () => {
    await chen(table, "K1", "h1", cong(0));
    await chen(table, "K1", "h2", cong(1));
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
  });

  it("trùng mốc ở bản DƯỚI (đã có bản mới hơn) ⇒ 0", async () => {
    await chen(table, "K1", "h1", cong(0));
    await chen(table, "K1", "h2", cong(0));
    await chen(table, "K1", "h3", cong(10)); // bản mới hơn ⇒ trùng mốc cũ vô hại
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
  });

  it("ba bản cùng mốc lớn nhất vẫn tính MỘT khoá", async () => {
    await chen(table, "K1", "h1", cong(7));
    await chen(table, "K1", "h2", cong(7));
    await chen(table, "K1", "h3", cong(7));
    await chen(table, "K1", "h0", cong(1));
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 1, lapTrongLuot: 0 });
  });

  it("cùng externalId nhưng KHÁC shop không là cùng khoá", async () => {
    await chen(table, "K1", "h1", cong(0), null, "SHOP-A");
    await chen(table, "K1", "h2", cong(0), null, "SHOP-B");
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
  });

  it("lặp khoá trong MỘT lượt (cùng syncLogId, khác hash, khác mốc) ⇒ lapTrongLuot = 1 theo phạm vi lượt", async () => {
    await chen(table, "K1", "h1", cong(0), "LUOT-1");
    await chen(table, "K1", "h2", cong(1), "LUOT-1"); // lệch 1 ms ⇒ không trùng mốc, nhưng vẫn lặp trong trang
    await chen(table, "K2", "h3", cong(0), "LUOT-1"); // khoá khác 1 bản
    expect(await demTrungMoc(prisma, table, { syncLogId: "LUOT-1" })).toEqual({ trungMocDau: 0, lapTrongLuot: 1 });
    expect(await demTrungMoc(prisma, table, { syncLogId: "LUOT-KHAC" })).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
  });

  it("khoá có hai bản ở HAI lượt khác nhau ⇒ không phải lặp trong lượt", async () => {
    await chen(table, "K1", "h1", cong(0), "LUOT-1");
    await chen(table, "K1", "h2", cong(50), "LUOT-2");
    expect(await demTrungMoc(prisma, table, { syncLogId: "LUOT-1" }).then((k) => k.lapTrongLuot)).toBe(0);
    expect(await demTrungMoc(prisma, table).then((k) => k.lapTrongLuot)).toBe(0);
  });

  it("toàn bảng: lặp trong lượt chỉ tính khi lượt đó chứa bản ĐẦU; bị bản mới hơn đè ⇒ tắt", async () => {
    await chen(table, "K1", "h1", cong(0), "LUOT-1");
    await chen(table, "K1", "h2", cong(1), "LUOT-1");
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 0, lapTrongLuot: 1 });
    await chen(table, "K1", "h3", cong(100), "LUOT-2"); // phiên bản mới hơn của khoá
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
    // phạm vi lượt vẫn thấy trang lặp đó — đó là sự thật của lượt, không phụ thuộc bản sau.
    expect(await demTrungMoc(prisma, table, { syncLogId: "LUOT-1" })).toEqual({ trungMocDau: 0, lapTrongLuot: 1 });
  });

  it("dòng không có syncLogId (di sản) không bao giờ là 'lặp trong lượt'", async () => {
    await chen(table, "K1", "h1", cong(0), null);
    await chen(table, "K1", "h2", cong(1), null);
    expect(await demTrungMoc(prisma, table)).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
  });

  it("externalIds / shopId giới hạn phạm vi, nhưng vẫn xét MỌI dòng của khoá được chọn", async () => {
    await chen(table, "K1", "h1", cong(0));
    await chen(table, "K1", "h2", cong(0));
    await chen(table, "K2", "h3", cong(0));
    await chen(table, "K2", "h4", cong(0));
    expect(await demTrungMoc(prisma, table, { externalIds: ["K1"] })).toEqual({ trungMocDau: 1, lapTrongLuot: 0 });
    expect(await demTrungMoc(prisma, table, { externalIds: ["K1", "K2"] })).toEqual({ trungMocDau: 2, lapTrongLuot: 0 });
    expect(await demTrungMoc(prisma, table, { externalIds: ["KHONG-CO"] })).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
    expect(await demTrungMoc(prisma, table, { shopId: SHOP, externalIds: ["K1"] })).toEqual({ trungMocDau: 1, lapTrongLuot: 0 });
    expect(await demTrungMoc(prisma, table, { shopId: "SHOP-KHAC" })).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
  });
});

describe("demTrungMoc — hợp đồng chung", () => {
  it("externalIds rỗng ⇒ 0 truy vấn", async () => {
    const queryRaw = vi.fn();
    const ketQua = await demTrungMoc({ $queryRaw: queryRaw } as never, "RawTiktokShopPayment", { externalIds: [] });
    expect(ketQua).toEqual({ trungMocDau: 0, lapTrongLuot: 0 });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("bảng ngoài danh sách soi bị từ chối (tên bảng được nội suy vào SQL)", async () => {
    await expect(demTrungMoc(prisma, "RawPancakeOrder")).rejects.toThrow(/không thuộc danh sách soi/);
    await expect(demTrungMoc(prisma, 'RawTiktokShopPayment"; DROP TABLE "Setting')).rejects.toThrow(/không thuộc danh sách soi/);
  });
});

describe("demTongTrungMocBangTien + câu cảnh báo", () => {
  it("chỉ trả bảng có ca; sạch ⇒ mảng rỗng và banner null", async () => {
    expect(await demTongTrungMocBangTien(prisma)).toEqual([]);
    expect(canhBaoTrungMocBanner([])).toBeNull();

    await chen("RawTiktokBusinessCost", "2026-11-20", "a", cong(0));
    await chen("RawTiktokBusinessCost", "2026-11-20", "b", cong(0));
    await chen("RawTiktokShopTransaction", "T1", "a", cong(0), "L");
    await chen("RawTiktokShopTransaction", "T1", "b", cong(3), "L");

    const ds = await demTongTrungMocBangTien(prisma);
    expect(ds).toEqual([
      { bang: "RawTiktokShopTransaction", trungMocDau: 0, lapTrongLuot: 1 },
      { bang: "RawTiktokBusinessCost", trungMocDau: 1, lapTrongLuot: 0 },
    ]);
    const banner = canhBaoTrungMocBanner(ds);
    expect(banner).toContain("RawTiktokBusinessCost");
    expect(banner).toContain("RawTiktokShopTransaction");
  });

  it("canhBaoTrungMocLuot: sạch ⇒ null; có ca ⇒ nêu stream, bảng, số khoá, hướng xử lý", () => {
    expect(canhBaoTrungMocLuot("tiktok/payments", "S", "RawTiktokShopPayment", { trungMocDau: 0, lapTrongLuot: 0 })).toBeNull();
    const s = canhBaoTrungMocLuot("tiktok/payments", "S", "RawTiktokShopPayment", { trungMocDau: 2, lapTrongLuot: 1 });
    expect(s).toContain("tiktok/payments");
    expect(s).toContain("RawTiktokShopPayment");
    expect(s).toContain("2 khoá");
    expect(s).toContain("1 khoá");
    expect(s).toMatch(/Báo dev/);
  });
});

describe("soiTrungMocCuaLuot — không bao giờ ném", () => {
  const luot = (landedIds: string[]) => ({
    stream: "tiktok/payments",
    table: "RawTiktokShopPayment",
    shopId: SHOP,
    landedIds,
    syncLogId: "L-SOI",
  });

  it("phép đọc ném ⇒ trả khongSoiDuoc (nêu bảng + lý do), canhBao null, KHÔNG ném", async () => {
    const hong = { $queryRaw: vi.fn().mockRejectedValue(new Error("connection reset")) };
    const loi = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const kq = await soiTrungMocCuaLuot(hong as never, luot(["P1"]));
      expect(kq.canhBao).toBeNull();
      expect(kq.khongSoiDuoc).toContain("RawTiktokShopPayment");
      expect(kq.khongSoiDuoc).toContain("connection reset");
      expect(hong.$queryRaw).toHaveBeenCalled();
      // Lỗi không im lặng: còn dấu vết ở console cho người trực máy chủ.
      expect(loi).toHaveBeenCalled();
    } finally {
      loi.mockRestore();
    }
  });

  it("lỗi không phải Error (chuỗi ném thẳng) cũng thành khongSoiDuoc", async () => {
    const hong = { $queryRaw: vi.fn().mockRejectedValue("boom") };
    const loi = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const kq = await soiTrungMocCuaLuot(hong as never, luot(["P1"]));
      expect(kq.canhBao).toBeNull();
      expect(kq.khongSoiDuoc).toContain("boom");
    } finally {
      loi.mockRestore();
    }
  });

  it("stream ngoài danh sách soi ⇒ không đọc gì, không lỗi", async () => {
    const db = { $queryRaw: vi.fn() };
    const kq = await soiTrungMocCuaLuot(db as never, { ...luot(["P1"]), table: "RawPancakeOrder" });
    expect(kq).toEqual({ canhBao: null, khongSoiDuoc: null });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("có ca thật ⇒ canhBao có chữ, khongSoiDuoc null", async () => {
    await chen("RawTiktokShopPayment", "P1", "a", cong(0), "L-SOI");
    await chen("RawTiktokShopPayment", "P1", "b", cong(0), "L-SOI");
    const kq = await soiTrungMocCuaLuot(prisma, luot(["P1"]));
    expect(kq.khongSoiDuoc).toBeNull();
    expect(kq.canhBao).toContain("RawTiktokShopPayment");
  });
});
