import { TIEN_TO_REF_ID, refIdChoPhieu } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { laPhieuTruocMoSo } from "@/lib/no-phai-tra/luat-da-tra-truoc-phieu";
import { docPhieuBronzeMoiNhat } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { prisma } from "@/lib/prisma";
import { ngayMoSo } from "@/lib/so-quy/so-quy-queries";

/**
 * ĐỌC-ONLY: phiếu nhập Pancake CÒN HIỆU LỰC (`status=1`) mà CHƯA có hồ sơ nghĩa vụ `PhieuNhapNo` — danh
 * sách của nút "Ghi nhận vào sổ nợ" (màn `/tai-chinh/chi-phi-nhap-hang` SAU khi bật theo dõi nợ).
 *
 * Khác `docDeXuatPhieuNhap` (đề xuất ghi CHI PHÍ cho phiếu chưa có dòng Sổ chi phí): sau bật, phiếu đã có
 * dòng Sổ chi phí cũng phải vào sổ nợ (dòng đó thành `daTraTruoc`), và phiếu TRƯỚC ngày mở sổ D0 cũng ghi
 * nhận được (chủ shop gõ tay phần đã trả) — nên liệt kê cả hai, gắn cờ `truocD0` để màn ẩn mặc định.
 * `soNguon` = `amount` dòng Sổ chi phí cùng `refId` (null = không có dòng) — số mà luật `daTraTruocHopLe`
 * dùng làm "nguồn" khi server ghi nhận.
 *
 * Không phụ thuộc quyền giá vốn: chỉ mang tổng phiếu, không có số lượng.
 */
export type PhieuChoGhiNo = {
  uuid: string;
  displayId: number | null;
  ngay: Date;
  soTien: number;
  nhaCungCap: string | null;
  ghiChu: string | null;
  soDongHang: number;
  /** Pancake khai tổng khác Σ dòng hàng — màn kêu trước khi ghi. */
  lechLuoiKiem: boolean;
  /** Ngày phiếu < ngày mở sổ D0 (chưa mở sổ ⇒ false) — tiền đã trả nằm trong số dư mở sổ. */
  truocD0: boolean;
  soNguon: number | null;
};

export async function docPhieuChoGhiNo(): Promise<PhieuChoGhiNo[]> {
  const [bronze, daCoNo, chiPhi, d0] = await Promise.all([
    docPhieuBronzeMoiNhat(),
    prisma.phieuNhapNo.findMany({ select: { refId: true } }),
    prisma.expense.findMany({
      where: { refId: { startsWith: TIEN_TO_REF_ID } },
      select: { refId: true, amount: true },
    }),
    ngayMoSo(),
  ]);
  const refDaCo = new Set(daCoNo.map((r) => r.refId));
  const chiPhiTheoRef = new Map(chiPhi.flatMap((e) => (e.refId === null ? [] : [[e.refId, e.amount] as const])));

  return [...bronze.values()]
    .filter((p) => p.status === 1 && !refDaCo.has(refIdChoPhieu(p.uuid)))
    .sort((a, b) => a.ngay.getTime() - b.ngay.getTime() || a.uuid.localeCompare(b.uuid))
    .map((p) => ({
      uuid: p.uuid,
      displayId: p.displayId,
      ngay: p.ngay,
      soTien: p.soTien,
      nhaCungCap: p.nhaCungCap,
      ghiChu: p.ghiChu,
      soDongHang: p.soDongHang,
      lechLuoiKiem: p.soTien !== p.tongTuDongHang,
      truocD0: laPhieuTruocMoSo(p.ngay, d0),
      soNguon: chiPhiTheoRef.get(refIdChoPhieu(p.uuid)) ?? null,
    }));
}
