import type { Prisma } from "@prisma/client";

import { dungAnhBanGhi, type NguonAnh } from "@/lib/thung-rac/chup-anh-ban-ghi";

/**
 * Ghi MỘT dòng thùng rác cho bản ghi (hoặc cụm bản ghi) sắp bị xoá cứng.
 *
 * BẮT BUỘC gọi bằng chính `tx` của lượt xoá, TRONG CÙNG transaction: xoá mà không chụp được là mất
 * dữ liệu vĩnh viễn (đúng sự cố đã đẻ ra tính năng này), còn chụp mà không xoá được là để lại một
 * dòng rác hứa khôi phục được một bản ghi vẫn đang sống — bấm khôi phục sẽ báo "đã tồn tại lại".
 * Nhận `Prisma.TransactionClient` chứ không phải `prisma` là để điều đó đúng ở mức KIỂU.
 */
export async function chupVaoThungRac(
  tx: Prisma.TransactionClient,
  nguon: NguonAnh
): Promise<void> {
  const { nhan, soTien, ngay, anh } = dungAnhBanGhi(nguon);

  await tx.banGhiDaXoa.create({
    data: {
      bang: nguon.bang,
      banGhiId: nguon.banGhi.id,
      nhan,
      soTien,
      ngay,
      anh: anh as unknown as Prisma.InputJsonValue,
    },
  });
}
