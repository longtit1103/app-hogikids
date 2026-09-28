import { afterEach, describe, expect, it } from "vitest";

import {
  conGiuKhoa,
  giaHanKhoa,
  giuKhoaViecNang,
  traKhoaViecNang,
} from "@/lib/backup/khoa-viec-nang";
import { prisma } from "@/lib/prisma";

/**
 * Khoá "việc nặng" phải nằm Ở DB, không phải cờ trong bộ nhớ.
 *
 * Cờ `globalThis` chỉ có hiệu lực TRONG container app, mà script dựng lại chạy ở TIẾN TRÌNH RIÊNG.
 * Kịch bản hỏng: script đang chạy → chủ shop bấm "Xóa dữ liệu giao dịch" → lượt xoá vẫn giành được
 * cờ trong app, chốt kho thô rồi xoá Sổ → script chạy tiếp với quyền ghi đè của lượt tay và dựng
 * dữ liệu trở lại. Nút xoá báo thành công nhưng bị hoàn tác ngầm.
 */

const KHOA_KEY = "khoaViecNang";

afterEach(async () => {
  await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
});

describe("khoá việc nặng dùng chung (ở DB)", () => {
  it("chỉ MỘT bên giành được; bên kia biết ai đang giữ", async () => {
    const a = await giuKhoaViecNang("dựng lại từ kho thô (script)");
    expect(a.the).not.toBeNull();

    const b = await giuKhoaViecNang("xoá dữ liệu giao dịch");
    expect(b.the).toBeNull();
    if (b.the) return;
    expect(b.dangGiu).toContain("dựng lại");
  });

  it("giành NGUYÊN TỬ: nhiều lượt bấm cùng lúc chỉ một lượt thắng", async () => {
    // Kiểm-rồi-giành luôn còn khe giữa lúc kiểm và lúc giành — nhất là khi script còn dừng chờ
    // người gõ xác nhận. Điều kiện thắng phải nằm TRONG chính câu ghi.
    const ketQua = await Promise.all(
      Array.from({ length: 8 }, (_, i) => giuKhoaViecNang(`việc ${i}`))
    );
    expect(ketQua.filter((r) => r.the !== null)).toHaveLength(1);
  });

  it("trả khoá rồi thì bên khác giành được", async () => {
    const a = await giuKhoaViecNang("việc A");
    if (!a.the) throw new Error("phải giành được");
    await traKhoaViecNang(a.the);

    const b = await giuKhoaViecNang("việc B");
    expect(b.the).not.toBeNull();
  });

  it("KHÔNG giật được khoá của việc khác khi trả nhầm thẻ", async () => {
    const a = await giuKhoaViecNang("việc A");
    if (!a.the) throw new Error("phải giành được");

    // Thẻ giả (vd một tiến trình cũ đã mất khoá) không được phép xoá khoá đang có chủ.
    await traKhoaViecNang({ token: "the-gia", viec: "việc giả" });

    expect(await conGiuKhoa(a.the)).toBe(true);
  });

  it("khoá QUÁ HẠN thì việc khác giành được (tiến trình cũ đã chết)", async () => {
    const a = await giuKhoaViecNang("việc treo");
    if (!a.the) throw new Error("phải giành được");
    // Ép hạn về quá khứ như thể chủ khoá chết mà không kịp trả.
    await prisma.setting.update({
      where: { key: KHOA_KEY },
      data: { value: `${a.the.token}|${Date.now() - 1000}|việc treo` },
    });

    const b = await giuKhoaViecNang("việc mới");
    expect(b.the).not.toBeNull();
    // HÀNG RÀO: chủ cũ phải TỰ BIẾT mình đã mất khoá, để dừng chứ không ghi tiếp. Hạn mà không kèm
    // hàng rào thì còn nguy hơn không hạn — hai bên cùng ghi lên một tập dữ liệu.
    expect(await conGiuKhoa(a.the)).toBe(false);
  });

  it("nhịp tim gia hạn được khi còn giữ, và thất bại khi đã mất", async () => {
    const a = await giuKhoaViecNang("việc A");
    if (!a.the) throw new Error("phải giành được");
    expect(await giaHanKhoa(a.the)).toBe(true);

    await traKhoaViecNang(a.the);
    expect(await giaHanKhoa(a.the)).toBe(false);
  });
});
