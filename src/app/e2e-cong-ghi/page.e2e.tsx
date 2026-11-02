/**
 * Trang CHỈ-TEST (đuôi `.e2e.tsx`: Next chỉ nhận khi build với `E2E_CONG_GHI_BUILD=1` — `next.config.ts`)
 * cho `tests/e2e/cong-ghi-prod.spec.ts`. Gác như trang thật: cổng chủ shop là câu đầu, rồi lớp phòng thủ
 * thứ hai (thiếu `E2E_CONG_GHI=1` lúc chạy ⇒ 404). Không đọc dữ liệu — chỉ dựng nút gọi action chỉ-test.
 */
import { notFound } from "next/navigation";

import { e2eCongGhiDangBat } from "@/lib/backup/cong-ghi-e2e-chi-test";
import { yeuCauChuShopTrang } from "@/lib/quyen/cong-trang";

import { NutE2eCongGhi } from "./nut-e2e-cong-ghi.e2e";

export const dynamic = "force-dynamic";

export default async function TrangE2eCongGhi() {
  await yeuCauChuShopTrang("/e2e-cong-ghi");
  if (!e2eCongGhiDangBat()) notFound();
  return <NutE2eCongGhi />;
}
