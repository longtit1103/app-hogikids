/**
 * Next cấp `searchParams` dạng `string | string[] | undefined`: lặp tham số trên URL
 * (`?kenh=a&kenh=b`) cho MẢNG. Trang cứ gọi `sp.kenh?.split(",")` hay `sp.q.trim()` như thể luôn là
 * chuỗi thì gặp mảng là `TypeError` ⇒ 500 chỉ vì ai đó sửa tay URL. Chuẩn hoá một lần ngay sau
 * `await searchParams`: mảng → phần tử ĐẦU TIÊN (cùng quy ước với `URLSearchParams.get`), mảng rỗng → undefined.
 */
export type SearchParamsTho<T> = { [K in keyof T]?: string | string[] | undefined };

/** Giá trị đầu tiên của một tham số URL; `undefined` khi vắng hoặc mảng rỗng. */
export function chuoiDauTien(giaTri: string | string[] | undefined): string | undefined {
  return Array.isArray(giaTri) ? giaTri[0] : giaTri;
}

/** Ép MỌI khoá của `searchParams` về `string | undefined` (kể cả khoá lạ ngoài kiểu khai báo). */
export function chuanHoaSearchParams<T extends object>(tho: SearchParamsTho<T>): { [K in keyof T]?: string } {
  const ra: Record<string, string | undefined> = {};
  for (const [khoa, giaTri] of Object.entries(tho as Record<string, string | string[] | undefined>)) {
    ra[khoa] = chuoiDauTien(giaTri);
  }
  return ra as { [K in keyof T]?: string };
}
