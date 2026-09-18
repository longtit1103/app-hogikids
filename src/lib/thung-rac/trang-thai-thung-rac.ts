import { format } from "date-fns";

/**
 * Suy TRẠNG THÁI hiển thị cho một dòng thùng rác từ 2 cột đã có sẵn (`khoiPhucLuc`, `lyDo` —
 * `lyDo` đến THẲNG từ `lyDoKhongKhoiPhuc()`, xem `thung-rac-queries.ts`). Hàm THUẦN, tách khỏi JSX
 * để test bằng literal thay vì render cả bảng.
 */
export type TrangThaiThungRac =
  | { kind: "da_khoi_phuc"; nhan: string }
  | { kind: "khong_khoi_phuc_duoc"; lyDo: string }
  | { kind: "khoi_phuc_duoc" };

export function trangThaiThungRac(dong: {
  khoiPhucLuc: Date | null;
  lyDo: string | null;
}): TrangThaiThungRac {
  if (dong.khoiPhucLuc !== null) {
    return { kind: "da_khoi_phuc", nhan: `Đã khôi phục ${format(dong.khoiPhucLuc, "dd/MM/yyyy HH:mm")}` };
  }
  if (dong.lyDo !== null) return { kind: "khong_khoi_phuc_duoc", lyDo: dong.lyDo };
  return { kind: "khoi_phuc_duoc" };
}
