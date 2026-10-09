import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

/**
 * Bốn ràng buộc thêm vào migration `20261008094601` SAU khi bản đầu đã áp lên `hogikids_test` (đồng bộ
 * tay + chữa checksum — `docs/chuan-code-va-quy-trinh-dev.md` §3). Test này chứng minh DB test THẬT có
 * đủ chúng: suite `tests/migration/no-phai-tra-check.test.ts` chỉ chạy được ở CI (DB dùng-một-lần).
 *
 * Mỗi ca chạy trong MỘT transaction — Postgres từ chối ⇒ rollback trọn, không để dòng nào lại DB.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

/** Ném sau khi ghi đúng ⇒ transaction rollback; phân biệt được với lỗi ràng buộc. */
class RollbackChuDich extends Error {}

describe("DB test có đủ CHECK không âm + một neo mở sổ mỗi thẻ", () => {
  it("PhieuNhapNo tongTien −1 bị từ chối", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "PhieuNhapNo" ("id", "refId", "shopId", "maPhieu", "ngayPhieu", "tongTien")
          VALUES ('ck-p1-phieu', 'ck-p1:1', '714995134', 'PN', now(), -1)`;
      }),
    ).rejects.toThrow(/PhieuNhapNo_tien_khong_am/);
  });

  it("KySaoKeThe daTraTruocMoSo −1 bị từ chối", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "TheTinDung" ("id", "ten", "ngayChotSaoKe", "ngayHanTra") VALUES ('ck-p1-the', 'Thẻ', 20, 5)`;
        await tx.$executeRaw`INSERT INTO "KySaoKeThe" ("id", "cardId", "ngayChot", "soDu", "hanTra", "daTraTruocMoSo")
          VALUES ('ck-p1-ky', 'ck-p1-the', '2026-09-20', 1, '2026-10-05', -1)`;
      }),
    ).rejects.toThrow(/KySaoKeThe_da_tra_truoc_khong_am/);
  });

  it("ViAdsTraTruoc soDuNeo −1 bị từ chối", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "ViAdsTraTruoc" ("id", "nenTang", "soDuNeo", "ngayNeo") VALUES ('ck-p1-vi', 'CK_P1', -1, now())`;
      }),
    ).rejects.toThrow(/ViAdsTraTruoc_so_du_neo_khong_am/);
  });

  it("neo mở sổ thứ hai của cùng thẻ bị từ chối; neo đầu + sao kê thật cùng thẻ thì ghi được", async () => {
    // Đối chứng: một neo + một sao kê thật cùng thẻ qua hết ràng buộc (rollback chủ đích).
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "TheTinDung" ("id", "ten", "ngayChotSaoKe", "ngayHanTra") VALUES ('ck-p1-the', 'Thẻ', 20, 5)`;
        await tx.$executeRaw`INSERT INTO "KySaoKeThe" ("id", "cardId", "ngayChot", "soDu", "laNeoMoSo")
          VALUES ('ck-p1-neo1', 'ck-p1-the', '2026-09-30', 0, true)`;
        await tx.$executeRaw`INSERT INTO "KySaoKeThe" ("id", "cardId", "ngayChot", "soDu", "hanTra")
          VALUES ('ck-p1-ky', 'ck-p1-the', '2026-10-20', 1000000, '2026-11-05')`;
        throw new RollbackChuDich();
      }),
    ).rejects.toBeInstanceOf(RollbackChuDich);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "TheTinDung" ("id", "ten", "ngayChotSaoKe", "ngayHanTra") VALUES ('ck-p1-the', 'Thẻ', 20, 5)`;
        await tx.$executeRaw`INSERT INTO "KySaoKeThe" ("id", "cardId", "ngayChot", "soDu", "laNeoMoSo")
          VALUES ('ck-p1-neo1', 'ck-p1-the', '2026-09-30', 0, true)`;
        await tx.$executeRaw`INSERT INTO "KySaoKeThe" ("id", "cardId", "ngayChot", "soDu", "laNeoMoSo")
          VALUES ('ck-p1-neo2', 'ck-p1-the', '2026-08-31', 0, true)`;
      }),
    ).rejects.toThrow(/KySaoKeThe_mot_neo_mo_so_moi_the/);

    expect(await prisma.theTinDung.count({ where: { id: "ck-p1-the" } })).toBe(0);
  });
});
