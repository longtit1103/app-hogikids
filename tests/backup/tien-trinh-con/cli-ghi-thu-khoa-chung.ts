/**
 * Tiến trình CLI THẬT cho `tests/backup/khoa-chung-cli-hai-tien-trinh.test.ts`. Chạy bằng
 * `node --import tsx tests/backup/tien-trinh-con/cli-ghi-thu-khoa-chung.ts <che-do>` với
 * `CLI_GHI_THU=1`, `DATABASE_URL` = DB test và KHÔNG có `VITEST` trong env. Phát sự kiện JSON từng dòng.
 *
 * Dùng singleton `@/lib/prisma` THẬT (cổng ghi + khoá chung CLI trong `taoPrismaClient`) — đúng đường
 * mọi script `scripts/**` đi.
 *
 * Chế độ:
 *  - `ghi-roi-cho`        : ghi 1 dòng (giành khoá shared) → `da-ghi` + pid kết nối khoá → chờ stdin `thoat`.
 *  - `ghi-mot`            : ghi 1 dòng; bị chặn ⇒ `bi-chan`, exit 3.
 *  - `ghi-lien-tuc`       : ghi liên tục (giá trị = clock_timestamp() của DB) tới khi chết.
 *  - `ghi-cham`           : như trên nhưng mỗi lệnh ghi kéo ~500ms (lệnh đang bay lúc khoá tuột).
 *  - `ghi-roi-disconnect` : ghi 1 dòng → `$disconnect()` → `da-nha` → chờ stdin `thoat` (tiến trình còn sống).
 */
import type pg from "pg";

const url = process.env.DATABASE_URL;
// Hàng rào DB: chỉ chạy trên DB test — sai thì thoát TRƯỚC khi dựng bất kỳ kết nối nào.
if (process.env.CLI_GHI_THU !== "1" || !url || new URL(url).pathname !== "/hogikids_test") {
  console.error("cli-ghi-thu-khoa-chung: từ chối — cần CLI_GHI_THU=1 và DATABASE_URL trỏ đúng /hogikids_test");
  process.exit(2);
}

const bao = (su_kien: string, them: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ su_kien, ...them })}\n`);

async function main(): Promise<void> {
  const { cheDoKhoaCli } = await import("@/lib/tao-prisma-client");
  // Chống xanh giả: tiến trình con PHẢI ở chế độ khoá CLI (không miễn như Vitest).
  bao("che-do", { khoaCli: cheDoKhoaCli(), coVitest: process.env.VITEST !== undefined });
  if (!cheDoKhoaCli()) process.exit(4);

  const { prisma } = await import("@/lib/prisma");
  const { clientKhoaCliNeuCo, LoiCliDangPhucHoi } = await import("@/lib/backup/khoa-chung-cli");
  const che = process.argv[2];
  const khoa = (ten: string) => `cong-ghi-test:cli:${ten}`;
  const pidCua = async (c: pg.Client) => (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  // KHÔNG tự giành khoá ở đây (đột biến "bỏ giành khoá" phải lộ ra): chỉ đọc pid nếu client đã giành.
  const pidKhoa = async () => {
    const c = await clientKhoaCliNeuCo();
    return c ? pidCua(c) : null;
  };
  const choThoat = () =>
    new Promise<void>((r) =>
      process.stdin.on("data", (d) => {
        if (String(d).includes("thoat")) r();
      }),
    );

  try {
    if (che === "ghi-mot") {
      await prisma.setting.create({ data: { key: khoa(`mot:${process.pid}`), value: "x" } });
      bao("da-ghi", { pidKhoa: await pidKhoa() });
    } else if (che === "ghi-roi-cho") {
      await prisma.setting.create({ data: { key: khoa(`cho:${process.pid}`), value: "x" } });
      bao("da-ghi", { pidKhoa: await pidKhoa() });
      await choThoat();
      process.stdin.destroy();
    } else if (che === "ghi-roi-disconnect") {
      await prisma.setting.create({ data: { key: khoa(`dc:${process.pid}`), value: "x" } });
      bao("da-ghi", { pidKhoa: await pidKhoa() });
      await prisma.$disconnect();
      bao("da-nha", { pidKhoa: await pidKhoa() });
      await choThoat();
      process.stdin.destroy();
      return;
    } else if (che === "ghi-lien-tuc") {
      for (let i = 0; ; i++) {
        await prisma.$executeRaw`INSERT INTO "Setting" (key, value) VALUES (${khoa(`lt:${process.pid}:${i}`)}, clock_timestamp()::text)`;
        if (i === 0) bao("dang-ghi", { pidKhoa: await pidKhoa() });
      }
    } else if (che === "ghi-cham") {
      for (let i = 0; ; i++) {
        await prisma.$executeRaw`INSERT INTO "Setting" (key, value)
          SELECT ${khoa(`cham:${process.pid}:${i}`)}, clock_timestamp()::text FROM pg_sleep(0.5)`;
        if (i === 0) bao("dang-ghi", { pidKhoa: await pidKhoa() });
      }
    } else {
      throw new Error(`chế độ lạ: ${che}`);
    }
  } catch (e) {
    if (e instanceof LoiCliDangPhucHoi) {
      bao("bi-chan", { loi: e.message });
      process.exit(3);
    }
    throw e;
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
