import { coQuyen, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";

/**
 * Che giá vốn / lợi nhuận TỪ SERVER (spec phân quyền §4.1).
 *
 * Mọi hàm đọc dữ liệu có trường nhạy cảm (giá vốn, giá trị tồn, COGS, lãi gộp/ròng, biên) nhận tham
 * số cuối `quyen: QuyenGiaVon` và trả `KetQuaChe<Day, Che>` — union có phân biệt theo
 * `coQuyenGiaVon`. Nhánh `false` KHÔNG mang các trường đó ở cả kiểu lẫn runtime (hàm query trực tiếp
 * không `select` cột `costPrice`; số tổng hợp qua `calcPnl` thì chiếu DTO chỉ-pick). Component phải
 * narrow bằng `if (kq.coQuyenGiaVon)` mới đọc được trường nhạy cảm — TS chặn đọc bừa.
 */
export type QuyenGiaVon = { coQuyenGiaVon: boolean };

export type KetQuaChe<Day, Che> = ({ coQuyenGiaVon: true } & Day) | ({ coQuyenGiaVon: false } & Che);

/** Quyền giá vốn của người đang đăng nhập — nguồn DUY NHẤT để page/route dựng tham số `quyen`. */
export function quyenGiaVonCua(nd: NguoiDung): QuyenGiaVon {
  return { coQuyenGiaVon: coQuyen(nd, "gia-von-loi-nhuan:xem") };
}
