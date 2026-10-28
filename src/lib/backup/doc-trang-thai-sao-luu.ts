import { prisma } from "@/lib/prisma";
import {
  chonLogTheoArtifact,
  tinhTrangSaoLuu,
  type LogSaoLuuGanNhat,
  type TrangThaiSaoLuu,
} from "./trang-thai-sao-luu";

/** Số dòng đọc lần đầu / khi phải mở rộng (xem `docTrangThaiSaoLuu`). */
const CUA_SO_HEP = 30;
const CUA_SO_RONG = 1000;

/**
 * Đọc các dòng `SyncLog` kind BACKUP mới nhất rồi suy ra trạng thái TỪNG artifact (dump app, tarball
 * toàn server, bản tải tay) cho Cài đặt › Dữ liệu — cách xếp log vào artifact ở `trang-thai-sao-luu.ts`.
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
  let logs = await docLogBackup(CUA_SO_HEP);
  const daDuHaiArtifact = (ds: LogSaoLuuGanNhat[]) => {
    const chon = chonLogTheoArtifact(ds);
    return chon.appDump !== null && chon.fullServer !== null;
  };
  // Cửa sổ hẹp đủ cho đường bình thường (mỗi đêm ~3 dòng). Thiếu một trong hai artifact bắt buộc thì
  // MỞ RỘNG đọc lại: một artifact đã chết lâu (vd cron tarball dừng 3 tuần trong khi dump app vẫn
  // chạy 2 lượt/ngày) bị đẩy ra khỏi cửa sổ hẹp — nếu coi nó "chưa có" thì banner im đúng ca nặng nhất.
  if (!daDuHaiArtifact(logs)) logs = await docLogBackup(CUA_SO_RONG);
  return tinhTrangSaoLuu(chonLogTheoArtifact(logs));
}

/** Các dòng BACKUP mới nhất trước, chỉ lấy cột cần để phân loại. */
async function docLogBackup(soDong: number): Promise<LogSaoLuuGanNhat[]> {
  return prisma.syncLog.findMany({
    where: { kind: "BACKUP" },
    orderBy: { startedAt: "desc" },
    take: soDong,
    select: { status: true, finishedAt: true, stats: true, error: true },
  });
}
