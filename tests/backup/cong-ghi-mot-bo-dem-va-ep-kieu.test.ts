/**
 * MỘT bộ đếm / cờ / ALS / client cho cả tiến trình dù module bị nạp thành NHIỀU bản sao.
 *
 * Next nạp module thành nhiều bản trong cùng tiến trình (bundle server action ≠ bundle route handler) —
 * bằng chứng chạy thật trên `next build && next start` nằm ở spike (commit `48bbbff2`,
 * báo cáo kết luận spike cổng ghi (`spike-cong-ghi-ket-luan.md` trong `plans/`), tiêu chí 9).
 * Ở đây là lưới hồi quy cho việc NEO `globalThis`: `vi.resetModules()` + import lại = bản module thứ
 * hai; bỏ neo (trạng thái thành biến module) ⇒ bản hai thấy bộ đếm 0 / client khác ⇒ đỏ.
 *
 * Kèm lưới tĩnh: đúng MỘT ép kiểu client (`as unknown as PrismaClient`) trong `src/`, và `prisma.ts`
 * không còn neo có điều kiện theo `NODE_ENV`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { batCo, chayGocRieng, datLaiCongGhi, taoBarrier } from "./cong-ghi-helpers";

afterEach(() => datLaiCongGhi());

describe("neo globalThis — hai bản module, một trạng thái", () => {
  it("bộ đếm, cờ và ngữ cảnh cửa dùng chung giữa hai bản `cong-ghi-toan-cuc`", async () => {
    const banA = await import("@/lib/backup/cong-ghi-toan-cuc");
    vi.resetModules();
    const banB = await import("@/lib/backup/cong-ghi-toan-cuc");
    expect(banB).not.toBe(banA); // đúng là hai bản module

    // Request vào cửa ở bản A ("bundle action") ⇒ bản B ("bundle route") thấy đếm = 1.
    const b = taoBarrier();
    const req = chayGocRieng(async () => {
      const cua = banA.vaoCuaGhi();
      if (!cua.ok) throw new Error("cửa A từ chối");
      try {
        await b.cho();
        // Ngữ cảnh gắn bởi bản A phải được bản B nhận là ngữ cảnh sống (ALS chung).
        return await banB.canOpGhi("thu", async () => "qua");
      } finally {
        cua.ra();
      }
    });
    await b.daToi;
    expect(banB.docBoDem().soRequest).toBe(1);

    // Cờ do phía "route" bật ⇒ cửa ở bản kia từ chối.
    batCo();
    expect(banA.vaoCuaGhi()).toMatchObject({ ok: false });
    expect((await chayGocRieng(() => banB.routeQuaCua(async () => new Response("ok")))).status).toBe(503);

    // Drain ở bản B chờ request đang mở ở bản A.
    let drainXong = false;
    const drain = banB.choDrain(30_000).then((ok) => {
      drainXong = true;
      return ok;
    });
    await new Promise((r) => setImmediate(r));
    expect(drainXong).toBe(false);
    b.mo();
    expect(await req).toBe("qua");
    expect(await drain).toBe(true);
    expect(banA.docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
  });

  it("singleton `prisma` là MỘT client cho mọi bản module `@/lib/prisma`", async () => {
    const banA = await import("@/lib/prisma");
    vi.resetModules();
    const banB = await import("@/lib/prisma");
    expect(banB).not.toBe(banA);
    expect(banB.prisma).toBe(banA.prisma);
  });

  it("lỗi cổng dựng ở bản A vẫn được bản B nhận diện (`laLoiCongGhiDangKhoa`), dù `instanceof` chéo bản sai", async () => {
    const banA = await import("@/lib/backup/cong-ghi-toan-cuc");
    vi.resetModules();
    const banB = await import("@/lib/backup/cong-ghi-toan-cuc");
    expect(banB).not.toBe(banA);

    // Lỗi thật do cổng của bản A ném (cờ bật, không ngữ cảnh).
    batCo();
    const loi = await chayGocRieng(() => banA.canOpGhi("thu", async () => "khong-toi")).catch((e: unknown) => e);
    expect(banB.laLoiCongGhiDangKhoa(loi)).toBe(true);
    expect(banA.laLoiCongGhiDangKhoa(loi)).toBe(true);

    // Lỗi thường / giá trị lạ không bị nhận nhầm.
    expect(banB.laLoiCongGhiDangKhoa(new Error(String((loi as Error).message)))).toBe(false);
    expect(banB.laLoiCongGhiDangKhoa(null)).toBe(false);
    expect(banB.laLoiCongGhiDangKhoa("LoiCongGhiDangKhoa")).toBe(false);
  });
});

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

describe("lưới tĩnh — ép kiểu client + neo singleton", () => {
  it("đúng MỘT `as unknown as PrismaClient` trong src/, nằm ở tao-prisma-client.ts", () => {
    const goc = process.cwd();
    const cho = quetTs(path.join(goc, "src")).flatMap((f) => {
      const n = (readFileSync(f, "utf8").match(/as\s+unknown\s+as\s+PrismaClient\b/g) ?? []).length;
      return n > 0 ? [[path.relative(goc, f).split(path.sep).join("/"), n] as const] : [];
    });
    expect(cho).toEqual([["src/lib/tao-prisma-client.ts", 1]]);
  });

  it("module cổng ghi KHÔNG export giá trị class lỗi nào — không còn gì để `instanceof`/so `constructor` (kể cả qua alias)", async () => {
    const m: Record<string, unknown> = await import("@/lib/backup/cong-ghi-toan-cuc");
    const lopLoi = Object.entries(m)
      .filter(([, v]) => typeof v === "function" && (v as { prototype?: unknown }).prototype instanceof Error)
      .map(([ten]) => ten);
    expect(lopLoi).toEqual([]);
    expect(Object.hasOwn(m, "LoiCongGhiDangKhoa")).toBe(false);
  });

  it("không chỗ nào trong src/ nhận diện lỗi cổng bằng `instanceof LoiCongGhiDangKhoa` (sai chéo bản module)", () => {
    const goc = process.cwd();
    const sai = quetTs(path.join(goc, "src"))
      .filter((f) => /instanceof\s+LoiCongGhiDangKhoa\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(goc, f).split(path.sep).join("/"));
    expect(sai).toEqual([]);
  });

  it("prisma.ts neo globalThis VÔ ĐIỀU KIỆN (không còn nhánh NODE_ENV) và bật cổng ghi", () => {
    const ma = readFileSync(path.join(process.cwd(), "src/lib/prisma.ts"), "utf8");
    expect(ma).not.toMatch(/NODE_ENV/);
    expect(ma).toMatch(/globalForPrisma\.prisma \?\?=/);
    expect(ma).toMatch(/congGhi:\s*true/);
  });
});
