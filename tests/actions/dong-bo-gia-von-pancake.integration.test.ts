import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Backup phải ghi được trong test ⇒ trỏ sang thư mục tạm. Action đọc `BACKUP_DIR` lúc GỌI nên gán
// ở đâu trong file cũng được (import ESM được nâng lên trên, gán lúc-nạp sẽ không kịp).
// Trên prod biến này vắng và action dùng `/backups` — chỗ DUY NHẤT container mount.

vi.mock("@/lib/session", () => ({ requireUser: vi.fn().mockResolvedValue("user-test") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { apGiaVonTheoPancake } from "@/lib/actions/dong-bo-gia-von-pancake";
import { docDeXuatGiaVon } from "@/lib/gia-von/doc-de-xuat-gia-von";
import { vanTayDeXuat, type CheDoDoiChieu } from "@/lib/gia-von/doi-chieu-gia-von";
import { thuGiuKhoaPhucHoi, traKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { giuKhoaViecNang, HAN_KHOA_MS, traKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import {
  KEY_MOC_KIEM_GIA_VON,
  KEY_SO_LECH_GIA_VON,
} from "@/lib/gia-von/trang-thai-lech-gia-von";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

const THU_MUC_BACKUP = mkdtempSync(path.join(tmpdir(), "gia-von-backup-"));
process.env.BACKUP_DIR = THU_MUC_BACKUP;

/**
 * Nút "Áp giá vốn Pancake" — đường ghi `costPrice` THỨ HAI, song song với CLI.
 *
 * Mọi lời hứa an toàn ở đây là lời hứa về TIỀN: `costPrice` quyết COGS, COGS quyết lãi của MỌI kỳ
 * (không snapshot). Nên từng lời hứa phải có một `it` ép nó tự đứng.
 */

const VARIATION_ID = "aa000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "bb000000-0000-4000-8000-000000000001";

/** Payload Bronze shop kho: Pancake khai giá vốn 90.000 cho biến thể này. */
async function landBronze(giaPancake: number, giaNhapCuoi = 0): Promise<void> {
  await prisma.rawPancakeProduct.create({
    data: {
      shopId: SHOP_KHO,
      externalId: PRODUCT_ID,
      payloadHash: `hash-${giaPancake}-${giaNhapCuoi}`,
      payload: {
        id: PRODUCT_ID,
        name: "Áo Dài Lụa",
        variations: [
          {
            id: VARIATION_ID,
            display_id: "SP-TEST-1",
            retail_price: 300_000,
            remain_quantity: 10,
            average_imported_price: giaPancake,
            last_imported_price: giaNhapCuoi,
            fields: [{ name: "Size", value: "M" }],
          },
        ],
      },
    },
  });
}

async function taoBienThe(costPrice: number): Promise<string> {
  const sp = await prisma.product.create({
    data: { pancakeId: PRODUCT_ID, name: "Áo Dài Lụa", status: "ACTIVE", syncedAt: new Date() },
  });
  const bt = await prisma.variant.create({
    data: {
      pancakeId: VARIATION_ID,
      productId: sp.id,
      sku: "SP-TEST-1",
      label: "M",
      sellPrice: 300_000,
      costPrice,
      syncedAt: new Date(),
    },
  });
  return bt.id;
}

/** Bấm nút như chủ shop: đọc danh sách đang hiện, lấy vân tay của nó, rồi mới gọi. */
async function bamAp(cheDo: CheDoDoiChieu) {
  const { deXuat } = await docDeXuatGiaVon(cheDo);
  return apGiaVonTheoPancake(cheDo, vanTayDeXuat(deXuat));
}

const giaVon = async (id: string) =>
  (await prisma.variant.findUniqueOrThrow({ where: { id } })).costPrice;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeProduct.deleteMany();
});

afterAll(() => {
  rmSync(THU_MUC_BACKUP, { recursive: true, force: true });
});

describe("apGiaVonTheoPancake", () => {
  it("ghi giá Pancake cho dòng đang lệch, và chạy lại thì KHÔNG còn gì để ghi", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(90_000);

    const lan1 = await bamAp("theo-pancake");
    expect(lan1).toEqual({ ok: true, data: { daGhi: 1, boQua: 0, soDeXuat: 1 } });
    expect(await giaVon(id)).toBe(90_000);

    // Idempotent: bấm hai lần không đẻ thêm thay đổi nào.
    const lan2 = await bamAp("theo-pancake");
    expect(lan2).toEqual({ ok: true, data: { daGhi: 0, boQua: 0, soDeXuat: 0 } });
  });

  it("Pancake để 0 ⇒ TUYỆT ĐỐI không ghi (0 = chưa khai, không phải giá vốn bằng 0)", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(0, 0);

    const kq = await bamAp("theo-pancake");

    expect(kq).toEqual({ ok: true, data: { daGhi: 0, boQua: 0, soDeXuat: 0 } });
    expect(await giaVon(id)).toBe(120_000); // số app giữ nguyên, không bị xoá trắng
  });

  it("chế độ chỉ-điền-trống KHÔNG đụng dòng app đã có số", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(90_000);

    const kq = await bamAp("chi-thieu");

    expect(kq).toEqual({ ok: true, data: { daGhi: 0, boQua: 0, soDeXuat: 0 } });
    expect(await giaVon(id)).toBe(120_000);
  });

  it("chế độ chỉ-điền-trống CÓ điền dòng app đang trống", async () => {
    const id = await taoBienThe(0);
    await landBronze(90_000);

    const kq = await bamAp("chi-thieu");

    expect(kq.ok && kq.data.daGhi).toBe(1);
    expect(await giaVon(id)).toBe(90_000);
  });

  it("đang PHỤC HỒI ⇒ từ chối, không chạm dòng nào, không tạo backup", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(90_000);
    const truocKhiChay = readdirSync(THU_MUC_BACKUP).length;

    const the = thuGiuKhoaPhucHoi();
    try {
      const kq = await bamAp("theo-pancake");
      expect(kq.ok).toBe(false);
    } finally {
      if (the) traKhoaPhucHoi(the);
    }

    expect(await giaVon(id)).toBe(120_000);
    expect(readdirSync(THU_MUC_BACKUP).length).toBe(truocKhiChay);
  });

  it("việc nặng khác đang giữ khoá ⇒ từ chối kèm TÊN việc đó", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(90_000);

    const khoa = await giuKhoaViecNang("lượt phục hồi giả");
    try {
      const kq = await bamAp("theo-pancake");
      expect(kq.ok).toBe(false);
      expect(kq.ok === false && kq.error).toContain("lượt phục hồi giả");
    } finally {
      if (khoa.the) await traKhoaViecNang(khoa.the);
    }

    expect(await giaVon(id)).toBe(120_000);
  });

  it("chụp backup giá cũ TRƯỚC khi ghi — có file, đọc lại được", async () => {
    await taoBienThe(120_000);
    await landBronze(90_000);

    await bamAp("theo-pancake");

    const files = readdirSync(THU_MUC_BACKUP).filter((f) => f.endsWith("-app.json"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("KHÔNG ghi được backup ⇒ TỪ CHỐI ghi DB (mất đường lùi thì không được đè giá)", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(90_000);

    // Trỏ backup vào thư mục không tồn tại — `writeFileSync` ném ⇒ cổng chặn phải bật.
    const cu = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = path.join(THU_MUC_BACKUP, "khong-ton-tai", "sau-nua");
    try {
      const kq = await bamAp("theo-pancake");
      expect(kq.ok).toBe(false);
      expect(kq.ok === false && kq.error).toContain("backup");
    } finally {
      process.env.BACKUP_DIR = cu;
    }

    expect(await giaVon(id)).toBe(120_000);
  });

  it("danh sách ĐỔI giữa lúc xem và lúc bấm ⇒ TỪ CHỐI, không ghi gì (duyệt gì ghi nấy)", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(90_000);

    // Chủ shop mở trang, thấy 1 mã. Rồi lượt đồng bộ land ảnh Bronze MỚI với giá khác.
    const { deXuat } = await docDeXuatGiaVon("theo-pancake");
    const vanTayLucXem = vanTayDeXuat(deXuat);
    await landBronze(75_000);

    const kq = await apGiaVonTheoPancake("theo-pancake", vanTayLucXem);

    expect(kq.ok).toBe(false);
    expect(kq.ok === false && kq.code).toBe("DANH_SACH_DA_DOI");
    expect(await giaVon(id)).toBe(120_000); // KHÔNG ghi gì, kể cả giá cũ lẫn giá mới
  });

  it("chế độ lạ từ client rơi về chế độ AN TOÀN, KHÔNG rơi vào nhánh đè", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(90_000);

    // Chuỗi rác: nếu rơi vào nhánh "theo-pancake" thì 120.000 bị đè mất.
    const { deXuat } = await docDeXuatGiaVon("chi-thieu");
    const kq = await apGiaVonTheoPancake("../../etc/passwd", vanTayDeXuat(deXuat));

    expect(kq.ok).toBe(true);
    expect(await giaVon(id)).toBe(120_000);
  });

  it("cập nhật lại SỐ ĐẾM ngay sau khi ghi — dải cảnh báo không kẹt số cũ", async () => {
    await taoBienThe(120_000);
    await landBronze(90_000);
    await prisma.setting.deleteMany({
      where: { key: { in: [KEY_SO_LECH_GIA_VON, KEY_MOC_KIEM_GIA_VON] } },
    });

    await bamAp("theo-pancake");

    // Ghi xong thì không còn mã nào lệch ⇒ số đếm phải về 0 NGAY, không đợi lượt đêm hôm sau.
    const soLech = await prisma.setting.findUnique({ where: { key: KEY_SO_LECH_GIA_VON } });
    const moc = await prisma.setting.findUnique({ where: { key: KEY_MOC_KIEM_GIA_VON } });
    expect(soLech?.value).toBe("0");
    expect(moc).not.toBeNull();
  });

  it("MẤT KHOÁ giữa lượt ghi ⇒ dừng ngay, không ghi tiếp dòng nào", async () => {
    // Hàng rào lease chạy TRONG transaction của từng dòng. Không có nó, một lượt phục hồi giành
    // được khoá vẫn bị lượt ghi này chèn số vào giữa — đúng ca mà lease sinh ra để chặn.
    const id = await taoBienThe(120_000);
    await landBronze(90_000);
    const { deXuat } = await docDeXuatGiaVon("theo-pancake");
    const vanTay = vanTayDeXuat(deXuat);

    // Ép lease của lượt sắp chạy hết hạn ngay khi nó vừa giành, rồi cho việc khác cướp.
    const goc = prisma.$transaction.bind(prisma) as (fn: unknown) => Promise<unknown>;
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce((async (fn: unknown) => {
        await prisma.setting.updateMany({
          where: { key: "khoaViecNang" },
          data: { value: `token-la|${Date.now() + HAN_KHOA_MS}|lượt phục hồi giả` },
        });
        return goc(fn);
      }) as typeof prisma.$transaction);
    try {
      const kq = await apGiaVonTheoPancake("theo-pancake", vanTay);
      expect(kq.ok).toBe(false);
    } finally {
      spy.mockRestore();
      await prisma.setting.deleteMany({ where: { key: "khoaViecNang" } });
    }

    expect(await giaVon(id)).toBe(120_000); // KHÔNG dòng nào lọt qua sau khi mất khoá
  });

  it("giá vốn ĐỔI giữa lúc đọc và lúc ghi ⇒ bỏ qua dòng đó, số chủ shop THẮNG", async () => {
    const id = await taoBienThe(120_000);
    await landBronze(90_000);

    // Mô phỏng: chủ shop sửa giá tay ngay sau khi action đọc đề xuất. Điều kiện CAS trong câu UPDATE
    // (`costPrice` phải còn đúng số lúc xem) là thứ giữ cho số vừa gõ không bị đè.
    const goc = prisma.$transaction.bind(prisma) as (fn: unknown) => Promise<unknown>;
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce((async (fn: unknown) => {
        await prisma.variant.update({ where: { id }, data: { costPrice: 111_111 } });
        return goc(fn);
      }) as typeof prisma.$transaction);
    try {
      const kq = await bamAp("theo-pancake");
      expect(kq.ok && kq.data.daGhi).toBe(0);
      expect(kq.ok && kq.data.boQua).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(await giaVon(id)).toBe(111_111); // số chủ shop vừa gõ được giữ
  });
});
