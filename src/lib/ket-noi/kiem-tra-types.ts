/**
 * Kiểu kết quả chung cho nút "Kiểm tra kết nối" ở trang Cài đặt.
 *
 * Bất biến: `chiTiet` hiện NGUYÊN VĂN trên UI ⇒ TUYỆT ĐỐI không nhét giá trị khóa/token vào —
 * chỉ mô tả kết cục ("khóa bị từ chối", "thấy 3 shop"...). Test khóa điều này.
 */

export type DongKiemTra = {
  /** Nhãn dòng — vd tên shop / tên phép thử. */
  nhan: string;
  ok: boolean;
  chiTiet: string;
};

export type KetQuaKiemTra = {
  /** true khi MỌI dòng ok — một dòng đỏ là cả nguồn coi như chưa thông. */
  ok: boolean;
  dong: DongKiemTra[];
};

export function gopKetQua(dong: DongKiemTra[]): KetQuaKiemTra {
  return { ok: dong.length > 0 && dong.every((d) => d.ok), dong };
}

/** Probe ra internet — 12s đủ phân biệt "chậm" với "không tới nơi", không treo UI. */
export const KIEM_TRA_TIMEOUT_MS = 12_000;
