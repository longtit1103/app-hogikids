import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type DbMigration, kiemUrlMigration, moDbMigration } from "../../helpers/db-migration-dung-mot-lan";

/**
 * Hậu kỳ trả quyền sở hữu của `deploy/restore.sh` (`reassign_owner_scoped`) phải chịu được sequence GẮN
 * cột bảng — `OWNED BY` tay, `serial`/`bigserial`/`@default(autoincrement())` (pg_depend 'a') và identity
 * (pg_depend 'i') — kể cả khi sequence nằm TRƯỚC bảng trong lượt quét `pg_class`.
 *
 * Postgres cấm `ALTER SEQUENCE … OWNER` với sequence đã gắn vào bảng ("cannot change owner of sequence
 * … linked to table") trừ khi owner đã trùng; `ALTER TABLE … OWNER` thì tự kéo theo sequence nó sở hữu.
 * Vòng quét không có thứ tự ⇒ gặp sequence trước bảng là lỗi ⇒ restore dừng SAU khi dữ liệu đã nạp,
 * role app còn khoá đăng nhập. Thứ tự quét = vị trí dòng trong heap `pg_class` (seq scan).
 *
 * Mức độ (đo PG15): dựng bằng DDL/migration (`CREATE SEQUENCE` trước bảng, `bigserial`, identity) thì dòng
 * sequence thường nằm TRƯỚC bảng — đó là thứ tự các ca ở đây ép. Đường restore thật nạp từ `pg_dump`
 * (TABLE trước SEQUENCE) nên thường ra bảng trước và bản cũ vẫn qua; lỗi chỉ xảy ra khi heap/FSM đặt dòng
 * sequence trước dòng bảng — CÓ THỂ, không mặc định. Test khoá để thứ tự heap không bao giờ quyết kết cục.
 *
 * Test chạy CHÍNH hàm thật (source script, gọi `reassign_owner_scoped`) trên Postgres thật — DB migration
 * dùng-một-lần (`TEST_DATABASE_URL_MIGRATION`, có cổng `kiemUrlMigration` + khoá chạy chồng). `docker`
 * giả bỏ `exec <container>` và đổi `-U supabase_admin -d <db>` thành URL DB đó, còn lại giữ nguyên:
 * vỏ dấu chốt `sh -c "$SH_DAU_CHOT"`, `-X -v ON_ERROR_STOP=1 -c <SQL đã nội suy>`.
 *
 * Role đích là role THỬ tên riêng mỗi lượt (ghi đè `OWNER_ROLE` sau khi source — hàm đọc biến lúc gọi):
 * không bao giờ đổi owner sang/khỏi role app thật `hogikids`. Role là object CẤP CLUSTER và đổi owner sang
 * role mới tạo cần SUPERUSER (PG15 từ chối "must be member of role" với role chỉ có CREATEROLE) ⇒ kiểm
 * `rolsuper` của user kết nối TRƯỚC mọi `CREATE ROLE`, thiếu thì đỏ kèm lý do (không skip — skip là xanh
 * giả). Object do role đang kết nối sở hữu (như `supabase_admin` ở host) ⇒ owner trước ≠ role đích.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const RESTORE_SH = path.resolve(here, "../../../deploy/restore.sh");

const SCHEMA = "kho_thu_tra_owner";
/** Tên riêng mỗi lượt: hai lượt (song song/lặp) cùng cluster không giành chung một role. */
const ROLE_DICH = `restore_tra_owner_dich_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const HAN = 60_000;

let db: DbMigration;

/** URL cho psql: bỏ `?schema=` (psql không hiểu tham số này). */
function urlPsql(): string {
  kiemUrlMigration(db.url);
  const u = new URL(db.url);
  u.search = "";
  return u.toString();
}

type KetQua = { status: number | null; stdout: string; stderr: string };

/** Source `restore.sh`, thay `docker` bằng bản chuyển thẳng sang psql local, gọi hàm trả owner thật. */
function chayTraOwner(): KetQua {
  const r = spawnSync(
    "bash",
    [
      "-c",
      [
        'source "$1"',
        'OWNER_ROLE=$2; URL_THU=$3',
        "docker() {",
        '  [[ "$1" == exec ]] || { echo "docker gia: khong phai exec: $*" >&2; return 97; }',
        '  shift; [[ "$1" == -i ]] && shift; shift',
        '  [[ "$1 $2 $4 $5 $6 $7 $8" == "sh -c sh psql -U supabase_admin -d" ]] || { echo "docker gia: hinh dang la: $*" >&2; return 98; }',
        "  local sh_chot=$3; shift 9",
        '  sh -c "$sh_chot" sh psql -d "$URL_THU" "$@"',
        "}",
        'reassign_owner_scoped db_khong_dung "$4"',
      ].join("\n"),
      "bash",
      RESTORE_SH,
      ROLE_DICH,
      urlPsql(),
      SCHEMA,
    ],
    { encoding: "utf8" },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function chay(sql: string): Promise<void> {
  await db.prisma.$executeRawUnsafe(sql);
}

async function datLaiSchema(): Promise<void> {
  await chay(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await chay(`CREATE SCHEMA ${SCHEMA}`);
}

/** Owner của mọi bảng/sequence/view trong schema thử, theo tên. */
async function ownerTheoTen(): Promise<Record<string, string>> {
  const dong = await db.prisma.$queryRawUnsafe<{ relname: string; owner: string }[]>(
    `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${SCHEMA}' AND c.relkind IN ('r','p','S','v','m')`,
  );
  return Object.fromEntries(dong.map((d) => [d.relname, d.owner]));
}

async function ownerSchema(): Promise<string> {
  const [d] = await db.prisma.$queryRawUnsafe<{ owner: string }[]>(
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = '${SCHEMA}'`,
  );
  return d.owner;
}

/** Thứ tự một lượt quét `pg_class` KHÔNG ORDER BY trả về — cùng hình dạng câu của vòng trả owner. */
async function thuTuQuetKhongSapXep(): Promise<string[]> {
  const dong = await db.prisma.$queryRawUnsafe<{ relname: string }[]>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${SCHEMA}' AND c.relkind IN ('r','p','S','v','m')`,
  );
  return dong.map((d) => d.relname);
}

let daTaoRole = false;
/**
 * Chỉ bật SAU khi user kết nối được xác nhận superuser. Trước đó test KHÔNG ghi gì vào DB — kể cả câu dọn
 * `DROP SCHEMA` của afterAll: user không đủ quyền mà vẫn chạy dọn là đụng một schema mình chưa từng tạo.
 * (`moDbMigration` trước lời kiểm chỉ kiểm URL + giành khoá tư vấn, không tạo/xoá gì.)
 */
let quaCongSieuUser = false;

beforeAll(async () => {
  db = await moDbMigration();
  const [toi] = await db.prisma.$queryRawUnsafe<{ ten: string; sieu: boolean }[]>(
    `SELECT current_user AS ten, rolsuper AS sieu FROM pg_roles WHERE rolname = current_user`,
  );
  if (!toi?.sieu) {
    throw new Error(
      `Test trả owner cần user kết nối là SUPERUSER (đang là '${toi?.ten ?? "?"}', rolsuper = false): ` +
        "đổi owner sang role thử mới tạo cần superuser — chạy trên PG local/CI (user ci).",
    );
  }
  quaCongSieuUser = true;
  await chay(`CREATE ROLE ${ROLE_DICH} NOLOGIN`);
  daTaoRole = true;
}, HAN);

afterAll(async () => {
  if (!db) return;
  try {
    if (quaCongSieuUser) await chay(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  } finally {
    try {
      if (daTaoRole) await chay(`DROP ROLE IF EXISTS ${ROLE_DICH}`);
    } finally {
      await db.dong();
    }
  }
}, HAN);

describe("restore.sh — trả owner schema có sequence OWNED BY", () => {
  it(
    "sequence OWNED BY nằm TRƯỚC bảng trong lượt quét pg_class ⇒ vẫn trả owner xong, sequence + bảng về role đích",
    async () => {
      // Ép thứ tự: tạo sequence TRƯỚC bảng (dòng pg_class của nó vào heap trước), rồi mới OWNED BY —
      // đúng hình dạng `RawPancakeOrder.landSeq`. Lặp vài lượt phòng khi dòng rơi vào trang trống cũ
      // (FSM) làm bảng ra trước; điều kiện tiên quyết được KIỂM chứ không giả định.
      let thuTu: string[] = [];
      for (let lan = 0; lan < 5; lan++) {
        await datLaiSchema();
        await chay(`CREATE SEQUENCE ${SCHEMA}."RawPancakeOrder_landSeq_seq"`);
        await chay(
          `CREATE TABLE ${SCHEMA}."RawPancakeOrder" (id text PRIMARY KEY,
             "landSeq" bigint NOT NULL DEFAULT nextval('${SCHEMA}."RawPancakeOrder_landSeq_seq"'))`,
        );
        await chay(
          `ALTER SEQUENCE ${SCHEMA}."RawPancakeOrder_landSeq_seq" OWNED BY ${SCHEMA}."RawPancakeOrder"."landSeq"`,
        );
        thuTu = await thuTuQuetKhongSapXep();
        if (thuTu[0] === "RawPancakeOrder_landSeq_seq") break;
      }
      expect(thuTu, "điều kiện tiên quyết: lượt quét không sắp xếp phải gặp sequence TRƯỚC bảng").toEqual([
        "RawPancakeOrder_landSeq_seq",
        "RawPancakeOrder",
      ]);
      const truoc = await ownerTheoTen();
      expect(truoc.RawPancakeOrder).not.toBe(ROLE_DICH);
      expect(truoc.RawPancakeOrder_landSeq_seq).not.toBe(ROLE_DICH);

      const r = chayTraOwner();
      expect(r.stderr).not.toMatch(/cannot change owner of sequence/);
      expect(r.status, r.stderr).toBe(0);
      expect(await ownerTheoTen()).toEqual({
        RawPancakeOrder: ROLE_DICH,
        RawPancakeOrder_landSeq_seq: ROLE_DICH,
      });
      expect(await ownerSchema()).toBe(ROLE_DICH);
    },
    HAN,
  );

  it(
    "serial (OWNED BY) + identity + sequence đứng lẻ + view ⇒ MỌI object về role đích, một lượt",
    async () => {
      await datLaiSchema();
      // `bigserial` ⇒ pg_depend 'a'; identity ⇒ pg_depend 'i' — cả hai đều bị cấm đổi owner lẻ.
      await chay(`CREATE TABLE ${SCHEMA}.a_serial (id bigserial PRIMARY KEY, ten text)`);
      await chay(`CREATE TABLE ${SCHEMA}.b_identity (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY)`);
      await chay(`CREATE SEQUENCE ${SCHEMA}.c_seq_dung_le`);
      await chay(`CREATE VIEW ${SCHEMA}.d_view AS SELECT id, ten FROM ${SCHEMA}.a_serial`);
      const truoc = await ownerTheoTen();
      expect(Object.keys(truoc).sort()).toEqual(
        ["a_serial", "a_serial_id_seq", "b_identity", "b_identity_id_seq", "c_seq_dung_le", "d_view"].sort(),
      );
      for (const owner of Object.values(truoc)) expect(owner).not.toBe(ROLE_DICH);

      const r = chayTraOwner();
      expect(r.stderr).not.toMatch(/cannot change owner of sequence/);
      expect(r.status, r.stderr).toBe(0);
      for (const [ten, owner] of Object.entries(await ownerTheoTen())) expect(owner, ten).toBe(ROLE_DICH);
      expect(await ownerSchema()).toBe(ROLE_DICH);
    },
    HAN,
  );

  it(
    "sequence có TÊN xếp trước bảng của nó (a_seq OWNED BY z_bang.id) ⇒ vẫn trả owner xong — sắp theo LOẠI, không theo tên",
    async () => {
      // Mọi tên Prisma sinh đều là `<bảng>_<cột>_seq` ⇒ xếp SAU bảng theo tên. Ca này chặn việc "rút gọn"
      // khoá sắp xếp về `ORDER BY c.relname`: tên sequence đứng trước tên bảng thì chỉ khoá
      // `(relkind = 'S')` mới đưa bảng lên trước.
      await datLaiSchema();
      await chay(`CREATE TABLE ${SCHEMA}.z_bang (id bigint NOT NULL)`);
      await chay(`CREATE SEQUENCE ${SCHEMA}.a_seq OWNED BY ${SCHEMA}.z_bang.id`);
      await chay(`ALTER TABLE ${SCHEMA}.z_bang ALTER COLUMN id SET DEFAULT nextval('${SCHEMA}.a_seq')`);
      const truoc = await ownerTheoTen();
      expect(Object.keys(truoc).sort()).toEqual(["a_seq", "z_bang"]);
      for (const owner of Object.values(truoc)) expect(owner).not.toBe(ROLE_DICH);

      const r = chayTraOwner();
      expect(r.stderr).not.toMatch(/cannot change owner of sequence/);
      expect(r.status, r.stderr).toBe(0);
      expect(await ownerTheoTen()).toEqual({ a_seq: ROLE_DICH, z_bang: ROLE_DICH });
      expect(await ownerSchema()).toBe(ROLE_DICH);
    },
    HAN,
  );
});
