import { cache } from "react";

import type { Prisma } from "@/generated/prisma/client";
import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import type { NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { prisma } from "@/lib/prisma";

/** Client đọc được `Setting` + `GanNenTangThe` + `ViAdsTraTruoc` — prisma gốc hoặc `tx` đang chạy. */
type DbDocNguCanh = Pick<Prisma.TransactionClient, "setting" | "ganNenTangThe" | "viAdsTraTruoc">;

/**
 * Ngữ cảnh bộ lọc "chi phí trừ quỹ": mốc M (null = tắt) + TOÀN BỘ lịch sử gắn nền tảng ads ↔ thẻ (cả dòng
 * cũ — đổi thẻ là thêm dòng, `mocCatNenTang` cần tuNgay sớm nhất) + hồ sơ ví ads trả trước (nhánh (c) chỉ
 * áp cho nền tảng ĐÃ có hồ sơ ví). Ba query nhỏ, đọc tươi.
 */
export async function docNguCanhLoc(db: DbDocNguCanh = prisma): Promise<NguCanhLoc> {
  const [mocM, gan, viAds] = await Promise.all([
    docMocM(db),
    db.ganNenTangThe.findMany({
      select: { cardId: true, nenTang: true, tuNgay: true },
      orderBy: [{ nenTang: "asc" }, { tuNgay: "asc" }],
    }),
    db.viAdsTraTruoc.findMany({ select: { nenTang: true, ngayNeo: true }, orderBy: { nenTang: "asc" } }),
  ]);
  return { mocM, gan, viAds };
}

/**
 * `docNguCanhLoc` NHỚ THEO REQUEST (React `cache`, cùng khuôn D0 nhớ theo request ở `so-quy-queries.ts`):
 * thẻ Quỹ, dòng chạy, dự báo cùng một lượt render đọc ngữ cảnh một lần. M chỉ đổi ở bước xác nhận bật,
 * gắn thẻ chỉ đổi ở form hồ sơ — lượt render không ghi hai bảng đó. CHỈ dùng trên đường đọc lúc RENDER;
 * action/script ghi rồi đọc gọi `docNguCanhLoc()` trần (danh sách file khoá ở
 * `tests/unit/so-quy/ngay-mo-so-nho-theo-request.test.ts`).
 */
export const docNguCanhLocTrongRequest = cache(function docNguCanhLocMacDinh(): Promise<NguCanhLoc> {
  // Hàm có TÊN, không nhận `db`: bản nhớ chỉ dành cho prisma gốc (một `tx` đi qua đây là đọc nhầm bản cũ).
  return docNguCanhLoc();
});
