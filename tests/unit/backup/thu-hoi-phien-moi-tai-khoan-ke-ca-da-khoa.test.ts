import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { thuHoiMoiPhienMoiNguoi } from "@/lib/session";

/**
 * Thu hồi phiên sau phục hồi (đường app) đổi epoch của MỌI tài khoản — kể cả tài khoản ĐANG BỊ KHOÁ.
 *
 * Bỏ sót dòng đã khoá (`WHERE "isActive"`) thì tài khoản đó giữ epoch đời bản sao lưu; chủ shop mở khoá
 * về sau là cookie cấp trong đời bản sao lưu SỐNG LẠI. Chạy trên Postgres thật (câu SQL là thứ cần đo),
 * TRONG một transaction luôn lùi ⇒ không để lại dòng nào, không đổi epoch của dữ liệu test khác.
 */
class LuiGiaoDich extends Error {}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("thuHoiMoiPhienMoiNguoi — mọi dòng User, không lọc trạng thái", () => {
  it("đổi epoch cả tài khoản đang hoạt động lẫn đã khoá, mỗi dòng một giá trị 32 hex", async () => {
    let ketQua: { id: string; sessionEpoch: string }[] = [];
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.createMany({
          data: [
            { id: "thp-dang-mo", email: "thp-dang-mo@hogikids.test", passwordHash: "x:y", sessionEpoch: "epoch-cu-mo" },
            {
              id: "thp-da-khoa",
              email: "thp-da-khoa@hogikids.test",
              passwordHash: "x:y",
              sessionEpoch: "epoch-cu-khoa",
              isActive: false,
            },
          ],
        });
        await thuHoiMoiPhienMoiNguoi(tx);
        ketQua = await tx.user.findMany({
          where: { id: { in: ["thp-dang-mo", "thp-da-khoa"] } },
          select: { id: true, sessionEpoch: true },
          orderBy: { id: "asc" },
        });
        throw new LuiGiaoDich();
      }),
    ).rejects.toBeInstanceOf(LuiGiaoDich);

    expect(ketQua.map((u) => u.id)).toEqual(["thp-da-khoa", "thp-dang-mo"]);
    for (const u of ketQua) expect(u.sessionEpoch, u.id).toMatch(/^[0-9a-f]{32}$/);
    expect(ketQua[0].sessionEpoch).not.toBe(ketQua[1].sessionEpoch);
    expect(await prisma.user.count({ where: { id: { in: ["thp-dang-mo", "thp-da-khoa"] } } })).toBe(0);
  });
});
