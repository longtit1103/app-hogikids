import { prisma } from "@/lib/prisma";

import { DS_NGUON_KET_NOI, type NguonKetNoiId, type TruongKhoa } from "./catalog-khoa-ket-noi";

/**
 * Đọc trạng thái các khóa kết nối cho trang Cài đặt — TẦNG CHE DUY NHẤT giữa bảng
 * `Setting` (chứa secret thô) và trình duyệt.
 *
 * Bất biến: trường `biMat` KHÔNG BAO GIỜ trả giá trị đầy đủ — chỉ `daLuu` + đuôi 4 ký tự
 * (và chỉ khi giá trị ≥ 8 ký tự, kẻo đuôi của khóa ngắn lộ gần hết khóa). Test khóa điều
 * này bằng cách stringify toàn bộ kết quả rồi soi từng giá trị secret đã seed.
 */

export type TrangThaiTruongKhoa = TruongKhoa & {
  daLuu: boolean;
  /** CHỈ điền cho trường không bí mật; trường bí mật luôn `null`. */
  giaTri: string | null;
  /** Đuôi 4 ký tự cuối — chỉ cho trường bí mật đã lưu và đủ dài, còn lại `null`. */
  duoi: string | null;
  /** Đã format "20/08/2026" theo giờ VN — string để qua ranh giới server→client an toàn. */
  capNhat: string | null;
};

export type TrangThaiKhoaKetNoi = Record<NguonKetNoiId, TrangThaiTruongKhoa[]>;

/** Giá trị dưới 8 ký tự thì đuôi 4 ký tự đã là nửa khóa — thà không hiện. */
const DO_DAI_TOI_THIEU_HIEN_DUOI = 8;

function formatNgayVn(d: Date): string {
  return d.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

export async function docTrangThaiKhoaKetNoi(): Promise<TrangThaiKhoaKetNoi> {
  const cacKey = DS_NGUON_KET_NOI.flatMap((n) => n.truong.map((t) => t.key));
  const rows = await prisma.setting.findMany({ where: { key: { in: cacKey } } });
  const theoKey = new Map(rows.map((r) => [r.key, r]));

  const ketQua = {} as TrangThaiKhoaKetNoi;
  for (const nguon of DS_NGUON_KET_NOI) {
    ketQua[nguon.id] = nguon.truong.map((truong) => {
      const row = theoKey.get(truong.key);
      const giaTriTho = row?.value ?? "";
      const daLuu = giaTriTho.length > 0;
      return {
        ...truong,
        daLuu,
        giaTri: !truong.biMat && daLuu ? giaTriTho : null,
        duoi:
          truong.biMat && daLuu && giaTriTho.length >= DO_DAI_TOI_THIEU_HIEN_DUOI
            ? giaTriTho.slice(-4)
            : null,
        capNhat: daLuu && row ? formatNgayVn(row.updatedAt) : null,
      };
    });
  }
  return ketQua;
}
