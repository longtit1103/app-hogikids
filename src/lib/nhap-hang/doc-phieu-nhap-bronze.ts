import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";
import { ngayMoSo } from "@/lib/so-quy/so-quy-queries";

import {
  doiChieuPhieuNhap,
  rutPhieuTuPayload,
  TIEN_TO_REF_ID,
  type ExpenseDaGhi,
  type KetQuaDoiChieuPhieuNhap,
  type PhieuNhapPancake,
} from "./doi-chieu-phieu-nhap";

/**
 * Đọc Bronze `RawPancakePurchase` + Sổ chi phí rồi trả về đề xuất ghi chi phí nhập hàng.
 *
 * THUẦN ĐỌC: không ghi, không khoá. Bên gọi (màn duyệt / lượt đêm) lo phần ghi.
 *
 * Bronze phiếu nhập KHÔNG có Silver và tới 17/09 chưa code nào đọc — đây là đường đọc đầu tiên.
 */
export async function docDeXuatPhieuNhap(): Promise<
  KetQuaDoiChieuPhieuNhap & {
    /** Tổng phiếu nhập hàng thật đọc được (mọi trạng thái, mọi ngày) — để màn hình nói được bối cảnh. */
    soPhieuNhapThat: number;
    /** Ngày mở sổ quỹ đang áp; `null` = chưa mở sổ ⇒ không lọc theo ngày. */
    d0: Date | null;
  }
> {
  const { kho: shopKho } = await layCauHinhShop();

  // Bản MỚI NHẤT mỗi phiếu. `DISTINCT ON` là BẮT BUỘC: đo 17/09 có 1.201 bản raw cho 184 phiếu duy
  // nhất (bội 6,53 lần) vì mỗi lượt đồng bộ lại chụp lại cả danh sách — thiếu nó thì một phiếu
  // 80 triệu được đề xuất bảy lần, và bản cũ còn mang status=1 của phiếu SAU ĐÓ đã huỷ.
  const rows = await prisma.$queryRawUnsafe<{ payload: unknown }[]>(
    `SELECT DISTINCT ON ("shopId","externalId") payload
       FROM "RawPancakePurchase" WHERE "shopId" = $1
       ORDER BY "shopId","externalId","fetchedAt" DESC, "id" DESC`,
    shopKho,
  );

  const phieu: PhieuNhapPancake[] = rows
    .map((r) => rutPhieuTuPayload(r.payload))
    .filter((p): p is PhieuNhapPancake => p !== null);

  // Chỉ những dòng chi phí SINH TỪ phiếu nhập Pancake mới tham gia đối chiếu; khoản nhập hàng chủ
  // shop tự gõ tay không có `refId` nên không bao giờ bị nhận nhầm là "đã ghi".
  const rowsExpense = await prisma.expense.findMany({
    where: { refId: { startsWith: TIEN_TO_REF_ID } },
    select: { id: true, refId: true, amount: true },
  });
  // `refId` là cột nullable trong schema; bộ lọc `startsWith` đã loại null nhưng kiểu vẫn nullable,
  // nên thu hẹp bằng phép kiểm thật thay vì ép kiểu (ép kiểu ở đây là lời hứa không ai kiểm lại).
  const expense: ExpenseDaGhi[] = rowsExpense.flatMap((r) =>
    r.refId === null ? [] : [{ id: r.id, refId: r.refId, amount: r.amount }],
  );

  const d0 = await ngayMoSo();

  return { ...doiChieuPhieuNhap({ phieu, expense, d0 }), soPhieuNhapThat: phieu.length, d0 };
}
