import { prisma } from "@/lib/prisma";
import { tinhTrangSaoLuu, type TrangThaiSaoLuu } from "./trang-thai-sao-luu";

/**
 * Đọc dòng `SyncLog` kind BACKUP mới nhất rồi suy ra trạng thái hiển thị cho Cài đặt › Dữ liệu.
 *
 * Tách khỏi `cai-dat/page.tsx` để CÓ THỂ TEST: server component async không dựng lại được trong
 * vitest, nên khi câu đọc nằm thẳng trong page thì gỡ nó đi cả suite vẫn xanh trong khi màn hình
 * quay lại kêu "Chưa sao lưu lần nào" — đúng bug gốc. Cũng tách khỏi `trang-thai-sao-luu.ts` để
 * file đó giữ nguyên tính THUẦN (không kéo PrismaClient vào test của hàm tính toán).
 *
 * Truy vấn RIÊNG, cố ý KHÔNG dùng chung danh sách log 10 dòng của trang: các kind chạy dày hơn
 * (PANCAKE, ADS…) có thể lấp hết cửa sổ 10 dòng trong một ngày bận và đẩy dòng BACKUP (1 lần/đêm)
 * rơi ra ngoài, dù nó vẫn là dòng mới nhất của KIND này.
 */
export async function docTrangThaiSaoLuu(): Promise<TrangThaiSaoLuu> {
  const logGanNhat = await prisma.syncLog.findFirst({
    where: { kind: "BACKUP" },
    orderBy: { startedAt: "desc" },
  });
  return tinhTrangSaoLuu(logGanNhat);
}
