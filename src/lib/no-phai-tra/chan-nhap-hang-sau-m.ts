import { format, startOfDay } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";

import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";

/**
 * ĐÓNG đường ghi `Expense` danh mục "Nhập hàng" (`purchase`) từ mốc bật nợ phải trả M trở đi
 * (spec §5.3). Sau M, tiền hàng đi DUY NHẤT một đường: hồ sơ `PhieuNhapNo` + dòng `SUPPLIER_PAY` ngày
 * trả thật. Một dòng chi phí "Nhập hàng" mới sau M sẽ trừ quỹ LẦN HAI cho cùng lô hàng (một lần ở
 * đây, một lần lúc trả nhà cung cấp), nên MỌI đường ghi `Expense` (tạo/sửa tay, duyệt phiếu nhập,
 * import CSV, bộ sinh định kỳ, khôi phục thùng rác) gọi hàm này trước câu ghi.
 *
 * So theo NGÀY giờ VN (`startOfDay`): dòng 31/10 23:59 vẫn là tháng cũ, 01/11 00:00 đã là sau M.
 * Chưa bật (M null) ⇒ không chặn gì — đường cũ giữ nguyên.
 *
 * HỢP ĐỒNG KHOÁ: người gọi PHẢI đã giữ `khoaChiaSeBatNoPhaiTra(tx)` trong CÙNG transaction (câu đầu tiên,
 * trước mọi khoá dòng) khi `categoryId` là `purchase`. Không giữ thì lượt ghi đọc M = null trong lúc bước
 * bật (khoá EXCLUSIVE) chưa commit, chèn dòng Nhập hàng ngày ≥ M; bước bật đã đọc xong "không còn Nhập hàng
 * sau M" nên vẫn bật ⇒ dòng đó trừ quỹ lần hai, phiếu Y giải thích sai. Lưới
 * `tests/khoa-chung-bat-cho-duong-ghi-nhap-hang.test.ts` + test đua `khe-dua-nhap-hang-va-buoc-bat`.
 */

export class LoiNhapHangSauM extends Error {
  readonly code = "DA_BAT_NO_PHAI_TRA" as const;

  constructor(mocM: Date) {
    super(
      `Từ ngày bật theo dõi nợ (${format(mocM, "dd/MM/yyyy")}), tiền hàng ghi qua sổ nợ: ghi nhận phiếu rồi ` +
        `Trả tiền hàng — không ghi chi phí "Nhập hàng" nữa.`,
    );
    this.name = "LoiNhapHangSauM";
  }
}

/** Client đọc được bảng `Setting` — prisma gốc hoặc `tx` của transaction đang chạy. */
type DbDocSetting = Pick<Prisma.TransactionClient, "setting">;

/**
 * Vị từ THUẦN của cùng luật — cho nơi CHỈ ĐỌC đã có sẵn M (cảnh báo "định kỳ đến hạn chưa sinh", dự báo
 * quỹ) để chúng hiểu "bộ sinh sẽ không sinh lần này" y hệt đường ghi. Đường GHI luôn gọi `chanNhapHangSauM`.
 */
export function laNhapHangSauM(d: { categoryId: string; date: Date }, mocM: Date | null): boolean {
  return d.categoryId === "purchase" && mocM !== null && startOfDay(d.date) >= mocM;
}

/** Ném `LoiNhapHangSauM` khi `categoryId = 'purchase'` VÀ ngày (giờ VN) ≥ M. */
export async function chanNhapHangSauM(
  db: DbDocSetting,
  d: { categoryId: string; date: Date },
): Promise<void> {
  // Danh mục khác không cần đọc Setting — đường ghi ads/chi thường không tốn thêm vòng DB.
  if (d.categoryId !== "purchase") return;
  const mocM = await docMocM(db);
  if (laNhapHangSauM(d, mocM)) throw new LoiNhapHangSauM(mocM as Date);
}
