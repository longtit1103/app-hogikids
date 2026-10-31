/**
 * Lối miễn cổng ghi: ghi được khi cờ bật (restore, backlog, SyncLog ERROR, trả lease việc nặng); op ghi ngoài lối miễn
 * vẫn bị chặn; CHỈ module trong danh sách cho phép được gọi `chayMienCong` (lưới import).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { chayMienCong, laLoiCongGhiDangKhoa, type LyDoMien } from "@/lib/backup/cong-ghi-toan-cuc";
import { giaHanKhoa, giuKhoaViecNang, traKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { hasBronzeBacklog, markBronzeBacklog } from "@/lib/bronze/bronze-only";
import { prisma } from "@/lib/prisma";

import { anhDuLieu, batCo, chayGocRieng, datLaiCongGhi, doiChieu, donDuLieu, k } from "./cong-ghi-helpers";

const KHOA_BACKLOG = "bronzeBacklogPending";
const KHOA_VIEC_NANG = "khoaViecNang";

beforeEach(async () => {
  await donDuLieu();
  await doiChieu.setting.deleteMany({ where: { key: { in: [KHOA_BACKLOG, KHOA_VIEC_NANG] } } });
});
afterEach(async () => {
  datLaiCongGhi();
  await doiChieu.setting.deleteMany({ where: { key: { in: [KHOA_BACKLOG, KHOA_VIEC_NANG] } } });
});
afterAll(async () => {
  await donDuLieu();
  await doiChieu.$disconnect();
});

/**
 * Module được bật lối miễn — mỗi mục một lý do. Thêm module mới vào đây phải qua review: lối miễn ghi
 * được VÀO GIỮA lượt phục hồi.
 */
const DUOC_MIEN: Readonly<Record<string, string>> = {
  "src/lib/backup/cong-ghi-toan-cuc.ts": "Nơi định nghĩa.",
  "src/app/api/restore/route.ts": "Chính lượt phục hồi (gia hạn lease, thu hồi phiên) sau khi giữ cờ.",
  "src/lib/bronze/bronze-only.ts": "markBronzeBacklog — lượt ingest bị cắt phải để lại cờ backlog.",
  "src/lib/ingest/sync-log.ts": "Kết cục SyncLog ERROR — lượt bị cắt phải để lại dấu lỗi.",
  "src/lib/backup/khoa-viec-nang.ts":
    "traKhoaViecNang — chỉ xoá lease đúng token của người gọi; chặn là lease kẹt tới hết hạn 5'.",
};

function quetTs(thuMuc: string): string[] {
  const ra: string[] = [];
  for (const ten of readdirSync(thuMuc)) {
    const p = path.join(thuMuc, ten);
    if (statSync(p).isDirectory()) {
      if (ten === "generated") continue;
      ra.push(...quetTs(p));
    } else if (/\.(ts|tsx)$/.test(ten)) ra.push(p);
  }
  return ra;
}

describe("lối miễn", () => {
  it.each<LyDoMien>(["restore", "backlog", "sync-log-error", "tra-khoa-viec-nang"])("lối miễn %s ghi được khi cờ bật (model + raw + tx)", async (lyDo) => {
    batCo();
    await chayGocRieng(() =>
      chayMienCong(lyDo, async () => {
        await prisma.setting.create({ data: { key: k(lyDo), value: "x" } });
        await prisma.$executeRaw`UPDATE "Setting" SET value = 'y' WHERE key = ${k(lyDo)}`;
        await prisma.$transaction(async (tx) => {
          await tx.setting.update({ where: { key: k(lyDo) }, data: { value: "z" } });
        });
      }),
    );
    expect(await anhDuLieu()).toEqual([`${k(lyDo)}=z`]);
  });

  it("lối miễn nhận thẳng PrismaPromise lười (không `await` trong fn) vẫn chạy TRONG ngữ cảnh", async () => {
    batCo();
    await chayGocRieng(() => chayMienCong("backlog", () => prisma.setting.create({ data: { key: k("luoi"), value: "x" } })));
    expect(await anhDuLieu()).toEqual([`${k("luoi")}=x`]);
  });

  it("markBronzeBacklog THẬT ghi được khi cờ bật, ngoài mọi cửa", async () => {
    batCo();
    await chayGocRieng(() => markBronzeBacklog());
    expect(await hasBronzeBacklog()).toBe(true);
  });

  it("traKhoaViecNang THẬT trả được lease khi cờ bật, ngoài mọi cửa — giành/gia hạn lease thì vẫn bị chặn", async () => {
    const gianh = await giuKhoaViecNang("việc nặng thử");
    if (!gianh.the) throw new Error("không giành được lease để dựng cảnh");
    const the = gianh.the;
    batCo();

    // Giành/gia hạn lease khi cờ bật = một việc nặng chưa được drain đếm muốn chạy tiếp ⇒ chặn.
    await expect(chayGocRieng(() => giuKhoaViecNang("việc nặng khác"))).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    await expect(chayGocRieng(() => giaHanKhoa(the))).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    // Trả lease của chính mình thì luôn được — chặn ở đây là lease kẹt tới hết hạn.
    await chayGocRieng(() => traKhoaViecNang(the));
    expect(await doiChieu.setting.findUnique({ where: { key: KHOA_VIEC_NANG } })).toBeNull();
  });

  it("traKhoaViecNang khi cờ bật KHÔNG gỡ lease của việc khác (chỉ đúng token người gọi)", async () => {
    const gianh = await giuKhoaViecNang("việc đang giữ");
    if (!gianh.the) throw new Error("không giành được lease để dựng cảnh");
    batCo();

    await chayGocRieng(() => traKhoaViecNang({ token: "token-cua-nguoi-khac", viec: "x" }));
    expect((await doiChieu.setting.findUnique({ where: { key: KHOA_VIEC_NANG } }))?.value).toContain(gianh.the.token);
  });

  it("ngoài lối miễn (cùng lúc) vẫn bị chặn", async () => {
    batCo();
    await expect(chayGocRieng(() => prisma.setting.create({ data: { key: k("khac"), value: "x" } }))).rejects.toSatisfy(laLoiCongGhiDangKhoa);
  });

  it("lưới import: chỉ module được liệt kê gọi `chayMienCong`", () => {
    const goc = process.cwd();
    const vi = quetTs(path.join(goc, "src"))
      .filter((f) => /\bchayMienCong\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(goc, f).split(path.sep).join("/"))
      .filter((f) => !Object.hasOwn(DUOC_MIEN, f));
    expect(vi).toEqual([]);
  });

  it("danh sách miễn không thừa (mục nào cũng còn gọi `chayMienCong`)", () => {
    const goc = process.cwd();
    for (const f of Object.keys(DUOC_MIEN)) {
      expect(readFileSync(path.join(goc, f), "utf8"), f).toMatch(/\bchayMienCong\b/);
    }
  });
});
