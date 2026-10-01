/**
 * Logic thuần của form quyền: bật/tắt một ô và kiểm tổ hợp. Tách khỏi component để test không cần DOM.
 * Quy tắc tổ hợp nằm ở `chuanHoaQuyen` (nguồn duy nhất) — file này KHÔNG lặp lại nó, chỉ gọi.
 */
import { chuanHoaQuyen, xemCuaSua, type Quyen } from "@/lib/quyen/danh-muc-quyen";

/** Bật/tắt `q`. Bật `:sua` kéo theo `:xem`; tắt `:xem` thì tắt luôn `:sua` cùng module (sửa ngầm định xem). */
export function batTatQuyen(giaTri: readonly Quyen[], q: Quyen, bat: boolean): Quyen[] {
  const tap = new Set<Quyen>(giaTri);
  if (bat) {
    tap.add(q);
    const xem = xemCuaSua(q);
    if (xem) tap.add(xem);
  } else {
    tap.delete(q);
    if (q.endsWith(":xem")) tap.delete(`${q.slice(0, -":xem".length)}:sua` as Quyen);
  }
  return [...tap];
}

/** Lỗi tổ hợp quyền (vd Lãi/Lỗ thiếu giá vốn) hoặc `null` khi hợp lệ. Không tự sửa. */
export function loiToHopQuyen(giaTri: readonly Quyen[]): string | null {
  const r = chuanHoaQuyen(giaTri);
  return r.ok ? null : r.error;
}
