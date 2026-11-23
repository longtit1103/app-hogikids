import { spawn } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type AnhDiSan, soAnhDiSan, soSoLieuTruocSau } from "@/lib/bronze/anh-di-san-moc-land-don";
import { quyetDinhCong } from "@/lib/bronze/cong-kiem-moc-land-don";
import { demKhopMocLandDon, LoiKiemKhongHoanThanh } from "@/lib/bronze/dem-khop-moc-land-don";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Bước kiểm chỉ-đọc landSeq — NHÓM DI SẢN, ảnh trước ↔ sau, một ảnh dữ liệu + thời hạn, phân trang KHÔNG ĐỦ CĂN CỨ.
 *  - OLD1 (không có kho thô), LEG1 (`rawFetchedAt` NULL, `raw` qua JS mất chính xác), LEG2 (`rawFetchedAt` NULL, `raw`
 *    khớp chính xác) ⇒ CÙNG nhóm di sản, không vào "không đủ căn cứ"; chỉ chấp nhận khi ảnh không đổi.
 *  - Thêm đơn di sản mới / đổi dữ liệu đơn di sản ⇒ cổng ĐỎ. Đơn ĐÃ có `rawLandSeq` mất dòng tham chiếu ⇒ LỖI.
 *  - Phiên khác giữ khoá ⇒ hết `lock_timeout` / `statement_timeout` / trần transaction ⇒ KHÔNG HOÀN THÀNH.
 */

const SO_LON = "9007199254740993";
const trangTho = (id: string, status: number, them = "") =>
  `{"success":true,"data":[{"id":"${id}","system_id":"${id}","shop_id":${SHOP_SHOPEE},"status":${status},` +
  `"inserted_at":"2026-07-01T03:00:00.000000","order_sources_name":"Shopee","marketplace_id":"-3",` +
  `"total_price":200000,"total_discount":0,"fee_marketplace":3000${them},"items":[{"quantity":2,` +
  `"discount_each_product":0,"variation_info":{"display_id":"SKU-DS","name":"SP","retail_price":100000}}]}]}`;

const donKhoTho = async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
};

/** Đơn qua đường thật (land → transform), rồi gỡ mốc nguồn ⇒ giống đơn ghi trước khi có cột `rawFetchedAt`. */
async function donKhongMocNguon(id: string, them = "") {
  await landRaw("orders", SHOP_SHOPEE, trangTho(id, 3, them));
  await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: [id] });
  await prisma.order.update({ where: { pancakeId: id }, data: { rawFetchedAt: null, rawLandSeq: null } });
}

/** Đơn Silver không có dòng kho thô nào cùng (đơn, shop). */
async function donKhongKhoTho(id: string) {
  await prisma.order.create({
    data: {
      pancakeId: id, code: id, channelId: "shopee", status: "COMPLETED", orderedAt: new Date("2026-07-01"),
      syncedAt: new Date(), raw: { id, shop_id: Number(SHOP_SHOPEE), status: 3 }, rawFetchedAt: new Date("2026-07-01"),
    },
  });
}

async function dungBaDonDiSan() {
  await donKhongKhoTho("OLD1");
  await donKhongMocNguon("LEG1", `,"so_lon":${SO_LON}`);
  await donKhongMocNguon("LEG2");
}

/** Một phiên psql RIÊNG giữ ACCESS EXCLUSIVE trên "Order" trong `giay` giây (chặn cả SELECT). */
function giuKhoaOrder(giay: number) {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.search = "";
  const p = spawn("psql", ["-X", "-q", "-d", u.toString(), "-c",
    `BEGIN; LOCK TABLE app."Order" IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(${giay});`],
    { stdio: "ignore", env: { ...process.env, PGAPPNAME: "landseq-kiem-thoi-han" } });
  return {
    choGiu: async () => {
      for (let i = 0; i < 300; i++) {
        const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE c.relname = 'Order' AND l.mode = 'AccessExclusiveLock' AND l.granted AND l.pid <> pg_backend_pid()`;
        if (Number(n) > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("phiên giữ khoá không lên");
    },
    nha: async () => {
      p.kill();
      await prisma.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'landseq-kiem-thoi-han'`;
    },
  };
}

beforeAll(async () => {
  await seedReference();
}, 60_000);
beforeEach(donKhoTho);
afterAll(donKhoTho);

describe("nhóm di sản + ảnh trước ↔ sau", () => {
  it("OLD1 / LEG1 / LEG2 cùng nhóm di sản (không vào không đủ căn cứ); ảnh không đổi ⇒ qua; thiếu ảnh sau migrate ⇒ đỏ", async () => {
    await dungBaDonDiSan();
    const kq = await demKhopMocLandDon(prisma);
    expect(kq.anhDiSan.diSan.map((d) => [d.pancakeId, d.lyDo])).toEqual([
      ["LEG1", "khong-co-moc-nguon"],
      ["LEG2", "khong-co-moc-nguon"],
      ["OLD1", "khong-co-kho-tho"],
    ]);
    expect(kq).toMatchObject({ khongDuCanCu: 0, lechBanKhac: 0, lechCap: 0, lechNoiDung: 0 });
    expect(kq.anhDuLieu).toEqual({ mucCoLap: "repeatable read", chiDoc: "on" });
    const anhTruoc: AnhDiSan = JSON.parse(JSON.stringify(kq.anhDiSan));
    const lanSau = await demKhopMocLandDon(prisma);
    expect(soAnhDiSan(anhTruoc, lanSau.anhDiSan)).toEqual([]);
    const soLieu = soSoLieuTruocSau(anhTruoc, { tongDon: lanSau.tongDon, daDien: lanSau.daDien, tien16: lanSau.anhDiSan.tien16 });
    expect(soLieu).toEqual([]);
    expect(quyetDinhCong(lanSau, soAnhDiSan(anhTruoc, lanSau.anhDiSan), [], soLieu).ma).toBe(0);
    expect(quyetDinhCong(lanSau, null).ma).toBe(1); // sau migrate KHÔNG có ảnh trước migrate để so
    // sau migrate có ảnh nhưng THIẾU kết quả so số liệu ⇒ đỏ (không để mắt người tự so)
    expect(quyetDinhCong(lanSau, soAnhDiSan(anhTruoc, lanSau.anhDiSan)).ma).toBe(1);
    // TRƯỚC migrate (chưa có cột): nhóm di sản chỉ được GHI NHẬN vào ảnh, chưa có gì để so ⇒ không chặn.
    expect(quyetDinhCong({ ...lanSau, daDien: null, lechCap: null, lechNoiDung: null }, null).ma).toBe(0);
  });

  it("đơn di sản MỚI xuất hiện ⇒ cổng đỏ", async () => {
    await dungBaDonDiSan();
    const anhTruoc = (await demKhopMocLandDon(prisma)).anhDiSan;
    await donKhongKhoTho("OLD2");
    const sau = await demKhopMocLandDon(prisma);
    const kb = soAnhDiSan(anhTruoc, sau.anhDiSan);
    expect(kb).toEqual([{ loai: "moi", pancakeId: "OLD2" }]);
    expect(quyetDinhCong(sau, kb).ma).toBe(1);
  });

  it("đổi dữ liệu nghiệp vụ (C1) / payload (C2) của đơn di sản ⇒ cổng đỏ", async () => {
    await dungBaDonDiSan();
    const anhTruoc = (await demKhopMocLandDon(prisma)).anhDiSan;
    await prisma.order.update({ where: { pancakeId: "LEG2" }, data: { status: "RETURNED" } });
    await prisma.$executeRaw`UPDATE "Order" SET raw = raw || '{"ghi_chu": 1}'::jsonb WHERE "pancakeId" = 'LEG1'`;
    const sau = await demKhopMocLandDon(prisma);
    const kb = soAnhDiSan(anhTruoc, sau.anhDiSan);
    expect(kb).toEqual([
      { loai: "doi-c2", pancakeId: "LEG1" },
      { loai: "doi-c1", pancakeId: "LEG2" },
    ]);
    expect(quyetDinhCong(sau, kb).ma).toBe(1);
  });

  it("đơn ĐÃ có rawLandSeq mà mất dòng tham chiếu ⇒ LỖI (lệch cặp), không vào nhóm di sản", async () => {
    await landRaw("orders", SHOP_SHOPEE, trangTho("MT-1", 3));
    await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: ["MT-1"] });
    await prisma.rawPancakeOrder.deleteMany({ where: { externalId: "MT-1" } });
    const kq = await demKhopMocLandDon(prisma);
    expect(kq.anhDiSan.diSan).toEqual([]);
    expect(kq.lechCap).toBe(1);
    expect(quyetDinhCong(kq, soAnhDiSan({ ...kq.anhDiSan, diSan: [] }, kq.anhDiSan)).ma).toBe(1);
  });

  it("danh sách KHÔNG ĐỦ CĂN CỨ xem HẾT theo trang (sắp pancakeId theo byte)", async () => {
    for (const id of ["KD-3", "KD-1", "KD-2"]) {
      await landRaw("orders", SHOP_SHOPEE, trangTho(id, 3));
      await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: [id] });
      await prisma.$executeRaw`UPDATE "Order" SET raw = raw || '{"lech": 1}'::jsonb WHERE "pancakeId" = ${id}`;
    }
    const t1 = await demKhopMocLandDon(prisma, { gioiHan: 2 });
    expect(t1.khongDuCanCu).toBe(3);
    expect(t1.donKhongDuCanCu.map((d) => d.pancakeId)).toEqual(["KD-1", "KD-2"]);
    expect(t1.donKhongDuCanCuTrangSau).toBe("KD-2");
    const t2 = await demKhopMocLandDon(prisma, { gioiHan: 2, sauDonKhongDuCanCu: "KD-2" });
    expect(t2.donKhongDuCanCu.map((d) => d.pancakeId)).toEqual(["KD-3"]);
    expect(t2.donKhongDuCanCuTrangSau).toBeNull();
    expect(quyetDinhCong(t1, [], [], []).ma).toBe(2);
  });
});

describe("đối soát số liệu trước ↔ sau migrate TỰ ĐỘNG (tổng đơn, da_dien = khop trước, 16 chỉ số tiền)", () => {
  it("ảnh mang khop + 16 chỉ số tiền đọc từ deploy/tien-16-chi-so.sql trong cùng ảnh dữ liệu; không đổi gì ⇒ KHỚP", async () => {
    await landRaw("orders", SHOP_SHOPEE, trangTho("SL-1", 3));
    await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: ["SL-1"] });
    const truoc = await demKhopMocLandDon(prisma);
    expect(truoc.anhDiSan.phienBan).toBe(3);
    expect(truoc.anhDiSan.khop).toBe(truoc.khop);
    expect(truoc.anhDiSan.tien16).toMatch(/^-?\d+(\|-?\d+){15}$/);
    expect(truoc.anhDiSan.tien16.split("|")[0]).toBe(String(truoc.tongDon)); // cột 1 = số đơn
    const sau = await demKhopMocLandDon(prisma);
    expect(soSoLieuTruocSau(truoc.anhDiSan, { tongDon: sau.tongDon, daDien: sau.daDien, tien16: sau.anhDiSan.tien16 })).toEqual([]);
  });

  it("ghi chen vào cửa sổ (thêm chi phí) ⇒ 16 chỉ số LỆCH ⇒ cổng đỏ mã 1", async () => {
    await dungBaDonDiSan();
    const truoc = await demKhopMocLandDon(prisma);
    await prisma.expense.create({
      data: { date: new Date("2026-07-02"), amount: 12_345, categoryId: "fixed", description: "ghi chen trong cửa sổ" },
    });
    const sau = await demKhopMocLandDon(prisma);
    const loi = soSoLieuTruocSau(truoc.anhDiSan, { tongDon: sau.tongDon, daDien: sau.daDien, tien16: sau.anhDiSan.tien16 });
    expect(loi).toHaveLength(1);
    expect(loi[0]).toMatch(/^tien16: trước .* ≠ sau /);
    const cong = quyetDinhCong(sau, soAnhDiSan(truoc.anhDiSan, sau.anhDiSan), [], loi);
    expect(cong.ma).toBe(1);
    expect(cong.thongDiep).toContain("số liệu LỆCH");
  });

  it("thuần: tổng đơn lệch / da_dien ≠ khop trước / thiếu cột ⇒ báo đúng từng mục", () => {
    const anh = { khop: 5, tongDon: 7, tien16: "7|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1" } as AnhDiSan;
    expect(soSoLieuTruocSau(anh, { tongDon: 7, daDien: 5, tien16: anh.tien16 })).toEqual([]);
    expect(soSoLieuTruocSau(anh, { tongDon: 8, daDien: 5, tien16: anh.tien16 })).toEqual(["tong_don: trước 7 ≠ sau 8"]);
    expect(soSoLieuTruocSau(anh, { tongDon: 7, daDien: 4, tien16: anh.tien16 })).toEqual(["da_dien: sau 4 ≠ khop trước migrate 5"]);
    expect(soSoLieuTruocSau(anh, { tongDon: 7, daDien: null, tien16: anh.tien16 })[0]).toContain("thiếu kết quả sau migrate");
  });
});

describe("một ảnh dữ liệu + thời hạn ⇒ KHÔNG HOÀN THÀNH", () => {
  it("phiên khác giữ khoá ⇒ hết lock_timeout ⇒ LoiKiemKhongHoanThanh nhanh", async () => {
    const k = giuKhoaOrder(20);
    try {
      await k.choGiu();
      const t0 = Date.now();
      await expect(demKhopMocLandDon(prisma, { thoiHan: { khoaMs: 300, cauLenhMs: 60_000 } })).rejects.toThrow(
        /KHÔNG HOÀN THÀNH: .*lock timeout/,
      );
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      await k.nha();
    }
  });

  it("câu lệnh quá statement_timeout ⇒ LoiKiemKhongHoanThanh", async () => {
    const k = giuKhoaOrder(20);
    try {
      await k.choGiu();
      const t0 = Date.now();
      await expect(demKhopMocLandDon(prisma, { thoiHan: { khoaMs: 60_000, cauLenhMs: 300 } })).rejects.toThrow(
        /statement timeout/,
      );
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      await k.nha();
    }
  });

  it("vượt trần transaction ⇒ LoiKiemKhongHoanThanh", async () => {
    const k = giuKhoaOrder(4);
    try {
      await k.choGiu();
      await expect(
        demKhopMocLandDon(prisma, { thoiHan: { giaoDichMs: 500, khoaMs: 60_000, cauLenhMs: 60_000 } }),
      ).rejects.toBeInstanceOf(LoiKiemKhongHoanThanh);
    } finally {
      await k.nha();
    }
  });
});
