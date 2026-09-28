/**
 * Kiểm rằng CHỐT CHẶN file phục hồi vẫn NHẬN được bản dump do chính `pg_dump` trong ảnh này tạo ra.
 *
 * Vì sao cần: `Dockerfile` cài `postgresql-client-15` từ kho PGDG và CỐ Ý không ghim bản phụ — ghim
 * thì kho prune bản cũ là lệnh dựng ảnh gãy đúng lúc đang phục hồi thảm hoạ (lúc đó phải dựng lại
 * ảnh). Đổi lại, mỗi lần dựng ảnh có thể ra một đời `pg_dump` khác, và đời mới có thể phát ra cú
 * pháp mà chốt chặn chưa biết. Đã xảy ra một lần: bản vá bảo mật 08/2025 khiến `pg_dump` chèn
 * `\restrict`/`\unrestrict` vào mọi bản plain, và chốt chặn coi đó là file bị sửa tay ⇒ TỪ CHỐI
 * đúng file phục hồi của chính mình. Kiểu hỏng này im lặng cho tới lúc cần dùng nhất.
 *
 * Cách dùng — chạy TRONG container app, ngay sau khi dựng ảnh:
 *   docker compose run --rm app npx tsx scripts/kiem-chot-chan-nhan-dump-cua-chinh-minh.ts
 * Hoặc kiểm một file có sẵn:
 *   npx tsx scripts/kiem-chot-chan-nhan-dump-cua-chinh-minh.ts /duong/dan/file.sql[.gz] [schema]
 *
 * Thoát 0 = chốt chặn nhận file. Thoát 1 = chốt chặn TỪ CHỐI ⇒ đường phục hồi định dạng SQL đang
 * hỏng, phải cập nhật chốt chặn TRƯỚC khi tin vào bản sao lưu.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);

// Script standalone không đi qua Next auto-load .env (cùng lý do đã ghi ở scripts/rebuild-from-raw.ts).
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

/**
 * Tạo bản dump PLAIN từ DATABASE_URL, dùng lại đúng hàm dựng args của đường sao lưu thật (DRY —
 * đừng parse URL lần thứ hai; `?schema=` là tham số của Prisma, `pg_dump` không hiểu).
 * `--schema-only` để lượt kiểm nhanh và không kéo dữ liệu thật ra đĩa.
 */
async function tuTaoDumpPlain(): Promise<{ sql: string; schema: string }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("Thiếu DATABASE_URL — không biết chụp DB nào.");

  const { pgDumpArgsFromUrl, parsePgUrl } = await import("@/lib/backup/run-pg-dump");
  const { args, env } = pgDumpArgsFromUrl(dbUrl);
  const { schema } = parsePgUrl(dbUrl);

  // Đổi định dạng custom sang plain: chốt chặn đang kiểm là chốt của đường `.sql.gz`.
  const argsPlain = args.map((a) => (a === "-Fc" ? "-Fp" : a)).concat("--schema-only");
  const { stdout } = await execFileAsync("pg_dump", argsPlain, {
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { sql: stdout, schema };
}

async function main(): Promise<void> {
  const duongDan = process.argv[2];

  let sql: string;
  let schema: string;
  let nguon: string;

  if (duongDan) {
    const raw = readFileSync(duongDan);
    sql = duongDan.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    schema = process.argv[3] ?? "app";
    nguon = duongDan;
  } else {
    const ket = await tuTaoDumpPlain();
    sql = ket.sql;
    schema = ket.schema;
    nguon = "pg_dump của chính ảnh này";
  }

  const { assertPlainSqlOnlySchema } = await import("@/lib/backup/assert-plain-sql-only-schema");

  try {
    assertPlainSqlOnlySchema(sql, schema);
  } catch (err) {
    process.exitCode = 1;
    console.error(
      `CHỐT CHẶN TỪ CHỐI bản dump lấy từ ${nguon} — đường phục hồi định dạng SQL đang hỏng.\n` +
        `Lý do: ${err instanceof Error ? err.message : String(err)}\n` +
        `Nhiều khả năng bản pg_dump vừa đổi cú pháp. Cập nhật chốt chặn ở ` +
        `src/lib/backup/assert-plain-sql-only-schema.ts VÀ bản đối xứng trong deploy/restore.sh trước khi ` +
        `tin vào bản sao lưu.`,
    );
    return;
  }

  console.log(
    `Chốt chặn NHẬN bản dump từ ${nguon} (schema "${schema}", ${sql.split("\n").length} dòng) — ` +
      `đường phục hồi SQL còn thông.`,
  );
}

main().catch((err) => {
  process.exitCode = 1;
  console.error("LỖI:", err instanceof Error ? err.message : err);
});
