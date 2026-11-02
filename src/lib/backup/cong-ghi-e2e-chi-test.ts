/**
 * Module CHỈ-TEST cho e2e cổng ghi trên BẢN BUILD (`tests/e2e/cong-ghi-prod.spec.ts`, chạy bằng
 * `npm run test:e2e:prod:cong-ghi`). Chỉ được import bởi file `*.e2e.ts(x)` dưới `src/app` — Next chỉ
 * nhận các file đó khi build với `E2E_CONG_GHI_BUILD=1` (`pageExtensions`, `next.config.ts`) — và bởi
 * test. Bản build prod không có file nào nạp module này (lưới `tests/luoi/file-chi-build-e2e.test.ts`).
 *
 * Trạng thái neo `globalThis` dưới khoá `Symbol.for` RIÊNG (không nằm trong trạng thái cổng): server
 * action và route handler là hai bundle khác nhau, mỗi bundle một bản sao module này — biến module là
 * hai barrier khác nhau và route "thả" không bao giờ tới action đang chờ.
 */
import { prisma } from "@/lib/prisma";

/**
 * Lớp phòng thủ THỨ HAI (lớp thứ nhất: bản build thường không có file chỉ-test): thiếu `E2E_CONG_GHI=1`
 * lúc chạy ⇒ route/trang/action chỉ-test trả 404 / từ chối như không tồn tại.
 */
export function e2eCongGhiDangBat(): boolean {
  return process.env.E2E_CONG_GHI === "1";
}

// ───────────── Barrier: action ghi dở, route chỉ-test thả ─────────────

type Barrier = { hua: Promise<void>; mo: () => void };
type TrangThaiE2e = { barrier?: Barrier; soDangCho: number };

const KHOA_TRANG_THAI = Symbol.for("hogikids.e2eCongGhi.trangThai");

function trangThai(): TrangThaiE2e {
  const g = globalThis as unknown as Record<symbol, TrangThaiE2e | undefined>;
  return (g[KHOA_TRANG_THAI] ??= { soDangCho: 0 });
}

/**
 * Hạn chờ barrier. Action đứng chờ là đang GIỮ cửa ghi — chờ vô hạn thì mọi lượt phục hồi drain quá hạn
 * (409) mãi tới khi tiến trình chết. Quá hạn ⇒ ném, `finally` của action nhả cửa.
 */
export const HAN_CHO_BARRIER_MS = 60_000;

/**
 * Action gọi giữa hai lần ghi: treo tới khi route chỉ-test `thaBarrierE2e()`, tối đa `HAN_CHO_BARRIER_MS`
 * (quá ⇒ ném). Đếm người đang chờ để spec chỉ "thả" SAU khi action đã thật sự đứng chờ — thả sớm hơn là
 * thả hụt.
 */
export async function choBarrierE2e(): Promise<void> {
  const st = trangThai();
  if (!st.barrier) {
    let mo!: () => void;
    const hua = new Promise<void>((r) => (mo = r));
    st.barrier = { hua, mo };
  }
  const hua = st.barrier.hua;
  let hen: ReturnType<typeof setTimeout> | undefined;
  const quaHan = new Promise<never>((_, loi) => {
    hen = setTimeout(() => loi(new Error(`Barrier e2e chờ quá ${HAN_CHO_BARRIER_MS / 1000}s — nhả cửa ghi.`)), HAN_CHO_BARRIER_MS);
  });
  st.soDangCho++;
  try {
    await Promise.race([hua, quaHan]);
  } finally {
    clearTimeout(hen);
    st.soDangCho--;
  }
}

/** Số action đang đứng chờ barrier (route chỉ-test trả về cho spec soi). */
export function soDangChoBarrierE2e(): number {
  return trangThai().soDangCho;
}

/** Thả mọi action đang chờ barrier; lượt chờ sau dùng barrier mới. */
export function thaBarrierE2e(): void {
  const st = trangThai();
  st.barrier?.mo();
  st.barrier = undefined;
}

// ───────────── Ghi thử (bảng `Setting`, tiền tố riêng) ─────────────

/** Tiền tố khoá `Setting` của dữ liệu thử — không trùng khoá thật nào của app. */
export const TIEN_TO_KHOA_E2E = "e2e-cong-ghi:";

/**
 * Ghi một dòng thử qua singleton Prisma THẬT (có cổng ghi). Người gọi phải đứng TRONG cửa ghi
 * (`vaoCuaGhi`) — ngoài cửa khi cờ phục hồi bật thì lưới cấp op ném, đúng hành vi cần đo.
 */
export async function ghiThuE2e(ten: string, giaTri: string): Promise<string> {
  const key = `${TIEN_TO_KHOA_E2E}${ten}`;
  const dong = await prisma.setting.upsert({ where: { key }, create: { key, value: giaTri }, update: { value: giaTri } });
  return dong.value;
}

// ───────────── Restore khô ─────────────

/**
 * Tên `Symbol.for` của bảng đăng ký restore khô. `src/app/api/restore/route.ts` (`docRestoreKhoE2e`)
 * viết lại ĐÚNG chuỗi này tại chỗ thay vì import (import là kéo module chỉ-test vào bundle prod) — lưới
 * `tests/luoi/file-chi-build-e2e.test.ts` khoá hai chuỗi trùng nhau.
 */
export const TEN_KHOA_RESTORE_KHO_E2E = "hogikids.e2eCongGhi.restoreKho";

/**
 * Hạn drain tối đa nhận cho restore khô — PHẢI bằng hạn của lượt thật (`HAN_DRAIN_GHI_MS` ở route restore;
 * route không export được hằng nên lưới `file-chi-build-e2e.test.ts` so hai số). Cũng là hạn mặc định
 * khi route chỉ-test không nhận tham số.
 */
export const HAN_DRAIN_KHO_TOI_DA_MS = 120_000;

/**
 * Đánh dấu CHÍNH object `request` này là restore khô với hạn drain `hanDrainMs`, để `POST` của
 * `/api/restore` (gọi trực tiếp, cùng object) chạy chuỗi khoá thật rồi dừng trước bản lùi. WeakMap: mục tự
 * mất cùng request, không rò.
 */
export function dangKyRestoreKhoE2e(request: Request, hanDrainMs: number): void {
  if (!e2eCongGhiDangBat()) throw new Error("Restore khô chỉ dùng được khi E2E_CONG_GHI=1.");
  if (!Number.isInteger(hanDrainMs) || hanDrainMs < 1 || hanDrainMs > HAN_DRAIN_KHO_TOI_DA_MS) {
    throw new RangeError(`hanDrainMs phải là số nguyên 1..${HAN_DRAIN_KHO_TOI_DA_MS} (nhận ${hanDrainMs}).`);
  }
  const g = globalThis as unknown as Record<symbol, WeakMap<Request, { hanDrainMs: number }> | undefined>;
  (g[Symbol.for(TEN_KHOA_RESTORE_KHO_E2E)] ??= new WeakMap()).set(request, { hanDrainMs });
}
