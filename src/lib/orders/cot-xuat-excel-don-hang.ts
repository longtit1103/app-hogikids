import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";
import type { DongDonHangChe, DongXuatDonHang, KetQuaXuatDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { trangThaiHienThi } from "@/lib/orders/trang-thai-don-hien-thi";
import type { SheetXuat } from "@/lib/reports/xuat-xlsx-server";

/**
 * Ánh xạ kết quả truy vấn Excel đơn hàng → một sheet. Hàm THUẦN (không I/O) để test không cần database.
 *
 * Cột giá vốn (Giá vốn, Lãi đơn, Biên %, Thiếu giá vốn) chỉ tồn tại ở nhánh `coQuyenGiaVon: true`: nhánh
 * che dùng bộ cột khác hẳn và kiểu dòng của nó không mang các trường đó, nên không có đường nào lọt số
 * lãi/giá vốn ra file. File không có tên khách, SĐT, địa chỉ.
 */

export const HEADER_XUAT_DON_HANG_CHUNG: readonly string[] = [
  "Mã đơn",
  "Mã sàn",
  "Ngày đặt",
  "Cập nhật",
  "Kênh",
  "Trạng thái",
  "Sản phẩm",
  "Số dòng hàng",
  "Tổng SL",
  "Tiền hàng",
  "Voucher",
  "Phí sàn",
  "Tiền sau voucher và phí sàn",
  "Phí tạm tính",
];

/** Cột chỉ người có quyền giá vốn thấy — nối SAU cột chung. */
export const HEADER_XUAT_DON_HANG_GIA_VON: readonly string[] = ["Giá vốn", "Lãi đơn", "Biên %", "Thiếu giá vốn"];

type GiaTriO = string | number;
type DongXlsx = Record<string, GiaTriO>;

const MAU_NGAY_GIO = "dd/MM/yyyy HH:mm";

/**
 * Chữ do nguồn ngoài nhập (mã đơn, tên sản phẩm, tên kênh) mà bắt đầu bằng `= + - @` hoặc tab/CR bị
 * bảng tính coi là công thức khi người dùng sửa ô hay dán sang file khác ⇒ chèn dấu `'` đầu chuỗi, cùng
 * luật với xuất CSV tồn kho. Chỉ áp cho ô chữ; ô số giữ nguyên là số.
 */
function anToanO(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function ngayGio(d: Date | null): string {
  return d ? formatNgayVn(d, MAU_NGAY_GIO) : "";
}

/** Đơn hợp lệ (H) = không phải hoàn/hủy; hoàn/hủy chỉ còn phí sàn thực giữ (`returnedFee`). */
function laDonHopLe(d: DongDonHangChe): boolean {
  return d.status !== "RETURNED" && d.status !== "CANCELLED";
}

function cotChung(d: DongDonHangChe): DongXlsx {
  const hopLe = laDonHopLe(d);
  return {
    "Mã đơn": anToanO(d.code),
    "Mã sàn": anToanO(d.maSan ?? ""),
    "Ngày đặt": ngayGio(d.orderedAt),
    "Cập nhật": ngayGio(d.statusChangedAt),
    Kênh: anToanO(d.channelName),
    "Trạng thái": trangThaiHienThi(d.status).nhan,
    "Sản phẩm": anToanO(d.sanPhamDau?.ten ?? ""),
    "Số dòng hàng": d.soDongHang,
    "Tổng SL": d.tongSoLuong,
    "Tiền hàng": d.itemsTotal,
    Voucher: d.discount,
    "Phí sàn": hopLe ? d.platformFeeEst : d.returnedFee,
    "Tiền sau voucher và phí sàn": hopLe ? d.itemsTotal - d.discount - d.platformFeeEst : "",
    "Phí tạm tính": d.phiTamTinh ? "Có" : "",
  };
}

/**
 * Biên % làm tròn 1 số lẻ; bỏ trống khi đơn hoàn/hủy, thiếu giá vốn (biên sẽ sai) hoặc tiền hàng không dương.
 * Làm tròn trên TRỊ TUYỆT ĐỐI rồi gắn dấu (`Math.round` lệch về +∞ nên −12,35 thành −12,3 trong khi 12,35
 * thành 12,4), nhân trước chia sau cho khỏi sai số float ở ca ,x5; kết quả 0 luôn là +0 (ô không ra "-0").
 */
function bienPhanTram(d: DongXuatDonHang): GiaTriO {
  if (!laDonHopLe(d) || d.thieuGiaVon || d.itemsTotal <= 0) return "";
  const phanNghin = Math.round((Math.abs(d.laiDon) * 1000) / d.itemsTotal);
  if (phanNghin === 0) return 0;
  return (Math.sign(d.laiDon) * phanNghin) / 10;
}

function cotGiaVon(d: DongXuatDonHang): DongXlsx {
  return {
    "Giá vốn": d.giaVon,
    "Lãi đơn": d.laiDon,
    "Biên %": bienPhanTram(d),
    "Thiếu giá vốn": d.thieuGiaVon ? "Có" : "",
  };
}

/** Một sheet "Don hang"; `header` cố định để file rỗng vẫn có dòng tiêu đề. */
export function dungSheetXuatDonHang(kq: KetQuaXuatDonHang): SheetXuat {
  if (kq.coQuyenGiaVon) {
    return {
      name: "Don hang",
      header: [...HEADER_XUAT_DON_HANG_CHUNG, ...HEADER_XUAT_DON_HANG_GIA_VON],
      rows: kq.rows.map((d) => ({ ...cotChung(d), ...cotGiaVon(d) })),
    };
  }
  return { name: "Don hang", header: [...HEADER_XUAT_DON_HANG_CHUNG], rows: kq.rows.map(cotChung) };
}
