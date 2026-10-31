/**
 * Lưới phụ cấp op trên singleton `prisma` THẬT: cờ phục hồi bật, op GHI không mang ngữ cảnh cửa ⇒
 * NÉM `LoiCongGhiDangKhoa`, DB không đổi; op ĐỌC vẫn chạy. Request vào TRƯỚC cờ vẫn ghi xong.
 * Phân loại fail-closed: op model lạ / raw không chắc chỉ-đọc = ghi.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { laSqlChiDoc, laLoiCongGhiDangKhoa, routeQuaCua } from "@/lib/backup/cong-ghi-toan-cuc";
import { prisma } from "@/lib/prisma";

import { anhDuLieu, batCo, chayGocRieng, datLaiCongGhi, doiChieu, donDuLieu, k, taoBarrier, traCoNeuCon } from "./cong-ghi-helpers";

beforeEach(async () => {
  await donDuLieu();
  await doiChieu.setting.createMany({ data: [{ key: k("a"), value: "1" }, { key: k("b"), value: "2" }] });
});
afterEach(() => datLaiCongGhi());
afterAll(async () => {
  await donDuLieu();
  await doiChieu.$disconnect();
});

type Op = [string, () => Promise<unknown>];

const OP_ORM: Op[] = [
  ["create", () => prisma.setting.create({ data: { key: k("c"), value: "x" } })],
  ["createMany", () => prisma.setting.createMany({ data: [{ key: k("c"), value: "x" }] })],
  ["createManyAndReturn", () => prisma.setting.createManyAndReturn({ data: [{ key: k("c"), value: "x" }] })],
  ["update", () => prisma.setting.update({ where: { key: k("a") }, data: { value: "9" } })],
  ["updateMany", () => prisma.setting.updateMany({ where: { key: k("a") }, data: { value: "9" } })],
  ["updateManyAndReturn", () => prisma.setting.updateManyAndReturn({ where: { key: k("a") }, data: { value: "9" } })],
  ["upsert", () => prisma.setting.upsert({ where: { key: k("a") }, create: { key: k("a"), value: "9" }, update: { value: "9" } })],
  ["delete", () => prisma.setting.delete({ where: { key: k("a") } })],
  ["deleteMany", () => prisma.setting.deleteMany({ where: { key: k("a") } })],
];

/** Khuôn `landRaw`: INSERT…SELECT…ON CONFLICT…RETURNING qua `$queryRawUnsafe`. */
const SQL_LAND = `
  INSERT INTO "Setting" (key, value)
  SELECT $1 || (elem->>'id'), md5(elem::text)
  FROM jsonb_array_elements($2::jsonb) AS elem
  WHERE elem->>'id' IS NOT NULL
  ON CONFLICT (key) DO NOTHING
  RETURNING key`;

const OP_RAW: Op[] = [
  ["$executeRaw", () => prisma.$executeRaw`INSERT INTO "Setting" (key, value) VALUES (${k("r1")}, 'x')`],
  ["$executeRawUnsafe", () => prisma.$executeRawUnsafe(`UPDATE "Setting" SET value = $1 WHERE key = $2`, "9", k("a"))],
  ["$queryRawUnsafe INSERT…RETURNING", () => prisma.$queryRawUnsafe(SQL_LAND, k("land:"), JSON.stringify([{ id: "1" }]))],
  ["$queryRaw CTE WITH…INSERT", () => prisma.$queryRaw`WITH x AS (INSERT INTO "Setting" (key, value) VALUES (${k("cte")}, 'x') RETURNING key) SELECT key FROM x`],
  ["$queryRaw SELECT … FOR UPDATE", () => prisma.$queryRaw`SELECT key FROM "Setting" WHERE key = ${k("a")} FOR UPDATE`],
  ["$queryRaw SELECT pg_advisory_xact_lock", () => prisma.$queryRaw`SELECT pg_advisory_xact_lock(1)::text AS x`],
];

describe("op ORM autocommit", () => {
  it.each(OP_ORM)("%s: cờ bật, ngoài cửa ⇒ ném, DB không đổi", async (_ten, chay) => {
    const truoc = await anhDuLieu();
    batCo();
    await expect(chay()).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    traCoNeuCon();
    expect(await anhDuLieu()).toEqual(truoc);
  });

  it("op đọc vẫn chạy khi cờ bật", async () => {
    batCo();
    expect(await prisma.setting.count({ where: { key: { startsWith: k("") } } })).toBe(2);
    expect(await prisma.setting.findMany({ where: { key: { startsWith: k("") } } })).toHaveLength(2);
    expect(await prisma.setting.findUnique({ where: { key: k("a") } })).not.toBeNull();
  });

  it("cờ tắt ⇒ mọi op ghi chạy bình thường", async () => {
    for (const [, chay] of OP_ORM) {
      await doiChieu.setting.upsert({ where: { key: k("a") }, create: { key: k("a"), value: "1" }, update: {} });
      await doiChieu.setting.deleteMany({ where: { key: k("c") } });
      await chay();
    }
  });

  it("request vào TRƯỚC cờ vẫn ghi xong sau khi cờ bật", async () => {
    const b = taoBarrier();
    const req = chayGocRieng(() =>
      routeQuaCua(async () => {
        await b.cho();
        await prisma.setting.create({ data: { key: k("sau-co"), value: "x" } });
        await prisma.$executeRaw`UPDATE "Setting" SET value = 'y' WHERE key = ${k("sau-co")}`;
        return new Response("ok");
      }),
    );
    await b.daToi;
    batCo();
    b.mo();
    expect((await req).status).toBe(200);
    expect(await anhDuLieu()).toContain(`${k("sau-co")}=y`);
  });
});

describe("op raw", () => {
  it.each(OP_RAW)("%s: cờ bật, ngoài cửa ⇒ ném, DB không đổi", async (_ten, chay) => {
    const truoc = await anhDuLieu();
    batCo();
    await expect(chay()).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    traCoNeuCon();
    expect(await anhDuLieu()).toEqual(truoc);
  });

  it("SELECT raw (tagged + unsafe + WITH) vẫn trả kết quả khi cờ bật", async () => {
    batCo();
    const a = await prisma.$queryRaw<{ key: string }[]>`SELECT key FROM "Setting" WHERE key LIKE ${k("%")} ORDER BY key`;
    expect(a.map((r) => r.key)).toEqual([k("a"), k("b")]);
    const b = await prisma.$queryRawUnsafe<{ n: number }[]>(`/* đọc */ SELECT count(*)::int AS n FROM "Setting" WHERE key LIKE $1`, k("%"));
    expect(b[0].n).toBe(2);
    const c = await prisma.$queryRaw<{ n: number }[]>`WITH t AS (SELECT key FROM "Setting" WHERE key LIKE ${k("%")}) SELECT count(*)::int AS n FROM t`;
    expect(c[0].n).toBe(2);
  });

  it("cờ tắt ⇒ khuôn landRaw chạy và trả RETURNING", async () => {
    const r = await prisma.$queryRawUnsafe<{ key: string }[]>(SQL_LAND, k("land:"), JSON.stringify([{ id: "1" }, { id: "2" }]));
    expect(r.map((x) => x.key).sort()).toEqual([k("land:1"), k("land:2")]);
  });

  it("phân loại SQL fail-closed", () => {
    expect(laSqlChiDoc("SELECT 1")).toBe(true);
    expect(laSqlChiDoc("  -- c\n with a as (select 1) select * from a")).toBe(true);
    expect(laSqlChiDoc("WITH a AS (DELETE FROM x RETURNING 1) SELECT * FROM a")).toBe(false);
    expect(laSqlChiDoc("INSERT INTO x VALUES (1)")).toBe(false);
    expect(laSqlChiDoc("SELECT nextval('s')")).toBe(false);
    expect(laSqlChiDoc("SELECT pg_try_advisory_lock_shared(1)")).toBe(false);
    expect(laSqlChiDoc("VALUES (1)")).toBe(false);
  });
});
