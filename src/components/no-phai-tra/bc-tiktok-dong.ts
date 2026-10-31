import type { BcTiktokHienThi } from "@/lib/no-phai-tra/bc-tiktok-hoa-don";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

import type { BcTiktokDong } from "./bc-tiktok-section";

/** `Date` ⇒ "dd/MM/yyyy" theo NGÀY VN (chạy ở server — client không tự đổi múi giờ). */
const ngayVn = (d: Date | null): string | null => {
  if (d === null) return null;
  const k = khoaNgayVn(d);
  return `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)}`;
};

const NHAN_KET_QUA: Record<string, { cau: string; canhBao: boolean }> = {
  xong: { cau: "Lượt kéo gần nhất: đọc hết hoá đơn", canhBao: false },
  loi: { cau: "Lượt kéo gần nhất: LỖI giữa chừng", canhBao: true },
  "khong-quyen-finance": { cau: "Lượt kéo gần nhất: TikTok báo THIẾU QUYỀN finance", canhBao: true },
};

/** Dữ liệu BC (server) ⇒ dòng hiển thị của khối "Business Center TikTok". */
export function dongBcTiktokChoKhoi(ds: readonly BcTiktokHienThi[]): BcTiktokDong[] {
  return ds.map((b) => {
    const kq = b.ketQuaGanNhat === null ? null : (NHAN_KET_QUA[b.ketQuaGanNhat] ?? { cau: `Lượt kéo gần nhất: ${b.ketQuaGanNhat}`, canhBao: true });
    return {
      bcId: b.bcId,
      trangThai: kq?.cau ?? "Không có lượt kéo nào trong 30 ngày",
      canhBao: kq?.canhBao ?? b.lanCuoiDocDuoc !== null,
      lanCuoiDocDuoc: ngayVn(b.lanCuoiDocDuoc),
      khongDungTu: ngayVn(b.khongDungTu),
      khongDungGhiChu: b.khongDungGhiChu,
      khongDungBoi: b.khongDungBoi,
    };
  });
}
