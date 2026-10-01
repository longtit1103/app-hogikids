import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { AnhBanGhi, BangThungRac } from "@/lib/thung-rac/chup-anh-ban-ghi";
import { doTinhTrang, tachAnh } from "@/lib/thung-rac/do-tinh-trang-khoi-phuc";
import { lyDoKhongKhoiPhuc } from "@/lib/thung-rac/ly-do-khong-khoi-phuc";
import type { PhamViThungRac } from "@/lib/thung-rac/quyen-thung-rac";

// Quyền theo loại bản ghi — định nghĩa ở `quyen-thung-rac.ts` (dùng chung với helper ghi), mở lại
// ở đây cho trang thùng rác chỉ cần import một chỗ.
export {
  bangDuocPhep,
  phamViThungRac,
  QUYEN_THEO_BANG,
  QUYEN_VAO_THUNG_RAC,
  type PhamViThungRac,
} from "@/lib/thung-rac/quyen-thung-rac";

/** Số dòng mỗi trang màn thùng rác — thùng rác nội bộ, không cần khớp cỡ trang của bảng nghiệp vụ. */
export const THUNG_RAC_PAGE_SIZE = 20;

/** Nhãn tiếng Việt của cột "Loại", dịch từ tên model Prisma lưu trong `BanGhiDaXoa.bang`. */
export const NHAN_LOAI_THUNG_RAC: Record<BangThungRac, string> = {
  Expense: "Sổ chi phí",
  CashMovement: "Dòng tiền",
  ThuNhap: "Thu nhập",
  Loan: "Khoản vay",
  SoTietKiem: "Sổ tiết kiệm",
};

export type ThungRacRow = {
  id: string;
  bang: BangThungRac;
  nhan: string;
  soTien: number;
  ngay: Date;
  xoaLuc: Date;
  khoiPhucLuc: Date | null;
  /** null = còn khôi phục được (và chưa khôi phục). Câu chữ đến THẲNG từ `lyDoKhongKhoiPhuc`. */
  lyDo: string | null;
};

/**
 * Dòng `CashMovement` có ảnh chụp đọc được VÀ không mang liên kết khoản vay / sổ tiết kiệm — bản SQL
 * của `!anhDongTienGanSoQuy(anh)` (`quyen-thung-rac.ts`), đổi một bên phải đổi bên kia:
 *  - `anh` không phải object, hoặc `anh.chinh` không phải object (thiếu / null / mảng / vô hướng) ⇒
 *    `->` trả NULL hoặc kiểu khác 'object' ⇒ KHÔNG khớp ⇒ bị loại (fail-closed);
 *  - khoá `loanId`/`savingsId` vắng mặt (NULL) hoặc JSON `null` ⇒ trơn; mọi giá trị khác ⇒ gắn.
 */
const DONG_TIEN_TRON_SQL = Prisma.sql`(
  jsonb_typeof("anh" -> 'chinh') = 'object'
  AND COALESCE(jsonb_typeof("anh" -> 'chinh' -> 'loanId'), 'null') = 'null'
  AND COALESCE(jsonb_typeof("anh" -> 'chinh' -> 'savingsId'), 'null') = 'null'
)`;

type DongThungRacTho = {
  id: string;
  bang: string;
  nhan: string;
  soTien: number;
  ngay: Date;
  anh: unknown;
  xoaLuc: Date;
  khoiPhucLuc: Date | null;
};

/**
 * Liệt kê thùng rác, mới xoá lên trước.
 *
 * Tính "khôi phục được không" cho MỖI dòng bằng đúng `doTinhTrang` mà `khoiPhucBanGhiDaXoa` dùng
 * lúc ghi — chỉ khác là gọi bằng `prisma` (đọc thường) thay vì `tx` transaction, vì đây là màn liệt
 * kê không ghi gì. Dùng lại thay vì tự dò lại là để bảng KHÔNG BAO GIỜ nói "khôi phục được" rồi bấm
 * vào lại báo lỗi khác — hai đường tính phải luôn là MỘT đường.
 *
 * Phạm vi BẮT BUỘC (spec phân quyền §1.4) — truyền `phamViThungRac(nd)`: chỉ liệt kê loại người xem
 * được thao tác (`bang`); thiếu `xemDongTienGanSoQuy` thì dòng `CashMovement` gắn khoản vay / sổ tiết
 * kiệm (đọc từ ảnh chụp) cũng bị loại. Lọc ở SQL nên `total` và từng trang cùng MỘT tập — lọc sau khi
 * cắt trang sẽ để trang thiếu dòng và tổng "N mục" lộ số dòng bị giấu. Không gì để hỏi ⇒ trả rỗng.
 *
 * `$queryRaw` (tham số hoá) vì bộ lọc JSON của Prisma không diễn đạt được "khoá vắng mặt HOẶC null"
 * lẫn "`chinh` phải là object" — hai vế làm nên tính fail-closed.
 */
export async function listThungRac(
  opts: PhamViThungRac & { page?: number }
): Promise<{ rows: ThungRacRow[]; total: number }> {
  const page = opts.page ?? 1;
  const locDongTien = !opts.xemDongTienGanSoQuy && opts.bang.includes("CashMovement");
  const bangTron = locDongTien ? opts.bang.filter((b) => b !== "CashMovement") : [...opts.bang];

  const nhanh: Prisma.Sql[] = [];
  if (bangTron.length > 0) nhanh.push(Prisma.sql`"bang" IN (${Prisma.join(bangTron)})`);
  if (locDongTien) nhanh.push(Prisma.sql`("bang" = ${"CashMovement"} AND ${DONG_TIEN_TRON_SQL})`);
  if (nhanh.length === 0) return { rows: [], total: 0 };
  const where = Prisma.join(nhanh, " OR ");

  const [dem, dong] = await Promise.all([
    prisma.$queryRaw<{ tong: bigint }[]>`SELECT COUNT(*) AS tong FROM "BanGhiDaXoa" WHERE ${where}`,
    prisma.$queryRaw<DongThungRacTho[]>`
      SELECT "id", "bang", "nhan", "soTien", "ngay", "anh", "xoaLuc", "khoiPhucLuc"
      FROM "BanGhiDaXoa"
      WHERE ${where}
      ORDER BY "xoaLuc" DESC, "id" DESC
      LIMIT ${THUNG_RAC_PAGE_SIZE} OFFSET ${(page - 1) * THUNG_RAC_PAGE_SIZE}`,
  ]);

  const rows = await Promise.all(
    dong.map(async (d): Promise<ThungRacRow> => {
      const bang = d.bang as BangThungRac;
      const anh = d.anh as AnhBanGhi;
      const canDung = tachAnh(bang, anh);
      const tinhTrang = await doTinhTrang(prisma, d.khoiPhucLuc !== null, canDung);
      return {
        id: d.id,
        bang,
        nhan: d.nhan,
        soTien: d.soTien,
        ngay: d.ngay,
        xoaLuc: d.xoaLuc,
        khoiPhucLuc: d.khoiPhucLuc,
        lyDo: lyDoKhongKhoiPhuc(tinhTrang),
      };
    })
  );

  return { rows, total: Number(dem[0]?.tong ?? 0) };
}
