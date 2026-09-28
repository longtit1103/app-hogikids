import { describe, expect, it } from "vitest";

import { trangThaiThungRac } from "@/lib/thung-rac/trang-thai-thung-rac";

/**
 * 3 ca hiển thị của cột "Trạng thái" màn thùng rác. `lyDo`/`khoiPhucLuc` đến THẲNG từ
 * `listThungRac()` (đã tự gọi `lyDoKhongKhoiPhuc()` — không kiểm lại logic đó ở đây, chỉ kiểm hàm
 * SUY TRẠNG THÁI từ 2 cột đó có đúng không).
 */
describe("trangThaiThungRac", () => {
  it("khôi phục được: chưa khôi phục, không có lý do chặn", () => {
    const t = trangThaiThungRac({ khoiPhucLuc: null, lyDo: null });
    expect(t).toEqual({ kind: "khoi_phuc_duoc" });
  });

  it("không khôi phục được: còn lý do chặn, ưu tiên hiện lý do dù chưa khôi phục", () => {
    const t = trangThaiThungRac({ khoiPhucLuc: null, lyDo: "Bản ghi này đã tồn tại lại trong sổ" });
    expect(t).toEqual({ kind: "khong_khoi_phuc_duoc", lyDo: "Bản ghi này đã tồn tại lại trong sổ" });
  });

  it("đã khôi phục: nhãn kèm mốc thời gian, BỎ QUA lý do nếu có", () => {
    const luc = new Date(2026, 8, 17, 9, 5); // 17/09/2026 09:05
    const t = trangThaiThungRac({ khoiPhucLuc: luc, lyDo: "Mục này đã được khôi phục" });
    expect(t).toEqual({ kind: "da_khoi_phuc", nhan: "Đã khôi phục 17/09/2026 09:05" });
  });
});
