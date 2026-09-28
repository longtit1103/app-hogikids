import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  chanSoDuTietKiemAm,
  khoaCacSoTietKiem,
  khoaSoTietKiem,
  kiemSoTietKiemConHieuLuc,
  LoiSoDuTietKiemAm,
  soDuDangGui,
} from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";
import {
  demSoDenHan,
  listSoTietKiem,
  tongDangGui,
  tongLaiDaNhanTrongKy,
  type SoTietKiemRow,
} from "@/lib/tiet-kiem/so-tiet-kiem-queries";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration sổ tiết kiệm trên `hogikids_test` — lõi thuần chạm DB (Phase 02). Không đụng server
 * action (Phase 03): ở đây dựng dòng tiền bằng `prisma.*` trực tiếp để cô lập đúng vị từ/queries.
 */

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

async function taoSo(principal: number): Promise<string> {
  const so = await prisma.soTietKiem.create({
    data: {
      name: "Sổ vị từ",
      bank: "VCB",
      principal,
      startDate: new Date(2026, 9, 1),
      termMonths: 6,
      maturityDate: new Date(2027, 3, 1),
      annualRateBp: 520,
    },
  });
  return so.id;
}

describe("vi-tu-so-tiet-kiem — số dư đang gửi và các cổng chặn", () => {
  it("Σ SAVINGS_OUT − Σ SAVINGS_IN: gửi 50tr ⇒ 50tr, nhận lại đủ ⇒ 0", async () => {
    const id = await taoSo(50_000_000);
    await prisma.cashMovement.create({
      data: { date: new Date(2026, 9, 1), kind: "SAVINGS_OUT", amount: 50_000_000, savingsId: id },
    });
    await prisma.$transaction(async (tx) => {
      expect(await soDuDangGui(tx, id)).toBe(50_000_000);
    });

    await prisma.cashMovement.create({
      data: { date: new Date(2027, 3, 1), kind: "SAVINGS_IN", amount: 50_000_000, savingsId: id },
    });
    await prisma.$transaction(async (tx) => {
      expect(await soDuDangGui(tx, id)).toBe(0);
      await chanSoDuTietKiemAm(tx, id); // 0 là hợp lệ, không ném
    });
  });

  it("nhận lại QUÁ số đang gửi ⇒ ném LoiSoDuTietKiemAm kèm số tiền thiếu", async () => {
    const id = await taoSo(50_000_000);
    await prisma.cashMovement.createMany({
      data: [
        { date: new Date(2026, 9, 1), kind: "SAVINGS_OUT", amount: 50_000_000, savingsId: id },
        { date: new Date(2027, 3, 1), kind: "SAVINGS_IN", amount: 51_000_000, savingsId: id },
      ],
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await chanSoDuTietKiemAm(tx, id);
      })
    ).rejects.toThrow(LoiSoDuTietKiemAm);

    await prisma.$transaction(async (tx) => {
      expect(await soDuDangGui(tx, id)).toBe(-1_000_000);
      const loi = await chanSoDuTietKiemAm(tx, id).catch((e: unknown) => e);
      expect(loi).toBeInstanceOf(LoiSoDuTietKiemAm);
      expect((loi as Error).message).toContain("1.000.000 ₫");
    });
  });

  it("kiemSoTietKiemConHieuLuc: sổ đang gửi qua, sổ đã tất toán và id lạ đều bị chặn", async () => {
    const id = await taoSo(50_000_000);
    await prisma.$transaction(async (tx) => {
      await kiemSoTietKiemConHieuLuc(tx, id); // không ném
    });

    await prisma.soTietKiem.update({ where: { id }, data: { closedAt: new Date(2027, 3, 1) } });
    await expect(
      prisma.$transaction(async (tx) => {
        await kiemSoTietKiemConHieuLuc(tx, id);
      })
    ).rejects.toThrow(/đã tất toán/);

    await expect(
      prisma.$transaction(async (tx) => {
        await kiemSoTietKiemConHieuLuc(tx, "khong-co-that");
      })
    ).rejects.toThrow(/Không tìm thấy sổ tiết kiệm/);
  });

  it("khoá: id lạ không ném (0 dòng), mảng rỗng là no-op", async () => {
    const id = await taoSo(50_000_000);
    await prisma.$transaction(async (tx) => {
      await khoaSoTietKiem(tx, id);
      await khoaSoTietKiem(tx, "khong-co-that");
      await khoaCacSoTietKiem(tx, []);
      await khoaCacSoTietKiem(tx, [id, id]); // trùng id ⇒ chỉ khoá một lần, không kẹt
    });
  });
});

/**
 * Fixture queries — ba sổ, MỌI mốc ngày đều ở QUÁ KHỨ so với bất kỳ ngày chạy test nào từ 2027 trở
 * đi, để `laiDonToiNay` (dùng `new Date()` bên trong) là số CỐ ĐỊNH chứ không trôi theo hôm nay.
 *
 *  A "Sổ 6 tháng VCB"  200tr · 5,2%/năm · 01/10/2025 → 01/04/2026 (182 ngày) · đang gửi, đã quá hạn
 *  B "Sổ 3 tháng ACB"  100tr · 4,8%/năm · 01/06/2026 → 01/09/2026 (92 ngày)  · tất toán 15/08/2026 (rút trước hạn)
 *  C "Sổ 12 tháng vay" 200tr · 5,2%/năm · 01/06/2026 → 01/06/2027 (365 ngày) · đang gửi, gắn khoản vay BULLET
 */
async function seedBaSo(): Promise<void> {
  const a = await prisma.soTietKiem.create({
    data: {
      name: "Sổ 6 tháng VCB",
      bank: "VCB",
      principal: 200_000_000,
      startDate: new Date(2025, 9, 1),
      termMonths: 6,
      maturityDate: new Date(2026, 3, 1),
      annualRateBp: 520,
    },
  });
  await prisma.cashMovement.create({
    data: { date: new Date(2025, 9, 1), kind: "SAVINGS_OUT", amount: 200_000_000, savingsId: a.id },
  });

  const b = await prisma.soTietKiem.create({
    data: {
      name: "Sổ 3 tháng ACB",
      bank: "ACB",
      principal: 100_000_000,
      startDate: new Date(2026, 5, 1),
      termMonths: 3,
      maturityDate: new Date(2026, 8, 1),
      annualRateBp: 480,
      closedAt: new Date(2026, 7, 15),
    },
  });
  await prisma.cashMovement.createMany({
    data: [
      { date: new Date(2026, 5, 1), kind: "SAVINGS_OUT", amount: 100_000_000, savingsId: b.id },
      { date: new Date(2026, 7, 15), kind: "SAVINGS_IN", amount: 100_000_000, savingsId: b.id },
    ],
  });
  await prisma.thuNhap.create({
    data: {
      date: new Date(2026, 7, 15),
      kind: "LAI_TIET_KIEM",
      amount: 1_200_000,
      description: "Lãi sổ ACB",
      savingsId: b.id,
      refId: `TIETKIEM:${b.id}`,
    },
  });

  // Khoản vay THẬT của chủ shop: khai lãi CỐ ĐỊNH 1.121.096 đ/kỳ, KHÔNG khai %/năm.
  const vay = await prisma.loan.create({
    data: {
      name: "Vay trả gốc cuối kỳ",
      kind: "BULLET",
      duNoMoSo: 200_000_000,
      startDate: new Date(2026, 5, 1),
      annualRateBp: 0,
      termMonths: 36,
      firstDueDate: new Date(2026, 6, 1),
      laiCoDinhMoiKy: 1_121_096,
    },
  });
  const c = await prisma.soTietKiem.create({
    data: {
      name: "Sổ 12 tháng vay",
      bank: "VCB",
      principal: 200_000_000,
      startDate: new Date(2026, 5, 1),
      termMonths: 12,
      maturityDate: new Date(2027, 5, 1),
      annualRateBp: 520,
      loanId: vay.id,
    },
  });
  await prisma.cashMovement.create({
    data: { date: new Date(2026, 5, 1), kind: "SAVINGS_OUT", amount: 200_000_000, savingsId: c.id },
  });
}

function lay(rows: SoTietKiemRow[], ten: string): SoTietKiemRow {
  const r = rows.find((x) => x.name === ten);
  if (!r) throw new Error(`Không thấy sổ "${ten}" trong bảng`);
  return r;
}

describe("so-tiet-kiem-queries — bảng sổ, đếm đến hạn, tổng đang gửi", () => {
  beforeEach(async () => {
    await seedBaSo();
  });

  it("sổ đang gửi: dangGui suy từ dòng tiền, lãi dự kiến 5.185.753, chưa có lãi thực nhận", () => {
    return listSoTietKiem().then((rows) => {
      const a = lay(rows, "Sổ 6 tháng VCB");
      expect(a.dangGui).toBe(200_000_000);
      expect(a.laiDuKien).toBe(5_185_753);
      // Sổ đã quá đáo hạn nên lãi dồn KẸP đúng bằng lãi dự kiến, không chạy tiếp.
      expect(a.laiDonToiNay).toBe(5_185_753);
      expect(a.laiThucNhan).toBeNull();
      expect(a.rutTruocHan).toBe(false);
      expect(a.coDongGhiTay).toBe(false);
      expect(a.chenhLech).toBeNull();
    });
  });

  it("sổ rút trước hạn: laiThucNhan = Σ ThuNhap (1.200.000), badge rút trước hạn bật", async () => {
    const b = lay(await listSoTietKiem(), "Sổ 3 tháng ACB");
    expect(b.dangGui).toBe(0);
    expect(b.laiDuKien).toBe(1_209_863);
    expect(b.laiThucNhan).toBe(1_200_000);
    expect(b.rutTruocHan).toBe(true);
  });

  it("sổ gắn khoản vay khai lãi cố định: quy đổi 673bp ⇒ chênh −153bp ≈ −3.060.000 đ/năm", async () => {
    const c = lay(await listSoTietKiem(), "Sổ 12 tháng vay");
    expect(c.laiDuKien).toBe(10_400_000);
    expect(c.loan?.name).toBe("Vay trả gốc cuối kỳ");
    expect(c.chenhLech).toEqual({ chenhBp: -153, chenhMoiNam: -3_060_000, quyDoi: true });
  });

  it("coDongGhiTay bật khi sổ có dòng ngoài đúng 1 dòng SAVINGS_OUT do app sinh", async () => {
    const a = lay(await listSoTietKiem(), "Sổ 6 tháng VCB");
    await prisma.cashMovement.create({
      data: { date: new Date(2026, 0, 5), kind: "SAVINGS_IN", amount: 10_000_000, savingsId: a.id },
    });
    const sau = lay(await listSoTietKiem(), "Sổ 6 tháng VCB");
    expect(sau.coDongGhiTay).toBe(true);
    expect(sau.dangGui).toBe(190_000_000);
  });

  it("thứ tự: sổ đang gửi lên trước sổ đã tất toán", async () => {
    const rows = await listSoTietKiem();
    expect(rows.map((r) => r.closedAt === null)).toEqual([true, true, false]);
  });

  it("demSoDenHan: chỉ đếm sổ CHƯA tất toán đã tới ngày đáo hạn", async () => {
    expect(await demSoDenHan(new Date(2026, 8, 20))).toBe(1); // A quá hạn; B đã đóng; C chưa tới
    expect(await demSoDenHan(new Date(2025, 11, 1))).toBe(0);
    expect(await demSoDenHan(new Date(2027, 5, 1))).toBe(2);
  });

  it("tongDangGui trả đủ 5 số cho footnote thẻ Quỹ", async () => {
    expect(await tongDangGui()).toEqual({
      tong: 400_000_000,
      soSoDangGui: 2,
      daoHanGanNhat: new Date(2026, 3, 1),
      gocDaoHanGanNhat: 200_000_000,
      laiDaoHanGanNhat: 5_185_753,
    });
  });

  /**
   * Điều chỉnh #1 vòng rà chéo 16/09: `tong` và `gocDaoHanGanNhat` phải SUY TỪ DÒNG TIỀN, không phải
   * `principal` khai trên sổ. Ca này là lưới duy nhất phân biệt hai cách — mọi sổ trong fixture gốc
   * đều có đúng 1 dòng gửi nên hai cách ra CÙNG số và không bắt được gì.
   */
  it("có dòng ghi tay rút bớt ⇒ tong bám tiền THẬT đã ra khỏi quỹ, không bám principal", async () => {
    const a = lay(await listSoTietKiem(), "Sổ 6 tháng VCB");
    // Rút bớt 30tr khỏi sổ A bằng dòng ghi tay: principal vẫn khai 200tr, tiền thật còn 170tr.
    await prisma.cashMovement.create({
      data: { date: new Date(2026, 0, 5), kind: "SAVINGS_IN", amount: 30_000_000, savingsId: a.id },
    });

    const t = await tongDangGui();
    // 170tr (A sau khi rút) + 200tr (C) = 370tr. Bám `principal` sẽ ra 400tr — sai 30tr.
    expect(t.tong).toBe(370_000_000);
    expect(t.tong).not.toBe(400_000_000);
    // A vẫn là sổ đáo hạn sớm nhất; "nhận lại" phải là số THẬT còn trong sổ.
    expect(t.gocDaoHanGanNhat).toBe(170_000_000);
    // Lãi thì KHÔNG đổi: ngân hàng trả theo số tiền gửi trên hợp đồng, không theo dòng ghi tay.
    expect(t.laiDaoHanGanNhat).toBe(5_185_753);
  });

  it("không sổ nào đang gửi ⇒ 5 số về 0/null, KHÔNG ném", async () => {
    await prisma.soTietKiem.updateMany({ data: { closedAt: new Date(2027, 0, 1) } });
    expect(await tongDangGui()).toEqual({
      tong: 0,
      soSoDangGui: 0,
      daoHanGanNhat: null,
      gocDaoHanGanNhat: 0,
      laiDaoHanGanNhat: 0,
    });
  });
});

/**
 * Dòng tổng bảng nói về KỲ ĐANG XEM (trang Tài chính luôn xem một tháng). Cộng cả lịch sử rồi đặt
 * cạnh các số theo tháng là đọc sai chắc chắn — quyết định #6 vòng rà chéo 16/09.
 */
describe("tongLaiDaNhanTrongKy — Σ ThuNhap LỌC THEO KỲ, không cộng cả lịch sử", () => {
  beforeEach(async () => {
    await seedBaSo(); // sổ B ghi lãi 1.200.000 ngày 15/08/2026
  });

  it("kỳ chứa ngày tất toán ⇒ cộng đúng số lãi", async () => {
    expect(
      await tongLaiDaNhanTrongKy({ from: new Date(2026, 7, 1), to: new Date(2026, 7, 31) })
    ).toBe(1_200_000);
  });

  it("kỳ KHÔNG chứa ngày tất toán ⇒ 0, không rò số tháng khác sang", async () => {
    expect(
      await tongLaiDaNhanTrongKy({ from: new Date(2026, 8, 1), to: new Date(2026, 8, 30) })
    ).toBe(0);
    expect(
      await tongLaiDaNhanTrongKy({ from: new Date(2026, 6, 1), to: new Date(2026, 6, 31) })
    ).toBe(0);
  });

  it("biên PHẢI dùng endOfDay: kỳ kết thúc ĐÚNG ngày tất toán vẫn cộng", async () => {
    expect(
      await tongLaiDaNhanTrongKy({ from: new Date(2026, 7, 1), to: new Date(2026, 7, 15) })
    ).toBe(1_200_000);
  });
});
