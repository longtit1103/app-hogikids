import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cổng "dump đời trước phân quyền" (spec §7.4) đi qua ĐÚNG đường phục hồi thật — `runRestore` với
 * `pg_restore` thật đọc fixture, và `POST /api/restore` — chứ không chỉ gọi parser.
 *
 * Dump chụp trước migration phân quyền (M1) mà nạp qua giao diện thì mất cột vai trò/quyền, app mở
 * ra không còn chủ shop ⇒ PHẢI chặn TRƯỚC `truocKhiPhaHuy` (chốt cuối trước lệnh phá huỷ), cả hai
 * định dạng: `.dump` (nhánh custom đọc mục lục, không bung SQL) lẫn `.sql.gz`.
 *
 * AN TOÀN DB TEST: `runRestore` bị bọc sao cho callback `truocKhiPhaHuy` LUÔN ném `DungTest` sau khi
 * chạy callback gốc ⇒ dù cổng hỏng, không lượt nào tới được `pg_restore --clean`/`DROP SCHEMA`.
 * Test "file mới qua cổng" dựa đúng vào đó: tới được chốt = đã qua cổng.
 */

const { DungTest } = vi.hoisted(() => ({
  DungTest: class DungTest extends Error {
    constructor() {
      super("dừng test ngay trước lệnh phá huỷ");
      this.name = "DungTest";
    }
  },
}));

vi.mock("@/lib/backup/run-restore", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/backup/run-restore");
  return {
    ...real,
    // Passthrough có spy: ca STAFF 403 phải chứng minh route chưa đọc nội dung file.
    kiemDumCoM1: vi.fn(real.kiemDumCoM1),
    runRestore: vi.fn((buf: Buffer, opts: Parameters<typeof real.runRestore>[1] = {}) =>
      real.runRestore(buf, {
        truocKhiPhaHuy: async () => {
          await opts.truocKhiPhaHuy?.();
          throw new DungTest();
        },
      }),
    ),
  };
});

vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return { ...that, docNguoiDungPhien: vi.fn(async () => nguoiDungGia()) };
});

// Passthrough có spy: ca "cổng chạy TRƯỚC khoá" phải chứng minh route CHƯA giành khoá bảo trì lẫn
// khoá việc nặng — đọc cờ sau request là vô nghĩa vì `finally` đã trả cả hai.
vi.mock("@/lib/backup/khoa-bao-tri", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/backup/khoa-bao-tri");
  return { ...real, thuGiuKhoaPhucHoi: vi.fn(real.thuGiuKhoaPhucHoi) };
});
vi.mock("@/lib/backup/khoa-viec-nang", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/backup/khoa-viec-nang");
  return { ...real, giuKhoaViecNang: vi.fn(real.giuKhoaViecNang) };
});

// Bản lùi pre-restore: không chạy `pg_dump` thật (chậm, không thuộc thứ cần đo).
vi.mock("@/lib/backup/run-pg-dump", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/backup/run-pg-dump")),
  runPgDump: vi.fn(async () => Buffer.from("PGDMP-ban-lui-gia")),
}));

// Route ghi bản lùi vào `/backups` (đường tuyệt đối trong container) — trên máy dev là EACCES. Chỉ
// chặn đường `/backups`; file tạm của `runRestore` (os.tmpdir) đi đường thật vì `pg_restore` đọc nó.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("node:fs/promises");
  const laBackups = (p: unknown) => String(p).startsWith("/backups");
  return {
    ...real,
    mkdir: vi.fn(async (p: string, ...rest: unknown[]) =>
      laBackups(p) ? undefined : (real.mkdir as (...a: unknown[]) => unknown)(p, ...rest),
    ),
    writeFile: vi.fn(async (p: string, ...rest: unknown[]) =>
      laBackups(p) ? undefined : (real.writeFile as (...a: unknown[]) => unknown)(p, ...rest),
    ),
    readdir: vi.fn(async (p: string, ...rest: unknown[]) =>
      laBackups(p) ? [] : (real.readdir as (...a: unknown[]) => unknown)(p, ...rest),
    ),
  };
});

import { POST } from "@/app/api/restore/route";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { giuKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { LoiBackupTruocPhanQuyen } from "@/lib/backup/kiem-migration-trong-dump";
import { kiemDumCoM1, runRestore } from "@/lib/backup/run-restore";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";

/** Chuỗi 422 của spec §7.4 — chép nguyên văn để khoá hợp đồng với modal phục hồi. */
const LOI_422 =
  "Bản backup chụp trước bản phân quyền (hoặc migration chưa hoàn tất) — phục hồi qua quy trình " +
  "trên host, mục 'Phục hồi dump đời trước phân quyền' của runbook";

const THU_MUC_FIXTURE = join(__dirname, "fixtures", "backup");
const docFixture = (ten: string): Buffer => readFileSync(join(THU_MUC_FIXTURE, ten));

const FILE_CU = ["truoc-m1.dump", "truoc-m1.sql.gz"] as const;
const FILE_MOI = ["sau-m1.dump", "sau-m1.sql.gz"] as const;

async function demUserVaDon(): Promise<{ user: number; don: number }> {
  return { user: await prisma.user.count(), don: await prisma.order.count() };
}

function reqCoFile(bytes: Buffer, ten: string): Request {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], ten));
  return new Request("http://localhost/api/restore", { method: "POST", body: fd });
}

afterEach(() => {
  donKhoaPhucHoi();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("runRestore — chặn dump đời trước phân quyền ở cả hai định dạng", () => {
  it.each(FILE_CU)("%s ⇒ ném LoiBackupTruocPhanQuyen, KHÔNG tới chốt phá huỷ, DB nguyên", async (ten) => {
    const truoc = await demUserVaDon();
    const chot = vi.fn();

    const loi = await runRestore(docFixture(ten), { truocKhiPhaHuy: chot }).catch((e: unknown) => e);

    expect(loi).toBeInstanceOf(LoiBackupTruocPhanQuyen);
    expect((loi as Error).message).toBe(LOI_422);
    expect(chot).not.toHaveBeenCalled();
    expect(await demUserVaDon()).toEqual(truoc);
  });

  it.each(FILE_MOI)("%s ⇒ qua cổng, tới đúng chốt phá huỷ", async (ten) => {
    const truoc = await demUserVaDon();
    const chot = vi.fn();

    const loi = await runRestore(docFixture(ten), { truocKhiPhaHuy: chot }).catch((e: unknown) => e);

    expect(loi).toBeInstanceOf(DungTest);
    expect(chot).toHaveBeenCalledTimes(1);
    expect(await demUserVaDon()).toEqual(truoc);
  });
});

describe("POST /api/restore — cổng chủ shop + 422 cho dump đời trước phân quyền", () => {
  beforeEach(() => {
    vi.mocked(docNguoiDungPhien).mockReset().mockResolvedValue(nguoiDungGia());
    vi.mocked(runPgDump).mockClear();
    vi.mocked(runRestore).mockClear(); // `clearMocks: false` toàn repo — lịch sử gọi cộng dồn qua các ca
  });

  it.each(FILE_CU)("%s ⇒ 422 đúng chuỗi, không thay dữ liệu", async (ten) => {
    const truoc = await demUserVaDon();

    const res = await POST(reqCoFile(docFixture(ten), ten));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: LOI_422 });
    expect(await demUserVaDon()).toEqual(truoc);
  });

  it("tài khoản nhân sự (STAFF) ⇒ 403, không chụp bản lùi, không đọc file", async () => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia({ id: "test-staff", role: "STAFF" }));
    vi.mocked(kiemDumCoM1).mockClear();

    try {
      const res = await POST(reqCoFile(docFixture("sau-m1.dump"), "sau-m1.dump"));

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("KHONG_CO_QUYEN");
      expect(vi.mocked(runPgDump)).not.toHaveBeenCalled();
      expect(vi.mocked(runRestore)).not.toHaveBeenCalled();
      // "Không đọc file" = cổng sớm (bước đầu tiên chạm nội dung file) chưa bao giờ được gọi.
      expect(vi.mocked(kiemDumCoM1)).not.toHaveBeenCalled();
    } finally {
      await prisma.auditLog.deleteMany({ where: { actorId: "test-staff" } });
    }
  });

  it("chưa đăng nhập ⇒ 401", async () => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(null);

    const res = await POST(reqCoFile(docFixture("sau-m1.dump"), "sau-m1.dump"));

    expect(res.status).toBe(401);
  });
});

/**
 * Cổng phải chạy TRƯỚC mọi bước tốn kém/phá huỷ của route: khoá bảo trì, khoá việc nặng, `pg_dump`
 * bản lùi và prune. Chạy sau thì mỗi lần chủ shop chọn nhầm file đời cũ, route chụp một bản lùi rác
 * rồi prune đẩy một bản lùi THẬT (giữ 3 bản) ra ngoài — nhầm đủ 3 lần là mất sạch lưới an toàn của
 * các lượt phục hồi trước.
 *
 * `BACKUP_DIR` trỏ thư mục tạm có sẵn 3 bản lùi giả: đếm file trước/sau là đo trực tiếp thứ bị mất.
 */
describe("POST /api/restore — cổng dump đời trước phân quyền chạy TRƯỚC khoá và bản lùi", () => {
  const BAN_LUI_CU = [
    "pre-restore-20260901-000000-aaaaaa.dump",
    "pre-restore-20260902-000000-bbbbbb.dump",
    "pre-restore-20260903-000000-cccccc.dump",
  ];
  let thuMucBackup: string;
  let backupDirCu: string | undefined;

  beforeEach(() => {
    backupDirCu = process.env.BACKUP_DIR;
    thuMucBackup = mkdtempSync(join(tmpdir(), "hogikids-restore-backup-"));
    for (const ten of BAN_LUI_CU) writeFileSync(join(thuMucBackup, ten), "ban-lui-that");
    process.env.BACKUP_DIR = thuMucBackup;
    vi.mocked(docNguoiDungPhien).mockReset().mockResolvedValue(nguoiDungGia());
    vi.mocked(runPgDump).mockClear();
    vi.mocked(runRestore).mockClear();
    vi.mocked(thuGiuKhoaPhucHoi).mockClear();
    vi.mocked(giuKhoaViecNang).mockClear();
  });

  afterEach(() => {
    if (backupDirCu === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = backupDirCu;
    rmSync(thuMucBackup, { recursive: true, force: true });
  });

  it.each(FILE_CU)("%s ⇒ 422, không giành khoá, không chụp bản lùi, 3 bản lùi cũ còn nguyên", async (ten) => {
    const res = await POST(reqCoFile(docFixture(ten), ten));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: LOI_422 });
    expect(vi.mocked(thuGiuKhoaPhucHoi)).not.toHaveBeenCalled();
    expect(vi.mocked(giuKhoaViecNang)).not.toHaveBeenCalled();
    expect(vi.mocked(runPgDump)).not.toHaveBeenCalled();
    expect(vi.mocked(runRestore)).not.toHaveBeenCalled();
    expect(readdirSync(thuMucBackup).sort()).toEqual(BAN_LUI_CU);
  });

  it("file .dump hỏng (pg_restore không đọc được) ⇒ 400 ngay ở cổng sớm, không khoá, không bản lùi", async () => {
    const res = await POST(reqCoFile(Buffer.from("PGDMP\x01khong-phai-dump-that"), "hong.dump"));

    // 400 chứ không 500: chưa đụng gì ⇒ modal nói "dữ liệu hiện tại vẫn nguyên vẹn", không xui đi
    // lùi bản `pre-restore-*.dump`.
    expect(res.status).toBe(400);
    expect(vi.mocked(thuGiuKhoaPhucHoi)).not.toHaveBeenCalled();
    expect(vi.mocked(runPgDump)).not.toHaveBeenCalled();
    expect(readdirSync(thuMucBackup).sort()).toEqual(BAN_LUI_CU);
  });

  // File KHÔNG phải backup của app (schema khác, hoặc nhiều schema). Cả 4 file đều mang
  // `_prisma_migrations` có M1 hoàn tất (xem README fixture) ⇒ chỉ guard schema chạy TRƯỚC cổng M1
  // mới trả đúng câu: `schema-khac` mà kiểm M1 trước là 422 "đời trước phân quyền" (chỉ sai sang
  // runbook host); `nhieu-schema` có `app._prisma_migrations` đời mới nên lọt cổng M1, giành khoá,
  // chụp bản lùi rồi prune đẩy một bản lùi THẬT ra ngoài trước khi guard trong `runRestore` chặn.
  const CAU_GUARD_CUSTOM =
    "Dump chứa object ngoài schema 'app': khac — TỪ CHỐI để không đè dữ liệu hệ thống Supabase.";
  const CAU_GUARD_PLAIN =
    "SQL CREATE SCHEMA 'khac' ≠ 'app' — TỪ CHỐI (nghi dump full-DB / đè schema hệ thống).";
  const FILE_LA: [string, string][] = [
    ["schema-khac.dump", CAU_GUARD_CUSTOM],
    ["nhieu-schema.dump", CAU_GUARD_CUSTOM],
    ["schema-khac.sql.gz", CAU_GUARD_PLAIN],
    ["nhieu-schema.sql.gz", CAU_GUARD_PLAIN],
  ];

  it.each(FILE_LA)(
    "%s ⇒ 400 đúng câu guard schema (không 422), không khoá, không bản lùi, 3 bản lùi cũ còn nguyên",
    async (ten, cau) => {
      const truoc = await demUserVaDon();

      const res = await POST(reqCoFile(docFixture(ten), ten));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: cau });
      expect(vi.mocked(thuGiuKhoaPhucHoi)).not.toHaveBeenCalled();
      expect(vi.mocked(giuKhoaViecNang)).not.toHaveBeenCalled();
      expect(vi.mocked(runPgDump)).not.toHaveBeenCalled();
      expect(vi.mocked(runRestore)).not.toHaveBeenCalled();
      expect(readdirSync(thuMucBackup).sort()).toEqual(BAN_LUI_CU);
      expect(await demUserVaDon()).toEqual(truoc);
    },
  );

  it.each(FILE_MOI)("%s ⇒ qua cổng sớm, đi tiếp tới bản lùi + chốt phá huỷ (dừng bằng DungTest)", async (ten) => {
    const res = await POST(reqCoFile(docFixture(ten), ten));

    // DungTest ném ở chốt phá huỷ ⇒ nhánh 500 chung của route: chứng minh đã đi hết các bước trước.
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("dừng test ngay trước lệnh phá huỷ");
    expect(vi.mocked(thuGiuKhoaPhucHoi)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(giuKhoaViecNang)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runPgDump)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runRestore)).toHaveBeenCalledTimes(1);
    // Bản lùi mới ghi vào đúng `BACKUP_DIR`, prune giữ 3 ⇒ bản cũ nhất bị đẩy ra — xác nhận thư mục
    // đo ở ca trên đúng là thư mục route ghi (không thì "còn nguyên" xanh vô nghĩa).
    const sau = readdirSync(thuMucBackup).sort();
    expect(sau).toHaveLength(3);
    expect(sau.slice(0, 2)).toEqual(BAN_LUI_CU.slice(1));
    expect(sau[2]).toMatch(/^pre-restore-\d{8}-\d{6}-[0-9a-f]{6}\.dump$/);
  });
});
