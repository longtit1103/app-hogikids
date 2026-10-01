import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Khoá / mở / sửa quyền / xoá tài khoản — chạy THẬT trên DB test. Giả ngữ cảnh người gọi
 * (`docNguoiDungPhien`); `kiemPhien` (đường mọi request đi qua) dùng bản thật để đo hiệu lực phiên.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  return { ...that, docNguoiDungPhien: vi.fn() };
});

import { khoaTaiKhoan, moKhoaTaiKhoan, suaQuyenTaiKhoan, xoaTaiKhoan } from "@/lib/actions/tai-khoan";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien, kiemPhien } from "@/lib/quyen/nguoi-dung-phien";

import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";
import { chuShopTrongDb, donDuLieuTaiKhoan, DUOI_EMAIL, staffGia, taoStaffTrongDb } from "./du-lieu-tai-khoan-test";

const EPOCH = "b".repeat(32);
const phienCua = (userId: string) => ({ userId, mocPhien: EPOCH });

beforeEach(async () => {
  donKhoaPhucHoi();
  await donDuLieuTaiKhoan();
  vi.mocked(docNguoiDungPhien).mockResolvedValue(await chuShopTrongDb());
});

afterAll(async () => {
  await donDuLieuTaiKhoan();
  await prisma.$disconnect();
});

async function nhatKyOk(hanhDong: string) {
  return prisma.auditLog.findMany({ where: { hanhDong, ketQua: "OK" } });
}

describe("khoá / mở", () => {
  it("khoá ⇒ isActive=false, epoch đổi, cookie cũ bị từ chối, có nhật ký OK", async () => {
    const u = await taoStaffTrongDb("khoa", { sessionEpoch: EPOCH });
    expect(await kiemPhien(phienCua(u.id))).not.toBeNull();

    expect(await khoaTaiKhoan(u.id)).toEqual({ ok: true, data: undefined });

    const sau = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(sau.isActive).toBe(false);
    expect(sau.sessionEpoch).not.toBe(EPOCH);
    expect(sau.sessionEpoch).toMatch(/^[0-9a-f]{32}$/);
    expect(await kiemPhien(phienCua(u.id))).toBeNull();
    expect(await nhatKyOk("TAI_KHOAN_KHOA")).toEqual([
      expect.objectContaining({ doiTuongId: u.id, doiTuongMoTa: u.email }),
    ]);
  });

  it("mở ⇒ isActive=true, epoch KHÔNG đổi (cookie cũ đã chết từ lúc khoá vẫn chết)", async () => {
    const u = await taoStaffTrongDb("mo", { sessionEpoch: EPOCH });
    await khoaTaiKhoan(u.id);
    const epochSauKhoa = (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).sessionEpoch;

    expect(await moKhoaTaiKhoan(u.id)).toEqual({ ok: true, data: undefined });

    const sau = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(sau.isActive).toBe(true);
    expect(sau.sessionEpoch).toBe(epochSauKhoa);
    expect(await kiemPhien(phienCua(u.id))).toBeNull();
    expect(await kiemPhien({ userId: u.id, mocPhien: epochSauKhoa })).not.toBeNull();
    expect(await nhatKyOk("TAI_KHOAN_MO_KHOA")).toHaveLength(1);
  });
});

describe("sửa quyền", () => {
  it("quyền mới áp ngay ở request kế (cùng cookie), epoch KHÔNG đổi", async () => {
    const u = await taoStaffTrongDb("sua-quyen", { sessionEpoch: EPOCH, quyen: ["don-hang:xem"] });

    expect(await suaQuyenTaiKhoan(u.id, ["chi-phi:sua", "ma-la"])).toEqual({ ok: true, data: undefined });

    const sau = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(sau.quyen).toEqual(["chi-phi:xem", "chi-phi:sua"]);
    expect(sau.sessionEpoch).toBe(EPOCH);
    const nd = await kiemPhien(phienCua(u.id));
    expect(nd && [...nd.quyen]).toEqual(["chi-phi:xem", "chi-phi:sua"]);
    expect(await nhatKyOk("TAI_KHOAN_SUA_QUYEN")).toHaveLength(1);
  });

  it("tổ hợp sai ⇒ TO_HOP_QUYEN_SAI, quyền cũ giữ nguyên", async () => {
    const u = await taoStaffTrongDb("sua-quyen-sai", { quyen: ["don-hang:xem"] });
    expect(await suaQuyenTaiKhoan(u.id, ["tai-chinh-loi-lo:xem"])).toMatchObject({
      ok: false,
      code: "TO_HOP_QUYEN_SAI",
      field: "quyen",
    });
    // Đầu vào không phải mảng chuỗi (client gọi thẳng action) ⇒ cũng từ chối, không ném.
    expect(await suaQuyenTaiKhoan(u.id, "chi-phi:sua" as unknown as string[])).toMatchObject({
      ok: false,
      code: "TO_HOP_QUYEN_SAI",
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).quyen).toEqual(["don-hang:xem"]);
  });
});

describe("xoá", () => {
  it("xoá ⇒ dòng mất, nhật ký giữ email snapshot + actor chủ shop; cookie của người bị xoá ⇒ null, không ném", async () => {
    const chuShop = await chuShopTrongDb();
    const u = await taoStaffTrongDb("xoa", { sessionEpoch: EPOCH });

    expect(await xoaTaiKhoan(u.id)).toEqual({ ok: true, data: undefined });

    expect(await prisma.user.findUnique({ where: { id: u.id } })).toBeNull();
    expect(await nhatKyOk("TAI_KHOAN_XOA")).toEqual([
      expect.objectContaining({ actorId: chuShop.id, doiTuongId: u.id, doiTuongMoTa: `xoa${DUOI_EMAIL}` }),
    ]);
    await expect(kiemPhien(phienCua(u.id))).resolves.toBeNull();
  });

  it("id không tồn tại (đã bị xoá ở tab khác) ⇒ KHONG_TIM_THAY", async () => {
    expect(await xoaTaiKhoan("khong-co-id-nay")).toMatchObject({ ok: false, code: "KHONG_TIM_THAY" });
    expect(await khoaTaiKhoan("")).toMatchObject({ ok: false, code: "KHONG_TIM_THAY" });
  });
});

describe("chủ shop bất khả xâm phạm + cổng", () => {
  it("mọi hàm với id OWNER ⇒ KHONG_TAC_DONG_CHU_SHOP, dòng OWNER không đổi, có dòng LOI", async () => {
    const chuShop = await chuShopTrongDb();
    const truoc = await prisma.user.findUniqueOrThrow({ where: { id: chuShop.id } });

    for (const goi of [
      () => khoaTaiKhoan(chuShop.id),
      () => moKhoaTaiKhoan(chuShop.id),
      () => suaQuyenTaiKhoan(chuShop.id, ["don-hang:xem"]),
      () => xoaTaiKhoan(chuShop.id),
    ]) {
      expect(await goi()).toMatchObject({ ok: false, code: "KHONG_TAC_DONG_CHU_SHOP" });
    }

    expect(await prisma.user.findUniqueOrThrow({ where: { id: chuShop.id } })).toEqual(truoc);
    const loi = await prisma.auditLog.findMany({ where: { ketQua: "LOI", doiTuongId: chuShop.id } });
    expect(loi).toHaveLength(4);
    expect(loi.every((d) => JSON.stringify(d.ghiChu) === JSON.stringify({ lyDo: "KHONG_TAC_DONG_CHU_SHOP" }))).toBe(true);
  });

  it("STAFF gọi ⇒ KHONG_CO_QUYEN, không đổi gì", async () => {
    const u = await taoStaffTrongDb("bi-goi", { sessionEpoch: EPOCH });
    vi.mocked(docNguoiDungPhien).mockResolvedValue(staffGia());

    for (const goi of [
      () => khoaTaiKhoan(u.id),
      () => moKhoaTaiKhoan(u.id),
      () => suaQuyenTaiKhoan(u.id, ["don-hang:xem"]),
      () => xoaTaiKhoan(u.id),
    ]) {
      expect(await goi()).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    }
    const sau = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(sau).toMatchObject({ isActive: true, sessionEpoch: EPOCH, quyen: [] });
  });
});
