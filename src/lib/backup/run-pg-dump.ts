import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { giay, HAN_PG_DUMP_MS, laLoiQuaHan, pgOptionsPhanh } from "./han-chay-lenh-pg";

const execFileAsync = promisify(execFile);

// pg_dump custom-format (-Fc) của cả DB có thể lớn — nới maxBuffer để không cắt cụt.
const MAX_DUMP_BYTES = 256 * 1024 * 1024; // 256MB

/**
 * Parse một Postgres connection URL thành các phần cho pg client CLI.
 *
 * EXPORTED — Task 5b's `restoreArgsFromUrl` MUST reuse this (đừng nhân bản logic
 * parse — DRY). `password`/`user` được `decodeURIComponent` để URL-encoded
 * `p%40ss` trở lại `p@ss`. `port` mặc định "5432" khi URL không ghi cổng; `db`
 * là pathname bỏ dấu "/" đầu.
 */
export function parsePgUrl(dbUrl: string): {
  host: string;
  port: string;
  user: string;
  db: string;
  password: string;
  schema: string;
} {
  const url = new URL(dbUrl);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    db: url.pathname.replace(/^\//, ""),
    password: decodeURIComponent(url.password),
    schema: url.searchParams.get("schema") || "public",
  };
}

/**
 * Dựng args cho `pg_dump` từ DATABASE_URL. Hàm THUẦN — unit-test không cần
 * Postgres. Trong prod, app là container `hogikids-app` nối `supabase-db` bằng
 * tên container nên host parse thẳng từ URL là `supabase-db` (KHÔNG ánh xạ host).
 */
export function pgDumpArgsFromUrl(dbUrl: string): { args: string[]; env: { PGPASSWORD: string } } {
  const { host, port, user, db, password, schema } = parsePgUrl(dbUrl);
  return {
    args: ["-h", host, "-p", port, "-U", user, "-d", db, "-n", schema, "-Fc"],
    env: { PGPASSWORD: password },
  };
}

/**
 * Chạy `pg_dump -Fc` cho DB trỏ bởi DATABASE_URL, trả về custom-format dump
 * dưới dạng Buffer. Image app BẮT BUỘC cài `postgresql-client-15` (khớp
 * `supabase-db` v15); app nối `-h supabase-db` cùng mạng docker. Lỗi (thiếu
 * binary / DB không tới được) → throw Error có message hữu ích để route trả 500.
 *
 * PHANH CHỐNG TREO: chỉ có MỘT, là `timeout` của `execFile` (xem `han-chay-lenh-pg.ts` để hiểu cả
 * cụm). `pg_dump` không có hạn tự thân, mà đây còn là bước BẢN LÙI của lượt phục hồi — nó treo là
 * khoá bảo trì không bao giờ được trả. `pg_dump` lấy ACCESS SHARE trên mọi bảng nên một câu DDL
 * đang giữ ACCESS EXCLUSIVE là đủ chặn nó vô hạn, và SIGTERM sau `HAN_PG_DUMP_MS` là thứ duy nhất
 * gỡ được.
 *
 * ⚠️ `PGOPTIONS` ở đây là NO-OP, giữ lại chỉ để mọi lệnh pg của app đi cùng một đường (test đếm
 * chéo trong `tests/unit/backup/han-chay-lenh-pg.test.ts` cũng chốt điều đó). ĐO THẬT prod
 * 01/08/2026: `pg_dump` tự chạy `SET statement_timeout = 0; SET lock_timeout = 0;` ngay sau khi
 * nối, nên KHÔNG nhận phanh tầng DB — chi tiết phép đo nằm ở `pgOptionsPhanh()`. Đừng viết lại
 * thành "PGOPTIONS chặn chờ khoá"; knob đúng nếu cần là cờ `--lock-wait-timeout` của pg_dump.
 */
export async function runPgDump(): Promise<Buffer> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL chưa được cấu hình — không thể sao lưu.");
  }

  const { args, env } = pgDumpArgsFromUrl(dbUrl);
  try {
    const { stdout } = await execFileAsync("pg_dump", args, {
      env: { ...process.env, ...env, PGOPTIONS: pgOptionsPhanh() },
      maxBuffer: MAX_DUMP_BYTES,
      encoding: "buffer",
      timeout: HAN_PG_DUMP_MS,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === "ENOENT") {
      throw new Error(
        "Không tìm thấy lệnh pg_dump — image app phải cài postgresql-client-15 khớp supabase-db.",
      );
    }
    // stderr thô (hostname DB, tên role, đường dẫn) CHỈ ra console server — KHÔNG được ghép vào
    // message ném lên trên: message đó chảy thẳng vào response `/api/backup` trả cho client.
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    if (stderr) console.error("pg_dump stderr:", stderr);
    // Quá hạn phải nói THẲNG là quá hạn: `execFile` giết bằng SIGTERM nên stderr thường rỗng, để
    // rơi vào nhánh chung sẽ ra "pg_dump thất bại (Command failed…)" — không chỉ được hướng nào.
    if (laLoiQuaHan(e)) {
      throw new Error(
        `pg_dump quá hạn ${giay(HAN_PG_DUMP_MS)} và đã bị dừng — DB không phản hồi hoặc đang bị ` +
          `khoá giữ lâu.`,
      );
    }
    console.error("pg_dump thất bại:", e.message);
    throw new Error("pg_dump thất bại — kiểm log server để biết chi tiết.");
  }
}
