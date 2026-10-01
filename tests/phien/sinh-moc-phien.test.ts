import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { sinhMocPhien, thuHoiMoiPhienMoiNguoi, thuHoiPhienCuaNguoi } from "@/lib/session";

/**
 * Epoch phiên theo TỪNG NGƯỜI — luôn ngẫu nhiên mật mã, đúng 32 hex, qua hai đường:
 *  - một người (Node): `randomBytes(16)`;
 *  - hàng loạt (SQL, sau phục hồi): `replace(gen_random_uuid()::text,'-','')` — hàm LÕI Postgres ≥ 13,
 *    không cần extension (role app không tạo được `pgcrypto`). Ca preflight chạy bằng đúng URL test.
 */
const HEX32 = /^[0-9a-f]{32}$/;
const EMAIL_A = "a@sinh-moc-phien.test";
const EMAIL_B = "b@sinh-moc-phien.test";
const EMAIL_CHU = "chu@sinh-moc-phien.test";

async function donUser(): Promise<void> {
  // Xoá cả OWNER sót từ suite khác: DB chỉ cho MỘT OWNER (partial unique `User_owner_duy_nhat`).
  await prisma.user.deleteMany({ where: { OR: [{ role: "OWNER" }, { email: { in: [EMAIL_A, EMAIL_B, EMAIL_CHU] } }] } });
}

beforeEach(donUser);

afterAll(async () => {
  await donUser();
  await prisma.$disconnect();
});

describe("sinhMocPhien", () => {
  it("32 hex, 100 lượt không trùng", () => {
    const tap = new Set(Array.from({ length: 100 }, () => sinhMocPhien()));
    expect(tap.size).toBe(100);
    for (const m of tap) expect(m).toMatch(HEX32);
  });
});

describe("thuHoiPhienCuaNguoi", () => {
  it("ghi epoch mới đúng dòng người đó và trả ra giá trị đã ghi", async () => {
    const a = await prisma.user.create({ data: { email: EMAIL_A, passwordHash: "x" } });
    const b = await prisma.user.create({ data: { email: EMAIL_B, passwordHash: "x" } });

    const moc = await prisma.$transaction((tx) => thuHoiPhienCuaNguoi(tx, a.id));

    expect(moc).toMatch(HEX32);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).sessionEpoch).toBe(moc);
    // Người khác KHÔNG bị đá ra.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).sessionEpoch).toBe("0");
  });

  it("kiểu: chỉ nhận client transaction — client gốc bị chặn lúc biên dịch (`tsc --noEmit`)", () => {
    // Không gọi thật: chỉ để `tsc` kiểm dòng `@ts-expect-error` (bỏ kiểu chặn ⇒ tsc báo "unused directive").
    const khongGoi = () =>
      // @ts-expect-error — `PrismaClient` gốc có `$connect`, không phải client trong transaction.
      thuHoiPhienCuaNguoi(prisma, "x");
    expect(typeof khongGoi).toBe("function");
  });

  it("chạy trong transaction của người gọi: rollback ⇒ epoch không đổi", async () => {
    const a = await prisma.user.create({ data: { email: EMAIL_A, passwordHash: "x" } });
    await expect(
      prisma.$transaction(async (tx) => {
        await thuHoiPhienCuaNguoi(tx, a.id);
        throw new Error("huỷ");
      }),
    ).rejects.toThrow("huỷ");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).sessionEpoch).toBe("0");
  });
});

describe("thuHoiMoiPhienMoiNguoi", () => {
  it("preflight: gen_random_uuid() là hàm lõi, chạy được bằng role/URL test, ra 32 hex", async () => {
    let rows: { moc: string }[];
    try {
      rows = await prisma.$queryRaw<{ moc: string }[]>`SELECT replace(gen_random_uuid()::text, '-', '') AS moc`;
    } catch (e) {
      throw new Error(
        `Postgres không có gen_random_uuid() (cần PG ≥ 13) — thu hồi phiên hàng loạt sau phục hồi sẽ hỏng: ${String(e)}`,
      );
    }
    expect(rows[0]?.moc).toMatch(HEX32);
  });

  it("mỗi người một epoch mới, khác nhau, khác giá trị cũ — KỂ CẢ chủ shop (OWNER)", async () => {
    // Chủ shop là tài khoản quan trọng nhất: sau phục hồi, cookie chủ shop cấp từ đời bản backup (kể
    // cả cookie đã bị thu hồi TRƯỚC lúc chụp) phải chết như mọi người. Lọc `WHERE role = 'STAFF'` là đỏ.
    const epochChuCu = "c".repeat(32);
    const chu = await prisma.user.create({
      data: { email: EMAIL_CHU, passwordHash: "x", role: "OWNER", sessionEpoch: epochChuCu },
    });
    const a = await prisma.user.create({ data: { email: EMAIL_A, passwordHash: "x" } });
    const b = await prisma.user.create({ data: { email: EMAIL_B, passwordHash: "x", sessionEpoch: "cu" } });

    await thuHoiMoiPhienMoiNguoi();

    const [mc, ma, mb] = await Promise.all(
      [chu.id, a.id, b.id].map(async (id) => (await prisma.user.findUniqueOrThrow({ where: { id } })).sessionEpoch),
    );
    expect(mc).toMatch(HEX32);
    expect(mc).not.toBe(epochChuCu);
    expect(ma).toMatch(HEX32);
    expect(mb).toMatch(HEX32);
    expect(new Set([mc, ma, mb]).size).toBe(3);
  });
});
