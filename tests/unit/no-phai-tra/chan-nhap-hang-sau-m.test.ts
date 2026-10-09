import { describe, expect, it } from "vitest";

import { chanNhapHangSauM, LoiNhapHangSauM } from "@/lib/no-phai-tra/chan-nhap-hang-sau-m";

/**
 * Cổng đóng đường ghi "Nhập hàng" sau mốc M — thuần trên `Setting` giả (không DB). Biên theo NGÀY giờ
 * VN: 31/10 23:59 vẫn trước M, 01/11 00:00 đã là M.
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);

/** `db` giả chỉ có `setting.findUnique` — đúng phần `docMocM` đọc. */
function dbVoiM(giaTri: string | null) {
  return {
    setting: {
      findUnique: async () => (giaTri === null ? null : { value: giaTri }),
    },
  } as unknown as Parameters<typeof chanNhapHangSauM>[0];
}

describe("chanNhapHangSauM", () => {
  it("M null ⇒ không ném, kể cả purchase ngày xa", async () => {
    await expect(chanNhapHangSauM(dbVoiM(null), { categoryId: "purchase", date: vn("2027-01-01T00:00:00") })).resolves.toBeUndefined();
  });

  it("purchase 31/10 23:59 VN với M = 01/11 ⇒ không ném", async () => {
    await expect(chanNhapHangSauM(dbVoiM("2026-11-01"), { categoryId: "purchase", date: vn("2026-10-31T23:59:59") })).resolves.toBeUndefined();
  });

  it("purchase 01/11 00:00 VN ⇒ ném LoiNhapHangSauM mã DA_BAT_NO_PHAI_TRA", async () => {
    const p = chanNhapHangSauM(dbVoiM("2026-11-01"), { categoryId: "purchase", date: vn("2026-11-01T00:00:00") });
    await expect(p).rejects.toBeInstanceOf(LoiNhapHangSauM);
    await expect(p).rejects.toMatchObject({ code: "DA_BAT_NO_PHAI_TRA" });
    // Form Sổ chi phí + màn duyệt phiếu dùng chung câu này: chỉ đường sổ nợ, không gợi ý đổi ngày.
    await expect(p).rejects.toMatchObject({
      message: expect.stringContaining("Từ ngày bật theo dõi nợ (01/11/2026), tiền hàng ghi qua sổ nợ: ghi nhận phiếu rồi Trả tiền hàng"),
    });
  });

  it("purchase sau M nhiều ngày ⇒ ném", async () => {
    await expect(chanNhapHangSauM(dbVoiM("2026-11-01"), { categoryId: "purchase", date: vn("2026-12-15T10:00:00") })).rejects.toBeInstanceOf(LoiNhapHangSauM);
  });

  it("ads 01/11 ⇒ không ném (chỉ danh mục purchase bị đóng) và không đọc Setting", async () => {
    let daDoc = false;
    const db = {
      setting: {
        findUnique: async () => {
          daDoc = true;
          return { value: "2026-11-01" };
        },
      },
    } as unknown as Parameters<typeof chanNhapHangSauM>[0];
    await expect(chanNhapHangSauM(db, { categoryId: "ads", date: vn("2026-11-01T00:00:00") })).resolves.toBeUndefined();
    expect(daDoc).toBe(false);
  });
});
