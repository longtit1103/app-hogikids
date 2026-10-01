import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { ANH_XA_ACTION_HANH_DONG, HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";

import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";

/**
 * Integration (`hogikids_test`): hai đường ghi nhật ký.
 * - `ghiNhatKy(tx, …)` đi CÙNG transaction của mutation ⇒ rollback thì dòng OK cũng biến mất.
 * - `ghiNhatKyLoi(…)` dùng client gốc, ghi dòng LOI, nuốt lỗi ghi (không làm hỏng luồng từ chối).
 */
const ACTOR = { id: "actor-nhat-ky-test", email: "nv@hogikids.test" };
const KHOA_SETTING = "test-nhat-ky-mutation";

class LoiCoY extends Error {}

beforeEach(async () => {
  donKhoaPhucHoi();
  await prisma.auditLog.deleteMany({});
  await prisma.setting.deleteMany({ where: { key: KHOA_SETTING } });
});

afterAll(async () => {
  donKhoaPhucHoi();
  await prisma.auditLog.deleteMany({});
  await prisma.setting.deleteMany({ where: { key: KHOA_SETTING } });
  await prisma.$disconnect();
});

describe("ghiNhatKy — trong transaction của mutation", () => {
  it("commit ⇒ đúng 1 dòng OK mang actorId/actorEmail + đối tượng + ghiChu", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.setting.create({ data: { key: KHOA_SETTING, value: "1" } });
      await ghiNhatKy(tx, {
        actor: ACTOR,
        hanhDong: HANH_DONG.TAI_KHOAN_TAO,
        doiTuong: { loai: "User", id: "u-1", moTa: "kho@hogikids.test" },
        ghiChu: { soDong: 3, lyDo: "tạo mới" },
      });
    });

    const dong = await prisma.auditLog.findMany();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({
      actorId: ACTOR.id,
      actorEmail: ACTOR.email,
      danhTinhKhaiBao: null,
      hanhDong: "TAI_KHOAN_TAO",
      doiTuongLoai: "User",
      doiTuongId: "u-1",
      doiTuongMoTa: "kho@hogikids.test",
      ketQua: "OK",
      ghiChu: { soDong: 3, lyDo: "tạo mới" },
    });
  });

  it("transaction ném SAU ghiNhatKy ⇒ không dòng nhật ký, mutation cũng không lưu", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.setting.create({ data: { key: KHOA_SETTING, value: "1" } });
        await ghiNhatKy(tx, { actor: ACTOR, hanhDong: HANH_DONG.DOI_MAT_KHAU });
        throw new LoiCoY("huỷ");
      }),
    ).rejects.toBeInstanceOf(LoiCoY);

    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.setting.count({ where: { key: KHOA_SETTING } })).toBe(0);
  });

  it("ghiNhatKy ném (DB từ chối) ⇒ mutation cùng transaction không lưu", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.setting.create({ data: { key: KHOA_SETTING, value: "1" } });
        // hanhDong NOT NULL — ép null qua cast để DB từ chối đúng câu INSERT nhật ký.
        await ghiNhatKy(tx, { actor: ACTOR, hanhDong: null as unknown as typeof HANH_DONG.DOI_MAT_KHAU });
      }),
    ).rejects.toThrow();
    expect(await prisma.setting.count({ where: { key: KHOA_SETTING } })).toBe(0);
  });

  it("ghiChu: khoá ngoài allowlist bị bỏ ở runtime, và bị chặn ở kiểu", async () => {
    await ghiNhatKy(prisma, {
      actor: ACTOR,
      hanhDong: HANH_DONG.DOI_MAT_KHAU,
      // @ts-expect-error — `matKhau` không nằm trong allowlist khoá ghiChu
      ghiChu: { matKhau: "bi-mat", ky: "2026-09" },
    });
    const dong = await prisma.auditLog.findFirstOrThrow();
    expect(dong.ghiChu).toEqual({ ky: "2026-09" });
  });

  it("không có ghiChu/đối tượng ⇒ cột null", async () => {
    await ghiNhatKy(prisma, { actor: ACTOR, hanhDong: HANH_DONG.DANG_XUAT });
    const dong = await prisma.auditLog.findFirstOrThrow();
    expect(dong).toMatchObject({ ghiChu: null, doiTuongLoai: null, doiTuongId: null, doiTuongMoTa: null });
  });
});

describe("ghiNhatKyLoi — client gốc, dòng LOI", () => {
  it("người chưa xác thực: actorId null, danhTinhKhaiBao = email khai, ketQua LOI", async () => {
    await ghiNhatKyLoi({ danhTinhKhaiBao: "x@y.z", hanhDong: "DANG_NHAP_SAI" });
    const dong = await prisma.auditLog.findMany();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({
      actorId: null,
      actorEmail: null,
      danhTinhKhaiBao: "x@y.z",
      hanhDong: "DANG_NHAP_SAI",
      ketQua: "LOI",
    });
  });

  it("người đã xác thực bị từ chối quyền: actorId + quyenThieu", async () => {
    await ghiNhatKyLoi({ actor: ACTOR, hanhDong: HANH_DONG.TU_CHOI_QUYEN, ghiChu: { quyenThieu: "chi-phi:sua" } });
    const dong = await prisma.auditLog.findFirstOrThrow();
    expect(dong).toMatchObject({ actorId: ACTOR.id, actorEmail: ACTOR.email, ketQua: "LOI" });
    expect(dong.ghiChu).toEqual({ quyenThieu: "chi-phi:sua" });
  });

  it("danhTinhKhaiBao dài bất thường bị cắt (đầu vào không tin cậy từ form)", async () => {
    await ghiNhatKyLoi({ danhTinhKhaiBao: `${"a".repeat(1000)}@x.z`, hanhDong: HANH_DONG.DANG_NHAP_SAI });
    const dong = await prisma.auditLog.findFirstOrThrow();
    expect(dong.danhTinhKhaiBao?.length).toBeLessThanOrEqual(320);
  });

  it("đang phục hồi DB ⇒ KHÔNG ghi (không chạm prisma), không ném", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
    const ghi = vi.spyOn(prisma.auditLog, "create");
    try {
      await expect(ghiNhatKyLoi({ actor: ACTOR, hanhDong: HANH_DONG.TU_CHOI_QUYEN })).resolves.toBeUndefined();
      expect(ghi).not.toHaveBeenCalled();
    } finally {
      ghi.mockRestore();
      donKhoaPhucHoi();
    }
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("ghi lỗi ⇒ NUỐT (console.error), không ném ra luồng từ chối", async () => {
    const loiLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const ghi = vi.spyOn(prisma.auditLog, "create").mockRejectedValueOnce(new Error("DB sập"));
    try {
      await expect(ghiNhatKyLoi({ hanhDong: HANH_DONG.DANG_NHAP_SAI, danhTinhKhaiBao: "x@y.z" })).resolves.toBeUndefined();
      expect(ghi).toHaveBeenCalledTimes(1);
      expect(loiLog).toHaveBeenCalled();
    } finally {
      ghi.mockRestore();
      loiLog.mockRestore();
    }
  });
});

describe("hanh-dong", () => {
  it("ánh xạ action tối thiểu trỏ đúng mã hợp lệ", () => {
    expect(ANH_XA_ACTION_HANH_DONG).toMatchObject({
      login: "DANG_NHAP_OK",
      logout: "DANG_XUAT",
      changePassword: "DOI_MAT_KHAU",
    });
    const hopLe = new Set<string>(Object.values(HANH_DONG));
    for (const ma of Object.values(ANH_XA_ACTION_HANH_DONG)) expect(hopLe.has(ma)).toBe(true);
  });

  it("mỗi mã bằng đúng tên khoá của nó", () => {
    for (const [k, v] of Object.entries(HANH_DONG)) expect(v).toBe(k);
  });
});
