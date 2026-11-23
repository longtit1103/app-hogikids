import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AnhDiSan,
  chupAnhDiSan,
  docAnhDiSan,
  kiemNguonAnh,
  LoiAnhDiSan,
  lyDoKhongXuatAnh,
} from "@/lib/bronze/anh-di-san-moc-land-don";

import { docCoCli, LoiCoCli } from "@/lib/bronze/co-cli-kiem-moc-land-don";

import {
  apMigrations,
  type DbMigration,
  moDbMigration,
  saoThuMucMigrations,
  xoaThuMucMigrationsTam,
} from "../helpers/db-migration-dung-mot-lan";
import { ketNoiPsql } from "../helpers/ket-noi-psql-khong-lo-mat-khau";

/**
 * Ảnh nhóm di sản của bước kiểm landSeq có NGUỒN GỐC + GIAI ĐOẠN, chạy CHÍNH CLI `scripts/dem-khop-moc-land-don-pancake.ts`
 * trên DB migration dùng-một-lần, đúng thứ tự vận hành (runbook ③a-6):
 *  - TRƯỚC migrate, cổng đạt ⇒ `--ghi-anh` xuất ảnh mang db / oid / schema / cluster / giai đoạn;
 *  - SAU migrate ⇒ `--ghi-anh` TỪ CHỐI (không chụp lại để thay baseline — đúng đường review đã dùng để qua cổng giả);
 *    `--so-anh` ảnh trước ⇒ KHỚP; đổi dữ liệu đơn di sản ⇒ ĐỎ; ảnh sai giai đoạn / sai nguồn ⇒ ĐỎ, không so;
 *  - file ảnh rỗng / hỏng / phiên bản cũ / không có / cờ thiếu giá trị ⇒ báo rõ nguyên nhân, thoát 1.
 * Định danh cluster lấy bằng QUYỀN HIỆN CÓ: role thường (quyền mặc định PUBLIC) đọc được; bị thu quyền ⇒ `null`, không làm
 * hỏng transaction, và `--ghi-anh` từ chối.
 */

const MIG = "20261106150000_raw_pancake_order_land_seq";
const HAN = 240_000;
const SHOP = "1942992175";
const SCRIPT = "scripts/dem-khop-moc-land-don-pancake.ts";

let db: DbMigration;
const thuMucTam: string[] = [];
const thuMuc = (p: Parameters<typeof saoThuMucMigrations>[0] = {}) => {
  const d = saoThuMucMigrations(p);
  thuMucTam.push(d);
  return d;
};
const tam = mkdtempSync(path.join(tmpdir(), "landseq-anh-nguon-"));

/**
 * Chạy CLI thật. `khoaCli: true` ⇒ XOÁ `VITEST` khỏi env tiến trình con (Vitest được miễn khoá ghi chung CLI —
 * `cheDoKhoaCli`), để tiến trình con giành khoá như trên prod; cùng cách `tests/backup/khoa-chung-cli-hai-tien-trinh.test.ts`.
 */
function chayCli(thamSo: string[], input?: string, o: { khoaCli?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: db.url };
  if (o.khoaCli) delete env.VITEST;
  const r = spawnSync("./node_modules/.bin/tsx", [SCRIPT, ...thamSo], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 120_000,
    input,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, tatCa: `${r.stdout}\n${r.stderr}` };
}

const ghiFile = (ten: string, noiDung: string) => {
  const f = path.join(tam, ten);
  writeFileSync(f, noiDung);
  return f;
};

/** S1 khớp đúng một dòng kho thô; OLD1 không có kho thô; LEG1 `rawFetchedAt` NULL ⇒ hai đơn di sản, cổng trước migrate ĐẠT. */
async function chenDuLieu(): Promise<void> {
  const p = db.prisma;
  await p.$executeRawUnsafe(
    `INSERT INTO "Channel" (id, name, color, "sortOrder") VALUES ('shopee', 'Shopee', '#f60', 1) ON CONFLICT DO NOTHING`,
  );
  for (const ext of ["S1", "LEG1"]) {
    const payload = JSON.stringify({ id: ext, status: 3, shop_id: Number(SHOP) });
    await p.$executeRawUnsafe(
      `INSERT INTO "RawPancakeOrder" (id, "shopId", "externalId", "payloadHash", payload, "fetchedAt")
       VALUES ('r-' || $1, $2, $1, md5($3), $3::jsonb, '2026-07-04 08:00:00.000')`,
      ext, SHOP, payload,
    );
  }
  for (const [pancakeId, moc] of [["S1", "2026-07-04 08:00:00.000"], ["LEG1", null], ["OLD1", "2026-07-01 00:00:00.000"]] as const) {
    await p.$executeRawUnsafe(
      `INSERT INTO "Order" (id, "pancakeId", code, "channelId", status, "orderedAt", "syncedAt", raw, "rawFetchedAt", "itemsTotal")
       VALUES ('o-' || $1, $1, $1, 'shopee', 'COMPLETED', '2026-07-01', '2026-07-06 01:02:03', $2::jsonb, $3::timestamp, 200000)`,
      pancakeId, JSON.stringify({ id: pancakeId, status: 3, shop_id: Number(SHOP) }), moc,
    );
  }
}

beforeAll(async () => {
  db = await moDbMigration();
}, HAN);

afterAll(async () => {
  for (const d of thuMucTam) xoaThuMucMigrationsTam(d);
  rmSync(tam, { recursive: true, force: true });
  await db?.dong();
});

describe("ảnh di sản: nguồn gốc + giai đoạn qua CLI thật", () => {
  it(
    "trước migrate xuất ảnh có nguồn; sau migrate --ghi-anh TỪ CHỐI, --so-anh ảnh trước KHỚP; đổi di sản / sai nguồn / sai giai đoạn ⇒ ĐỎ",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieu();

      const truoc = chayCli(["--ghi-anh"]);
      expect(truoc.status, truoc.tatCa).toBe(0);
      expect(truoc.stderr).toMatch(/^ĐẠT$/m);
      const anh = docAnhDiSan(truoc.stdout); // stdout CHỈ có JSON ảnh
      expect(anh).toMatchObject({
        phienBan: 3,
        giaiDoan: "truoc-migrate",
        tongDon: 3,
        nguon: { db: decodeURIComponent(new URL(db.url).pathname.slice(1)), schema: "app" },
      });
      expect(anh.nguon.cluster).toMatch(/^\d+$/);
      expect(anh.nguon.dbOid).toMatch(/^\d+$/);
      expect(anh.diSan.map((d) => [d.pancakeId, d.lyDo])).toEqual([["LEG1", "khong-co-moc-nguon"], ["OLD1", "khong-co-kho-tho"]]);
      // Số liệu đối soát mang theo ảnh: khop = số đơn migration sẽ điền; 16 chỉ số tiền (cột 1 = số đơn).
      expect(anh.khop).toBe(Number(truoc.stderr.match(/ khop=(\d+) /)![1]));
      expect(anh.tien16).toMatch(/^3(\|-?\d+){15}$/);
      const fileAnh = ghiFile("anh-truoc.json", truoc.stdout);

      apMigrations(db.url, thuMuc());

      // Chụp lại SAU migrate để thay baseline ⇒ TỪ CHỐI, stdout rỗng.
      const chupLai = chayCli(["--ghi-anh"]);
      expect(chupLai.status).toBe(1);
      expect(chupLai.stdout).toBe("");
      expect(chupLai.stderr).toMatch(/TỪ CHỐI --ghi-anh: DB đã SAU migrate/);

      const sau = chayCli(["--so-anh", fileAnh]);
      expect(sau.status, sau.tatCa).toBe(0);
      expect(sau.stdout).toMatch(/so ảnh di sản với lần trước: KHỚP/);
      expect(sau.stdout).toMatch(/so số liệu trước ↔ sau migrate \(tong_don, da_dien = khop trước, tien16\): KHỚP/);
      expect(sau.stdout).toMatch(/giai_doan=sau-migrate/);

      // Số liệu ghi trong ảnh khác DB (thứ gì đó ghi chen vào cửa sổ) ⇒ TỰ so ra LỆCH ⇒ ĐỎ, không cần mắt người.
      const lechSoLieu: [string, AnhDiSan, RegExp][] = [
        ["tien16", { ...anh, tien16: anh.tien16.replace(/^3\|/, "3|9") }, /tien16: trước /],
        ["khop", { ...anh, khop: anh.khop + 1 }, /da_dien: sau \d+ ≠ khop trước migrate /],
        ["tong-don", { ...anh, tongDon: anh.tongDon + 1 }, /tong_don: trước 4 ≠ sau 3/],
      ];
      for (const [ten, a, mau] of lechSoLieu) {
        const r = chayCli(["--so-anh", ghiFile(`so-lieu-${ten}.json`, JSON.stringify(a))]);
        expect(r.status, ten).toBe(1);
        expect(r.stdout, ten).toMatch(/so số liệu trước ↔ sau migrate .*: LỆCH/);
        expect(r.stdout, ten).toMatch(mau);
        expect(r.stdout, ten).toMatch(/KHÔNG ĐẠT — số liệu LỆCH so với trước migrate/);
      }
      // Sau migrate mà KHÔNG đưa ảnh vào ⇒ thiếu căn cứ đối soát ⇒ ĐỎ.
      const khongAnh = chayCli([]);
      expect(khongAnh.status).toBe(1);
      expect(khongAnh.stdout).toMatch(/KHÔNG có ảnh trước migrate để so/);
      expect(chayCli(["--so-anh", "-"], truoc.stdout).status).toBe(0); // đọc ảnh qua stdin

      // Ảnh SAI GIAI ĐOẠN (chụp sau migrate) / SAI NGUỒN ⇒ không so, ĐỎ.
      const bienThe: [string, AnhDiSan, RegExp][] = [
        ["giai-doan", { ...anh, giaiDoan: "sau-migrate" }, /giai đoạn "sau-migrate"/],
        ["db-oid", { ...anh, nguon: { ...anh.nguon, dbOid: "1" } }, /dbOid: ảnh "1"/],
        ["cluster", { ...anh, nguon: { ...anh.nguon, cluster: "123" } }, /cluster: ảnh "123"/],
        ["db", { ...anh, nguon: { ...anh.nguon, db: "postgres" } }, /db: ảnh "postgres"/],
        ["schema", { ...anh, nguon: { ...anh.nguon, schema: "public" } }, /schema: ảnh "public" ≠ DB đang kiểm "app"/],
      ];
      for (const [ten, a, mau] of bienThe) {
        const r = chayCli(["--so-anh", ghiFile(`${ten}.json`, JSON.stringify(a))]);
        expect(r.status, ten).toBe(1);
        expect(r.stdout, ten).toMatch(/KHÔNG ĐẠT — ẢNH SAI NGUỒN \/ SAI GIAI ĐOẠN, KHÔNG so/);
        expect(r.stdout, ten).toMatch(mau);
        expect(r.stdout, ten).not.toMatch(/so ảnh di sản với lần trước/);
      }

      // Dữ liệu đơn di sản đổi trong cửa sổ ⇒ ĐỎ; và KHÔNG có lối chụp lại để "làm khớp".
      await db.prisma.$executeRawUnsafe(`UPDATE "Order" SET status = 'RETURNED' WHERE "pancakeId" = 'LEG1'`);
      const doi = chayCli(["--so-anh", fileAnh]);
      expect(doi.status).toBe(1);
      expect(doi.stdout).toMatch(/doi-c1 don=LEG1/);
      expect(chayCli(["--ghi-anh"]).status).toBe(1);
    },
    HAN,
  );

  it(
    "file ảnh rỗng / hỏng / phiên bản cũ / không có / cờ thiếu giá trị ⇒ báo rõ, thoát 1, không lộ lỗi JSON thô",
    () => {
      const ca: [string, string[], RegExp][] = [
        ["rong", ["--so-anh", ghiFile("rong.json", "")], /ảnh di sản RỖNG — file không có nội dung/],
        ["khoang-trang", ["--so-anh", ghiFile("trang.json", "  \n")], /ảnh di sản RỖNG/],
        ["hong", ["--so-anh", ghiFile("hong.json", '{"phienBan": 2, "diSan": [')], /ảnh di sản HỎNG — không phải JSON hợp lệ/],
        ["phien-ban-cu", ["--so-anh", ghiFile("v1.json", '{"phienBan":1,"diSan":[]}')], /phiên bản 1 — cần phiên bản 3/],
        ["phien-ban-2-thieu-so-lieu", ["--so-anh", ghiFile("v2.json", '{"phienBan":2,"diSan":[]}')], /phiên bản 2 — cần phiên bản 3/],
        ["khong-co-file", ["--so-anh", path.join(tam, "khong-co.json")], /không đọc được ảnh/],
      ];
      for (const [ten, thamSo, mau] of ca) {
        const r = chayCli(thamSo);
        expect(r.status, ten).toBe(1);
        expect(r.stdout, ten).toMatch(/^KHÔNG ĐẠT — .* — KHÔNG so, KHÔNG tính đạt$/m);
        expect(r.stdout, ten).toMatch(mau);
        // Lỗi cũ: chỉ `SyntaxError: Unexpected end of JSON input` + stack. Chi tiết parser được phép nằm TRONG thông điệp.
        expect(r.tatCa, ten).not.toMatch(/SyntaxError|^\s+at /m);
      }
      // Cờ sai ⇒ TỪ CHỐI trước mọi việc, stdout rỗng — không lặng lẽ bỏ qua `--so-anh` (cổng xanh giả khi di sản rỗng).
      const fileAnh = ghiFile("bat-ky.json", "{}");
      const coSai: [string, string[], RegExp][] = [
        ["thieu-gia-tri", ["--so-anh"], /cờ --so-anh thiếu giá trị/],
        ["gia-tri-la-co", ["--so-anh", "--liet-ke-mo-ho"], /cờ --so-anh thiếu giá trị/],
        ["dang-bang", [`--so-anh=${fileAnh}`], /cờ dạng "--so-anh=.*" không nhận/],
        ["go-sai", ["--soanh", fileAnh], /cờ lạ "--soanh"/],
        ["doi-so-thua", [fileAnh], /đối số thừa/],
        ["lap", ["--so-anh", fileAnh, "--so-anh", fileAnh], /cờ --so-anh lặp lại/],
        ["xung-dot", ["--ghi-anh", "--so-anh", fileAnh], /--ghi-anh và --so-anh xung đột/],
        ["gioi-han", ["--gioi-han", "0"], /--gioi-han "0" phải là số nguyên 1–1000/],
      ];
      for (const [ten, thamSo, mau] of coSai) {
        const r = chayCli(thamSo);
        expect(r.status, ten).toBe(1);
        expect(r.stdout, ten).toBe("");
        expect(r.stderr, ten).toMatch(/^TỪ CHỐI — cờ không hợp lệ: .* — không chạy kiểm, KHÔNG tính đạt$/m);
        expect(r.stderr, ten).toMatch(mau);
      }
    },
    HAN,
  );

  it(
    "TRƯỚC migrate, cổng CHƯA ĐẠT ⇒ --ghi-anh thoát đúng mã cổng, stdout RỖNG (mơ hồ ⇒ 1; không đủ căn cứ ⇒ 2)",
    async () => {
      // Mã 1: S1 khớp HAI dòng kho thô cùng mốc ⇒ mơ hồ.
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieu();
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "RawPancakeOrder" (id, "shopId", "externalId", "payloadHash", payload, "fetchedAt")
         VALUES ('r-S1-b', $1, 'S1', 'h-b', '{"id":"S1","status":4}'::jsonb, '2026-07-04 08:00:00.000')`,
        SHOP,
      );
      const moHo = chayCli(["--ghi-anh"]);
      expect(moHo.status, moHo.stderr).toBe(1);
      expect(moHo.stdout).toBe("");
      expect(moHo.stderr).toMatch(/TỪ CHỐI --ghi-anh: cổng chưa ĐẠT \(mã 1\)/);

      // Mã 2: S1 có mốc mà không dòng nào cùng mốc, raw không khớp bản nào ⇒ KHÔNG ĐỦ CĂN CỨ.
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieu();
      await db.prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "rawFetchedAt" = '2026-07-09 00:00:00', raw = raw || '{"lech": 1}'::jsonb WHERE "pancakeId" = 'S1'`,
      );
      const kdcc = chayCli(["--ghi-anh"]);
      expect(kdcc.status, kdcc.stderr).toBe(2);
      expect(kdcc.stdout).toBe("");
      expect(kdcc.stderr).toMatch(/TỪ CHỐI --ghi-anh: cổng chưa ĐẠT \(mã 2\)/);
    },
    HAN,
  );

  it(
    "nối dây cờ phân trang: --gioi-han + --sau (ứng viên mơ hồ), --sau-kdcc (không đủ căn cứ), --liet-ke-mo-ho sau migrate",
    async () => {
      const p = db.prisma;
      const themDon = async (id: string, moc: string, raw: string) =>
        p.$executeRawUnsafe(
          `INSERT INTO "Order" (id, "pancakeId", code, "channelId", status, "orderedAt", "syncedAt", raw, "rawFetchedAt", "itemsTotal")
           VALUES ('o-' || $1, $1, $1, 'shopee', 'COMPLETED', '2026-07-01', '2026-07-06 01:02:03', $2::jsonb, $3::timestamp, 200000)`,
          id, raw, moc,
        );
      const themTho = async (rid: string, ext: string, moc: string, status: number) =>
        p.$executeRawUnsafe(
          `INSERT INTO "RawPancakeOrder" (id, "shopId", "externalId", "payloadHash", payload, "fetchedAt")
           VALUES ($1, $2, $3, md5($1), jsonb_build_object('id', $3::text, 'status', $4::int), $5::timestamp)`,
          rid, SHOP, ext, status, moc,
        );
      const MOC = "2026-07-05 10:00:00.000";
      // TRƯỚC migrate: M1..M3 mơ hồ (mỗi đơn khớp 2 dòng cùng mốc); K1, K2 có mốc mà không dòng nào cùng mốc, raw lệch.
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieu();
      for (const m of ["M1", "M2", "M3"]) {
        await themTho(`r-${m}-a`, m, MOC, 3);
        await themTho(`r-${m}-b`, m, MOC, 4);
        await themDon(m, MOC, JSON.stringify({ id: m, status: 3, shop_id: Number(SHOP) }));
      }
      for (const k of ["K1", "K2"]) {
        await themTho(`r-${k}`, k, MOC, 3);
        await themDon(k, "2026-07-09 00:00:00.000", JSON.stringify({ id: k, status: 9, shop_id: Number(SHOP) }));
      }
      const uv = chayCli(["--gioi-han", "1", "--sau", "M1"]);
      expect(uv.status, uv.tatCa).toBe(1); // mơ hồ ⇒ KHÔNG ĐẠT
      expect(uv.stdout).toMatch(/ỨNG VIÊN MƠ HỒ — trang sau don=M1: 1 đơn \(tổng mơ hồ 3; mỗi trang tối đa 1\)/);
      expect(uv.stdout).toMatch(/^  don=M2 /m);
      expect(uv.stdout).not.toMatch(/^  don=M[13] /m);
      expect(uv.stdout).toMatch(/còn trang sau: chạy lại kèm `--sau M2`/);
      // `--sau` KHÔNG lái trang không đủ căn cứ: vẫn trang đầu (K1).
      expect(uv.stdout).toMatch(/ĐƠN KHÔNG ĐỦ CĂN CỨ — trang này 1\/5:\n  don=K1 ly_do=/);
      const kd = chayCli(["--gioi-han", "1", "--sau-kdcc", "K1"]);
      // KĐCC gồm K1, K2 và cả M1..M3 (raw không khớp chính xác payload nào) — sắp theo byte: K1 < K2 < M1…
      expect(kd.stdout).toMatch(/ĐƠN KHÔNG ĐỦ CĂN CỨ — trang này 1\/5:\n  don=K2 ly_do=/);
      expect(kd.stdout).not.toMatch(/don=K1 ly_do=/);
      expect(kd.stdout).toMatch(/còn trang sau: chạy lại kèm `--sau-kdcc K2`/);
      expect(kd.stdout).not.toMatch(/ỨNG VIÊN MƠ HỒ — trang sau/); // --sau-kdcc KHÔNG lái trang ứng viên

      // SAU migrate: một đơn mơ hồ chỉ được in khi có --liet-ke-mo-ho.
      await db.datLai();
      apMigrations(db.url, thuMuc());
      await chenDuLieu();
      await themTho("r-S1-b", "S1", "2026-07-04 08:00:00.000", 4);
      expect(chayCli([]).stdout).not.toMatch(/ỨNG VIÊN MƠ HỒ/);
      expect(chayCli(["--liet-ke-mo-ho"]).stdout).toMatch(/ỨNG VIÊN MƠ HỒ — trang đầu: 1 đơn[\s\S]*^  don=S1 /m);
    },
    HAN,
  );

  it(
    "đang phục hồi DB (khoá ghi chung bị giữ độc quyền) ⇒ --ghi-anh / --so-anh thoát 1, stdout rỗng, không bảo chạy lại; thông báo tách trước / sau migrate",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieu();
      const fileAnh = ghiFile("anh-phuc-hoi.json", chayCli(["--ghi-anh"]).stdout);
      // Đối chứng: KHÔNG có ai giữ khoá ⇒ tiến trình con giành khoá shared được, chạy bình thường (mã 0).
      expect(chayCli(["--so-anh", fileAnh], undefined, { khoaCli: true }).status).toBe(0);
      const u = new URL(db.url);
      u.search = "";
      // Phiên psql RIÊNG giữ khoá EXCLUSIVE như lượt phục hồi (`SO_KHOA_GHI_CHUNG`).
      const kn = ketNoiPsql(u.toString());
      const giu = spawn("psql", ["-X", "-q", "-d", kn.urlKhongMatKhau, "-c", "SELECT pg_advisory_lock(261028001); SELECT pg_sleep(60);"], {
        stdio: "ignore",
        env: { ...process.env, ...kn.env, PGAPPNAME: "landseq-gia-phuc-hoi" },
      });
      try {
        for (let i = 0; ; i++) {
          const [{ n }] = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
             WHERE l.locktype = 'advisory' AND l.objid = 261028001 AND l.mode = 'ExclusiveLock' AND l.granted
               AND a.application_name = 'landseq-gia-phuc-hoi' AND a.datname = current_database()`,
          );
          if (Number(n) > 0) break;
          if (i > 300) throw new Error("phiên giữ khoá phục hồi không lên");
          await new Promise((r) => setTimeout(r, 20));
        }
        for (const thamSo of [["--ghi-anh"], ["--so-anh", fileAnh]]) {
          const r = chayCli(thamSo, undefined, { khoaCli: true });
          expect(r.status, thamSo.join(" ")).toBe(1);
          if (thamSo[0] === "--ghi-anh") expect(r.stdout).toBe("");
          expect(r.tatCa).toMatch(/KHÔNG ĐẠT — đang phục hồi DB .*; KHÔNG chạy lại, KHÔNG dùng lại ảnh sau phục hồi/);
          // Hai giai đoạn: trước migrate mới được mở cửa sổ mới từ preflight; sau migrate giữ dừng + báo chủ shop.
          expect(r.tatCa).toMatch(
            /TRƯỚC lần migrate đầu tiên \(bước \(a\)\/\(b\)\): BỎ CUỘC cửa sổ theo mục "BỎ CUỘC TRƯỚC MIGRATE" — giữ ảnh \+ nguồn ghi dừng, báo chủ shop; cất ảnh và quay về container cũ CHỈ theo duyệt; chỉ mở cửa sổ mới từ PREFLIGHT khi cửa sổ này đã khép/,
          );
          // (b) chạy lại SAU migration lỗi thuộc nhánh GIỮ DỪNG, không thuộc bảng trước migrate.
          expect(r.tatCa).toMatch(/TỪ lần migrate đầu tiên \(\(b\) chạy lại sau migration lỗi, KIỂM SAU\): GIỮ app \+ nguồn ghi DỪNG, KHÔNG `up -d`, giữ nguyên ảnh\/log, báo chủ shop — KHÔNG quay lại bước chụp ảnh, KHÔNG dùng bảng xử lý trước migrate/);
          expect(r.tatCa).not.toMatch(/chạy lại sau khi phục hồi xong/);
        }
      } finally {
        giu.kill();
        await db.prisma.$queryRawUnsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE application_name = 'landseq-gia-phuc-hoi' AND datname = current_database()`,
        );
      }
    },
    HAN,
  );

  it(
    "hết lock_timeout ⇒ thoát 3: chỉ cho chạy lại MỘT lần TRƯỚC lần migrate đầu tiên / KIỂM SAU; (b) chạy lại sau migration lỗi thì GIỮ DỪNG",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [MIG] }));
      await chenDuLieu();
      const fileAnh = ghiFile("anh-het-han.json", chayCli(["--ghi-anh"]).stdout);
      const u = new URL(db.url);
      u.search = "";
      // Phiên psql RIÊNG giữ ACCESS EXCLUSIVE trên bảng đơn ⇒ lượt kiểm hết lock_timeout 5 s.
      const giu = spawn(
        "psql",
        ["-X", "-q", "-d", ketNoiPsql(u.toString()).urlKhongMatKhau, "-c", 'BEGIN; LOCK TABLE app."Order" IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60);'],
        { stdio: "ignore", env: { ...process.env, ...ketNoiPsql(u.toString()).env, PGAPPNAME: "landseq-gia-giu-khoa" } },
      );
      try {
        for (let i = 0; ; i++) {
          const [{ n }] = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
             WHERE l.mode = 'AccessExclusiveLock' AND l.granted AND a.application_name = 'landseq-gia-giu-khoa'
               AND a.datname = current_database()`,
          );
          if (Number(n) > 0) break;
          if (i > 300) throw new Error("phiên giữ khoá bảng đơn không lên");
          await new Promise((r) => setTimeout(r, 20));
        }
        const r = chayCli(["--so-anh", fileAnh]);
        expect(r.status, r.tatCa).toBe(3);
        expect(r.tatCa).toMatch(/KHÔNG HOÀN THÀNH — .* — KHÔNG tính đạt\. TRƯỚC lần migrate đầu tiên \(bước \(a\)\/\(b\)\) hoặc KIỂM SAU: chỉ chạy lại đúng lệnh này MỘT lần/);
        expect(r.tatCa).toMatch(/\(b\) chạy lại SAU migration lỗi: KHÔNG chạy lại — GIỮ app \+ nguồn ghi DỪNG, giữ nguyên ảnh\/log, báo chủ shop\./);
      } finally {
        giu.kill();
        await db.prisma.$queryRawUnsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE application_name = 'landseq-gia-giu-khoa' AND datname = current_database()`,
        );
      }
    },
    HAN,
  );

  it(
    "định danh cluster bằng QUYỀN HIỆN CÓ: role thường đọc được (mặc định PUBLIC); bị thu quyền ⇒ null, transaction vẫn chạy, không xuất ảnh",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc());
      await chenDuLieu();
      const p = db.prisma;
      const ROLE = "landseq_kiem_quyen_cluster";
      await p.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER; END IF; END $$`);
      await p.$executeRawUnsafe(`GRANT USAGE ON SCHEMA app TO ${ROLE}`);
      await p.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA app TO ${ROLE}`);
      const chupBangRole = () =>
        p.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${ROLE}`);
          const [{ su }] = await tx.$queryRawUnsafe<{ su: boolean }[]>(
            `SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`,
          );
          expect(su).toBe(false);
          return chupAnhDiSan(tx, true, { khop: 0, tien16: Array(16).fill("0").join("|") });
        });
      try {
        const coQuyen = await chupBangRole();
        expect(coQuyen.nguon.cluster).toMatch(/^\d+$/);
        await p.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC`);
        const khongQuyen = await chupBangRole();
        expect(khongQuyen.nguon.cluster).toBeNull();
        expect(khongQuyen.diSan.map((d) => d.pancakeId)).toEqual(["LEG1", "OLD1"]); // phần còn lại vẫn chạy trọn
        const truocMigrate: AnhDiSan = { ...khongQuyen, giaiDoan: "truoc-migrate" };
        expect(lyDoKhongXuatAnh(truocMigrate, 0)).toMatch(/KHÔNG có quyền EXECUTE pg_control_system\(\).*KHÔNG tự cấp quyền/);
        expect(kiemNguonAnh({ ...coQuyen, giaiDoan: "truoc-migrate" }, khongQuyen)).toContain(
          "không lấy được định danh cluster của DB đang kiểm bằng quyền hiện có",
        );
      } finally {
        await p.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO PUBLIC`);
        await p.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`);
        await p.$executeRawUnsafe(`DROP ROLE ${ROLE}`);
      }
    },
    HAN,
  );
});

describe("đọc cờ CLI (thuần)", () => {
  it("nhận đúng cờ hợp lệ", () => {
    expect(docCoCli([])).toEqual({ ghiAnh: false, lietKeMoHo: false });
    expect(docCoCli(["--so-anh", "-", "--gioi-han", "1000", "--sau", "A", "--sau-kdcc", "B", "--liet-ke-mo-ho"])).toEqual({
      ghiAnh: false, soAnh: "-", lietKeMoHo: true, gioiHan: 1000, sau: "A", sauKdcc: "B",
    });
    expect(docCoCli(["--ghi-anh"]).ghiAnh).toBe(true);
  });
  it("từ chối cờ lạ / sai cú pháp / trùng / xung đột / giá trị sai", () => {
    for (const thamSo of [
      ["--so-anh=f"], ["--soanh", "f"], ["-x"], ["f"], ["--ghi-anh", "--ghi-anh"], ["--so-anh"], ["--sau", "--ghi-anh"],
      ["--ghi-anh", "--so-anh", "f"], ["--gioi-han", "1001"], ["--gioi-han", "01"], ["--gioi-han", "1.5"], ["--gioi-han", "-1"],
    ]) {
      expect(() => docCoCli(thamSo), thamSo.join(" ")).toThrow(LoiCoCli);
    }
  });
  it("thông báo dạng --co=giá-trị đúng loại cờ", () => {
    expect(() => docCoCli(["--so-anh=f"])).toThrow(/cờ dạng "--so-anh=f" không nhận — viết tách: --so-anh <giá trị>/);
    expect(() => docCoCli(["--ghi-anh=1"])).toThrow(/cờ dạng "--ghi-anh=1" không nhận — --ghi-anh là cờ bật\/tắt, không nhận giá trị/);
    expect(() => docCoCli(["--liet-ke-mo-ho=1"])).toThrow(/--liet-ke-mo-ho là cờ bật\/tắt/);
    expect(() => docCoCli(["--soanh=f"])).toThrow(/^cờ lạ "--soanh" \(dạng "--soanh=f"\)$/);
  });
});

describe("luật xuất ảnh / đọc ảnh (thuần)", () => {
  const mau: AnhDiSan = {
    phienBan: 3,
    nguon: { db: "d", dbOid: "1", schema: "app", cluster: "9" },
    giaiDoan: "truoc-migrate",
    luc: "2026-11-07T09:00:00.000+07:00",
    tongDon: 0,
    khop: 0,
    tien16: Array(16).fill("0").join("|"),
    diSan: [],
  };
  it("chỉ xuất ảnh khi TRƯỚC migrate + cổng ĐẠT + có cluster", () => {
    expect(lyDoKhongXuatAnh(mau, 0)).toBeNull();
    for (const ma of [1, 2, 3]) expect(lyDoKhongXuatAnh(mau, ma)).toMatch(new RegExp(`cổng chưa ĐẠT \\(mã ${ma}\\)`));
    expect(lyDoKhongXuatAnh({ ...mau, giaiDoan: "sau-migrate" }, 0)).toMatch(/SAU migrate/);
  });
  it("đọc lại đúng ảnh hợp lệ; thiếu nguồn ⇒ LoiAnhDiSan", () => {
    expect(docAnhDiSan(JSON.stringify(mau))).toEqual(mau);
    expect(kiemNguonAnh(mau, { ...mau, giaiDoan: "sau-migrate" })).toEqual([]);
    const { nguon: _bo, ...thieuNguon } = mau;
    expect(() => docAnhDiSan(JSON.stringify(thieuNguon))).toThrow(LoiAnhDiSan);
    expect(() => docAnhDiSan(JSON.stringify({ ...mau, nguon: { ...mau.nguon, cluster: null } }))).toThrow(/thiếu nguồn/);
    expect(() => docAnhDiSan("null")).toThrow(/phiên bản null/);
    // Thiếu / sai số liệu đối soát ⇒ không dùng được để so sau migrate.
    const { tien16: _t, ...thieuTien } = mau;
    expect(() => docAnhDiSan(JSON.stringify(thieuTien))).toThrow(/số liệu đối soát/);
    expect(() => docAnhDiSan(JSON.stringify({ ...mau, tien16: "1|2|3" }))).toThrow(/số liệu đối soát/);
    expect(() => docAnhDiSan(JSON.stringify({ ...mau, khop: -1 }))).toThrow(/số liệu đối soát/);
  });
});
