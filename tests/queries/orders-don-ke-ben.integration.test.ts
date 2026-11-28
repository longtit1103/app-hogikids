import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDateRange } from "@/lib/date-range";
import type { BoLocDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { prisma } from "@/lib/prisma";
import { getDonKeBen } from "@/lib/queries/orders-don-ke-ben";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Cụm ‹ i / N › của drawer: vị trí đơn trong ĐÚNG tập lọc + thứ tự của danh sách, đơn kề bên kèm trang
 * của nó (20 dòng/trang). Người thiếu quyền giá vốn cố gõ `sx=lai_thap` ⇒ vị trí như `moi` (thứ tự theo
 * lãi tự nó lộ lãi).
 *
 * 25 đơn tháng 10, ngày tăng dần theo i; tiền hàng TĂNG theo i và không có dòng hàng ⇒ lãi = tiền hàng −
 * phí, thứ tự theo lãi NGƯỢC hẳn thứ tự theo ngày (đối chứng cho phép thử che).
 */

const NOW = new Date(2026, 10, 27, 12, 0, 0);
const THANG_10 = parseDateRange({ tu: "2026-10-01", den: "2026-10-31" })!;
const DAY = { coQuyenGiaVon: true } as const;
const CHE = { coQuyenGiaVon: false } as const;

const boLoc = (p: Partial<BoLocDonHang> = {}): BoLocDonHang => ({
  ky: { loai: "khoang", ...THANG_10, nguon: "url" }, statuses: [], channels: [], q: "", loc: [], sx: "moi", trang: 1, don: null, ...p,
});

/** id theo i (0 = cũ nhất). Thứ tự `moi`: i = 24, 23, …, 0 ⇒ đơn thứ k (1-based) là i = 25 − k. */
const idTheoI = new Map<number, string>();
let idNgoaiKy = "";

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();
  const now = new Date();
  for (let i = 0; i < 25; i++) {
    const o = await prisma.order.create({
      data: {
        pancakeId: `DKB-${i}`, code: `DKB-${i}`, channelId: "shopee", status: "COMPLETED",
        orderedAt: new Date(2026, 9, 1 + i, 10, 0, 0), itemsTotal: 260_000 + i * 10_000, platformFeeEst: 50_000, syncedAt: now,
      },
    });
    idTheoI.set(i, o.id);
  }
  const ngoai = await prisma.order.create({
    data: {
      pancakeId: "DKB-T9", code: "DKB-T9", channelId: "shopee", status: "COMPLETED",
      orderedAt: new Date(2026, 8, 15, 10, 0, 0), itemsTotal: 1, syncedAt: now,
    },
  });
  idNgoaiKy = ngoai.id;
}, 60_000);

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

const thuK = (k: number) => idTheoI.get(25 - k)!;

describe("getDonKeBen", () => {
  it("đơn thứ 20 (sx moi) ⇒ viTri 20, trước ở trang 1, sau ở trang 2", async () => {
    const kq = await getDonKeBen(boLoc(), thuK(20), DAY, NOW);
    expect(kq).toEqual({ viTri: 20, tong: 25, truoc: { id: thuK(19), trang: 1 }, sau: { id: thuK(21), trang: 2 } });
  });

  it("đơn thứ 1 ⇒ không có trước; đơn cuối ⇒ không có sau", async () => {
    const dau = await getDonKeBen(boLoc(), thuK(1), DAY, NOW);
    expect(dau).toEqual({ viTri: 1, tong: 25, truoc: null, sau: { id: thuK(2), trang: 1 } });
    const cuoi = await getDonKeBen(boLoc(), thuK(25), DAY, NOW);
    expect(cuoi).toEqual({ viTri: 25, tong: 25, truoc: { id: thuK(24), trang: 2 }, sau: null });
  });

  it("đơn ngoài kỳ hoặc id không tồn tại ⇒ viTri null, tổng vẫn đúng", async () => {
    expect(await getDonKeBen(boLoc(), idNgoaiKy, DAY, NOW)).toEqual({ viTri: null, tong: 25, truoc: null, sau: null });
    expect(await getDonKeBen(boLoc(), "khong-ton-tai", DAY, NOW)).toEqual({ viTri: null, tong: 25, truoc: null, sau: null });
  });

  it("đủ quyền sx lai_thap ⇒ thứ tự theo lãi (đơn thứ 20 theo ngày thành thứ 6)", async () => {
    const kq = await getDonKeBen(boLoc({ sx: "lai_thap" }), thuK(20), DAY, NOW);
    expect(kq.viTri).toBe(6);
  });

  it("không quyền + sx lai_thap ⇒ vị trí bằng sx moi", async () => {
    for (const k of [1, 6, 20, 25]) {
      const coGo = await getDonKeBen(boLoc({ sx: "lai_thap", loc: ["lo"] }), thuK(k), CHE, NOW);
      const moi = await getDonKeBen(boLoc(), thuK(k), CHE, NOW);
      expect(coGo).toEqual(moi);
      expect(coGo.viTri).toBe(k);
    }
  });
});
