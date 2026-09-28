import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CHỐT FENCING NẰM TRONG `runRestore` — chặn đúng khoảng mà chốt ở route với tới.
 *
 * Route kiểm quyền giữ khoá ngay trước khi gọi `runRestore`, nhưng giữa câu kiểm đó và lệnh phá huỷ
 * ĐẦU TIÊN vẫn còn `writeFile` (đĩa), `gunzipAsync` (zlib) và `pg_restore -l`. Mấy bước file/zlib
 * KHÔNG có hạn ở tầng Node — `BIEN_NGOAI_LENH_MS` chỉ là số cộng vào TTL, không phải timeout. Treo
 * đủ lâu là TTL nhả cờ, lượt khác giành khoá, rồi lượt này tỉnh dậy vẫn drop + nạp chồng lên.
 *
 * Suite này chốt hai điều, cho CẢ HAI định dạng backup:
 *  1. `truocKhiPhaHuy` được gọi TRƯỚC lệnh phá huỷ đầu tiên (`pg_restore <dump>` ở custom,
 *     `DROP SCHEMA` ở plain) — ném trong callback thì không lệnh nào trong số đó chạy.
 *  2. Nhánh plain ghi file tạm TRƯỚC `DROP SCHEMA`. Thứ tự cũ (drop rồi mới ghi file) đặt một bước
 *     không-có-hạn vào GIỮA chuỗi phá huỷ: treo ở đó là schema đã sạch mà dữ liệu chưa vào.
 *
 * Không chạy pg thật: chặn ở `execFile`, và ghi mọi việc-có-thật-sự-xảy-ra vào một nhật ký chung để
 * so được THỨ TỰ giữa thao tác file và lệnh DB.
 */
const gia = vi.hoisted(() => {
  const nhatKy: string[] = [];
  return { nhatKy };
});

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, kq?: { stdout: string; stderr: string }) => void,
  ) => {
    const sql = args.includes("-c") ? (args[args.indexOf("-c") + 1] ?? "") : "";
    if (args[0] === "-l") gia.nhatKy.push("pg_restore doc-muc-luc");
    else if (/DROP\s+SCHEMA/i.test(sql)) gia.nhatKy.push("DROP SCHEMA");
    else if (/GRANT/i.test(sql)) gia.nhatKy.push("GRANT n8n");
    else if (/has_database_privilege/i.test(sql)) gia.nhatKy.push("hoi quyen tao schema");
    else if (args.includes("-f")) gia.nhatKy.push("nap psql -f");
    else gia.nhatKy.push("nap pg_restore");
    // `has_database_privilege` phải trả 't', nếu không `donSchemaChoDumpPlain` dừng trước khi drop.
    cb(null, { stdout: /has_database_privilege/i.test(sql) ? "t" : "", stderr: "" });
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const that = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...that,
    default: that,
    writeFile: vi.fn(async (duongDan: string) => {
      gia.nhatKy.push(`ghi file tam ${String(duongDan).endsWith(".sql") ? "sql" : "dump"}`);
    }),
    unlink: vi.fn(async () => {
      gia.nhatKy.push("don file tam");
    }),
  };
});

import { runRestore } from "@/lib/backup/run-restore";

/** File `.dump` hợp lệ ở mức magic — đủ để `runRestore` đi vào nhánh custom. */
const DUMP = Buffer.from("PGDMP\x01noi-dung-gia");

/** `.sql.gz` hợp lệ: chỉ đụng schema đích, không chạm schema hệ thống Supabase. */
const SQL_GZ = gzipSync(Buffer.from('CREATE TABLE "app"."Thu" (id integer);\n'));

/** Lệnh nào trong nhật ký là PHÁ HUỶ dữ liệu — thứ tuyệt đối không được chạy sau khi mất khoá. */
function coLenhPhaHuy(): boolean {
  return gia.nhatKy.some((b) => b === "DROP SCHEMA" || b.startsWith("nap "));
}

beforeEach(() => {
  gia.nhatKy.length = 0;
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@db-gia:5432/postgres?schema=app");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runRestore — chốt `truocKhiPhaHuy` chặn trước lệnh phá huỷ đầu tiên", () => {
  it("custom: callback ném → đã đọc mục lục nhưng KHÔNG nạp", async () => {
    const loi = new Error("mat khoa");
    await expect(runRestore(DUMP, { truocKhiPhaHuy: () => { throw loi } })).rejects.toBe(loi);

    expect(gia.nhatKy).toContain("pg_restore doc-muc-luc"); // bước chuẩn bị, chỉ đọc file
    expect(coLenhPhaHuy()).toBe(false);
    expect(gia.nhatKy).not.toContain("GRANT n8n"); // lỗi lan ra, không chạy nốt phần sau
  });

  it("plain: callback ném → KHÔNG drop, KHÔNG nạp", async () => {
    const loi = new Error("mat khoa");
    await expect(runRestore(SQL_GZ, { truocKhiPhaHuy: () => { throw loi } })).rejects.toBe(loi);

    expect(coLenhPhaHuy()).toBe(false);
    // Kể cả câu SELECT hỏi quyền (chạy ngay trước DROP trong cùng hàm) cũng chưa được gọi: chốt
    // đứng trước cả cụm `donSchemaChoDumpPlain`, không nằm lọt giữa nó.
    expect(gia.nhatKy).not.toContain("hoi quyen tao schema");
  });

  it("plain: ghi file tạm TRƯỚC `DROP SCHEMA` — không để bước không-có-hạn nằm giữa chuỗi phá huỷ", async () => {
    await runRestore(SQL_GZ, {});

    const iGhiFile = gia.nhatKy.indexOf("ghi file tam sql");
    const iDrop = gia.nhatKy.indexOf("DROP SCHEMA");
    const iNap = gia.nhatKy.indexOf("nap psql -f");
    expect(iGhiFile).toBeGreaterThanOrEqual(0);
    expect(iDrop).toBeGreaterThan(iGhiFile); // thứ tự cũ (drop trước, ghi file sau) làm ca này đỏ
    expect(iNap).toBeGreaterThan(iDrop);
  });

  it("còn giữ khoá (callback không ném) thì cả hai nhánh chạy trọn, GRANT đứng NGAY SAU lệnh nạp", async () => {
    // Thứ tự `nạp → GRANT → dọn file tạm` là có chủ đích: `unlink` không có hạn ở tầng Node, để nó
    // chen vào giữa là mở thêm một cửa sổ mà lượt này có thể mất khoá rồi mới chạy GRANT lên schema
    // của lượt khác. Assertion so cả mảng nên đảo lại thứ tự cũ là ca này đỏ.
    const chot = vi.fn();

    await expect(runRestore(DUMP, { truocKhiPhaHuy: chot })).resolves.toEqual({ format: "custom" });
    expect(gia.nhatKy).toEqual([
      "ghi file tam dump",
      "pg_restore doc-muc-luc",
      "nap pg_restore",
      "GRANT n8n",
      "don file tam",
    ]);

    gia.nhatKy.length = 0;
    await expect(runRestore(SQL_GZ, { truocKhiPhaHuy: chot })).resolves.toEqual({ format: "plain-gzip" });
    expect(gia.nhatKy).toEqual([
      "ghi file tam sql",
      "hoi quyen tao schema",
      "DROP SCHEMA",
      "nap psql -f",
      "GRANT n8n",
      "don file tam",
    ]);

    expect(chot).toHaveBeenCalledTimes(2); // đúng MỘT lần mỗi lượt
  });

  it("không truyền callback (chỗ gọi cũ) vẫn chạy bình thường", async () => {
    await expect(runRestore(DUMP)).resolves.toEqual({ format: "custom" });
    expect(gia.nhatKy).toContain("nap pg_restore");
  });

  // Hook nay ASYNC (route gia hạn khoá việc nặng trong DB tại chốt) — hai điểm gọi PHẢI `await`.
  // Cách phân biệt await-thật với gọi-suông: hook reject SAU MỘT NHỊP CHỜ THẬT (macrotask). Điểm
  // gọi nào bỏ `await` thì rejection thành mồ côi, lệnh nạp/drop cứ thế chạy và `runRestore`
  // resolve thành công — cả hai assertion dưới đỏ ngay. Callback đồng bộ ném (các case trên)
  // KHÔNG bắt được lỗi này.
  it("custom: hook async reject sau một nhịp chờ → lỗi LAN RA và KHÔNG nạp (bỏ await là đỏ)", async () => {
    const loi = new Error("mat khoa viec nang");
    await expect(
      runRestore(DUMP, {
        truocKhiPhaHuy: async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw loi;
        },
      }),
    ).rejects.toBe(loi);

    expect(gia.nhatKy).toContain("pg_restore doc-muc-luc"); // đã qua bước chuẩn bị chỉ-đọc
    expect(coLenhPhaHuy()).toBe(false);
  });

  it("plain: hook async reject sau một nhịp chờ → lỗi LAN RA, KHÔNG drop, KHÔNG nạp (bỏ await là đỏ)", async () => {
    const loi = new Error("mat khoa viec nang");
    await expect(
      runRestore(SQL_GZ, {
        truocKhiPhaHuy: async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw loi;
        },
      }),
    ).rejects.toBe(loi);

    expect(coLenhPhaHuy()).toBe(false);
    expect(gia.nhatKy).not.toContain("hoi quyen tao schema");
  });

  it("hook async chạy XONG rồi lệnh phá huỷ mới bắt đầu — thứ tự ghi trong nhật ký", async () => {
    // Chốt thứ tự bằng nhật ký chung: hook đánh dấu SAU một macrotask; điểm gọi bỏ `await` thì
    // lệnh nạp (mock execFile chạy đồng bộ) vào sổ TRƯỚC dấu của hook ⇒ so index là đỏ.
    await expect(
      runRestore(DUMP, {
        truocKhiPhaHuy: async () => {
          await new Promise((r) => setTimeout(r, 5));
          gia.nhatKy.push("chot gia han xong");
        },
      }),
    ).resolves.toEqual({ format: "custom" });

    const iChot = gia.nhatKy.indexOf("chot gia han xong");
    const iNap = gia.nhatKy.indexOf("nap pg_restore");
    expect(iChot).toBeGreaterThanOrEqual(0);
    expect(iNap).toBeGreaterThan(iChot);
  });
});
