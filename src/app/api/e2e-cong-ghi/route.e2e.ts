/**
 * Route CHỈ-TEST (đuôi `.e2e.ts`: Next chỉ nhận khi build với `E2E_CONG_GHI_BUILD=1` — `next.config.ts`)
 * cho `tests/e2e/cong-ghi-prod.spec.ts`. Gác như route thật: cổng chủ shop là câu đầu, rồi lớp phòng thủ
 * thứ hai (thiếu `E2E_CONG_GHI=1` lúc chạy ⇒ 404), POST còn so origin (Next không tự so cho route handler).
 *
 *  - GET                    : ảnh chụp bộ đếm cổng ghi đọc từ bundle ROUTE (action ở bundle khác) + số
 *                             action đang đứng chờ barrier.
 *  - POST ?lam=tha          : thả barrier mà server action chỉ-test đang chờ.
 *  - POST ?lam=restore-kho&hanDrainMs=N : gọi THẲNG `POST` thật của `/api/restore` với chính request
 *    này, đã đánh dấu restore khô — cổng chủ shop + origin + lease → X → cờ → drain → fencing thật, rồi
 *    dừng trước bản lùi (`docRestoreKhoE2e` ở route restore). KHÔNG đi qua `routeQuaCua`: lượt phục
 *    hồi không được tự đếm vào drain của chính nó (cùng lý do route restore được miễn).
 */
import { POST as postRestore } from "@/app/api/restore/route";
import { docBoDem } from "@/lib/backup/cong-ghi-toan-cuc";
import {
  dangKyRestoreKhoE2e,
  e2eCongGhiDangBat,
  HAN_DRAIN_KHO_TOI_DA_MS,
  soDangChoBarrierE2e,
  thaBarrierE2e,
} from "@/lib/backup/cong-ghi-e2e-chi-test";
import { chanRequestKhacOrigin } from "@/lib/chan-request-khac-origin";
import { congChuShopRoute } from "@/lib/quyen/cong-route";

export const dynamic = "force-dynamic";

const khongCo = (): Response => new Response("Not Found", { status: 404 });

export async function GET(): Promise<Response> {
  const cong = await congChuShopRoute();
  if (!cong.ok) return cong.response;
  if (!e2eCongGhiDangBat()) return khongCo();
  return Response.json({
    ...docBoDem(),
    soDangChoBarrier: soDangChoBarrierE2e(),
    nextRuntime: process.env.NEXT_RUNTIME ?? null,
  });
}

export async function POST(req: Request): Promise<Response> {
  const cong = await congChuShopRoute();
  if (!cong.ok) return cong.response;
  if (!e2eCongGhiDangBat()) return khongCo();
  const khacOrigin = chanRequestKhacOrigin(req);
  if (khacOrigin) return khacOrigin;
  const thamSo = new URL(req.url).searchParams;
  const lam = thamSo.get("lam");
  if (lam === "tha") {
    thaBarrierE2e();
    return Response.json({ ok: true });
  }
  if (lam === "restore-kho") {
    const hanDrainMs = Number(thamSo.get("hanDrainMs") ?? HAN_DRAIN_KHO_TOI_DA_MS);
    if (!Number.isInteger(hanDrainMs) || hanDrainMs < 1 || hanDrainMs > HAN_DRAIN_KHO_TOI_DA_MS) {
      return Response.json({ ok: false, error: `hanDrainMs phải là số nguyên 1..${HAN_DRAIN_KHO_TOI_DA_MS}` }, { status: 400 });
    }
    dangKyRestoreKhoE2e(req, hanDrainMs);
    return postRestore(req);
  }
  return Response.json({ ok: false, error: "lam phải là tha | restore-kho" }, { status: 400 });
}
