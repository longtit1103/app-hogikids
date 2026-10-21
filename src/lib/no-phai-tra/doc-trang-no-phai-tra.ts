import { addMonths, format, startOfMonth, subDays } from "date-fns";

import { docVanTayQuyTruocM } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";
import { docDongVeMuonTruocM } from "@/lib/no-phai-tra/doc-dong-ve-muon-truoc-m";
import { hanTraGoiY } from "@/lib/no-phai-tra/doc-khoi-no-phai-tra";
import { ngayChotGanNhat, type TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";
import {
  chonDongNoiBat,
  docSoLieuLucBat,
  LOAI_YEU_CAU_BAT_DOC,
  netDieuChinh,
  NHAN_NGUON_VE_MUON,
  tinhTroiQuyTruocM,
} from "@/lib/no-phai-tra/troi-quy-truoc-m";
import { NHAN_NEN_TANG_VI, type HoSoViAds } from "@/lib/no-phai-tra/vi-ads-queries";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Dữ liệu dẫn xuất cho trang `/tai-chinh/no-phai-tra` (chuẩn bị / xác nhận bật). Thuần đọc; ngày trả về
 * dạng chuỗi đã format ở server (client không format theo múi giờ trình duyệt).
 */

const DINH_DANG = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày bật dự kiến từ `?m=`: hợp lệ thì dùng, không thì mặc định ngày đầu tháng sau (giờ VN). */
export function chuanHoaNgayM(raw: string | undefined, homNay: Date = new Date()): string {
  if (raw !== undefined && DINH_DANG.test(raw)) {
    const d = new Date(`${raw}T00:00:00+07:00`);
    if (!Number.isNaN(d.getTime()) && khoaNgayVn(d) === raw && d.getFullYear() >= 2000) return raw;
  }
  return format(startOfMonth(addMonths(homNay, 1)), "yyyy-MM-dd");
}

export type TheChoBatServer = { id: string; ten: string; saoKeNgayChot: string; saoKeHanTra: string };

/** Thẻ ĐANG MỞ kèm gợi ý kỳ sao kê gần nhất trước ngày bật (ngày chốt của thẻ ≤ M − 1, hạn trả kế tiếp). */
export function theChoBat(the: readonly TheKemTrangThai[], mocM: Date): TheChoBatServer[] {
  return the
    .filter((t) => t.closedAt === null)
    .map((t) => {
      const ngayChot = ngayChotGanNhat(mocM, t.ngayChotSaoKe);
      return { id: t.id, ten: t.ten, saoKeNgayChot: ngayChot, saoKeHanTra: hanTraGoiY(ngayChot, t.ngayHanTra) };
    });
}

export function viChoBat(vis: readonly HoSoViAds[]): { id: string; nhan: string }[] {
  return vis.map((v) => ({ id: v.id, nhan: `Ví ${NHAN_NEN_TANG_VI[v.nenTang] ?? v.nenTang}` }));
}

export const nhanNgay = (iso: string) => format(new Date(`${iso}T00:00:00+07:00`), "dd/MM/yyyy");
export const ngayTruoc = (iso: string) => format(subDays(new Date(`${iso}T00:00:00+07:00`), 1), "yyyy-MM-dd");

/**
 * Các dòng điều chỉnh mở sổ đã ghi, cũ trước. `cuaBuocBat` = dòng của bước bật (mang `yeuCauId` của yêu cầu bật);
 * dòng `yeuCauId` null là dòng BÙ do lối "Sửa số tiền trước mốc" ghi sau đó — màn hình tách riêng hai nhóm.
 */
export async function docDieuChinhDaGhi(): Promise<
  { id: string; vao: boolean; soTien: number; moTa: string; ngayNhan: string; cuaBuocBat: boolean }[]
> {
  const rows = await prisma.cashMovement.findMany({
    where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    select: { id: true, kind: true, amount: true, description: true, date: true, yeuCauId: true },
  });
  return rows.map((r) => ({
    id: r.id,
    vao: r.kind === "CUTOVER_ADJ_IN",
    soTien: r.amount,
    moTa: r.description,
    ngayNhan: format(r.date, "dd/MM/yyyy"),
    cuaBuocBat: r.yeuCauId !== null,
  }));
}

/** Chỉ báo trôi quỹ trước ngày bật — dạng hiển thị (ngày đã format ở server). */
export type TroiQuyHienThi = {
  /**
   * Số trôi CÓ DẤU so với LÚC BẬT: dương = quỹ cuối ngày trước bật (cộng điều chỉnh mở sổ) đã tăng đúng số này. Chỉ
   * bằng "lệch tiền thật" khi lúc bật đã chốt khớp toàn bộ — bật để lại phần chưa giải thích thì không.
   */
  troi: number;
  quyLucBat: number;
  quyHienTai: number;
  /** Dòng ngày < M ghi vào app SAU lúc bật, tác động lớn nhất trước. */
  dongNoiBat: { nhanNguon: string; ngayNhan: string; tacDong: number; moTa: string }[];
  /** Mọi dòng ghi sau lúc bật tìm thấy — để chủ shop thấy chúng giải thích được bao nhiêu phần trôi. */
  soDongVeMuon: number;
  tacDongVeMuon: number;
  /** Chạm trần đọc ở ít nhất một nguồn ⇒ số đếm/tổng ở trên là "ít nhất". */
  chamTran: boolean;
};

const TOI_DA_DONG_NOI_BAT = 5;

/**
 * Chỉ báo trôi quỹ trước ngày bật (công thức ở `troi-quy-truoc-m.ts`). CHỈ ĐỌC. Null ⇒ ẩn khối: chưa có yêu cầu
 * bật thành công, hoặc kết quả bật thiếu vân tay quỹ (bật trước khi có field — không đoán số lúc bật). Quỹ hiện
 * tại tính bằng CÙNG hàm vân tay của bước bật (`docVanTayQuyTruocM`, ép bộ lọc trước bật): khác hàm là trôi giả.
 * Chỉ dò dòng về muộn khi trôi ≠ 0 (thêm 6 lượt đọc).
 */
export async function docTroiQuyTruocM(mocM: Date): Promise<TroiQuyHienThi | null> {
  const yeuCau = await prisma.yeuCauGhi.findFirst({
    where: { loai: LOAI_YEU_CAU_BAT_DOC, ketQua: { path: ["ok"], equals: true } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, ketQua: true },
  });
  const lucBat = yeuCau === null ? null : docSoLieuLucBat(yeuCau.ketQua);
  if (yeuCau === null || lucBat === null) return null;

  const [vanTay, dieuChinh] = await Promise.all([
    docVanTayQuyTruocM(mocM),
    prisma.cashMovement.groupBy({
      by: ["kind"],
      where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } },
      _sum: { amount: true },
    }),
  ]);
  const troi = tinhTroiQuyTruocM(lucBat, {
    quyApp: vanTay.quyApp,
    dieuChinhNet: netDieuChinh(dieuChinh.map((g) => ({ kind: g.kind, amount: g._sum.amount ?? 0 }))),
  });
  if (troi === null) return null;

  const ve = troi === 0 ? { dong: [], chamTran: false } : await docDongVeMuonTruocM(mocM, yeuCau.createdAt);
  return {
    troi,
    quyLucBat: lucBat.quyApp,
    quyHienTai: vanTay.quyApp,
    dongNoiBat: chonDongNoiBat(ve.dong, TOI_DA_DONG_NOI_BAT).map((d) => ({
      nhanNguon: NHAN_NGUON_VE_MUON[d.nguon],
      ngayNhan: nhanNgay(d.khoaNgay),
      tacDong: d.tacDong,
      moTa: d.moTa,
    })),
    soDongVeMuon: ve.dong.length,
    tacDongVeMuon: ve.dong.reduce((s, d) => s + d.tacDong, 0),
    chamTran: ve.chamTran,
  };
}
