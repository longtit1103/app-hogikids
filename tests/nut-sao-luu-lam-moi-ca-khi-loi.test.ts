import { describe, expect, it, vi } from "vitest";

import { chayLuotSaoLuu } from "@/components/settings/chay-luot-sao-luu";

/**
 * Bất biến của nút "Sao lưu ngay": LƯỢT NÀO CŨNG làm mới màn hình, kể cả lượt lỗi.
 *
 * Vì sao đáng một suite riêng: lượt lỗi VẪN ghi `SyncLog{kind:BACKUP,status:ERROR}`
 * (`api/backup/route.ts`), mà thẻ "Sao lưu" ở Cài đặt › Dữ liệu render ở SERVER. Chỉ refresh ở
 * nhánh thành công thì bấm nút → hỏng → toast đỏ chớp qua, còn thẻ vẫn khoe "Sao lưu gần nhất:
 * <mốc cũ>" — màn hình nói dối đúng lúc người dùng cần tin nó nhất.
 *
 * Test gọi thẳng hàm điều phối (không render component): repo không có jsdom/testing-library, và
 * đây cũng chính là lý do logic được tách khỏi `backup-button.tsx`.
 */
function dungPhuThuoc(taiBanSaoLuu: () => Promise<void>) {
  return {
    taiBanSaoLuu,
    baoThanhCong: vi.fn(),
    baoLoi: vi.fn(),
    lamMoiManHinh: vi.fn(),
  };
}

describe("chayLuotSaoLuu", () => {
  it("lượt THÀNH CÔNG → toast xanh + làm mới màn hình", async () => {
    const pt = dungPhuThuoc(vi.fn(async () => {}));

    await chayLuotSaoLuu(pt);

    expect(pt.baoThanhCong).toHaveBeenCalledWith("Đã tạo bản sao lưu");
    expect(pt.baoLoi).not.toHaveBeenCalled();
    expect(pt.lamMoiManHinh).toHaveBeenCalledTimes(1);
  });

  it("lượt LỖI → toast đỏ và VẪN làm mới màn hình (thẻ Sao lưu phải đổi sang trạng thái lỗi)", async () => {
    const pt = dungPhuThuoc(
      vi.fn(async () => {
        throw new Error("pg_dump: connection to server failed");
      }),
    );

    await chayLuotSaoLuu(pt);

    expect(pt.baoThanhCong).not.toHaveBeenCalled();
    expect(pt.baoLoi).toHaveBeenCalledWith("Sao lưu thất bại: pg_dump: connection to server failed");
    // Dòng khoá của cả suite: gỡ `finally` ở `chay-luot-sao-luu.ts` là test này đỏ.
    expect(pt.lamMoiManHinh).toHaveBeenCalledTimes(1);
  });

  it("lỗi không phải Error → vẫn có toast đỏ mặc định và vẫn làm mới", async () => {
    const pt = dungPhuThuoc(
      vi.fn(async () => {
        throw "hỏng kiểu lạ";
      }),
    );

    await chayLuotSaoLuu(pt);

    expect(pt.baoLoi).toHaveBeenCalledWith("Sao lưu thất bại");
    expect(pt.lamMoiManHinh).toHaveBeenCalledTimes(1);
  });

  it("không ném lỗi ra ngoài — caller chỉ còn phải lo cờ loading", async () => {
    const pt = dungPhuThuoc(
      vi.fn(async () => {
        throw new Error("bất kỳ");
      }),
    );

    await expect(chayLuotSaoLuu(pt)).resolves.toBeUndefined();
  });

  it("toast bắn TRƯỚC lúc làm mới — người bấm biết kết quả ngay, không chờ server render", async () => {
    const pt = dungPhuThuoc(vi.fn(async () => {}));

    await chayLuotSaoLuu(pt);

    expect(pt.baoThanhCong.mock.invocationCallOrder[0]).toBeLessThan(
      pt.lamMoiManHinh.mock.invocationCallOrder[0],
    );
  });
});
