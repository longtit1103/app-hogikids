import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  return { ...that, docNguoiDungPhien: vi.fn() };
});

import { datLaiMatKhau } from "@/lib/actions/tai-khoan";
import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien, kiemPhien } from "@/lib/quyen/nguoi-dung-phien";

import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";
import { chuShopTrongDb, donDuLieuTaiKhoan, staffGia, taoStaffTrongDb } from "./du-lieu-tai-khoan-test";

const EPOCH = "b".repeat(32);
const MK_CU = "Mat-khau-cu-0000";

beforeEach(async () => {
  donKhoaPhucHoi();
  await donDuLieuTaiKhoan();
  vi.mocked(docNguoiDungPhien).mockResolvedValue(await chuShopTrongDb());
});

afterAll(async () => {
  await donDuLieuTaiKhoan();
  await prisma.$disconnect();
});

describe("datLaiMatKhau", () => {
  it("hash mới khớp MK tạm, bắt đổi MK, epoch đổi (cookie cũ chết), nhật ký không chứa MK", async () => {
    const u = await taoStaffTrongDb("dat-lai", { matKhau: MK_CU, sessionEpoch: EPOCH });

    const res = await datLaiMatKhau(u.id);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { matKhauTam } = res.data;
    expect(matKhauTam).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    const sau = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword(matKhauTam, sau.passwordHash)).toBe(true);
    expect(await verifyPassword(MK_CU, sau.passwordHash)).toBe(false);
    expect(sau.mustChangePassword).toBe(true);
    expect(sau.sessionEpoch).not.toBe(EPOCH);
    expect(await kiemPhien({ userId: u.id, mocPhien: EPOCH })).toBeNull();

    const nhatKy = await prisma.auditLog.findMany({ where: { hanhDong: "TAI_KHOAN_DAT_LAI_MK" } });
    expect(nhatKy).toEqual([expect.objectContaining({ ketQua: "OK", doiTuongId: u.id, doiTuongMoTa: u.email })]);
    expect(JSON.stringify(nhatKy)).not.toContain(matKhauTam);
    expect(JSON.stringify(nhatKy)).not.toContain(sau.passwordHash);
  });

  it("đặt lại MK chủ shop ⇒ KHONG_TAC_DONG_CHU_SHOP, hash/epoch chủ shop không đổi", async () => {
    const chuShop = await chuShopTrongDb();
    const truoc = await prisma.user.findUniqueOrThrow({ where: { id: chuShop.id } });

    expect(await datLaiMatKhau(chuShop.id)).toMatchObject({ ok: false, code: "KHONG_TAC_DONG_CHU_SHOP" });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: chuShop.id } })).toEqual(truoc);
  });

  it("STAFF gọi ⇒ KHONG_CO_QUYEN; id không tồn tại ⇒ KHONG_TIM_THAY", async () => {
    const u = await taoStaffTrongDb("dat-lai-bi-chan", { matKhau: MK_CU, sessionEpoch: EPOCH });
    expect(await datLaiMatKhau("khong-co-id-nay")).toMatchObject({ ok: false, code: "KHONG_TIM_THAY" });

    vi.mocked(docNguoiDungPhien).mockResolvedValue(staffGia());
    expect(await datLaiMatKhau(u.id)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    const sau = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(sau).toMatchObject({ sessionEpoch: EPOCH, mustChangePassword: false });
    expect(await verifyPassword(MK_CU, sau.passwordHash)).toBe(true);
  });
});
