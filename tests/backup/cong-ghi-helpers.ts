/**
 * Helper chung cho `tests/backup/cong-ghi-*.test.ts`.
 *
 * - Dữ liệu thử nằm trong bảng `Setting`, khoá tiền tố `cong-ghi-test:` (DB test, dọn sau mỗi test).
 * - `prisma` (singleton THẬT, có cổng) là đối tượng được kiểm. `doiChieu` là client KHÔNG cổng (dựng
 *   qua `taoPrismaClient` không tuỳ chọn — Vitest miễn khoá CLI) chỉ để đọc/dọn kể cả khi cờ bật.
 * - `datLaiCongGhi()` trả trạng thái toàn cục (bộ đếm, người chờ drain, ALS, cờ) về sạch — gọi ở
 *   `afterEach`: trạng thái neo `globalThis` nên một test hỏng giữa chừng sẽ rò sang test sau và làm
 *   cả file đỏ dây chuyền (đo ở spike).
 */
import type { AsyncLocalStorage } from "node:async_hooks";

import { thuGiuKhoaPhucHoi, traKhoaPhucHoi, type ThePhienPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { taoPrismaClient } from "@/lib/tao-prisma-client";

import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";

export const TIEN_TO = "cong-ghi-test:";
export const k = (ten: string) => `${TIEN_TO}${ten}`;

/** Client đối chiếu KHÔNG cổng — đọc/dọn dữ liệu thử kể cả khi cờ đang bật. */
export const doiChieu = taoPrismaClient(process.env.DATABASE_URL);

export async function donDuLieu(): Promise<void> {
  await doiChieu.setting.deleteMany({ where: { key: { startsWith: TIEN_TO } } });
}

export async function anhDuLieu(): Promise<string[]> {
  const rows = await doiChieu.setting.findMany({ where: { key: { startsWith: TIEN_TO } }, orderBy: { key: "asc" } });
  return rows.map((r) => `${r.key}=${r.value}`);
}

let theDangGiu: ThePhienPhucHoi | null = null;

/** Bật cờ phục hồi THẬT (`khoa-bao-tri.ts`). */
export function batCo(): ThePhienPhucHoi {
  const the = thuGiuKhoaPhucHoi();
  if (!the) throw new Error("cờ phục hồi đang bị giữ từ test trước");
  theDangGiu = the;
  return the;
}

export function traCoNeuCon(): void {
  if (theDangGiu) traKhoaPhucHoi(theDangGiu);
  theDangGiu = null;
}

type TrangThaiCongTho = {
  als: AsyncLocalStorage<unknown>;
  soRequest: number;
  soOpLe: number;
  nguoiCho: Set<() => void>;
  dangDrain: boolean;
};

/** Trả cổng ghi + cờ về sạch. Đọc thẳng ô `globalThis` (cùng khoá `Symbol.for` với mã thật). */
export function datLaiCongGhi(): void {
  traCoNeuCon();
  donKhoaPhucHoi();
  const st = (globalThis as unknown as Record<symbol, TrangThaiCongTho | undefined>)[Symbol.for("hogikids.congGhi")];
  if (!st) return;
  st.soRequest = 0;
  st.soOpLe = 0;
  st.nguoiCho.clear();
  st.dangDrain = false;
  st.als.disable();
}

/** Barrier thủ công: `cho()` treo tới khi `mo()`; `daToi` báo đã có ai đứng chờ. */
export function taoBarrier() {
  let mo!: () => void;
  const p = new Promise<void>((r) => (mo = r));
  let baoToi!: () => void;
  const daToi = new Promise<void>((r) => (baoToi = r));
  return {
    cho: () => {
      baoToi();
      return p;
    },
    mo: () => mo(),
    daToi,
  };
}

/** Promise đã settle chưa — xả hết microtask + vài vòng macrotask (không đoán giờ). */
export async function daSettle(p: Promise<unknown>): Promise<boolean> {
  let xong = false;
  p.then(
    () => (xong = true),
    () => (xong = true),
  );
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return xong;
}

/**
 * Chạy `fn` ở một GỐC async riêng (như một request HTTP mới tới) — ngữ cảnh ALS của đoạn mã gọi
 * KHÔNG chảy vào, và `enterWith` bên trong `fn` không rò ra đoạn mã gọi.
 */
export function chayGocRieng<T>(fn: () => Promise<T>): Promise<T> {
  const st = (globalThis as unknown as Record<symbol, TrangThaiCongTho | undefined>)[Symbol.for("hogikids.congGhi")];
  return new Promise<T>((resolve, reject) => {
    const lich = () =>
      setImmediate(() => {
        fn().then(resolve, reject);
      });
    // `als.exit`: lên lịch từ một khung KHÔNG ngữ cảnh — `setImmediate` mang theo khung lúc lên lịch.
    if (st) st.als.exit(lich);
    else lich();
  });
}

/** Chờ điều kiện (soi trạng thái, không đoán giờ); quá 10s ⇒ ném. */
export async function choDen(dk: () => boolean): Promise<void> {
  const het = Date.now() + 10_000;
  while (!dk()) {
    if (Date.now() > het) throw new Error("chờ điều kiện quá 10s");
    await new Promise((r) => setTimeout(r, 2));
  }
}
