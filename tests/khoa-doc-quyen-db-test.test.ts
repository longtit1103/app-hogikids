import { describe, expect, it } from "vitest";

import { NHIP_TU_KIEM_MS, TUOI_KET_NOI_GIAY, giuKhoaDocQuyenDbTest, motKetNoi } from "./helpers/khoa-doc-quyen-db-test";

/**
 * Khoá độc quyền database test — phép kiểm cho CHÍNH cái chốt đang bảo vệ mọi lượt test khác.
 *
 * Lý do có file này (25/08 → 30/08): khoá TUỘT khi pool Prisma thay kết nối quá 300s tuổi ở lần
 * checkout kế tiếp, mà không test nào biết — helper chỉ được gọi ở `globalSetup`, chưa từng có test
 * riêng. Ba điều khai:
 *  1. Giành được ⇒ `conGiu()` = true; lượt thứ hai cùng khoá bị TỪ CHỐI NGAY (không xếp hàng);
 *     nhả xong thì lượt sau giành được.
 *  2. `conGiu()` nhìn theo SESSION, không theo số khoá: tay cầm đã nhả (kết nối đóng, Prisma mở
 *     session mới khi hỏi lại) phải trả false NGAY CẢ KHI khoá đó đang được tay cầm khác giữ. Đây
 *     là nhánh phát hiện tuột — pool thay kết nối cũng chính là "session mới không giữ khoá".
 *  3. URL của kết nối giữ khoá PHẢI mang `connection_limit=1` + hai tham số kéo tuổi kết nối (đo
 *     30/08: bỏ chúng là khoá mất ở câu lệnh đầu tiên sau mốc 300s — với nhịp tự kiểm 60s thì đúng
 *     phút 5). Tuổi ≥ 1 giờ: full suite 6–7,5 phút, còn dư cho lượt chạy chậm gấp nhiều lần.
 *
 * Khoá số RIÊNG cho file này: `KHOA_VITEST` đang được `globalSetup` giữ suốt lượt, giành lại là
 * tự tranh với chính mình. Không đụng DB nghiệp vụ nên không cần dọn fixture.
 */

const KHOA_THU = 260_818_999;
// `tests/setup.ts` đã hoán DATABASE_URL sang TEST_DATABASE_URL (và từ chối chạy nếu trỏ DB thật).
const urlDbTest = () => process.env.DATABASE_URL!;

describe("khoá độc quyền database test", () => {
  it("giành được ⇒ conGiu() true; lượt thứ hai cùng khoá bị từ chối ngay; nhả xong giành lại được", async () => {
    const a = await giuKhoaDocQuyenDbTest(urlDbTest(), KHOA_THU, "lượt A");
    try {
      expect(await a.conGiu()).toBe(true);
      await expect(giuKhoaDocQuyenDbTest(urlDbTest(), KHOA_THU, "lượt B")).rejects.toThrow(
        /Có lượt lượt B KHÁC đang chạy trên cùng database test/,
      );
    } finally {
      await a.nha();
    }

    const b = await giuKhoaDocQuyenDbTest(urlDbTest(), KHOA_THU, "lượt B");
    try {
      expect(await b.conGiu()).toBe(true);
    } finally {
      await b.nha();
    }
  });

  it("conGiu() nhìn theo SESSION: tay cầm đã nhả hỏi lại ⇒ false dù khoá đang được tay cầm khác giữ", async () => {
    const a = await giuKhoaDocQuyenDbTest(urlDbTest(), KHOA_THU, "lượt A");
    await a.nha();

    const b = await giuKhoaDocQuyenDbTest(urlDbTest(), KHOA_THU, "lượt B");
    try {
      // Số khoá ĐANG bị giữ (bởi b) — nhưng session của a đã đóng, hỏi lại là session mới ⇒ phải false.
      // Đổi phép kiểm thành "có ai giữ khoá này không" là test này đỏ: đúng lỗ hổng mà pool thay kết nối chui qua.
      expect(await a.conGiu()).toBe(false);
      expect(await b.conGiu()).toBe(true);
    } finally {
      await b.nha();
    }
  });

  it("URL kết nối giữ khoá: 1 kết nối + tuổi kết nối ≥ 1 giờ (bỏ tham số tuổi = tái tạo lỗi tuột phút 5)", () => {
    const u = new URL(motKetNoi("postgresql://u:p@host:5432/hogikids_test?schema=app"));
    expect(u.searchParams.get("connection_limit")).toBe("1");
    expect(u.searchParams.get("max_connection_lifetime")).toBe(String(TUOI_KET_NOI_GIAY));
    expect(u.searchParams.get("max_idle_connection_lifetime")).toBe(String(TUOI_KET_NOI_GIAY));
    expect(u.searchParams.get("schema")).toBe("app"); // không làm rơi tham số sẵn có
    expect(TUOI_KET_NOI_GIAY).toBeGreaterThanOrEqual(60 * 60);
    // Nhịp tự kiểm phải ngắn hơn hẳn tuổi kết nối — nếu không, tuột rồi mới hỏi thì hỏi làm gì.
    expect(NHIP_TU_KIEM_MS).toBeLessThan(TUOI_KET_NOI_GIAY * 1000 / 10);
  });
});
