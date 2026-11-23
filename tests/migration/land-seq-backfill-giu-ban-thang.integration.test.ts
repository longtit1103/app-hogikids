import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { kiemNguonAnh, soAnhDiSan } from "@/lib/bronze/anh-di-san-moc-land-don";
import { demKhopMocLandDon } from "@/lib/bronze/dem-khop-moc-land-don";
import { NOI_MOC_PHIEN_BAN_DON_SQL, THU_TU_PHIEN_BAN_DON_SQL } from "@/lib/bronze/thu-tu-phien-ban-don";

import { soLandSeq, THU_TU_PHIEN_BAN_DON_CU_SQL, tinhChecksumDon } from "../helpers/checksum-don-pancake";
import { ketNoiPsql } from "../helpers/ket-noi-psql-khong-lo-mat-khau";
import {
  apMigrations,
  danhDauMigrationDaCuonLai,
  type DbMigration,
  lechSchemaVoiDb,
  moDbMigration,
  saoThuMucMigrations,
  xoaThuMucMigrationsTam,
} from "../helpers/db-migration-dung-mot-lan";

/**
 * Migration đánh số land `RawPancakeOrder.landSeq` + `Order.rawLandSeq` chạy bằng `prisma migrate deploy` THẬT trên DB
 * dùng-một-lần: dữ liệu có nhóm trùng `fetchedAt` với uuid NGƯỢC thứ tự land, chèn theo thứ tự vật lý khác
 * `(fetchedAt, id)`. Sau migration:
 *  - bản đứng đầu mỗi đơn GIỐNG HỆT trước (thứ tự cũ trước = thứ tự mới sau) — giữ hiện trạng, không "sửa" sang bản
 *    land sau;
 *  - C1 nghiệp vụ, C2 payload, C3 kết cục, C4 metadata cũ BẰNG nhau; chỉ thêm `landSeq`/`rawLandSeq`;
 *  - `landSeq` = thứ hạng theo `(fetchedAt, id)`; `rawLandSeq` chỉ điền khi khớp ĐÚNG MỘT dòng;
 *  - sequence trỏ đúng max, lượt chèn sau nhận max + 1; schema DB khớp `schema.prisma` (diff rỗng).
 * Ca biên: bảng rỗng ⇒ dòng đầu tiên nhận 1. Dữ liệu MƠ HỒ (đơn khớp ≥ 2 dòng cùng mốc) ⇒ migration tự dừng, cuộn lại
 * TOÀN BỘ. Đang có phiên giữ khoá bảng ⇒ hết `lock_timeout` thì dừng nhanh, cũng cuộn lại. Bước kiểm chỉ-đọc
 * `demKhopMocLandDon` (script `scripts/dem-khop-moc-land-don-pancake.ts`) ra đúng ba số trước và sau migrate.
 */

const MIG = "20261106150000_raw_pancake_order_land_seq";
const HAN = 240_000;
const SHOP = "1942992175";

let db: DbMigration;
const thuMucTam: string[] = [];
const thuMuc = (p: Parameters<typeof saoThuMucMigrations>[0] = {}) => {
  const d = saoThuMucMigrations(p);
  thuMucTam.push(d);
  return d;
};

/**
 * Dòng kho thô: [id, externalId, fetchedAt, updated_at | null, status, shopId]. Thứ tự mảng = thứ tự chèn vật lý, CỐ Ý
 * khác `(fetchedAt, id)` trong mọi nhóm trùng — đánh số theo thứ tự quét vật lý (BIGSERIAL Prisma sinh) là lật bản thắng.
 */
const BRONZE: [string, string, string, string | null, number, string][] = [
  // G1 trùng mốc 2 dòng: bản land TRƯỚC mang id lớn (đang thắng theo `id DESC`) — phải VẪN thắng sau migration.
  ["ffffffff-ffff-4fff-bfff-ffffffffffg1", "G1", "2026-07-01 10:00:00.123", null, 3, SHOP],
  ["00000000-0000-4000-8000-0000000000g1", "G1", "2026-07-01 10:00:00.123", null, 4, SHOP],
  // G2 trùng mốc 3 dòng, chèn lộn xộn.
  ["cccccccc-0000-4000-8000-0000000000g2", "G2", "2026-07-01 11:00:00.500", null, 3, SHOP],
  ["88888888-0000-4000-8000-0000000000g2", "G2", "2026-07-01 11:00:00.500", null, 2, SHOP],
  ["11111111-0000-4000-8000-0000000000g2", "G2", "2026-07-01 11:00:00.500", null, 4, SHOP],
  // G3 không trùng: bản cũ id lớn, bản mới id nhỏ — fetchedAt quyết. Chèn bản MỚI trước (thứ tự vật lý ngược).
  ["00000000-0000-4000-8000-0000000000g3", "G3", "2026-07-02 09:00:00.000", null, 4, SHOP],
  ["ffffffff-0000-4000-8000-0000000000g3", "G3", "2026-07-01 09:00:00.000", null, 3, SHOP],
  // G4 updated_at quyết: bản land sớm nội dung mới hơn.
  ["aaaaaaaa-0000-4000-8000-0000000000g4", "G4", "2026-07-03 08:00:00.000", "2026-07-01T05:00:00", 3, SHOP],
  ["bbbbbbbb-0000-4000-8000-0000000000g4", "G4", "2026-07-02 08:00:00.000", "2026-07-01T06:00:00", 4, SHOP],
  // Đơn lẻ + bản sao kho.
  ["dddddddd-0000-4000-8000-0000000000s1", "S1", "2026-07-04 08:00:00.000", null, 3, SHOP],
  ["eeeeeeee-0000-4000-8000-0000000000m1", "AF1942992175O55", "2026-07-04 09:00:00.000", null, 3, "714995134"],
];

/** Đơn Silver: [pancakeId, rawFetchedAt | null, shop_id trong raw, backfilledFromMirror]. */
const SILVER: [string, string | null, string, boolean][] = [
  ["G3", "2026-07-02 09:00:00.000", SHOP, false], // khớp ĐÚNG MỘT dòng ⇒ điền số
  ["S1", "2026-07-04 08:00:00.000", SHOP, false], // khớp một ⇒ điền
  ["G1", "2026-07-01 10:00:00.999", SHOP, false], // mốc không khớp dòng nào ⇒ NULL
  ["G2", null, SHOP, false], // không mốc ⇒ NULL (ca MƠ HỒ: đặt mốc = mốc chung của nhóm G2 — xem `chenDuLieuMau`)
  ["G4", "2026-07-05 00:00:00.000", SHOP, false], // mốc không khớp dòng nào ⇒ NULL
  // Đơn bù từ bản sao kho — ĐÚNG hình dạng `scripts/bu-don-shopee-tu-don-kho.ts` ghi: `pancakeId` = id dòng mirror,
  // `raw.shop_id` = shop kho, `rawFetchedAt` = `fetchedAt` dòng mirror ⇒ khớp dòng mirror ⇒ điền số của dòng đó.
  ["AF1942992175O55", "2026-07-04 09:00:00.000", "714995134", true],
];

/** Mốc chung của nhóm trùng 3 dòng G2 — gán cho đơn G2 là tạo đúng một đơn MƠ HỒ. */
const MOC_G2 = "2026-07-01 11:00:00.500";

/** Bản public loại runbook (`deploy/*.md`) — ca đọc runbook chỉ chạy khi có file (repo private luôn có). */
const CO_RUNBOOK = existsSync(path.resolve(process.cwd(), "deploy/huong-dan-trien-khai-minipc.md"));

/**
 * Lệnh XÁC NHẬN cuộn lại CHÉP NGUYÊN VĂN từ runbook (`deploy/huong-dan-trien-khai-minipc.md` ③a-6): bỏ `#` đầu dòng, GIỮ
 * `\` nối dòng — đúng chữ người vận hành gõ (kể cả `; echo "ma=$?"`).
 */
function lenhXacNhanCuonLaiTrongRunbook(): string {
  const rb = readFileSync(path.resolve(process.cwd(), "deploy/huong-dan-trien-khai-minipc.md"), "utf8");
  const dau = rb.indexOf("XÁC NHẬN transaction đã cuộn lại");
  const cuoi = rb.indexOf("Ra BẤT KỲ kết quả nào khác `0|0|failed`", dau);
  expect(dau).toBeGreaterThan(0);
  expect(cuoi).toBeGreaterThan(dau);
  const dong = rb.slice(dau, cuoi).split("\n").map((d) => d.replace(/^#\s*/, ""));
  const batDau = dong.findIndex((d) => d.startsWith("docker exec supabase-db psql "));
  if (batDau < 0) throw new Error("không tìm thấy lệnh xác nhận trong runbook");
  return dong.slice(batDau).join("\n").trim();
}

/** Phần SELECT của lệnh xác nhận (trong `BEGIN TRANSACTION READ ONLY; …; ROLLBACK` — chỉ đọc, có trần thời gian). */
function cauXacNhanCuonLaiTrongRunbook(): string {
  const khoi = lenhXacNhanCuonLaiTrongRunbook()
    .split("\n")
    .map((d) => d.replace(/\\\s*$/, ""))
    .join(" ");
  const m = khoi.match(
    /-c "BEGIN TRANSACTION\s+READ ONLY; SET LOCAL statement_timeout = '10s'; (SELECT[\s\S]*?); ROLLBACK"; echo "ma=\$\?"$/,
  );
  if (!m) throw new Error("lệnh xác nhận trong runbook không đúng dạng chỉ-đọc + in mã thoát");
  return m[1];
}

/** Chạy NGUYÊN VĂN lệnh shell của runbook, chỉ thay đầu `docker exec … psql` bằng psql local trỏ DB test. */
function chayLenhXacNhanNguyenVan(url: string): string {
  // Mật khẩu (nếu có) CHỈ qua env riêng của tiến trình con — chuỗi lệnh chỉ mang URL không mật khẩu.
  const kn = ketNoiPsql(url);
  const lenh = lenhXacNhanCuonLaiTrongRunbook().replace(
    "docker exec supabase-db psql -U supabase_admin -d postgres",
    `psql -d '${kn.urlKhongMatKhau}'`,
  );
  expect(lenh.startsWith("psql -d ")).toBe(true);
  const r = spawnSync("bash", ["-c", lenh], { encoding: "utf8", env: { ...process.env, ...kn.env } });
  return r.stdout;
}

/** Chạy câu xác nhận; ba cột không tên ⇒ gói thành một dòng văn bản để không mất cột trùng tên `?column?`. */
const ketQuaXacNhan = async (sql: string) =>
  (await db.prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT t::text AS t FROM (${sql}) t`)).map((r) => r.t);

async function chenDuLieuMau(o: { moHo?: boolean } = {}): Promise<void> {
  const p = db.prisma;
  await p.$executeRawUnsafe(
    `INSERT INTO "Channel" (id, name, color, "sortOrder") VALUES ('shopee', 'Shopee', '#f60', 1) ON CONFLICT DO NOTHING`,
  );
  for (const [id, ext, f, u, status, shop] of BRONZE) {
    const payload = JSON.stringify({ id: ext, status, shop_id: Number(shop), ...(u ? { updated_at: u } : {}) });
    await p.$executeRawUnsafe(
      `INSERT INTO "RawPancakeOrder" (id, "shopId", "externalId", "payloadHash", payload, "fetchedAt", "silverOutcome")
       VALUES ($1, $2, $3, md5($4), $4::jsonb, $5::timestamp, $6)`,
      id, shop, ext, payload, f, status === 4 ? "APPLIED" : null,
    );
  }
  for (const [pancakeId, mocLuu, shop, mirror] of SILVER) {
    const rawFetchedAt = o.moHo && pancakeId === "G2" ? MOC_G2 : mocLuu;
    await p.$executeRawUnsafe(
      `INSERT INTO "Order" (id, "pancakeId", code, "channelId", status, "orderedAt", "syncedAt", raw, "rawFetchedAt",
         "itemsTotal", "backfilledFromMirror")
       VALUES ('o-' || $1, $1, $1, 'shopee', 'COMPLETED', '2026-07-01', '2026-07-06 01:02:03', $2::jsonb, $3::timestamp, 200000, $4)`,
      pancakeId, JSON.stringify({ id: pancakeId, shop_id: Number(shop) }), rawFetchedAt, mirror,
    );
    await p.$executeRawUnsafe(
      `INSERT INTO "OrderItem" (id, "orderId", sku, "productName", quantity, "unitPrice") VALUES ('i-' || $1, 'o-' || $1, 'SKU', 'SP', 2, 100000)`,
      pancakeId,
    );
  }
  // `Order.raw` = payload của dòng đã dựng nên đơn (như transform ghi); đơn bù mang thêm khoá `_buTuDonKho` như script bù.
  await p.$executeRawUnsafe(`
    UPDATE "Order" o SET raw = r.payload || CASE WHEN o."backfilledFromMirror"
      THEN '{"_buTuDonKho": {"nguon": "shop kho"}}'::jsonb ELSE '{}'::jsonb END
    FROM "RawPancakeOrder" r
    WHERE r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id' AND r."fetchedAt" = o."rawFetchedAt"`);
}

beforeAll(async () => {
  db = await moDbMigration();
}, HAN);

afterAll(async () => {
  for (const d of thuMucTam) xoaThuMucMigrationsTam(d);
  await db?.dong();
});

describe("migration landSeq — backfill giữ nguyên bản thắng", () => {
  it(
    "dữ liệu có nhóm trùng mốc + uuid ngược: bản đứng đầu, C1–C4 không đổi; chỉ thêm landSeq/rawLandSeq",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieuMau();
      const truoc = await tinhChecksumDon(db.prisma, THU_TU_PHIEN_BAN_DON_CU_SQL);
      const demTruoc = await demKhopMocLandDon(db.prisma);
      expect(demTruoc).toMatchObject({
        tongDon: 6, khop: 3, moHo: 0, khongKhop: 3, khongDoiChieuDuoc: 3, giaiThichDuoc: 0, lechBanKhac: 0, khongDuCanCu: 2,
        // G1/G4: có mốc nhưng không dòng nào cùng mốc, raw không khớp bản nào ⇒ KHÔNG ĐỦ CĂN CỨ.
        donKhongDuCanCu: ["G1", "G4"].map((pancakeId) => ({ pancakeId, lyDo: "khong-khop-ban-nao" })),
        donKhongDuCanCuTrangSau: null,
        daDien: null, lechCap: null, lechNoiDung: null, ungVienMoHo: [], ungVienTrangSau: null,
        anhDuLieu: { mucCoLap: "repeatable read", chiDoc: "on" },
      });
      // G2: rawFetchedAt NULL ⇒ nhóm di sản "không có mốc nguồn".
      expect(demTruoc.anhDiSan.diSan.map((d) => [d.pancakeId, d.lyDo])).toEqual([["G2", "khong-co-moc-nguon"]]);

      const day = thuMuc();
      apMigrations(db.url, day);
      expect(lechSchemaVoiDb(db.url, day)).toBeNull();

      const sauCu = await tinhChecksumDon(db.prisma, THU_TU_PHIEN_BAN_DON_CU_SQL);
      const sauMoi = await tinhChecksumDon(db.prisma, THU_TU_PHIEN_BAN_DON_SQL);
      expect(sauMoi).toEqual(truoc); // C1–C4 + bản đứng đầu theo thứ tự MỚI = trước theo thứ tự CŨ
      expect(sauCu).toEqual(truoc);

      const dau = await db.prisma.$queryRawUnsafe<{ e: string; id: string }[]>(
        `SELECT DISTINCT ON ("shopId", "externalId") "externalId" AS e, id FROM "RawPancakeOrder" ${NOI_MOC_PHIEN_BAN_DON_SQL}
         ORDER BY "shopId", "externalId", ${THU_TU_PHIEN_BAN_DON_SQL}`,
      );
      // G1/G2: id lớn nhất vẫn thắng (quy ước giữ hiện trạng); G3: fetchedAt mới hơn.
      expect(Object.fromEntries(dau.map((r) => [r.e, r.id]))).toMatchObject({
        G1: "ffffffff-ffff-4fff-bfff-ffffffffffg1",
        G2: "cccccccc-0000-4000-8000-0000000000g2",
        G3: "00000000-0000-4000-8000-0000000000g3",
        G4: "bbbbbbbb-0000-4000-8000-0000000000g4",
      });

      // landSeq = thứ hạng theo (fetchedAt, id) — không theo thứ tự chèn vật lý.
      const thuHang = await db.prisma.$queryRawUnsafe<{ id: string; s: string; rn: string }[]>(
        `SELECT id, "landSeq"::text AS s, (row_number() OVER (ORDER BY "fetchedAt", id))::text AS rn FROM "RawPancakeOrder"`,
      );
      expect(thuHang.every((r) => r.s === r.rn)).toBe(true);

      const { bronze, silver } = await soLandSeq(db.prisma);
      expect(silver).toEqual({
        G3: bronze["00000000-0000-4000-8000-0000000000g3"],
        S1: bronze["dddddddd-0000-4000-8000-0000000000s1"],
        AF1942992175O55: bronze["eeeeeeee-0000-4000-8000-0000000000m1"],
        G1: null,
        G2: null,
        G4: null,
      });
      const demSau = await demKhopMocLandDon(db.prisma);
      expect(demSau).toMatchObject({
        tongDon: 6, khop: 3, moHo: 0, khongKhop: 3, khongDoiChieuDuoc: 3, giaiThichDuoc: 0, lechBanKhac: 0, khongDuCanCu: 2,
        // G1/G4: có mốc nhưng không dòng nào cùng mốc, raw không khớp bản nào ⇒ KHÔNG ĐỦ CĂN CỨ.
        donKhongDuCanCu: ["G1", "G4"].map((pancakeId) => ({ pancakeId, lyDo: "khong-khop-ban-nao" })),
        donKhongDuCanCuTrangSau: null,
        daDien: 3, lechCap: 0, lechNoiDung: 0, ungVienMoHo: [], ungVienTrangSau: null,
        anhDuLieu: { mucCoLap: "repeatable read", chiDoc: "on" },
      });
      // G2: rawFetchedAt NULL ⇒ nhóm di sản "không có mốc nguồn".
      expect(demSau.anhDiSan.diSan.map((d) => [d.pancakeId, d.lyDo])).toEqual([["G2", "khong-co-moc-nguon"]]);
      expect(soAnhDiSan(demTruoc.anhDiSan, demSau.anhDiSan)).toEqual([]); // migration không đổi đơn di sản
      // Cùng DB/cluster, giai đoạn chuyển trước → sau ⇒ ảnh trước dùng được để so ảnh sau.
      expect([demTruoc.anhDiSan.giaiDoan, demSau.anhDiSan.giaiDoan]).toEqual(["truoc-migrate", "sau-migrate"]);
      expect(kiemNguonAnh(demTruoc.anhDiSan, demSau.anhDiSan)).toEqual([]);

      const [seq] = await db.prisma.$queryRawUnsafe<{ last_value: string; is_called: boolean }[]>(
        `SELECT last_value::text, is_called FROM "RawPancakeOrder_landSeq_seq"`,
      );
      expect(seq).toEqual({ last_value: String(BRONZE.length), is_called: true });
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "RawPancakeOrder" (id, "shopId", "externalId", "payloadHash", payload) VALUES ('moi', $1, 'G1', 'h-moi', '{}')`,
        SHOP,
      );
      const [moi] = await db.prisma.$queryRawUnsafe<{ s: string }[]>(`SELECT "landSeq"::text AS s FROM "RawPancakeOrder" WHERE id = 'moi'`);
      expect(moi.s).toBe(String(BRONZE.length + 1));
    },
    HAN,
  );

  it(
    "dữ liệu MƠ HỒ ⇒ migration thất bại, cuộn lại TOÀN BỘ (không cột, không sequence, dữ liệu nguyên vẹn); gỡ mơ hồ + resolve ⇒ áp được",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieuMau({ moHo: true });
      const truoc = await tinhChecksumDon(db.prisma, THU_TU_PHIEN_BAN_DON_CU_SQL);
      const dem = await demKhopMocLandDon(db.prisma);
      expect(dem).toMatchObject({ khop: 3, moHo: 1, khongKhop: 2 });
      // Ứng viên: đúng đơn G2 + đủ 3 dòng kho thô cùng mốc (không chọn bản nào).
      expect(dem.ungVienMoHo.map((u) => [u.pancakeId, u.dong.map((d) => d.id).sort()])).toEqual([
        ["G2", ["11111111-0000-4000-8000-0000000000g2", "88888888-0000-4000-8000-0000000000g2", "cccccccc-0000-4000-8000-0000000000g2"]],
      ]);

      const day = thuMuc();
      let thongBao = "";
      try {
        apMigrations(db.url, day);
      } catch (e) {
        thongBao = (e as Error).message;
      }
      // Khối kiểm sớm TRƯỚC `BEGIN;` ⇒ Prisma in đúng nguyên nhân, không chỉ "current transaction is aborted".
      expect(thongBao).toMatch(/landSeq: 1 đơn Silver khớp >= 2 dòng kho thô/);
      expect(thongBao).not.toMatch(/current transaction is aborted/);

      const [con] = await db.prisma.$queryRawUnsafe<{ cot: bigint; seq: string | null }[]>(
        `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'app'
                   AND column_name IN ('landSeq', 'rawLandSeq'))::bigint AS cot,
                to_regclass('app."RawPancakeOrder_landSeq_seq"')::text AS seq`,
      );
      expect(con).toEqual({ cot: BigInt(0), seq: null });
      const ghi = await db.prisma.$queryRawUnsafe<{ xong: boolean; lui: boolean; log: boolean }[]>(
        `SELECT finished_at IS NOT NULL AS xong, rolled_back_at IS NOT NULL AS lui, logs LIKE '%mơ hồ%' AS log
         FROM "_prisma_migrations" WHERE migration_name = $1`,
        MIG,
      );
      expect(ghi).toEqual([{ xong: false, lui: false, log: true }]); // lượt THẤT BẠI (log ghi nguyên nhân), chưa giải quyết
      expect(await tinhChecksumDon(db.prisma, THU_TU_PHIEN_BAN_DON_CU_SQL)).toEqual(truoc);

      // Câu xác nhận của runbook: 0 cột, 0 sequence, lần gần nhất thất bại. Bản public loại runbook (`deploy/*.md`) ⇒ chỉ
      // kiểm phần này khi có file; repo private luôn có.
      const cauRunbook = CO_RUNBOOK ? cauXacNhanCuonLaiTrongRunbook() : "";
      if (CO_RUNBOOK) {
        expect(await ketQuaXacNhan(cauRunbook)).toEqual(["(0,0,failed)"]);
        // Đúng chữ người vận hành gõ (psql -tA + echo mã thoát): kết quả và "lệnh thành công" tách bạch.
        expect(chayLenhXacNhanNguyenVan(db.url)).toBe("0|0|failed\nma=0\n");
      }
      // resolve rồi deploy lại khi CHƯA gỡ nguyên nhân ⇒ thất bại LẦN HAI ⇒ hai dòng cùng tên trong `_prisma_migrations`.
      danhDauMigrationDaCuonLai(db.url, day, MIG);
      expect(() => apMigrations(db.url, day)).toThrow(/landSeq: 1 đơn/);
      const [{ n }] = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE migration_name = $1`,
        MIG,
      );
      expect(Number(n)).toBe(2);
      if (CO_RUNBOOK) {
        expect(await ketQuaXacNhan(cauRunbook)).toEqual(["(0,0,failed)"]); // chọn đúng lần GẦN NHẤT
        // Đối chứng: câu cũ (không ORDER BY … LIMIT 1) vỡ đúng như review đã đo.
        await expect(ketQuaXacNhan(cauRunbook.replace(/\s*ORDER BY started_at DESC LIMIT 1/, ""))).rejects.toThrow(
          /more than one row/,
        );
      }

      // Đường vận hành: gỡ nguyên nhân (ở đây: đơn không còn trỏ nhóm trùng) → resolve → deploy lại.
      await db.prisma.$executeRawUnsafe(`UPDATE "Order" SET "rawFetchedAt" = NULL WHERE "pancakeId" = 'G2'`);
      expect(() => apMigrations(db.url, day)).toThrow(/P3009|failed migrations/);
      danhDauMigrationDaCuonLai(db.url, day, MIG);
      apMigrations(db.url, day);
      expect(lechSchemaVoiDb(db.url, day)).toBeNull();
      expect(await demKhopMocLandDon(db.prisma)).toMatchObject({ moHo: 0, daDien: 3, lechCap: 0, lechNoiDung: 0 });
    },
    HAN,
  );

  it(
    "gỡ khối kiểm sớm ⇒ chốt TRONG transaction vẫn chặn mơ hồ, cuộn lại toàn bộ",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieuMau({ moHo: true });
      const truoc = await tinhChecksumDon(db.prisma, THU_TU_PHIEN_BAN_DON_CU_SQL);
      const goKhoiKiemSom = (sql: string): string => {
        const khoi = /^-- KIỂM SỚM đơn MƠ HỒ[\s\S]*?^END \$\$;\n(?=\nBEGIN;$)/m;
        expect(sql).toMatch(khoi);
        const moi = sql.replace(khoi, "");
        expect(moi.indexOf("RAISE EXCEPTION 'landSeq")).toBeGreaterThan(moi.search(/^BEGIN;$/m)); // chỉ còn chốt SAU BEGIN
        return moi;
      };
      expect(() => apMigrations(db.url, thuMuc({ suaNoiDung: { [MIG]: goKhoiKiemSom } }))).toThrow(/migrate deploy thất bại/);
      const [{ cot }] = await db.prisma.$queryRawUnsafe<{ cot: bigint }[]>(
        `SELECT count(*)::bigint AS cot FROM information_schema.columns WHERE table_schema = 'app'
           AND column_name IN ('landSeq', 'rawLandSeq')`,
      );
      expect(cot).toBe(BigInt(0));
      expect(await tinhChecksumDon(db.prisma, THU_TU_PHIEN_BAN_DON_CU_SQL)).toEqual(truoc);
    },
    HAN,
  );

  it(
    "phiên khác đang giữ khoá bảng ⇒ hết lock_timeout thì migration dừng nhanh và cuộn lại",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      const u = new URL(db.url);
      u.search = "";
      // Một phiên psql giữ khoá ACCESS SHARE trên "Order" (như câu đọc đang chạy) trong 60 giây.
      const kn = ketNoiPsql(u.toString());
      const giu = spawn("psql", ["-X", "-q", "-d", kn.urlKhongMatKhau, "-c",
        `BEGIN; LOCK TABLE app."Order" IN ACCESS SHARE MODE; SELECT pg_sleep(60);`],
        { stdio: "ignore", env: { ...process.env, ...kn.env, PGAPPNAME: "landseq-test-giu-khoa" } });
      try {
        for (let i = 0; ; i++) {
          const [{ n }] = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
             WHERE c.relname = 'Order' AND l.mode = 'AccessShareLock' AND l.granted AND l.pid <> pg_backend_pid()`,
          );
          if (Number(n) > 0) break;
          if (i > 300) throw new Error("phiên giữ khoá không lên");
          await new Promise((r) => setTimeout(r, 20));
        }
        const batDau = Date.now();
        // Hết hạn chờ khoá xảy ra SAU `BEGIN;` ⇒ Prisma chỉ in "current transaction is aborted" (nguyên nhân thật
        // ở log server) — test khoá HÀNH VI: dừng nhanh, cuộn lại, lượt ghi nhận thất bại.
        expect(() => apMigrations(db.url, thuMuc())).toThrow(/migrate deploy thất bại/);
        expect(Date.now() - batDau).toBeLessThan(30_000); // dừng nhanh, không treo tới khi phiên kia nhả (60 s)
        const [{ cot }] = await db.prisma.$queryRawUnsafe<{ cot: bigint }[]>(
          `SELECT count(*)::bigint AS cot FROM information_schema.columns WHERE table_schema = 'app'
             AND column_name IN ('landSeq', 'rawLandSeq')`,
        );
        expect(cot).toBe(BigInt(0));
        const ghi = await db.prisma.$queryRawUnsafe<{ xong: boolean }[]>(
          `SELECT finished_at IS NOT NULL AS xong FROM "_prisma_migrations" WHERE migration_name = $1`,
          MIG,
        );
        expect(ghi).toEqual([{ xong: false }]);
      } finally {
        giu.kill();
        // Giết psql chưa đủ: backend đang `pg_sleep` vẫn giữ khoá tới hết giờ ⇒ kết thúc thẳng backend đó.
        await db.prisma.$queryRawUnsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'landseq-test-giu-khoa'`,
        );
      }
    },
    HAN,
  );

  it(
    "bảng thuộc role KHÁC role chạy migration (DB phục hồi từ dump mang OWNER TO hogikids) ⇒ vẫn áp được, sequence cùng owner bảng",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      const coRole = await db.prisma.$queryRawUnsafe<{ x: number }[]>(`SELECT 1 AS x FROM pg_roles WHERE rolname = 'hogikids'`);
      if (coRole.length === 0) await db.prisma.$executeRawUnsafe("CREATE ROLE hogikids NOLOGIN");
      await db.prisma.$executeRawUnsafe(`ALTER TABLE "RawPancakeOrder" OWNER TO hogikids`);
      await db.prisma.$executeRawUnsafe(`ALTER TABLE "Order" OWNER TO hogikids`);
      apMigrations(db.url, thuMuc());
      const owner = await db.prisma.$queryRawUnsafe<{ relname: string; o: string }[]>(
        `SELECT relname, pg_get_userbyid(relowner) AS o FROM pg_class
         WHERE relname IN ('RawPancakeOrder', 'RawPancakeOrder_landSeq_seq') ORDER BY relname`,
      );
      expect(owner).toEqual([
        { relname: "RawPancakeOrder", o: "hogikids" },
        { relname: "RawPancakeOrder_landSeq_seq", o: "hogikids" },
      ]);
    },
    HAN,
  );

  it(
    "bảng RỖNG ⇒ sequence chưa gọi, dòng đầu tiên nhận 1",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc());
      const [seq] = await db.prisma.$queryRawUnsafe<{ last_value: string; is_called: boolean }[]>(
        `SELECT last_value::text, is_called FROM "RawPancakeOrder_landSeq_seq"`,
      );
      expect(seq).toEqual({ last_value: "1", is_called: false });
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "RawPancakeOrder" (id, "shopId", "externalId", "payloadHash", payload) VALUES ('dau', $1, 'X', 'h', '{}')`,
        SHOP,
      );
      const [r] = await db.prisma.$queryRawUnsafe<{ s: string }[]>(`SELECT "landSeq"::text AS s FROM "RawPancakeOrder"`);
      expect(r.s).toBe("1");
    },
    HAN,
  );
});
