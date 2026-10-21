import { describe, expect, it, vi } from "vitest";

import { lyDoCuaDong } from "@/lib/thung-rac/thung-rac-queries";
import type { TinhTrangKhoiPhuc } from "@/lib/thung-rac/ly-do-khong-khoi-phuc";

const tinhTrangSach: TinhTrangKhoiPhuc = {
  daKhoiPhuc: false,
  idDaTonTaiLai: false,
  refIdBiChiem: null,
  chaDaMat: null,
  chaDaTatToan: null,
  thangDaCoDinhKy: false,
  seLamAmSoDu: null,
  viPhamNoPhaiTra: null,
};

describe("lyDoCuaDong — bỏ lượt dò cho dòng đã khôi phục", () => {
  it("dòng đã khôi phục: KHÔNG gọi lượt dò, trả đúng câu mà dò đầy đủ sẽ ra", async () => {
    const doTinh = vi.fn(async () => tinhTrangSach);
    const lyDo = await lyDoCuaDong(true, doTinh);
    expect(doTinh).not.toHaveBeenCalled();
    expect(lyDo).toBe("Mục này đã được khôi phục");
  });

  it("dòng chưa khôi phục và khôi phục được: gọi lượt dò một lần, lý do null", async () => {
    const doTinh = vi.fn(async () => tinhTrangSach);
    expect(await lyDoCuaDong(false, doTinh)).toBeNull();
    expect(doTinh).toHaveBeenCalledTimes(1);
  });

  it("dòng chưa khôi phục nhưng id đã tồn tại lại: câu lý do lấy từ lượt dò", async () => {
    const lyDo = await lyDoCuaDong(false, async () => ({ ...tinhTrangSach, idDaTonTaiLai: true }));
    expect(lyDo).toBe("Bản ghi này đã tồn tại lại trong sổ");
  });
});
