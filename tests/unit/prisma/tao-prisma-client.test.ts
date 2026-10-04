import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cauHinhKetNoiTuUrl, taoPrismaClient } from "@/lib/tao-prisma-client";

/**
 * Nhà máy `PrismaClient` (Prisma 7, driver `pg`). Driver `pg` KHÔNG hiểu `?schema=app` — quên dịch là
 * câu raw SQL viết tên bảng trần (`"Setting"`, `"Loan" … FOR UPDATE`) rơi về schema `public`. Suite
 * này chốt phép dịch (hàm thuần, không mở kết nối) và chốt bằng MÁY rằng không ai dựng client trần.
 */

describe("cauHinhKetNoiTuUrl — dịch URL kiểu Prisma 6 sang pg", () => {
  it("?schema=app ⇒ adapter schema app + search_path app; tham số riêng Prisma bị bóc khỏi URL", () => {
    const { schema, pool } = cauHinhKetNoiTuUrl("postgresql://u:p%40ss@db-host:5432/hogikids_test?schema=app");
    expect(schema).toBe("app");
    expect(pool.options).toBe("-c search_path=app -c TimeZone=UTC");
    const u = new URL(pool.connectionString);
    expect(u.searchParams.has("schema")).toBe(false);
    expect(u.pathname).toBe("/hogikids_test");
    expect(u.password).toBe("p%40ss"); // không giải mã/đổi mật khẩu
  });

  it("không khai schema ⇒ public (mặc định Prisma 6)", () => {
    const { schema, pool } = cauHinhKetNoiTuUrl("postgresql://u:p@h:5432/postgres");
    expect(schema).toBe("public");
    expect(pool.options).toBe("-c search_path=public -c TimeZone=UTC");
  });

  it("mặc định pool khớp Prisma 6: chờ kết nối hữu hạn 10s, giữ kết nối rảnh 300s, không giới hạn tuổi", () => {
    const { pool } = cauHinhKetNoiTuUrl("postgresql://u:p@h:5432/db?schema=app");
    expect(pool.connectionTimeoutMillis).toBe(10_000);
    expect(pool.idleTimeoutMillis).toBe(300_000);
    expect(pool.maxLifetimeSeconds).toBe(0);
    expect(pool.max).toBeUndefined(); // để pg tự chọn (10)
    expect(pool.allowExitOnIdle).toBe(true);
  });

  it("dịch connection_limit / tuổi kết nối (khoá độc quyền DB test cần đúng 1 kết nối sống lâu)", () => {
    const { pool } = cauHinhKetNoiTuUrl(
      "postgresql://u:p@h:5432/db_test?schema=app&connection_limit=1&max_connection_lifetime=86400&max_idle_connection_lifetime=86400&pool_timeout=20",
    );
    expect(pool.max).toBe(1);
    expect(pool.maxLifetimeSeconds).toBe(86_400);
    expect(pool.idleTimeoutMillis).toBe(86_400_000);
    expect(pool.connectionTimeoutMillis).toBe(20_000);
    const u = new URL(pool.connectionString);
    for (const ten of ["connection_limit", "max_connection_lifetime", "max_idle_connection_lifetime", "pool_timeout"]) {
      expect(u.searchParams.has(ten)).toBe(false);
    }
  });

  it("giữ options sẵn có — nối search_path vào sau", () => {
    const { pool } = cauHinhKetNoiTuUrl(
      "postgresql://u:p@h:5432/db?schema=app&sslmode=disable&options=-c%20statement_timeout%3D5000",
    );
    // `options` PHẢI bị bóc khỏi URL: pg cho tham số trong URL đè field cùng tên ⇒ mất search_path.
    expect(new URL(pool.connectionString).searchParams.has("options")).toBe(false);
    expect(pool.options).toBe("-c statement_timeout=5000 -c search_path=app -c TimeZone=UTC");
  });

  it("múi giờ phiên ép UTC và đứng SAU options sẵn có (Postgres áp -c theo thứ tự, cái sau thắng)", () => {
    const { pool } = cauHinhKetNoiTuUrl("postgresql://u:p@h:5432/db?schema=app&options=-c%20TimeZone%3DAsia%2FHo_Chi_Minh");
    expect(pool.options).toBe("-c TimeZone=Asia/Ho_Chi_Minh -c search_path=app -c TimeZone=UTC");
    expect(pool.options.endsWith("-c TimeZone=UTC")).toBe(true);
  });

  it.each(["socket_timeout=10", "pgbouncer=true", "statement_cache_size=0", "sslaccept=strict", "sslidentity=/tmp/id.p12", "sslpassword=x"])(
    "từ chối tham số chỉ Prisma 6 hiểu (pg bỏ qua im lặng): %s",
    (thamSo) => {
      const ten = thamSo.split("=")[0];
      expect(() => cauHinhKetNoiTuUrl(`postgresql://u:p@h:5432/db?schema=app&${thamSo}`)).toThrow(
        new RegExp(`"${ten}".*chỉ Prisma 6 hiểu`),
      );
    },
  );

  // Đo 01/10 trên Postgres 15 bật TLS chứng chỉ tự ký (pg_stat_ssl): không khai / disable ⇒ TLS false;
  // require ⇒ TLS true, nối được; verify-full ⇒ "self-signed certificate". Để `pg-connection-string` tự hiểu
  // thì `require` = kiểm đầy đủ ⇒ DB tự ký từ chối nối (khác Prisma 6).
  it.each([
    ["(không khai)", "", false],
    ["disable", "&sslmode=disable", false],
    ["require — TLS, KHÔNG kiểm chứng chỉ (như Prisma 6)", "&sslmode=require", { rejectUnauthorized: false }],
    ["verify-full — TLS + kiểm chứng chỉ", "&sslmode=verify-full", { rejectUnauthorized: true }],
  ])("sslmode %s ⇒ dịch tường minh sang ssl của pg, bóc khỏi URL", (_ten, them, mongDoi) => {
    const { pool } = cauHinhKetNoiTuUrl(`postgresql://u:p@h:5432/db?schema=app${them}`);
    expect(pool.ssl).toEqual(mongDoi);
    // Còn trong URL thì `pg-connection-string` dựng `ssl` riêng ĐÈ lên bản dịch (tham số URL thắng).
    expect(new URL(pool.connectionString).searchParams.has("sslmode")).toBe(false);
  });

  it("mỗi lần dịch trả object ssl riêng (pg giữ tham chiếu theo kết nối — không chia sẻ hằng)", () => {
    const a = cauHinhKetNoiTuUrl("postgresql://u:p@h/db?sslmode=require").pool.ssl;
    const b = cauHinhKetNoiTuUrl("postgresql://u:p@h/db?sslmode=require").pool.ssl;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it.each(["prefer", "allow", "verify-ca", "no-verify", "REQUIRE", ""])(
    "sslmode=%s ⇒ từ chối (fail-closed) thay vì đổi nghĩa im lặng",
    (gt) => {
      expect(() => cauHinhKetNoiTuUrl(`postgresql://u:p@h:5432/db?schema=app&sslmode=${gt}`)).toThrow(
        /sslmode=.*không hợp lệ.*disable.*require.*verify-full/,
      );
    },
  );

  it.each(["ssl=true", "sslcert=/x.crt", "sslkey=/x.key", "sslrootcert=/ca.crt", "uselibpqcompat=true"])(
    "tham số TLS mà pg tự dựng ssl riêng (đè bản dịch) ⇒ từ chối: %s",
    (thamSo) => {
      const ten = thamSo.split("=")[0];
      expect(() => cauHinhKetNoiTuUrl(`postgresql://u:p@h:5432/db?schema=app&sslmode=require&${thamSo}`)).toThrow(
        new RegExp(`"${ten}".*chưa được hỗ trợ`),
      );
    },
  );

  it.each([
    ["schema viết hoa", "postgresql://u:p@h/db?schema=App"],
    ["schema chèn ký tự lạ", "postgresql://u:p@h/db?schema=app%3Bdrop"],
    ["connection_limit=0", "postgresql://u:p@h/db?connection_limit=0"],
    ["số âm", "postgresql://u:p@h/db?pool_timeout=-1"],
    ["không phải số", "postgresql://u:p@h/db?max_idle_connection_lifetime=abc"],
  ])("từ chối tham số sai: %s", (_ten, url) => {
    expect(() => cauHinhKetNoiTuUrl(url)).toThrow(/không hợp lệ/);
  });
});

describe("taoPrismaClient — thiếu URL", () => {
  it("dựng được (next build không có DATABASE_URL) nhưng truy vấn ném lỗi rõ, không để pg tự đoán host", async () => {
    const client = taoPrismaClient(undefined);
    await expect(client.user.count()).rejects.toThrow(/Chưa có URL database/);
  });
});

describe("taoPrismaClient — tuỳ chọn logTruyVan (script đo/kiểm)", () => {
  it("bật sự kiện query: $on nhận đúng câu SQL, và options `default_transaction_read_only` trong URL sống cùng search_path", async () => {
    const goc = new URL(process.env.DATABASE_URL ?? "");
    goc.searchParams.set("options", "-c default_transaction_read_only=on");
    const client = taoPrismaClient(goc.toString(), { logTruyVan: true });
    const cau: string[] = [];
    client.$on("query", (e) => cau.push(e.query));
    try {
      const [r] = await client.$queryRaw<{ ro: string; sp: string }[]>`
        SELECT current_setting('default_transaction_read_only') AS ro, current_setting('search_path') AS sp`;
      expect(r?.ro).toBe("on");
      expect(r?.sp).toContain(goc.searchParams.get("schema") ?? "public");
      expect(cau.some((q) => /default_transaction_read_only/.test(q))).toBe(true);
    } finally {
      await client.$disconnect();
    }
  });
});

/**
 * LƯỚI: `new PrismaClient(` chỉ được xuất hiện trong `src/lib/tao-prisma-client.ts`. Client dựng trần
 * ở chỗ khác sẽ KHÔNG có adapter (Prisma 7 ném lúc dựng) — hoặc có adapter tự chế quên `search_path`,
 * và câu raw SQL lặng lẽ chạy sai schema. Đọc MÃ NGUỒN: ta kiểm CÁI CHỮ.
 */
describe("không dựng PrismaClient ngoài nhà máy", () => {
  const GOC = path.resolve(__dirname, "../../..");
  const THU_MUC = ["src", "scripts", "tests", "prisma"];
  // Các file ĐƯỢC PHÉP mang chữ đó: chính nhà máy, file test này (chữ nằm trong chú thích/regex), và
  // client GIẢ LẬP lỗi driver cho test — dựng trên pool `pg` bị thay `query`/`connect`, không bao giờ
  // chạm DB nên không có `search_path` nào để quên.
  const DUOC_PHEP = new Set([
    path.join("src", "lib", "tao-prisma-client.ts"),
    path.join("tests", "unit", "prisma", "tao-prisma-client.test.ts"),
    path.join("tests", "helpers", "prisma-client-gia-lap-loi-driver.ts"),
  ]);

  function quet(thuMuc: string, ra: string[]): void {
    for (const ten of readdirSync(thuMuc)) {
      const p = path.join(thuMuc, ten);
      if (statSync(p).isDirectory()) {
        // Client sinh ra (`src/generated`) tự chứa ví dụ `new PrismaClient(` trong chú thích.
        if (path.relative(GOC, p) === path.join("src", "generated")) continue;
        quet(p, ra);
      } else if (/\.(ts|tsx|mts|cts)$/.test(ten)) {
        ra.push(p);
      }
    }
  }

  it("mọi `new PrismaClient(` nằm trong tao-prisma-client.ts", () => {
    const tep: string[] = [];
    for (const d of THU_MUC) quet(path.join(GOC, d), tep);
    const vi = tep
      .filter((p) => !DUOC_PHEP.has(path.relative(GOC, p)))
      .filter((p) => /new\s+PrismaClient\s*\(/.test(readFileSync(p, "utf8")))
      .map((p) => path.relative(GOC, p));
    expect(vi).toEqual([]);
  });
});
