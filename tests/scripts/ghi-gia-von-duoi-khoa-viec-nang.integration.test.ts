import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as khoaViecNang from "@/lib/backup/khoa-viec-nang";
import { prisma } from "@/lib/prisma";

import type { DeXuatGiaVon } from "@/lib/gia-von/doi-chieu-gia-von";
import {
  type ClientGhiGiaVon,
  ghiGiaVonDuoiKhoaViecNang,
  LoiDungGiuaChung,
  VIEC_GHI_GIA_VON,
} from "@/lib/gia-von/ghi-gia-von-theo-pancake";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Đường ghi giá vốn của script chạy NGOÀI tiến trình app, nên thứ duy nhất nó và lượt phục hồi cùng
 * thấy là lease "khoá việc nặng" trong bảng `Setting`. Bộ test này chạy trên DB test THẬT với module
 * lease THẬT (không mock) và ép từng mặt của hợp đồng:
 *
 *  - lượt phục hồi đang giữ lease ⇒ từ chối TRƯỚC cả bước backup, không đụng lease của họ;
 *  - lease mang tên script hiện diện TRONG lúc ghi (không chỉ trước/sau — đó mới là thứ khiến
 *    route phục hồi 409 nếu chen vào giữa), và được trả sạch khi xong;
 *  - lease sang tay TRƯỚC dòng đầu tiên (khe backup I/O) ⇒ 0 dòng đổi;
 *  - lease sang tay GIỮA hai dòng ⇒ dừng ngay dòng kế tiếp (không có "lô" nào được ghi nốt), lỗi
 *    nói rõ đã ghi/bỏ qua bao nhiêu + file backup;
 *  - câu giành lease NÉM (bảng `Setting` đang bị thay) ⇒ không ghi dòng nào, không tạo backup.
 */

const KHOA_KEY = "khoaViecNang";
const VIEC_PHUC_HOI = "phục hồi dữ liệu từ bản sao lưu";
const GIA_CU = 100_000;

let thuMucTam: string;

/** Một sản phẩm + `n` biến thể cùng giá vốn cũ; trả id theo đúng thứ tự tạo. */
async function taoBienThe(n: number): Promise<string[]> {
  const sp = await prisma.product.create({
    data: { pancakeId: "P-KHOA", name: "Áo test khoá", status: "ACTIVE", syncedAt: new Date() },
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const bt = await prisma.variant.create({
      data: {
        pancakeId: `V-KHOA-${i}`,
        productId: sp.id,
        sku: `SKU-KHOA-${i}`,
        label: `M/${i}`,
        sellPrice: 300_000,
        costPrice: GIA_CU,
        syncedAt: new Date(),
      },
    });
    ids.push(bt.id);
  }
  return ids;
}

/** Giá đề xuất khác nhau từng dòng để đọc lại phân biệt được dòng nào đã ghi. */
const giaMoi = (i: number) => 200_000 + i;

const deXuatCho = (ids: string[]): DeXuatGiaVon[] =>
  ids.map((variantId, i) => ({
    variantId,
    pancakeId: `V-KHOA-${i}`,
    sku: `SKU-KHOA-${i}`,
    ten: `Áo test khoá · M/${i}`,
    giaHienTai: GIA_CU,
    giaDeXuat: giaMoi(i),
    nguon: "nhap-cuoi",
  }));

const layGiaVon = async (ids: string[]): Promise<number[]> => {
  const rows = await prisma.variant.findMany({ where: { id: { in: ids } }, select: { id: true, costPrice: true } });
  const theoId = new Map(rows.map((r) => [r.id, r.costPrice]));
  return ids.map((id) => theoId.get(id)!);
};

const docLease = async (): Promise<string | null> =>
  (await prisma.setting.findUnique({ where: { key: KHOA_KEY } }))?.value ?? null;

/** Ghi đè dòng lease bằng token của việc khác — mô phỏng lease hết hạn bị việc nặng mới giành. */
async function cuopLease(viec: string): Promise<void> {
  const value = `tok-viec-khac|${Date.now() + 5 * 60_000}|${viec}`;
  await prisma.setting.upsert({ where: { key: KHOA_KEY }, create: { key: KHOA_KEY, value }, update: { value } });
}

/**
 * Client bọc mỏng: chạy `truoc()` ngay TRƯỚC transaction của dòng thứ `lan` (đếm từ 0) rồi uỷ quyền
 * cho Prisma thật. Đây là cách duy nhất nhắm trúng khe "giữa hai dòng" một cách tất định — lease
 * sang tay ở đúng đó thì hàng rào trong transaction kế tiếp phải bắt được.
 */
function clientChen(truoc: () => Promise<void>, tai: number): ClientGhiGiaVon {
  let lan = 0;
  return {
    $transaction: async (fn) => {
      if (lan++ === tai) await truoc();
      return prisma.$transaction(fn);
    },
  };
}

const optsGhi = (ten: string) => ({
  duongDanBackup: path.join(thuMucTam, `${ten}.json`),
  cheDo: "theo-pancake",
  ghiLuc: new Date("2026-09-02T10:00:00.000Z"),
});

/** Chạy đường ghi và trả LỖI (không phải kết quả) — để assert kiểu + trường của lỗi. */
const loiCua = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeAll(async () => {
  await seedReference();
  thuMucTam = mkdtempSync(path.join(tmpdir(), "ghi-gia-von-khoa-"));
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
});

afterAll(async () => {
  rmSync(thuMucTam, { recursive: true, force: true });
  await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
  await prisma.$disconnect();
});

describe("ghi giá vốn dưới khoá việc nặng", () => {
  it("lượt phục hồi đang giữ lease ⇒ TỪ CHỐI kèm tên việc, DB nguyên, KHÔNG tạo backup, không đụng lease của họ", async () => {
    const ids = await taoBienThe(2);
    const phucHoi = await khoaViecNang.giuKhoaViecNang(VIEC_PHUC_HOI);
    if (!phucHoi.the) throw new Error("không giành được lease để dựng cảnh");
    const opts = optsGhi("bi-tu-choi");

    const kq = await ghiGiaVonDuoiKhoaViecNang(prisma, khoaViecNang, deXuatCho(ids), opts);

    expect(kq).toEqual({ tuChoi: VIEC_PHUC_HOI });
    expect(await layGiaVon(ids)).toEqual([GIA_CU, GIA_CU]);
    // Không có backup mồ côi cho một lượt không ghi gì — file backup chỉ tồn tại khi có ghi.
    expect(existsSync(opts.duongDanBackup)).toBe(false);
    // Thua thì tuyệt đối không giật lease của lượt phục hồi.
    expect(await docLease()).toContain(phucHoi.the.token);

    await khoaViecNang.traKhoaViecNang(phucHoi.the);
  });

  it("không ai giữ ⇒ ghi xong; lease MANG TÊN script hiện diện TRONG lúc ghi và được trả sạch sau đó", async () => {
    const ids = await taoBienThe(3);
    const leaseLucGhi: (string | null)[] = [];
    // Soi lease ngay trước transaction của TỪNG dòng: "có lease trước và sau" chưa chứng minh được
    // gì — cái làm route phục hồi 409 khi chen vào giữa là lease còn sống ĐÚNG lúc dòng đang ghi.
    const clientSoi: ClientGhiGiaVon = {
      $transaction: async (fn) => {
        leaseLucGhi.push(await docLease());
        return prisma.$transaction(fn);
      },
    };
    const opts = optsGhi("ghi-binh-thuong");

    const kq = await ghiGiaVonDuoiKhoaViecNang(clientSoi, khoaViecNang, deXuatCho(ids), opts);

    expect(kq).toMatchObject({ daGhi: 3, boQua: 0 });
    expect(await layGiaVon(ids)).toEqual([giaMoi(0), giaMoi(1), giaMoi(2)]);
    expect(leaseLucGhi).toHaveLength(3);
    for (const lease of leaseLucGhi) expect(lease).toContain(`|${VIEC_GHI_GIA_VON}`);
    expect(await docLease()).toBeNull();
    expect(existsSync(opts.duongDanBackup)).toBe(true);
  });

  it("lease sang tay TRƯỚC dòng đầu tiên (khe ghi file backup) ⇒ 0 dòng đổi, backup đã tồn tại, lỗi nêu 0 đã ghi", async () => {
    const ids = await taoBienThe(3);
    const client = clientChen(() => cuopLease(VIEC_PHUC_HOI), 0);
    const opts = optsGhi("mat-lease-truoc-dong-dau");

    const loi = await loiCua(ghiGiaVonDuoiKhoaViecNang(client, khoaViecNang, deXuatCho(ids), opts));

    expect(loi).toBeInstanceOf(LoiDungGiuaChung);
    expect(loi).toMatchObject({ daGhi: 0, boQua: 0, tong: 3 });
    expect(await layGiaVon(ids)).toEqual([GIA_CU, GIA_CU, GIA_CU]);
    // Backup đã ghi (đứng trước hàng rào) — có file cũng không sao: nó chỉ chứa giá cũ.
    expect(existsSync(opts.duongDanBackup)).toBe(true);
    expect(await docLease()).toContain("tok-viec-khac");
  });

  it("lease sang tay GIỮA hai dòng ⇒ dừng NGAY dòng kế tiếp, lỗi nêu đã ghi/bỏ qua + backup, dòng sau KHÔNG đổi", async () => {
    const ids = await taoBienThe(4);
    // Việc khác cướp lease ngay sau dòng đầu tiên. Hàng rào nằm TRONG transaction của mỗi dòng nên
    // dòng thứ hai phải ném — không có "lô" nào được ghi nốt vào cửa sổ đã thuộc về lượt kia.
    const client = clientChen(() => cuopLease(VIEC_PHUC_HOI), 1);
    const opts = optsGhi("mat-lease-giua-chung");

    const loi = await loiCua(ghiGiaVonDuoiKhoaViecNang(client, khoaViecNang, deXuatCho(ids), opts));

    expect(loi).toBeInstanceOf(LoiDungGiuaChung);
    const dung = loi as LoiDungGiuaChung;
    expect(dung).toMatchObject({ daGhi: 1, boQua: 0, tong: 4 });
    expect(dung.message).toMatch(/sau 1\/4 dòng \(ít nhất 1 đã ghi, 0 bỏ qua/);
    expect(dung.message).toContain(opts.duongDanBackup);
    expect(dung.cause).toBeInstanceOf(khoaViecNang.MatKhoaViecNang);

    expect(await layGiaVon(ids)).toEqual([giaMoi(0), GIA_CU, GIA_CU, GIA_CU]);
    // Lease giờ thuộc việc kia — bước trả ở finally không được xoá nó.
    expect(await docLease()).toContain("tok-viec-khac");
  });

  it("dòng bị CAS bỏ qua được đếm riêng trong lỗi dừng giữa chừng (không tính là đã ghi)", async () => {
    const ids = await taoBienThe(3);
    // Dòng 0 đã bị chủ shop sửa tay trước khi ghi ⇒ CAS bỏ qua; rồi lease sang tay trước dòng 2.
    await prisma.variant.update({ where: { id: ids[0] }, data: { costPrice: 150_000 } });
    const client = clientChen(() => cuopLease(VIEC_PHUC_HOI), 2);
    const opts = optsGhi("bo-qua-roi-mat-lease");

    const loi = await loiCua(ghiGiaVonDuoiKhoaViecNang(client, khoaViecNang, deXuatCho(ids), opts));

    expect(loi).toMatchObject({ daGhi: 1, boQua: 1, tong: 3 });
    expect(await layGiaVon(ids)).toEqual([150_000, giaMoi(1), GIA_CU]);
  });

  it("câu giành lease NÉM (bảng Setting đang bị thay) ⇒ không ghi dòng nào, không tạo backup", async () => {
    const ids = await taoBienThe(2);
    const khoaHong = {
      ...khoaViecNang,
      giuKhoaViecNang: async () => {
        throw new Error('relation "Setting" does not exist');
      },
    };
    const opts = optsGhi("setting-khong-ton-tai");

    await expect(
      ghiGiaVonDuoiKhoaViecNang(prisma, khoaHong, deXuatCho(ids), opts),
    ).rejects.toThrow(/Setting/);

    expect(await layGiaVon(ids)).toEqual([GIA_CU, GIA_CU]);
    expect(existsSync(opts.duongDanBackup)).toBe(false);
  });
});
