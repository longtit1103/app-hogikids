import type { KhacBietDiSan } from "./anh-di-san-moc-land-don";
import type { DemKhopMocLandDon } from "./dem-khop-moc-land-don";

/**
 * Quyết định CỔNG của bước kiểm landSeq (script `dem-khop-moc-land-don-pancake.ts`) — thuần, để test được.
 *
 * Mã thoát:
 *  - 0 ĐẠT.
 *  - 1 KHÔNG ĐẠT: trước migrate có đơn mơ hồ hoặc Silver giữ bản khác; sau migrate lệch cặp / lệch nội dung; ảnh đưa vào
 *    SAI NGUỒN / SAI GIAI ĐOẠN (`kiemNguonAnh`); ẢNH nhóm di sản ĐỔI so với lần kiểm trước; sau migrate KHÔNG có ảnh
 *    trước migrate để so (kể cả khi không còn đơn di sản — thiếu căn cứ so số liệu); sau migrate THIẾU kết quả so số
 *    liệu hoặc số liệu LỆCH (`soSoLieuTruocSau`: tổng đơn, da_dien = khop trước migrate, 16 chỉ số tiền). (File ảnh
 *    rỗng / hỏng: script dừng trước, cũng thoát 1.)
 *  - 2 KHÔNG ĐỦ CĂN CỨ: có đơn không xác định được Silver đang giữ bản nào.
 *  - 3 KHÔNG HOÀN THÀNH: hết thời hạn (transaction / câu lệnh / chờ khoá) — do script đặt khi bắt `LoiKiemKhongHoanThanh`.
 * Nhóm di sản KHÔNG bao giờ làm cổng xanh "vì đã xác minh": trước migrate chúng chỉ được ghi nhận vào ảnh; sau migrate chỉ
 * qua khi ảnh khớp HOÀN TOÀN ảnh trước.
 */
export type QuyetDinhCong = { ma: 0 | 1 | 2; thongDiep: string };

export function quyetDinhCong(
  kq: DemKhopMocLandDon,
  khacBiet: KhacBietDiSan[] | null,
  loiNguonAnh: string[] = [],
  /** Kết quả `soSoLieuTruocSau` — CHỈ có nghĩa sau migrate; `null` = chưa so (sau migrate ⇒ thiếu kết quả ⇒ ĐỎ). */
  loiSoLieu: string[] | null = null,
): QuyetDinhCong {
  const sauMigrate = kq.daDien !== null;
  const loi = sauMigrate
    ? kq.lechCap! > 0 || kq.lechNoiDung! > 0
    : kq.moHo > 0 || kq.lechBanKhac > 0;
  if (loi) {
    return {
      ma: 1,
      thongDiep: sauMigrate
        ? "KHÔNG ĐẠT — lệch cặp mốc / lệch nội dung — dừng và tra tay"
        : "KHÔNG ĐẠT — có đơn mơ hồ / Silver giữ bản khác (DỪNG, không migrate)",
    };
  }
  if (loiNguonAnh.length > 0) {
    return { ma: 1, thongDiep: `KHÔNG ĐẠT — ẢNH SAI NGUỒN / SAI GIAI ĐOẠN, KHÔNG so: ${loiNguonAnh.join("; ")}` };
  }
  if (khacBiet !== null && khacBiet.length > 0) {
    return { ma: 1, thongDiep: `KHÔNG ĐẠT — ẢNH NHÓM DI SẢN ĐỔI so với lần kiểm trước (${khacBiet.length} khác biệt) — dừng và tra tay` };
  }
  if (sauMigrate && khacBiet === null) {
    return {
      ma: 1,
      thongDiep:
        `KHÔNG ĐẠT — sau migrate KHÔNG có ảnh trước migrate để so (--so-anh) — thiếu căn cứ đối soát di sản ` +
        `(${kq.anhDiSan.diSan.length} đơn), tổng đơn, da_dien và 16 chỉ số tiền — DỪNG, không mở ghi`,
    };
  }
  if (sauMigrate && loiSoLieu === null) {
    return { ma: 1, thongDiep: "KHÔNG ĐẠT — thiếu kết quả so số liệu trước ↔ sau migrate — DỪNG, không mở ghi" };
  }
  if (sauMigrate && loiSoLieu!.length > 0) {
    return {
      ma: 1,
      thongDiep: `KHÔNG ĐẠT — số liệu LỆCH so với trước migrate: ${loiSoLieu!.join("; ")} — DỪNG, không mở ghi, tra nguồn ghi chen`,
    };
  }
  if (kq.khongDuCanCu > 0) {
    return { ma: 2, thongDiep: "KHÔNG ĐỦ CĂN CỨ — có đơn không xác định được Silver đang giữ bản nào — KHÔNG tính đạt, tra tay" };
  }
  return { ma: 0, thongDiep: "ĐẠT" };
}
