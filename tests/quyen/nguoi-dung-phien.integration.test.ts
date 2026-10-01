import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { coQuyen, kiemPhien, laChuShop } from "@/lib/quyen/nguoi-dung-phien";

/**
 * Integration (`hogikids_test`): ngữ cảnh người dùng mỗi request — `kiemPhien` đối chiếu cookie với
 * ĐÚNG dòng `User` của người đó (epoch từng người, `isActive`, bộ quyền đã chuẩn hoá).
 *
 * DB chỉ cho MỘT OWNER (partial unique) ⇒ xoá mọi OWNER trước khi tạo OWNER thử.
 */
const EMAIL_STAFF = "staff-phien@nguoi-dung-phien.test";
const EMAIL_CHU = "chu-phien@nguoi-dung-phien.test";

async function donUser(): Promise<void> {
  await prisma.user.deleteMany({
    where: { OR: [{ role: "OWNER" }, { email: { in: [EMAIL_STAFF, EMAIL_CHU] } }] },
  });
}

async function taoStaff(data: {
  sessionEpoch?: string;
  isActive?: boolean;
  quyen?: string[];
  mustChangePassword?: boolean;
}) {
  return prisma.user.create({
    data: {
      email: EMAIL_STAFF,
      passwordHash: "khong-dung",
      role: "STAFF",
      tenHienThi: "Nhân viên kho",
      sessionEpoch: data.sessionEpoch ?? "0",
      isActive: data.isActive ?? true,
      quyen: data.quyen ?? ["don-hang:xem"],
      mustChangePassword: data.mustChangePassword ?? false,
    },
  });
}

beforeEach(donUser);

afterAll(async () => {
  await donUser();
  await prisma.$disconnect();
});

describe("kiemPhien", () => {
  it("không có userId ⇒ null, không hỏi DB", async () => {
    expect(await kiemPhien({})).toBeNull();
  });

  it("epoch cookie khớp User.sessionEpoch ⇒ trả NguoiDung đầy đủ", async () => {
    const u = await taoStaff({ sessionEpoch: "a".repeat(32), mustChangePassword: true });

    const nd = await kiemPhien({ userId: u.id, mocPhien: "a".repeat(32) });

    expect(nd).not.toBeNull();
    expect(nd).toMatchObject({
      id: u.id,
      email: EMAIL_STAFF,
      tenHienThi: "Nhân viên kho",
      role: "STAFF",
      phaiDoiMatKhau: true,
      mocPhien: "a".repeat(32),
    });
    expect([...nd!.quyen]).toEqual(["don-hang:xem"]);
  });

  it("epoch lệch (đã bị thu hồi) ⇒ null", async () => {
    const u = await taoStaff({ sessionEpoch: "b".repeat(32) });
    expect(await kiemPhien({ userId: u.id, mocPhien: "a".repeat(32) })).toBeNull();
  });

  it("tài khoản bị khoá (isActive=false) ⇒ null dù epoch khớp", async () => {
    const u = await taoStaff({ isActive: false });
    expect(await kiemPhien({ userId: u.id, mocPhien: "0" })).toBeNull();
  });

  it("user đã xoá ⇒ null, không ném", async () => {
    const u = await taoStaff({});
    await prisma.user.delete({ where: { id: u.id } });
    expect(await kiemPhien({ userId: u.id, mocPhien: "0" })).toBeNull();
  });

  it("cookie đời cũ (không mocPhien) + DB '0' ⇒ vào được", async () => {
    const u = await taoStaff({ sessionEpoch: "0" });
    expect((await kiemPhien({ userId: u.id }))?.id).toBe(u.id);
  });

  it("cookie đời cũ (không mocPhien) + DB đã thu hồi ⇒ null (không hồi sinh)", async () => {
    const u = await taoStaff({ sessionEpoch: "abc" });
    expect(await kiemPhien({ userId: u.id })).toBeNull();
  });

  it("mã quyền lạ trong DB bị bỏ, không ném", async () => {
    const u = await taoStaff({ quyen: ["la:xem", "don-hang:xem"] });
    const nd = await kiemPhien({ userId: u.id, mocPhien: "0" });
    expect([...nd!.quyen]).toEqual(["don-hang:xem"]);
  });

  it("tổ hợp lệch do sửa tay (Lãi/Lỗ thiếu giá vốn) ⇒ bỏ Lãi/Lỗ, giữ phần còn lại", async () => {
    const u = await taoStaff({ quyen: ["tai-chinh-loi-lo:xem", "chi-phi:sua"] });
    const nd = await kiemPhien({ userId: u.id, mocPhien: "0" });
    expect(nd).not.toBeNull();
    expect(coQuyen(nd!, "tai-chinh-loi-lo:xem")).toBe(false);
    expect(coQuyen(nd!, "chi-phi:sua")).toBe(true);
    expect(coQuyen(nd!, "chi-phi:xem")).toBe(true); // sua kéo theo xem
  });
});

describe("coQuyen / laChuShop", () => {
  it("OWNER với quyen=[] ⇒ coQuyen luôn true, laChuShop true", async () => {
    const chu = await prisma.user.create({
      data: { email: EMAIL_CHU, passwordHash: "khong-dung", role: "OWNER", quyen: [] },
    });
    const nd = await kiemPhien({ userId: chu.id, mocPhien: "0" });

    expect(nd).not.toBeNull();
    expect(nd!.quyen.size).toBe(0);
    expect(coQuyen(nd!, "chi-phi:sua")).toBe(true);
    expect(coQuyen(nd!, "gia-von-loi-nhuan:xem")).toBe(true);
    expect(laChuShop(nd!)).toBe(true);
  });

  it("STAFF chỉ có đúng quyền được cấp; không phải chủ shop", async () => {
    const u = await taoStaff({ quyen: ["don-hang:xem"] });
    const nd = await kiemPhien({ userId: u.id, mocPhien: "0" });

    expect(coQuyen(nd!, "don-hang:xem")).toBe(true);
    expect(coQuyen(nd!, "chi-phi:xem")).toBe(false);
    expect(laChuShop(nd!)).toBe(false);
  });
});
