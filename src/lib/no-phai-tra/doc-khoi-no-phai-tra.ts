import { format } from "date-fns";

import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docPhieuConNo, vanTayPhieuConNo, type PhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { ngayTrongThang } from "@/lib/no-phai-tra/ky-sao-ke";
import { prisma } from "@/lib/prisma";
import { docTheKemTrangThai, ngayChotGanNhat, type TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";

/**
 * Dữ liệu cho khối "Nợ phải trả" của tab Dòng tiền (thẻ tín dụng + phiếu nhập còn nợ). Chỉ gọi khi
 * người xem có `tai-chinh-so-quy:xem`. THUẦN ĐỌC. Truyền xuống component dạng dữ liệu thường — mọi tiền
 * là `Int`, ngày là `Date` (RSC chuyển được).
 */
/** Gợi ý cho form chốt sao kê của một thẻ (`yyyy-MM-dd`, chủ shop sửa được). */
export type GoiYChotSaoKe = { ngayChot: string; hanTra: string };

export type KhoiNoPhaiTra = {
  /** M dạng `yyyy-MM-dd` (giờ VN); `null` = chưa bật theo dõi nợ. */
  mocM: string | null;
  the: TheKemTrangThai[];
  phieu: PhieuConNo[];
  /** Theo `id` thẻ: ngày chốt mặc định = ngày chốt gần nhất ≤ hôm qua; hạn trả = ngày hạn của thẻ sau đó. */
  goiYChot: Record<string, GoiYChotSaoKe>;
  /** Vân tay danh sách phiếu lúc render — form trả gộp gửi lên để server bắt danh sách đã đổi. */
  vanTay: string;
  /** Có hồ sơ ví quảng cáo trả trước — để thẻ chốt số dư gợi ý đọc chênh âm. */
  coHoSoViAds: boolean;
};

/** Hạn trả gợi ý: ngày hạn của thẻ trong tháng của ngày chốt nếu còn sau ngày chốt, không thì tháng kế. */
export function hanTraGoiY(ngayChot: string, ngayHanTra: number): string {
  const [nam, thang] = ngayChot.split("-").map(Number);
  const thangNay = ngayTrongThang(nam, thang, ngayHanTra);
  if (thangNay > ngayChot) return thangNay;
  return thang === 12 ? ngayTrongThang(nam + 1, 1, ngayHanTra) : ngayTrongThang(nam, thang + 1, ngayHanTra);
}

export async function docKhoiNoPhaiTra(): Promise<KhoiNoPhaiTra> {
  const [moc, the, phieu, soVi] = await Promise.all([
    docMocM(),
    docTheKemTrangThai(),
    docPhieuConNo(),
    prisma.viAdsTraTruoc.count(),
  ]);
  const mocMStr = moc === null ? null : format(moc, "yyyy-MM-dd");
  const homNay = new Date();
  const goiYChot: Record<string, GoiYChotSaoKe> = {};
  for (const t of the) {
    let ngayChot = ngayChotGanNhat(homNay, t.ngayChotSaoKe);
    // Ngày chốt không được trước M (neo trước M chỉ sinh ở bước bật).
    if (mocMStr !== null && ngayChot < mocMStr) ngayChot = mocMStr;
    goiYChot[t.id] = { ngayChot, hanTra: hanTraGoiY(ngayChot, t.ngayHanTra) };
  }
  return {
    mocM: mocMStr,
    the,
    goiYChot,
    phieu,
    vanTay: vanTayPhieuConNo(phieu),
    coHoSoViAds: soVi > 0,
  };
}
