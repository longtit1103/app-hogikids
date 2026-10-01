/**
 * Tham số `quyen` + narrow kết quả `KetQuaChe` cho test (spec phân quyền §4.1). Không giả lập người
 * dùng — chỉ là hai hằng quyền và hai hàm ép nhánh, ném khi hàm dưới test trả NHẦM nhánh.
 */
export const DAY = { coQuyenGiaVon: true } as const;
export const CHE = { coQuyenGiaVon: false } as const;

type CoNhanh = { coQuyenGiaVon: boolean };

export function nhanhDay<T extends CoNhanh>(kq: T): Extract<T, { coQuyenGiaVon: true }> {
  if (!kq.coQuyenGiaVon) throw new Error("Mong nhánh ĐỦ quyền giá vốn, nhận nhánh che");
  return kq as Extract<T, { coQuyenGiaVon: true }>;
}

export function nhanhChe<T extends CoNhanh>(kq: T): Extract<T, { coQuyenGiaVon: false }> {
  if (kq.coQuyenGiaVon) throw new Error("Mong nhánh CHE, nhận nhánh đủ quyền giá vốn");
  return kq as Extract<T, { coQuyenGiaVon: false }>;
}
