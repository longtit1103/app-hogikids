import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Action THƯỜNG của tab Dòng tiền (`updateCashMovement`/`deleteCashMovement`) nhận id thẳng — bảng ẩn
 * nút với dòng loại nợ phải trả chưa đủ. Dòng `CUTOVER_ADJ_IN` (điều chỉnh mở sổ) mà sửa được thành
 * `CAPITAL_IN` thì lọt êm CHECK DB (mọi khoá hồ sơ NULL) — chỉ cổng ở action chặn được. Dòng kind cũ
 * vẫn sửa/xoá như trước.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const sua = {
  date: "2026-07-10",
  kind: "CAPITAL_IN",
  amount: 5_000_000,
  description: "Đổi nghĩa thành góp vốn",
};

const TU_CHOI = {
  ok: false,
  code: "KIND_CHUA_HO_TRO",
  error: "Dòng này thuộc loại mới (nợ phải trả) — sửa/xoá ở khối tương ứng",
};

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

async function taoCutover() {
  return prisma.cashMovement.create({
    data: {
      date: new Date(2026, 6, 1),
      kind: "CUTOVER_ADJ_IN",
      amount: 3_000_000,
      description: "Điều chỉnh mở sổ nợ phải trả",
    },
  });
}

describe("action thường từ chối dòng loại nợ phải trả", () => {
  it("update CUTOVER_ADJ_IN → CAPITAL_IN bị từ chối, dòng giữ nguyên", async () => {
    const row = await taoCutover();
    expect(await updateCashMovement(row.id, sua)).toEqual(TU_CHOI);
    const sau = await prisma.cashMovement.findUniqueOrThrow({ where: { id: row.id } });
    expect(sau).toMatchObject({ kind: "CUTOVER_ADJ_IN", amount: 3_000_000 });
  });

  it("delete CUTOVER_ADJ_IN bị từ chối, dòng còn, thùng rác không có bản chụp", async () => {
    const row = await taoCutover();
    expect(await deleteCashMovement(row.id)).toEqual(TU_CHOI);
    expect(await prisma.cashMovement.count({ where: { id: row.id } })).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("dòng CAPITAL_IN thường vẫn sửa rồi xoá được", async () => {
    const row = await prisma.cashMovement.create({
      data: { date: new Date(2026, 6, 1), kind: "CAPITAL_IN", amount: 1_000_000, description: "Góp vốn" },
    });
    expect(await updateCashMovement(row.id, sua)).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      kind: "CAPITAL_IN",
      amount: 5_000_000,
    });
    expect(await deleteCashMovement(row.id)).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});
