import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  apMigrations,
  type DbMigration,
  lechSchemaVoiDb,
  moDbMigration,
  saoThuMucMigrations,
  xoaThuMucMigrationsTam,
} from "../helpers/db-migration-dung-mot-lan";
import { kiemMigrationNguyenKhoi, tachCau } from "../helpers/kiem-migration-nguyen-khoi";

/**
 * Áp TOÀN BỘ migration hiện có của repo lên PG trắng cô lập (`TEST_DATABASE_URL_MIGRATION`, DROP/CREATE schema) bằng
 * đúng `prisma migrate deploy` của repo. Chạy mỗi lượt CI (vài giây) — và là phép kiểm BẮT BUỘC mỗi lần nâng Prisma
 * (docs/chuan-code-va-quy-trinh-dev.md): bản engine mới có thể tách/gửi file cũ khác đi (prisma/orm#30640).
 *  - đủ số migration đã áp, 0 bản dở, 0 bản đánh dấu cuộn lại; tập tên = thư mục;
 *  - schema khớp `schema.prisma` (Prisma không quản CHECK ⇒ kiểm riêng ở dưới);
 *  - tập ràng buộc CHECK trong DB = tập các file migration tạo ra (theo thứ tự, trừ phần đã DROP), so theo TÊN. Lỗi giữa
 *    chừng thì `apMigrations` đã ném trước khi tới đây; phép so này bắt ca engine BỎ LẶNG một câu `ADD CONSTRAINT` mà vẫn
 *    báo áp xong (Prisma không quản CHECK nên `migrate diff` không thấy);
 *  - tập index MỘT PHẦN viết tay (`CREATE [UNIQUE] INDEX … WHERE …` — Prisma không quản `WHERE` nên `migrate diff` không
 *    thấy) trong DB = tập rút từ file migration, đúng UNIQUE, đúng cột trong điều kiện; ghim cứng đủ 4 tên hiện có;
 *  - mọi index hợp lệ (`indisvalid` + `indisready`) — `CREATE INDEX CONCURRENTLY` lỗi để lại index INVALID;
 *  - ca cố ý lỗi giữa chừng trên migration bọc `BEGIN;`…`COMMIT;`: cả khối cuộn lại, `SET LOCAL` có hiệu lực — quy ước của
 *    cổng `cong-migration-moi-nguyen-khoi.test.ts` còn đúng với engine hiện tại.
 */

const HAN = 240_000;
const THU_MUC_REPO = path.resolve(process.cwd(), "prisma/migrations");
const dsMigration = readdirSync(THU_MUC_REPO)
  .filter((t) => statSync(path.join(THU_MUC_REPO, t)).isDirectory())
  .sort();

/** Tập CHECK mà chuỗi migration để lại: duyệt file theo thứ tự, trong mỗi câu theo vị trí xuất hiện ADD … CHECK / DROP. */
function checkKyVong(): Set<string> {
  const tap = new Set<string>();
  const mau = /DROP CONSTRAINT (?:IF EXISTS )?"([^"]+)"|CONSTRAINT "([^"]+)"\s+CHECK\b/gi;
  for (const ten of dsMigration) {
    for (const cau of tachCau(readFileSync(path.join(THU_MUC_REPO, ten, "migration.sql"), "utf8"))) {
      for (const m of cau.matchAll(mau)) {
        if (m[1]) tap.delete(m[1]);
        else if (m[2]) tap.add(m[2]);
      }
    }
  }
  return tap;
}

/** Index một phần viết tay mà chuỗi migration để lại: tên → { unique, các định danh + chuỗi trong điều kiện WHERE }. */
function indexMotPhanKyVong(): Map<string, { duyNhat: boolean; manh: string[] }> {
  const tap = new Map<string, { duyNhat: boolean; manh: string[] }>();
  for (const ten of dsMigration) {
    for (const cau of tachCau(readFileSync(path.join(THU_MUC_REPO, ten, "migration.sql"), "utf8"))) {
      const tao = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"[\s\S]*?\bWHERE\b([\s\S]*)$/i.exec(cau);
      if (tao) tap.set(tao[2], { duyNhat: Boolean(tao[1]), manh: [...tao[3].matchAll(/"([^"]+)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]) });
      const xoa = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?[A-Za-z_]+"?\.)?"([^"]+)"/i.exec(cau);
      if (xoa) tap.delete(xoa[1]);
    }
  }
  return tap;
}

let db: DbMigration;
const thuMucTam: string[] = [];
const thuMuc = (): string => {
  const d = saoThuMucMigrations();
  thuMucTam.push(d);
  return d;
};
const themMigration = (dir: string, ten: string, sql: string) => {
  mkdirSync(path.join(dir, ten));
  writeFileSync(path.join(dir, ten, "migration.sql"), sql);
};
const hoi = <T>(sql: string) => db.prisma.$queryRawUnsafe<T[]>(sql);

beforeAll(async () => {
  db = await moDbMigration();
}, HAN);

afterAll(async () => {
  for (const d of thuMucTam) xoaThuMucMigrationsTam(d);
  await db?.dong();
});

describe("áp toàn bộ migration lên PG trắng", () => {
  it(
    `đủ ${dsMigration.length} migration, 0 dở, schema khớp, CHECK đủ, index hợp lệ`,
    async () => {
      await db.datLai();
      const dir = thuMuc();
      apMigrations(db.url, dir);

      const [dem] = await hoi<{ tong: bigint; xong: bigint; do_dang: bigint; cuon_lai: bigint }>(
        `SELECT count(*) AS tong,
                count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS xong,
                count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS do_dang,
                count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS cuon_lai
         FROM app._prisma_migrations`,
      );
      expect({ tong: Number(dem.tong), xong: Number(dem.xong), do_dang: Number(dem.do_dang), cuon_lai: Number(dem.cuon_lai) }).toEqual({
        tong: dsMigration.length,
        xong: dsMigration.length,
        do_dang: 0,
        cuon_lai: 0,
      });
      const ten = (await hoi<{ migration_name: string }>(`SELECT migration_name FROM app._prisma_migrations ORDER BY 1`)).map((r) => r.migration_name);
      expect(ten).toEqual(dsMigration);

      expect(lechSchemaVoiDb(db.url, dir)).toBeNull();

      const check = (
        await hoi<{ conname: string }>(
          `SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = 'app' AND c.contype = 'c' ORDER BY 1`,
        )
      ).map((r) => r.conname);
      const kyVong = [...checkKyVong()].sort();
      expect(kyVong.length, "không đọc được CHECK nào từ migration — phép so mù").toBeGreaterThan(10);
      expect(check).toEqual(kyVong);
      // Ràng buộc tiền chính (CLAUDE.md bất biến 1) — tên cụ thể, phòng khi bộ đọc CHECK ở trên cùng mù với DB.
      expect(check).toEqual(expect.arrayContaining(["CashMovement_loan_savings_loai_tru", "CashMovement_loan_bat_buoc"]));

      const motPhan = await hoi<{ ten: string; duy_nhat: boolean; dieu_kien: string }>(
        `SELECT ci.relname AS ten, i.indisunique AS duy_nhat, pg_get_expr(i.indpred, i.indrelid) AS dieu_kien
         FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ci.relnamespace
         WHERE n.nspname = 'app' AND i.indpred IS NOT NULL ORDER BY 1`,
      );
      const kyVongIdx = indexMotPhanKyVong();
      // Ghim cứng: bộ rút từ file mà mù thì phép so dưới cũng mù theo.
      expect([...kyVongIdx.keys()].sort()).toEqual([
        "CashMovement_lai_nhap_goc_mot_ky",
        "KySaoKeThe_mot_neo_mo_so_moi_the",
        "KySaoKeThe_mot_sao_ke_pdf_moi_the",
        "User_owner_duy_nhat",
      ]);
      expect(motPhan.map((r) => r.ten)).toEqual([...kyVongIdx.keys()].sort());
      for (const r of motPhan) {
        const kv = kyVongIdx.get(r.ten)!;
        expect(r.duy_nhat, `${r.ten}: UNIQUE`).toBe(kv.duyNhat);
        expect(kv.manh.length, `${r.ten}: không đọc được điều kiện từ file`).toBeGreaterThan(0);
        for (const m of kv.manh) expect(r.dieu_kien, `${r.ten}: điều kiện thiếu ${m}`).toContain(m);
      }

      const hong = await hoi<{ index: string }>(
        `SELECT ci.relname AS index FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = ci.relnamespace
         WHERE n.nspname = 'app' AND NOT (i.indisvalid AND i.indisready)`,
      );
      expect(hong).toEqual([]);
    },
    HAN,
  );

  it(
    "migration bọc BEGIN/COMMIT lỗi giữa chừng ⇒ cả khối cuộn lại; SET LOCAL có hiệu lực trong khối",
    async () => {
      const setLocal = "BEGIN;\nSET LOCAL lock_timeout = '7s';\nCREATE TABLE \"KiemSetLocal\" AS SELECT current_setting('lock_timeout') AS v;\nCOMMIT;\n";
      const loiGiua =
        "BEGIN;\nSET LOCAL lock_timeout = '7s';\nCREATE TABLE \"KiemCuonLai\" (id int);\nINSERT INTO \"KiemCuonLai\" VALUES (1);\n" +
        "ALTER TABLE \"KiemSetLocal\" ADD COLUMN \"them\" int;\nSELECT 1 / 0;\nCREATE TABLE \"KiemCuonLaiSau\" (id int);\nCOMMIT;\n";
      // Cả hai file đúng quy ước của cổng tĩnh — nếu cổng chê thì quy ước và phép đo này đã lệch nhau.
      expect(kiemMigrationNguyenKhoi(setLocal)).toEqual([]);
      expect(kiemMigrationNguyenKhoi(loiGiua)).toEqual([]);

      await db.datLai();
      const dir = thuMuc();
      themMigration(dir, "29991231000000_kiem_set_local_trong_khoi", setLocal);
      apMigrations(db.url, dir);
      expect(await hoi<{ v: string }>(`SELECT v FROM app."KiemSetLocal"`)).toEqual([{ v: "7s" }]);

      themMigration(dir, "29991231000001_kiem_cuon_lai_khi_loi_giua", loiGiua);
      expect(() => apMigrations(db.url, dir)).toThrow(/prisma migrate deploy thất bại/);

      const conLai = await hoi<{ ten: string }>(
        `SELECT table_name AS ten FROM information_schema.tables WHERE table_schema = 'app' AND table_name LIKE 'KiemCuonLai%'
         UNION ALL SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'KiemSetLocal' AND column_name = 'them'`,
      );
      expect(conLai, "câu trước lỗi đã commit riêng — migration bọc BEGIN/COMMIT không còn nguyên khối với engine này").toEqual([]);
      const [dong] = await hoi<{ xong: boolean; cuon_lai: boolean }>(
        `SELECT finished_at IS NOT NULL AS xong, rolled_back_at IS NOT NULL AS cuon_lai FROM app._prisma_migrations
         WHERE migration_name = '29991231000001_kiem_cuon_lai_khi_loi_giua' ORDER BY started_at DESC LIMIT 1`,
      );
      expect(dong).toEqual({ xong: false, cuon_lai: false });
    },
    HAN,
  );
});
