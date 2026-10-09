import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { refIdChoPhieu } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import {
  docPhieuConNo,
  docPhieuTheoRefId,
  hauKiemPhieu,
  khoaCacPhieu,
  vanTayPhieuConNo,
} from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { prisma } from "@/lib/prisma";
import { LoiKhoaDongTienBan } from "@/lib/so-quy/khoa-dong-tien-co-han";

import { donFixtureNoPhaiTra, seedBronze, taoPhieuNo, vn } from "../../helpers/phieu-nhap-no-fixture";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Đọc / vân tay / khoá / hậu kiểm hồ sơ phiếu nợ trên DB thật (`hogikids_test`). Số theo spec §6
 * (đơn vị triệu): #1 tổng 20 trả 23 hoàn 3 ⇒ 0; #2 tổng 100 đã trả trước 10, trả 27 ⇒ 63.
 */

const TR = 1_000_000;
const NGAY_TRA = vn("2026-10-05T00:00:00");

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await donFixtureNoPhaiTra();
});

afterAll(async () => {
  await truncateBusinessTables();
  await donFixtureNoPhaiTra();
  await prisma.$disconnect();
});

async function tra(phieuNhapId: string, amount: number, kind: "SUPPLIER_PAY" | "SUPPLIER_REFUND" = "SUPPLIER_PAY") {
  await prisma.cashMovement.create({ data: { date: NGAY_TRA, kind, amount, phieuNhapId, description: "t" } });
}

describe("docPhieuConNo — còn nợ suy từ dòng tiền", () => {
  it("ghép Σ SUPPLIER_PAY / SUPPLIER_REFUND đúng phiếu, sắp cũ → mới", async () => {
    const p1 = await taoPhieuNo({ uuid: "u-1", ngayPhieu: vn("2026-09-10T00:00:00"), tongTien: 20 * TR });
    const p2 = await taoPhieuNo({ uuid: "u-2", ngayPhieu: vn("2026-09-20T00:00:00"), tongTien: 100 * TR, daTraTruoc: 10 * TR });
    await tra(p1, 23 * TR);
    await tra(p1, 3 * TR, "SUPPLIER_REFUND");
    await tra(p2, 27 * TR);
    // Dòng tiền không gắn phiếu không được cộng vào phiếu nào.
    await prisma.cashMovement.create({ data: { date: NGAY_TRA, kind: "CAPITAL_IN", amount: 500 * TR } });

    const rows = await docPhieuConNo();
    expect(rows.map((r) => r.id)).toEqual([p1, p2]);
    expect(rows[0]).toMatchObject({ daTra: 23 * TR, daHoan: 3 * TR, conNo: 0, trangThai: "DA_TRA_DU", soDongTien: 2 });
    expect(rows[1]).toMatchObject({ daTra: 27 * TR, daHoan: 0, conNo: 63 * TR, trangThai: "CON_NO", soDongTien: 1 });
  });

  it("trả thừa ⇒ âm TRA_THUA; huỷ sau khi trả ⇒ âm CAN_THU_HOI", async () => {
    const p1 = await taoPhieuNo({ uuid: "u-1", tongTien: 20 * TR });
    const p3 = await taoPhieuNo({ uuid: "u-3", tongTien: 20 * TR, daHuy: true });
    await tra(p1, 23 * TR);
    await tra(p3, 5 * TR);
    const theoId = new Map((await docPhieuConNo()).map((r) => [r.id, r]));
    expect(theoId.get(p1)).toMatchObject({ conNo: -3 * TR, trangThai: "TRA_THUA" });
    expect(theoId.get(p3)).toMatchObject({ conNo: -5 * TR, trangThai: "CAN_THU_HOI" });
  });

  it("docPhieuTheoRefId: có ⇒ phiếu kèm còn nợ; chưa ghi nhận ⇒ null", async () => {
    const p1 = await taoPhieuNo({ uuid: "u-1", tongTien: 20 * TR });
    await tra(p1, 5 * TR);
    expect(await docPhieuTheoRefId(refIdChoPhieu("u-1"))).toMatchObject({ id: p1, conNo: 15 * TR });
    expect(await docPhieuTheoRefId(refIdChoPhieu("khong-co"))).toBeNull();
  });
});

describe("vanTayPhieuConNo", () => {
  it("không phụ thuộc thứ tự; đổi khi một phiếu được trả thêm", async () => {
    const p1 = await taoPhieuNo({ uuid: "u-1", tongTien: 20 * TR });
    await taoPhieuNo({ uuid: "u-2", tongTien: 100 * TR });
    const truoc = await docPhieuConNo();
    const vt = vanTayPhieuConNo(truoc);
    expect(vanTayPhieuConNo([...truoc].reverse())).toBe(vt);
    expect(vt).toMatch(/^[0-9a-f]{64}$/);

    await tra(p1, 1);
    expect(vanTayPhieuConNo(await docPhieuConNo())).not.toBe(vt);
  });

  it("đổi khi có phiếu mới ghi nhận", async () => {
    await taoPhieuNo({ uuid: "u-1", tongTien: 20 * TR });
    const vt = vanTayPhieuConNo(await docPhieuConNo());
    await taoPhieuNo({ uuid: "u-2", tongTien: 0 });
    expect(vanTayPhieuConNo(await docPhieuConNo())).not.toBe(vt);
  });
});

describe("khoaCacPhieu", () => {
  it("rỗng / trùng id / id lạ ⇒ không ném", async () => {
    const p1 = await taoPhieuNo({ uuid: "u-1", tongTien: 20 * TR });
    await prisma.$transaction(async (tx) => {
      await khoaCacPhieu(tx, []);
      await khoaCacPhieu(tx, [p1, p1, "id-khong-co"]);
    });
  });

  it("phiếu đang bị lượt khác giữ ⇒ lượt sau hết hạn chờ ⇒ LoiKhoaDongTienBan", async () => {
    const p1 = await taoPhieuNo({ uuid: "u-1", tongTien: 20 * TR });
    let nha!: () => void;
    const choNha = new Promise<void>((r) => (nha = r));
    let daGiu!: () => void;
    const giuXong = new Promise<void>((r) => (daGiu = r));

    const giu = prisma.$transaction(
      async (tx) => {
        await khoaCacPhieu(tx, [p1]);
        daGiu();
        await choNha;
      },
      { timeout: 20_000 },
    );
    await giuXong;
    try {
      await expect(
        prisma.$transaction(async (tx) => {
          await khoaCacPhieu(tx, [p1], 300);
        }),
      ).rejects.toBeInstanceOf(LoiKhoaDongTienBan);
    } finally {
      nha();
      await giu;
    }
  });
});

describe("hauKiemPhieu — chỉ cảnh báo", () => {
  const UUID = "u-hk";

  it("Bronze total_price 100 → 95 (bản mới nhất) ⇒ DOI_TONG", async () => {
    await seedBronze({ uuid: UUID, displayId: 2, insertedAt: "2026-09-20T03:00:00", tongTien: 100 * TR }, vn("2026-09-20T12:00:00"));
    await seedBronze({ uuid: UUID, displayId: 2, insertedAt: "2026-09-20T03:00:00", tongTien: 95 * TR }, vn("2026-09-28T12:00:00"));
    const id = await taoPhieuNo({ uuid: UUID, maPhieu: "#2", tongTien: 100 * TR });

    const cb = await hauKiemPhieu();
    expect(cb).toEqual([expect.objectContaining({ phieuNhapId: id, loai: "DOI_TONG", soCu: 100 * TR, soMoi: 95 * TR })]);
  });

  it("bản cũ hơn khác tổng nhưng bản MỚI NHẤT khớp ⇒ không cảnh báo", async () => {
    await seedBronze({ uuid: UUID, insertedAt: "2026-09-20T03:00:00", tongTien: 95 * TR }, vn("2026-09-20T12:00:00"));
    await seedBronze({ uuid: UUID, insertedAt: "2026-09-20T03:00:00", tongTien: 100 * TR }, vn("2026-09-28T12:00:00"));
    await taoPhieuNo({ uuid: UUID, tongTien: 100 * TR });
    expect(await hauKiemPhieu()).toEqual([]);
  });

  it("status 1 → 2 ⇒ DA_HUY_PANCAKE; đã đánh dấu huỷ ⇒ hết cảnh báo", async () => {
    await seedBronze({ uuid: UUID, insertedAt: "2026-09-20T03:00:00", tongTien: 20 * TR }, vn("2026-09-20T12:00:00"));
    await seedBronze({ uuid: UUID, insertedAt: "2026-09-20T03:00:00", tongTien: 20 * TR, status: 2 }, vn("2026-09-29T12:00:00"));
    const id = await taoPhieuNo({ uuid: UUID, tongTien: 20 * TR });

    expect(await hauKiemPhieu()).toEqual([expect.objectContaining({ phieuNhapId: id, loai: "DA_HUY_PANCAKE" })]);
    await prisma.phieuNhapNo.update({ where: { id }, data: { daHuy: true } });
    expect(await hauKiemPhieu()).toEqual([]);
  });

  it("status lạ (3) KHÔNG suy là huỷ", async () => {
    await seedBronze({ uuid: UUID, insertedAt: "2026-09-20T03:00:00", tongTien: 20 * TR, status: 3 });
    await taoPhieuNo({ uuid: UUID, tongTien: 20 * TR });
    expect(await hauKiemPhieu()).toEqual([]);
  });

  it("Expense cùng refId 53,6 → 33,6 sau ghi nhận ⇒ LECH_DA_TRA_TRUOC; đã giải thích đúng số ⇒ ẩn; Expense đổi tiếp ⇒ hiện lại", async () => {
    await seedBronze({ uuid: UUID, insertedAt: "2026-09-20T03:00:00", tongTien: 53_600_000 });
    const id = await taoPhieuNo({ uuid: UUID, tongTien: 53_600_000, daTraTruoc: 53_600_000 });
    await prisma.expense.create({
      data: {
        date: vn("2026-09-20T00:00:00"),
        categoryId: "purchase",
        amount: 53_600_000,
        description: "Phiếu nhập",
        refId: refIdChoPhieu(UUID),
      },
    });
    expect(await hauKiemPhieu()).toEqual([]);

    await prisma.expense.update({ where: { refId: refIdChoPhieu(UUID) }, data: { amount: 33_600_000 } });
    expect(await hauKiemPhieu()).toEqual([
      expect.objectContaining({ phieuNhapId: id, loai: "LECH_DA_TRA_TRUOC", soCu: 53_600_000, soMoi: 33_600_000 }),
    ]);

    // Cờ trơn không kèm số (hoặc kèm số khác) KHÔNG đủ để ẩn.
    await prisma.phieuNhapNo.update({ where: { id }, data: { lechDaGiaiThich: true } });
    expect((await hauKiemPhieu()).map((c) => c.loai)).toEqual(["LECH_DA_TRA_TRUOC"]);
    await prisma.phieuNhapNo.update({ where: { id }, data: { lechDaGiaiThichSo: 33_600_000 } });
    expect(await hauKiemPhieu()).toEqual([]);

    // Sổ chi phí sửa tiếp 33,6 → 30 ⇒ lời giải thích cũ không còn áp.
    await prisma.expense.update({ where: { refId: refIdChoPhieu(UUID) }, data: { amount: 30 * TR } });
    expect(await hauKiemPhieu()).toEqual([
      expect.objectContaining({ phieuNhapId: id, loai: "LECH_DA_TRA_TRUOC", soCu: 53_600_000, soMoi: 30 * TR }),
    ]);
  });

  it("phiếu từ D0 trở đi: Expense bị XOÁ sau ghi nhận ⇒ LECH_DA_TRA_TRUOC soMoi 0 (tiền chưa rời quỹ)", async () => {
    await prisma.cashMovement.create({ data: { date: vn("2026-09-15T00:00:00"), kind: "CAPITAL_IN", amount: 500 * TR } });
    await seedBronze({ uuid: UUID, insertedAt: "2026-09-20T03:00:00", tongTien: 53_600_000 });
    const id = await taoPhieuNo({ uuid: UUID, tongTien: 53_600_000, daTraTruoc: 53_600_000 });
    expect(await hauKiemPhieu()).toEqual([
      expect.objectContaining({ phieuNhapId: id, loai: "LECH_DA_TRA_TRUOC", soCu: 53_600_000, soMoi: 0 }),
    ]);
    // Đã giải thích với số 0 ⇒ ẩn.
    await prisma.phieuNhapNo.update({ where: { id }, data: { lechDaGiaiThich: true, lechDaGiaiThichSo: 0 } });
    expect(await hauKiemPhieu()).toEqual([]);
  });

  it("phiếu trước D0 gõ tay daTraTruoc, không có dòng chi phí ⇒ không cảnh báo", async () => {
    await prisma.cashMovement.create({ data: { date: vn("2026-09-15T00:00:00"), kind: "CAPITAL_IN", amount: 500 * TR } });
    await seedBronze({ uuid: UUID, insertedAt: "2026-08-10T03:00:00", tongTien: 50 * TR });
    await taoPhieuNo({ uuid: UUID, ngayPhieu: vn("2026-08-10T00:00:00"), tongTien: 50 * TR, daTraTruoc: 20 * TR });
    expect(await hauKiemPhieu()).toEqual([]);
  });
});
