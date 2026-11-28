import type { OrderStatus } from "@/generated/prisma/client";

import { formatPercent, formatVnd } from "@/lib/format";
import type { DongDonHang, DongDonHangChe } from "@/lib/orders/don-hang-kieu-du-lieu";
import { formatPlatformFeeRatio, returnedOrderFeeDisplay } from "@/lib/orders/provisional-fee";

/**
 * Mô hình CHỮ của từng ô trong dòng đơn — bảng và thẻ điện thoại dùng chung để hai nơi không lệch nhau.
 * Hàm thuần: chỉ định dạng số server đã tính (`laiDon`, `phiTamTinh`…), KHÔNG tính lại lãi/phí/cờ tạm tính.
 */
export type OChu = { so: string; phu: string | null; kieu: "thuong" | "xam" | "lo" | "canh-bao" };

const DAU_TRU = "−";
const KHONG_CO = "—";

/** Đơn tính vào doanh thu/lãi (loại hoàn + hủy). */
export function laDonHopLe(status: OrderStatus): boolean {
  return status !== "RETURNED" && status !== "CANCELLED";
}

/**
 * Tỉ lệ `tu / mau` dạng phần trăm (qua `formatPercent`) có dấu trừ chuẩn U+2212 — Intl của trình
 * duyệt/Node trả dấu gạch nối ASCII. Số âm làm tròn về 0 ra "0%" (không "−0%"); mẫu ≤ 0 ⇒ "—" (không
 * chia 0). Dùng chung dòng đơn, thẻ số và drawer để ba nơi viết biên cùng một kiểu.
 */
export function phanTramCoDau(tu: number, mau: number): string {
  if (mau <= 0) return KHONG_CO;
  const chu = formatPercent((tu * 100) / mau);
  if (/^-0%$/.test(chu)) return "0%";
  return chu.replace(/^-/, DAU_TRU);
}

/**
 * Ô "Phí sàn". Đơn hợp lệ: `−platformFeeEst` (0 ⇒ "—") + tỉ lệ. Đơn hoàn/hủy: số THỰC sàn giữ
 * (`returnedFee`) — kênh nào cũng hiện khi > 0 (cùng số ô Lãi trừ); `0 ₫` "sàn giữ" khi sàn phí thật còn treo. `tamTinh` luôn lấy từ `phiTamTinh` của server (cùng biểu thức với chip
 * lọc) — hàm KHÔNG tự suy lại; `returnedOrderFeeDisplay` chỉ dùng để chọn số hiển thị cho đơn hoàn/hủy.
 */
export function oPhiSan(d: DongDonHangChe, now: Date): OChu & { tamTinh: boolean } {
  const tamTinh = d.phiTamTinh;

  if (!laDonHopLe(d.status)) {
    const hoan = returnedOrderFeeDisplay(d, now);
    if (hoan.show) return { so: formatVnd(-hoan.fee), phu: "sàn giữ", kieu: "thuong", tamTinh };
    return { so: KHONG_CO, phu: "sàn không giữ phí", kieu: "thuong", tamTinh };
  }

  if (d.platformFeeEst === 0) {
    return { so: KHONG_CO, phu: d.channelId === "direct" ? "không phí sàn" : null, kieu: "thuong", tamTinh };
  }
  return {
    so: formatVnd(-d.platformFeeEst),
    phu: formatPlatformFeeRatio(d.platformFeeEst, d.itemsTotal),
    kieu: "thuong",
    tamTinh,
  };
}

/**
 * Ô "Lãi đơn" — CHỈ gọi ở nhánh có quyền giá vốn (kiểu `DongDonHang` mới có `laiDon`).
 * Đơn hoàn/hủy luôn xám (không bao giờ đỏ): lãi = −phí sàn sàn giữ. Thiếu giá vốn ⇒ cảnh báo, không biên.
 */
export function oLaiDon(d: DongDonHang): OChu {
  if (!laDonHopLe(d.status)) {
    return d.returnedFee > 0
      ? { so: formatVnd(-d.returnedFee), phu: "phí sàn giữ", kieu: "xam" }
      : { so: KHONG_CO, phu: "không tính", kieu: "xam" };
  }
  if (d.thieuGiaVon) {
    return { so: `⚠ ${formatVnd(d.laiDon)}`, phu: "thiếu giá vốn", kieu: "canh-bao" };
  }
  return {
    so: formatVnd(d.laiDon),
    phu: d.itemsTotal > 0 ? `biên ${phanTramCoDau(d.laiDon, d.itemsTotal)}` : null,
    kieu: d.laiDon < 0 ? "lo" : "thuong",
  };
}

/** Ô "Sản phẩm": tên SP đầu + "×SL"; dòng phụ "+N sản phẩm khác" và tên khách (chỉ kênh bán trực tiếp). */
export function oSanPham(d: DongDonHangChe): { ten: string; soLuong: string; phu: string | null } {
  const phu: string[] = [];
  if (d.soDongHang > 1) phu.push(`+${d.soDongHang - 1} sản phẩm khác`);
  if (d.tenKhach) phu.push(d.tenKhach);
  return {
    ten: d.sanPhamDau?.ten ?? KHONG_CO,
    soLuong: d.sanPhamDau ? `×${d.sanPhamDau.soLuong}` : "",
    phu: phu.length > 0 ? phu.join(" · ") : null,
  };
}

/** Đơn lỗ: hợp lệ ∧ lãi < 0. Đơn hoàn/hủy KHÔNG BAO GIỜ là đơn lỗ dù lãi (= −phí sàn giữ) âm. */
export function laDongLo(d: DongDonHang): boolean {
  return laDonHopLe(d.status) && d.laiDon < 0;
}
