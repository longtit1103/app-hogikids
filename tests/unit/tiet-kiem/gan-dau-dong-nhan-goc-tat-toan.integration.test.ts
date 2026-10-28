import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { moLaiSoTietKiem } from "@/lib/actions/tat-toan-so-tiet-kiem";
import { prisma } from "@/lib/prisma";
import {
  ganDauDongNhanGoc,
  khaoSatSoCanGanDau,
} from "@/lib/tiet-kiem/gan-dau-dong-nhan-goc-tat-toan";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Integration test (`hogikids_test`) cho phần lõi của script `scripts/danh-dau-dong-nhan-goc-tat-toan.ts`:
 * sổ tất toán bởi bản cũ (đóng, cột trỏ dòng NULL) mà còn dòng nhận gốc mang mẫu mô tả app sinh thì
 * Mở lại bị từ chối — script liệt kê ứng viên (lượt thử) rồi chỉ gán dấu các id chủ shop đã duyệt.
 *
 * Số literal tính tay, sổ 100.000.000.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const GOC = 100_000_000;
const ACTOR = { id: "script-test", email: "script-test@hogikids.local" };
const HANH_DONG_GAN_DAU = "TIET_KIEM_GAN_DAU_DONG_NHAN_GOC";

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

/** Sổ đóng bởi bản cũ: một dòng gửi 100tr + các dòng nhận cho sẵn, đóng 05/03/2027. */
async function taoSoCu(ten: string, dongIn: { amount: number; description?: string; ngay?: string }[]) {
  const so = await prisma.soTietKiem.create({
    data: {
      name: ten,
      principal: GOC,
      startDate: vn("2026-09-05"),
      termMonths: 6,
      maturityDate: vn("2027-03-05"),
      annualRateBp: 520,
      closedAt: vn("2027-03-05"),
    },
  });
  await prisma.cashMovement.create({
    data: { date: vn("2026-09-05"), kind: "SAVINGS_OUT", amount: GOC, savingsId: so.id, description: `Gửi tiết kiệm ${ten}` },
  });
  const ids: string[] = [];
  for (const d of dongIn) {
    const m = await prisma.cashMovement.create({
      data: {
        date: vn(d.ngay ?? "2027-03-05"),
        kind: "SAVINGS_IN",
        amount: d.amount,
        savingsId: so.id,
        description: d.description ?? `Nhận lại gốc tiết kiệm ${ten} — tất toán 05/03/2027`,
      },
    });
    ids.push(m.id);
  }
  return { soId: so.id, ids };
}

async function soDongNhatKy(): Promise<number> {
  return prisma.auditLog.count({ where: { hanhDong: HANH_DONG_GAN_DAU } });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany({ where: { hanhDong: HANH_DONG_GAN_DAU } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany({ where: { hanhDong: HANH_DONG_GAN_DAU } });
  await prisma.$disconnect();
});

describe("khaoSatSoCanGanDau (lượt thử)", () => {
  it("liệt kê đúng ứng viên duy nhất; sổ có 2 dòng khớp bị loại kèm lý do; sổ chỉ dòng tay không cần gán", async () => {
    const a = await taoSoCu("Sổ A", [{ amount: GOC }]);
    const b = await taoSoCu("Sổ B", [
      { amount: 40_000_000, description: "Ngân hàng trả gốc, ghi tay", ngay: "2027-01-10" },
      { amount: 60_000_000 },
    ]);
    const c = await taoSoCu("Sổ C", [{ amount: 50_000_000 }, { amount: 50_000_000 }]);
    // Sổ chỉ có dòng tay: Mở lại không bị chặn ⇒ không phải việc của script.
    await taoSoCu("Sổ D", [{ amount: GOC, description: "Ngân hàng trả gốc, ghi tay" }]);

    const ks = await khaoSatSoCanGanDau();
    const theoSo = new Map(ks.map((x) => [x.soId, x]));

    expect(ks).toHaveLength(3);
    expect(theoSo.get(a.soId)).toMatchObject({ tenSo: "Sổ A", ngayTatToan: "2027-03-05", dongId: a.ids[0], soTien: GOC, lyDo: null });
    expect(theoSo.get(b.soId)).toMatchObject({ dongId: b.ids[1], soTien: 60_000_000, lyDo: null });
    expect(theoSo.get(c.soId)).toMatchObject({ dongId: null, soTien: null });
    expect(theoSo.get(c.soId)?.lyDo).toContain("2 dòng");

    // Lượt thử không ghi gì.
    expect(await prisma.soTietKiem.count({ where: { dongNhanGocTatToanId: { not: null } } })).toBe(0);
    expect(await soDongNhatKy()).toBe(0);
  });
});

describe("ganDauDongNhanGoc (--apply)", () => {
  it("ghi cột + một dòng nhật ký mỗi sổ; chạy lần 2 không đổi gì; sau đó Mở lại chỉ xoá dòng đã gán", async () => {
    const a = await taoSoCu("Sổ A", [{ amount: GOC }]);
    const b = await taoSoCu("Sổ B", [
      { amount: 40_000_000, description: "Ngân hàng trả gốc, ghi tay", ngay: "2027-01-10" },
      { amount: 60_000_000 },
    ]);

    const lan1 = await ganDauDongNhanGoc([a.ids[0], b.ids[1]], ACTOR);
    expect(lan1).toEqual({ daGan: [a.ids[0], b.ids[1]].sort(), daCoSan: [] });
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id: a.soId } })).dongNhanGocTatToanId).toBe(a.ids[0]);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id: b.soId } })).dongNhanGocTatToanId).toBe(b.ids[1]);
    const nhatKy = await prisma.auditLog.findMany({ where: { hanhDong: HANH_DONG_GAN_DAU } });
    expect(nhatKy.map((n) => n.doiTuongId).sort()).toEqual([a.soId, b.soId].sort());
    expect(nhatKy.every((n) => n.ketQua === "OK" && n.actorId === ACTOR.id && n.doiTuongLoai === "SoTietKiem")).toBe(true);

    // Idempotent: lần 2 không ghi gì thêm.
    const lan2 = await ganDauDongNhanGoc([a.ids[0], b.ids[1]], ACTOR);
    expect(lan2).toEqual({ daGan: [], daCoSan: [a.ids[0], b.ids[1]].sort() });
    expect(await soDongNhatKy()).toBe(2);
    expect(await khaoSatSoCanGanDau()).toEqual([]);

    // Đã gán ⇒ Mở lại qua được và giữ dòng tay 40tr của sổ B.
    expect((await moLaiSoTietKiem({ id: b.soId })).ok).toBe(true);
    const conLai = await prisma.cashMovement.findMany({ where: { savingsId: b.soId, kind: "SAVINGS_IN" } });
    expect(conLai.map((d) => ({ id: d.id, amount: d.amount }))).toEqual([{ id: b.ids[0], amount: 40_000_000 }]);
  });

  it("danh sách có một id KHÔNG phải ứng viên (dòng tay / sổ 2 dòng khớp) → từ chối TRỌN, không gán sổ nào", async () => {
    const a = await taoSoCu("Sổ A", [{ amount: GOC }]);
    const b = await taoSoCu("Sổ B", [
      { amount: 40_000_000, description: "Ngân hàng trả gốc, ghi tay", ngay: "2027-01-10" },
      { amount: 60_000_000 },
    ]);
    const c = await taoSoCu("Sổ C", [{ amount: 50_000_000 }, { amount: 50_000_000 }]);

    await expect(ganDauDongNhanGoc([a.ids[0], b.ids[0]], ACTOR)).rejects.toThrow();
    await expect(ganDauDongNhanGoc([a.ids[0], c.ids[0]], ACTOR)).rejects.toThrow();
    // Hai dòng của CÙNG một sổ trong một lượt ⇒ từ chối.
    await expect(ganDauDongNhanGoc(c.ids, ACTOR)).rejects.toThrow();
    await expect(ganDauDongNhanGoc(["khong-ton-tai"], ACTOR)).rejects.toThrow();

    expect(await prisma.soTietKiem.count({ where: { dongNhanGocTatToanId: { not: null } } })).toBe(0);
    expect(await soDongNhatKy()).toBe(0);
  });
});
