import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { listHanhDongDaCo, listNhatKy } from "@/lib/quan-tri/nhat-ky-queries";
import { listTaiKhoan } from "@/lib/quan-tri/tai-khoan-queries";

import { chuShopTrongDb, donDuLieuTaiKhoan, DUOI_EMAIL, taoStaffTrongDb } from "./du-lieu-tai-khoan-test";

/** Actor riêng của suite — lọc theo nó để không phụ thuộc nhật ký suite khác còn trong DB. */
const ACTOR_A = "actor-qt-a";
const ACTOR_B = "actor-qt-b";
const MOC = new Date("2026-09-15T10:00:00+07:00").getTime();
const PHUT = 60_000;

async function donNhatKySuite() {
  await prisma.auditLog.deleteMany({ where: { actorId: { in: [ACTOR_A, ACTOR_B] } } });
}

beforeEach(async () => {
  await donDuLieuTaiKhoan();
  await donNhatKySuite();
});

afterAll(async () => {
  await donDuLieuTaiKhoan();
  await donNhatKySuite();
  await prisma.$disconnect();
});

describe("listTaiKhoan", () => {
  it("OWNER đứng đầu, rồi theo email; không trả hash/epoch; quyền lạ trong DB bị lọc", async () => {
    await chuShopTrongDb();
    await taoStaffTrongDb("zeta", { quyen: ["don-hang:xem"] });
    await taoStaffTrongDb("alpha", { quyen: ["san-pham:xem", "ma-cu-khong-con"], mustChangePassword: true });
    await prisma.user.update({ where: { email: `zeta${DUOI_EMAIL}` }, data: { isActive: false } });

    const rows = await listTaiKhoan();

    expect(rows[0]?.role).toBe("OWNER");
    expect(rows.filter((r) => r.role === "OWNER")).toHaveLength(1);
    const staff = rows.filter((r) => r.role === "STAFF").map((r) => r.email);
    expect(staff).toEqual([...staff].sort());
    const cuaSuite = rows.filter((r) => r.email.endsWith(DUOI_EMAIL) && r.role === "STAFF");
    expect(cuaSuite).toEqual([
      {
        id: expect.any(String),
        email: `alpha${DUOI_EMAIL}`,
        tenHienThi: "",
        role: "STAFF",
        isActive: true,
        mustChangePassword: true,
        lastLoginAt: null,
        quyen: ["san-pham:xem"],
      },
      expect.objectContaining({ email: `zeta${DUOI_EMAIL}`, isActive: false, quyen: ["don-hang:xem"] }),
    ]);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ["email", "id", "isActive", "lastLoginAt", "mustChangePassword", "quyen", "role", "tenHienThi"],
      );
    }
  });
});

describe("listNhatKy", () => {
  it("sắp thoiDiem giảm dần, phân trang 50, tong = tổng sau lọc", async () => {
    await prisma.auditLog.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        actorId: ACTOR_A,
        hanhDong: "TAI_KHOAN_TAO",
        ketQua: "OK" as const,
        thoiDiem: new Date(MOC + i * PHUT),
        doiTuongMoTa: `so-${i}`,
      })),
    });

    const t1 = await listNhatKy({ actorId: ACTOR_A }, 1);
    expect(t1.tong).toBe(120);
    expect(t1.rows).toHaveLength(50);
    expect(t1.rows[0]?.doiTuongMoTa).toBe("so-119");
    expect(t1.rows[49]?.doiTuongMoTa).toBe("so-70");
    const t3 = await listNhatKy({ actorId: ACTOR_A }, 3);
    expect(t3.rows.map((r) => r.doiTuongMoTa)).toEqual(Array.from({ length: 20 }, (_, i) => `so-${19 - i}`));
    // Trang vượt/không hợp lệ không ném: trang ngoài phạm vi rỗng, trang ≤ 0 / NaN quy về 1.
    expect((await listNhatKy({ actorId: ACTOR_A }, 99)).rows).toEqual([]);
    expect((await listNhatKy({ actorId: ACTOR_A }, 0)).rows[0]?.doiTuongMoTa).toBe("so-119");
    expect((await listNhatKy({ actorId: ACTOR_A }, Number.NaN)).rows[0]?.doiTuongMoTa).toBe("so-119");
    expect((await listNhatKy({ actorId: ACTOR_A }, 1, 10)).rows).toHaveLength(10);
  });

  it("lọc theo người, hành động, khoảng ngày (cả hai đầu BAO GỒM)", async () => {
    await prisma.auditLog.createMany({
      data: [
        { actorId: ACTOR_A, hanhDong: "DANG_NHAP_OK", ketQua: "OK", thoiDiem: new Date(MOC) },
        { actorId: ACTOR_A, hanhDong: "TAI_KHOAN_KHOA", ketQua: "OK", thoiDiem: new Date(MOC + 10 * PHUT) },
        { actorId: ACTOR_B, hanhDong: "DANG_NHAP_OK", ketQua: "OK", thoiDiem: new Date(MOC + 20 * PHUT) },
        { actorId: ACTOR_B, hanhDong: "DANG_NHAP_SAI", ketQua: "LOI", thoiDiem: new Date(MOC + 30 * PHUT) },
      ],
    });

    const theoNguoi = await listNhatKy({ actorId: ACTOR_B }, 1);
    expect(theoNguoi.rows.map((r) => r.hanhDong)).toEqual(["DANG_NHAP_SAI", "DANG_NHAP_OK"]);

    const theoHanhDong = await listNhatKy({ actorId: ACTOR_A, hanhDong: "TAI_KHOAN_KHOA" }, 1);
    expect(theoHanhDong.tong).toBe(1);

    const trongKhoang = await listNhatKy(
      { tu: new Date(MOC + 10 * PHUT), den: new Date(MOC + 20 * PHUT), hanhDong: undefined },
      1,
    );
    const cuaSuite = trongKhoang.rows.filter((r) => r.actorId === ACTOR_A || r.actorId === ACTOR_B);
    expect(cuaSuite.map((r) => r.hanhDong)).toEqual(["DANG_NHAP_OK", "TAI_KHOAN_KHOA"]);
  });
});

describe("listHanhDongDaCo", () => {
  it("các mã đã xuất hiện, không trùng, sắp tăng dần", async () => {
    await prisma.auditLog.createMany({
      data: [
        { actorId: ACTOR_A, hanhDong: "TAI_KHOAN_XOA", ketQua: "OK" },
        { actorId: ACTOR_A, hanhDong: "TAI_KHOAN_XOA", ketQua: "OK" },
        { actorId: ACTOR_B, hanhDong: "DANG_XUAT", ketQua: "OK" },
      ],
    });

    const ma = await listHanhDongDaCo();

    expect(ma).toEqual(expect.arrayContaining(["DANG_XUAT", "TAI_KHOAN_XOA"]));
    expect(new Set(ma).size).toBe(ma.length);
    expect(ma).toEqual([...ma].sort());
  });
});
