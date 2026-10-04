import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import {
  KEY_META_ACCESS_TOKEN,
  KEY_META_DATA_EXPIRE_AT,
  KEY_META_EXPIRE_AT,
  KEY_META_SAVED_AT,
  luuTokenMetaVaoKho,
} from "@/lib/tokens/luu-token-meta";

/**
 * Lưu 4 key token Meta + nhật ký thao tác là MỘT transaction (DB test thật): callback ghi-thêm ném
 * ⇒ 4 key giữ nguyên giá trị cũ; thành công ⇒ 4 key mới + đúng 1 dòng nhật ký.
 */
const KEYS = [KEY_META_ACCESS_TOKEN, KEY_META_EXPIRE_AT, KEY_META_DATA_EXPIRE_AT, KEY_META_SAVED_AT];
const TOKEN_CU = { accessToken: "token-cu", expireAt: 111, dataAccessExpireAt: 222 };
const TOKEN_MOI = { accessToken: "token-moi", expireAt: 333, dataAccessExpireAt: 444 };
const ACTOR = { id: "actor-token-meta", email: "chu@hogikids.test" };

const docKho = async () =>
  Object.fromEntries((await prisma.setting.findMany({ where: { key: { in: KEYS } } })).map((r) => [r.key, r.value]));
const dem = () => prisma.auditLog.count({ where: { hanhDong: HANH_DONG.KHOA_KET_NOI_THAY_META, actorId: ACTOR.id } });

async function don() {
  await prisma.setting.deleteMany({ where: { key: { in: KEYS } } });
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR.id } });
}

beforeAll(don, 60_000);
beforeEach(async () => {
  await don();
  await luuTokenMetaVaoKho(TOKEN_CU); // trạng thái cũ để đo rollback
});
afterAll(async () => {
  await don();
  await prisma.$disconnect();
});

describe("luuTokenMetaVaoKho + ghiThemTrongTx", () => {
  it("callback ném ⇒ rollback: 4 key giữ giá trị cũ, không có dòng nhật ký", async () => {
    const truoc = await docKho();
    await expect(
      luuTokenMetaVaoKho(TOKEN_MOI, async (tx) => {
        await ghiNhatKy(tx, { actor: ACTOR, hanhDong: HANH_DONG.KHOA_KET_NOI_THAY_META });
        throw new Error("ghi nhật ký hỏng");
      }),
    ).rejects.toThrow("ghi nhật ký hỏng");

    expect(await docKho()).toEqual(truoc);
    expect(truoc[KEY_META_ACCESS_TOKEN]).toBe("token-cu");
    expect(await dem()).toBe(0);
  });

  it("callback thành công ⇒ 4 key mới + đúng 1 dòng nhật ký", async () => {
    const savedAt = await luuTokenMetaVaoKho(TOKEN_MOI, (tx) =>
      ghiNhatKy(tx, { actor: ACTOR, hanhDong: HANH_DONG.KHOA_KET_NOI_THAY_META }),
    );

    expect(await docKho()).toEqual({
      [KEY_META_ACCESS_TOKEN]: "token-moi",
      [KEY_META_EXPIRE_AT]: "333",
      [KEY_META_DATA_EXPIRE_AT]: "444",
      [KEY_META_SAVED_AT]: String(savedAt),
    });
    expect(await dem()).toBe(1);
  });

  it("không truyền callback (route ingest) ⇒ vẫn ghi đủ 4 key", async () => {
    await luuTokenMetaVaoKho(TOKEN_MOI);
    expect((await docKho())[KEY_META_ACCESS_TOKEN]).toBe("token-moi");
  });
});
