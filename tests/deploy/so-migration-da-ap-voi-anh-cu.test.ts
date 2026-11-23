import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { taoPrismaClient } from "@/lib/tao-prisma-client";

import { ketNoiPsql } from "../helpers/ket-noi-psql-khong-lo-mat-khau";

/**
 * `deploy/so-migration-da-ap-voi-anh-cu.sh` — bằng chứng "DB không có migration nào đã áp ngoài ảnh cũ" (runbook ③a-6,
 * KHI MIGRATION THẤT BẠI). Hợp đồng:
 *  - KHỚP (0) CHỈ khi tập (tên + checksum) đã áp THÀNH CÔNG trên DB = manifest của ĐÚNG ảnh đã ghim ID;
 *  - mọi ca khác (thiếu / hỏng `.deploy-vars`, ảnh không còn / khác ID, manifest lỗi / rỗng / sai dạng, truy vấn lỗi /
 *    rỗng, tên trùng, lệch tập hoặc lệch checksum) ⇒ CHƯA ĐỦ CĂN CỨ (2) — lệnh lỗi KHÔNG BAO GIỜ thành "khớp";
 *  - manifest đọc trong ảnh bằng `docker run --rm --network none --pull never` với ĐÚNG ID đã ghim;
 *  - dòng trống / dòng dở dang của migration khác landSeq / sort lỗi ⇒ CHƯA ĐỦ CĂN CỨ;
 *  - `DOCKER_CMD` / `PSQL_CMD` CHỈ được nhận trong chế độ thử tường minh — đường production thấy biến ⇒ TỪ CHỐI, không in giá trị.
 * `docker` giả chạy ĐÚNG đoạn node của script trên thư mục migration giả; psql THẬT trên DB nháp cùng server test.
 */

const SCRIPT = path.join(process.cwd(), "deploy/so-migration-da-ap-voi-anh-cu.sh");
const NHAP = "nhap_so_migration_anh_cu";
const ID = `sha256:${"a".repeat(64)}`;
const tam = mkdtempSync(path.join(tmpdir(), "so-migration-anh-cu-"));
const thuMucMig = path.join(tam, "migrations");
const ghiLuotGoi = path.join(tam, "docker-da-goi.txt");
const dockerGia = path.join(tam, "docker-gia.sh");
const fileVars = path.join(tam, "deploy-vars");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MIG = [
  { ten: "20261001000000_mot", sql: "SELECT 1;\n" },
  { ten: "20261002000000_hai", sql: "SELECT 2;\n" },
  { ten: "20261003000000_ba", sql: "SELECT 3;\n" },
];
const LAND_SEQ = "20261106150000_raw_pancake_order_land_seq";

/** docker giả: `image inspect` trả ID do test đặt; `run` ghi tham số rồi chạy đoạn node THẬT của script trên thư mục giả. */
writeFileSync(
  dockerGia,
  `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${ghiLuotGoi}"
if [ "$1" = image ]; then
  [ -n "\${GIA_INSPECT_LOI:-}" ] && exit 1
  printf '%s\\n' "\${GIA_ID_THAT:-${ID}}"; exit 0
fi
if [ "$1" = run ]; then
  if [ -n "\${GIA_RUN_MA:-}" ]; then printf '%s' "\${GIA_RUN_OUT:-}"; exit "$GIA_RUN_MA"; fi
  if [ -n "\${GIA_RUN_OUT+x}" ]; then printf '%s' "$GIA_RUN_OUT"; exit 0; fi
  while [ $# -gt 0 ]; do if [ "$1" = -e ]; then JS="$2"; break; fi; shift; done
  exec node -e "$JS" "${thuMucMig}"
fi
exit 99
`,
);
chmodSync(dockerGia, 0o755);

const psqlNhap = () => {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  return `psql -h ${u.hostname} -p ${u.port || "5432"} -U ${decodeURIComponent(u.username) || "postgres"} -d ${NHAP}`;
};
const chay = (env: Record<string, string> = {}, thamSo: string[] = [fileVars]) => {
  const r = spawnSync("bash", [SCRIPT, ...thamSo], {
    encoding: "utf8",
    env: { ...process.env, ...ketNoiPsql(process.env.TEST_DATABASE_URL!).env, HK_SO_MIGRATION_CHE_DO_THU: "1", DOCKER_CMD: dockerGia, PSQL_CMD: psqlNhap(), ...env },
  });
  return { ...r, tatCa: `${r.stdout}\n${r.stderr}` };
};

let nhap: PrismaClient;
const datMigrationDaAp = async (dong: { ten: string; checksum: string; xong?: boolean; lui?: boolean }[]) => {
  await nhap.$executeRawUnsafe(`TRUNCATE app._prisma_migrations`);
  for (const [i, d] of dong.entries()) {
    await nhap.$executeRawUnsafe(
      `INSERT INTO app._prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at)
       VALUES ($1, $2, $3, now(), $4, $5)`,
      `id${i}`,
      d.checksum,
      d.ten,
      d.xong === false ? null : new Date(),
      d.lui ? new Date() : null,
    );
  }
};
const dungMig = () => MIG.map((m) => ({ ten: m.ten, checksum: sha(m.sql) }));

beforeAll(async () => {
  const admin = taoPrismaClient(process.env.TEST_DATABASE_URL!);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${NHAP} WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE ${NHAP}`);
  } finally {
    await admin.$disconnect();
  }
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.pathname = `/${NHAP}`;
  u.search = "?schema=app";
  nhap = taoPrismaClient(u.toString());
  await nhap.$executeRawUnsafe(`CREATE SCHEMA app`);
  // Đúng các cột Prisma dùng ở `_prisma_migrations`.
  await nhap.$executeRawUnsafe(`CREATE TABLE app._prisma_migrations (id varchar(36) PRIMARY KEY,
    checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text,
    rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
}, 60_000);

afterAll(async () => {
  await nhap.$disconnect();
  const admin = taoPrismaClient(process.env.TEST_DATABASE_URL!);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${NHAP} WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
  rmSync(tam, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(thuMucMig, { recursive: true, force: true });
  mkdirSync(thuMucMig);
  for (const m of MIG) {
    mkdirSync(path.join(thuMucMig, m.ten));
    writeFileSync(path.join(thuMucMig, m.ten, "migration.sql"), m.sql);
  }
  writeFileSync(path.join(thuMucMig, "migration_lock.toml"), 'provider = "postgresql"\n');
  writeFileSync(fileVars, `OLD_HEAD=abc\nOLD_IMAGE_ID=${ID}\nROLLBACK_TAG=hogikids-app:rollback-abc\n`);
  writeFileSync(ghiLuotGoi, "");
  // Ca chuẩn: 3 migration đã áp; landSeq lỗi (finished_at NULL) + một lượt đã đánh dấu rolled back — đều KHÔNG tính.
  await datMigrationDaAp([
    ...dungMig(),
    { ten: LAND_SEQ, checksum: sha("x"), xong: false },
    { ten: LAND_SEQ, checksum: sha("x"), lui: true },
  ]);
});

const chuaDu = (r: ReturnType<typeof chay>, lyDo: RegExp) => {
  expect(r.status, r.tatCa).toBe(2);
  // Chế độ thử gắn nhãn vào CHÍNH dòng kết luận — không thể đọc nhầm là kết quả production.
  expect(r.stdout).toMatch(/KẾT LUẬN \[CHẾ ĐỘ THỬ — KHÔNG phải kết quả production\]: CHƯA ĐỦ CĂN CỨ — /);
  expect(r.tatCa).toMatch(lyDo);
  expect(r.tatCa).not.toMatch(/KẾT LUẬN[^\n]*: KHỚP/);
};

describe("so migration đã áp với manifest ảnh cũ", () => {
  it("KHỚP khi tập đã áp thành công = manifest (bỏ dòng lỗi / đã rolled back); manifest đọc từ ĐÚNG ảnh, không mạng, không kéo ảnh", () => {
    const r = chay();
    expect(r.status, r.tatCa).toBe(0);
    expect(r.stdout).toMatch(/đã áp thành công trên DB: 3 migration · manifest ảnh cũ: 3 migration/);
    expect(r.stdout).toMatch(
      /KẾT LUẬN \[CHẾ ĐỘ THỬ — KHÔNG phải kết quả production\]: KHỚP — tập bản ghi _prisma_migrations đã áp thành công \(3 dòng, tên \+ checksum\) = manifest ảnh cũ .*KHÔNG thay XÁC NHẬN schema \+ KIỂM PHIÊN, KHÔNG phải quyền tự lùi ảnh/,
    );
    const goi = readFileSync(ghiLuotGoi, "utf8");
    expect(goi).toContain(`image inspect -f {{.Id}} ${ID}`);
    expect(goi).toMatch(new RegExp(`^run --rm --network none --pull never --entrypoint node ${ID} -e `, "m"));
  });

  it("DB đã áp migration mà ảnh cũ KHÔNG có ⇒ CHƯA ĐỦ CĂN CỨ, in đúng dòng lệch", async () => {
    await datMigrationDaAp([...dungMig(), { ten: "20261105000000_khac", checksum: sha("khac") }]);
    const r = chay();
    chuaDu(r, /ĐÃ ÁP trên DB mà ảnh cũ KHÔNG có \(hoặc khác checksum\): 20261105000000_khac [0-9a-f]{64}\n/);
  });

  it("cùng tên nhưng lệch checksum ⇒ CHƯA ĐỦ CĂN CỨ", async () => {
    await datMigrationDaAp([...dungMig().slice(0, 2), { ten: MIG[2].ten, checksum: sha("ban-khac") }]);
    chuaDu(chay(), new RegExp(`ĐÃ ÁP trên DB .*: ${MIG[2].ten} ${sha("ban-khac")}`));
  });

  it("ảnh cũ có migration mà DB chưa áp ⇒ CHƯA ĐỦ CĂN CỨ (không chỉ kiểm một chiều)", async () => {
    await datMigrationDaAp(dungMig().slice(0, 2));
    chuaDu(chay(), new RegExp(`ảnh cũ có mà DB CHƯA áp .*: ${MIG[2].ten} `));
  });

  it("tên trùng trong các dòng đã áp ⇒ CHƯA ĐỦ CĂN CỨ", async () => {
    await datMigrationDaAp([...dungMig(), dungMig()[0]]);
    chuaDu(chay(), /TRÙNG: 20261001000000_mot/);
  });

  it("DB không có dòng đã áp nào (truy vấn thoát 0, rỗng) ⇒ CHƯA ĐỦ CĂN CỨ, không phải khớp", async () => {
    await datMigrationDaAp([]);
    chuaDu(chay(), /truy vấn _prisma_migrations RỖNG/);
    // Chỉ có dòng dở dang / đã cuộn lại (không dòng nào áp thành công) ⇒ danh sách đã áp RỖNG.
    await datMigrationDaAp([{ ten: LAND_SEQ, checksum: sha("x"), xong: false }, { ten: LAND_SEQ, checksum: sha("x"), lui: true }]);
    chuaDu(chay(), /danh sách migration đã áp trên DB RỖNG/);
  });

  it("psql lỗi (bảng không có / thoát khác 0) ⇒ CHƯA ĐỦ CĂN CỨ — lệnh lỗi KHÔNG đọc thành 0 dòng", () => {
    const psqlLoi = path.join(tam, "psql-loi.sh");
    writeFileSync(psqlLoi, "#!/usr/bin/env bash\necho 'psql: error: connection refused' >&2\nexit 2\n");
    chmodSync(psqlLoi, 0o755);
    chuaDu(chay({ PSQL_CMD: psqlLoi }), /truy vấn _prisma_migrations LỖI \(psql thoát 2\)/);
    // psql THẬT, schema sai ⇒ lỗi SQL ⇒ ON_ERROR_STOP ⇒ thoát 3.
    chuaDu(chay({ PSQL_CMD: psqlNhap().replace(NHAP, "postgres") }), /truy vấn _prisma_migrations LỖI \(psql thoát [1-9]\)/);
  });

  it("manifest: docker run lỗi / rỗng / sai dạng / thư mục thiếu migration.sql ⇒ CHƯA ĐỦ CĂN CỨ", () => {
    chuaDu(chay({ GIA_RUN_MA: "125" }), /lấy manifest migration từ ảnh cũ LỖI \(docker run thoát 125\)/);
    chuaDu(chay({ GIA_RUN_MA: "1", GIA_RUN_OUT: `${MIG[0].ten} ${sha(MIG[0].sql)}\n` }), /docker run thoát 1/);
    chuaDu(chay({ GIA_RUN_OUT: "" }), /manifest ảnh cũ RỖNG/);
    chuaDu(chay({ GIA_RUN_OUT: "khong phai dong manifest\n" }), /manifest ảnh cũ có dòng sai dạng/);
    mkdirSync(path.join(thuMucMig, "20261004000000_thieu_file"));
    chuaDu(chay(), /lấy manifest migration từ ảnh cũ LỖI/);
  });

  it(".deploy-vars thiếu / hỏng / ID không đầy đủ / nhiều dòng; ảnh không còn hoặc khác ID ⇒ CHƯA ĐỦ CĂN CỨ, không chạy docker run", () => {
    const ca: [string | null, Record<string, string>, RegExp][] = [
      [null, {}, /không đọc được file/],
      ["OLD_HEAD=abc\n", {}, /không có dòng OLD_IMAGE_ID/],
      ["OLD_IMAGE_ID=sha256:abc\n", {}, /không phải ID đầy đủ/],
      [`OLD_IMAGE_ID=${ID}\nOLD_IMAGE_ID=${ID}\n`, {}, /NHIỀU dòng OLD_IMAGE_ID/],
      [`OLD_IMAGE_ID=${ID}\n`, { GIA_INSPECT_LOI: "1" }, /không tra được ảnh/],
      [`OLD_IMAGE_ID=${ID}\n`, { GIA_ID_THAT: `sha256:${"b".repeat(64)}` }, /≠ ID đã ghim/],
    ];
    for (const [noiDung, env, lyDo] of ca) {
      if (noiDung === null) rmSync(fileVars, { force: true });
      else writeFileSync(fileVars, noiDung);
      writeFileSync(ghiLuotGoi, "");
      chuaDu(chay(env), lyDo);
      expect(readFileSync(ghiLuotGoi, "utf8")).not.toMatch(/^run /m);
    }
  });

  it("dòng DỞ DANG: landSeq lỗi chỉ in (vẫn KHỚP); migration KHÁC dở dang ⇒ CHƯA ĐỦ CĂN CỨ", async () => {
    const r = chay();
    expect(r.status, r.tatCa).toBe(0);
    expect(r.stdout).toContain(`dòng dở dang (dự kiến khi migration landSeq lỗi): ${LAND_SEQ}`);
    await datMigrationDaAp([...dungMig(), { ten: "20261104000000_dang_do", checksum: sha("d"), xong: false }]);
    chuaDu(chay(), /DỞ DANG của migration khác landSeq: 20261104000000_dang_do/);
  });

  it("dòng TRỐNG trong manifest hoặc trong đầu ra psql ⇒ CHƯA ĐỦ CĂN CỨ (không bị vòng tách dòng nuốt)", () => {
    const d = dungMig().map((m) => `${m.ten} ${m.checksum}`);
    chuaDu(chay({ GIA_RUN_OUT: `${d[0]}\n\n${d[1]}\n${d[2]}\n` }), /manifest ảnh cũ có dòng TRỐNG/);
    chuaDu(chay({ GIA_RUN_OUT: `\n${d.join("\n")}\n` }), /manifest ảnh cũ có dòng TRỐNG/);
    const psqlTrong = path.join(tam, "psql-dong-trong.sh");
    writeFileSync(psqlTrong, `#!/usr/bin/env bash\nprintf 'A|%s\\n\\nA|%s\\nA|%s\\n' '${d[0]}' '${d[1]}' '${d[2]}'\n`);
    chmodSync(psqlTrong, 0o755);
    chuaDu(chay({ PSQL_CMD: psqlTrong }), /đầu ra truy vấn _prisma_migrations có dòng TRỐNG/);
    // Dòng mang nhãn lạ (không A| / D| / R|) ⇒ đầu ra lạ, không bỏ qua.
    const psqlLa = path.join(tam, "psql-dong-la.sh");
    writeFileSync(psqlLa, `#!/usr/bin/env bash\nprintf 'A|%s\\nX|%s\\nA|%s\\n' '${d[0]}' '${d[1]}' '${d[2]}'\n`);
    chmodSync(psqlLa, 0o755);
    chuaDu(chay({ PSQL_CMD: psqlLa }), /có dòng lạ: 'X\|20261002000000_hai/);
  });

  it("sort lỗi ở bước so tập (chỉ hỏng với dòng 'tên checksum') ⇒ CHƯA ĐỦ CĂN CỨ, dù DB lệch manifest", async () => {
    const thuMucSort = path.join(tam, "sort-gia");
    mkdirSync(thuMucSort, { recursive: true });
    const sortThat = spawnSync("bash", ["-c", "command -v sort"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      path.join(thuMucSort, "sort"),
      `#!/usr/bin/env bash\nin="$(cat)"\ncase "$in" in *" "*) exit 2;; esac\nprintf '%s\\n' "$in" | "${sortThat}" "$@"\n`,
    );
    chmodSync(path.join(thuMucSort, "sort"), 0o755);
    await datMigrationDaAp([...dungMig(), { ten: "20261105000000_khac", checksum: sha("khac") }]);
    chuaDu(chay({ PATH: `${thuMucSort}:${process.env.PATH}` }), /sort danh sách DB LỖI/);
  });

  it("đường production (không bật chế độ thử): DOCKER_CMD / PSQL_CMD bị đặt ⇒ TỪ CHỐI 64, KHÔNG in giá trị, không gọi lệnh nào", () => {
    const bimat = "postgresql://ai:mat-khau-bi-mat@host-bi-mat:5432/db";
    for (const bien of [{ PSQL_CMD: `psql ${bimat}` }, { DOCKER_CMD: dockerGia }, { DOCKER_CMD: "" }] as Record<string, string>[]) {
      writeFileSync(ghiLuotGoi, "");
      // Env tự dựng: CHỈ một biến thay lệnh, KHÔNG bật chế độ thử (đúng ca biến sót lại trong shell vận hành).
      const env = { ...process.env, ...bien } as NodeJS.ProcessEnv;
      delete env.HK_SO_MIGRATION_CHE_DO_THU;
      if (!("DOCKER_CMD" in bien)) delete env.DOCKER_CMD;
      if (!("PSQL_CMD" in bien)) delete env.PSQL_CMD;
      const k = spawnSync("bash", [SCRIPT, fileVars], { encoding: "utf8", env });
      const r = { ...k, tatCa: `${k.stdout}\n${k.stderr}` };
      expect(r.status, r.tatCa).toBe(64);
      expect(r.tatCa).toMatch(/TỪ CHỐI: biến DOCKER_CMD \/ PSQL_CMD đang được đặt \(giá trị không in\)/);
      expect(r.tatCa).not.toContain("mat-khau-bi-mat");
      expect(r.tatCa).not.toContain("host-bi-mat");
      expect(r.tatCa).not.toMatch(/KẾT LUẬN/);
      expect(readFileSync(ghiLuotGoi, "utf8")).toBe("");
    }
  });

  it("đọc _prisma_migrations bằng ĐÚNG MỘT lượt psql (một snapshot — đã áp + dở dang không thể lệch nhau)", () => {
    const dem = path.join(tam, "psql-dem.txt");
    const psqlDem = path.join(tam, "psql-dem.sh");
    writeFileSync(psqlDem, `#!/usr/bin/env bash\necho x >> "${dem}"\nexec psql "$@"\n`);
    chmodSync(psqlDem, 0o755);
    writeFileSync(dem, "");
    const r = chay({ PSQL_CMD: psqlNhap().replace(/^psql /, `${psqlDem} `) });
    expect(r.status, r.tatCa).toBe(0);
    expect(readFileSync(dem, "utf8")).toBe("x\n");
  });

  it("thiếu / thừa tham số ⇒ 64", () => {
    expect(chay({}, []).status).toBe(64);
    expect(chay({}, [fileVars, "thua"]).status).toBe(64);
  });
});
