import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `globalSetup` của Vitest phải GIÀNH khoá độc quyền DB test TRƯỚC khi nạp `tests/setup.ts` — file đó
 * upsert `Setting` ngay lúc import, nên nạp trước khi giữ khoá thì lượt bị từ chối (có lượt khác đang
 * chạy) vẫn kịp ghi vào DB của lượt kia. Test dựng hai mock: khoá (`giuKhoaDocQuyenDbTest`) và `./setup`
 * (đếm số lần module được nạp) rồi gọi `setup()` thật.
 */
const { soLanNapSetup, giuKhoa, nhaKhoa } = vi.hoisted(() => ({
  soLanNapSetup: { n: 0 },
  giuKhoa: vi.fn(),
  nhaKhoa: vi.fn(),
}));

vi.mock("../../helpers/khoa-doc-quyen-db-test", () => ({
  KHOA_VITEST: 260_818_001,
  giuKhoaDocQuyenDbTest: giuKhoa,
}));

vi.mock("../../setup", () => {
  soLanNapSetup.n += 1;
  return {};
});

describe("global setup: giữ khoá trước, seed sau", () => {
  const dbUrlGoc = process.env.DATABASE_URL;
  const testUrlGoc = process.env.TEST_DATABASE_URL;

  beforeEach(() => {
    soLanNapSetup.n = 0;
    giuKhoa.mockReset();
    nhaKhoa.mockReset();
    vi.resetModules();
    process.env.TEST_DATABASE_URL = testUrlGoc ?? "postgresql://x:y@localhost:5432/hogikids_test?schema=app";
  });

  afterEach(() => {
    if (dbUrlGoc === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = dbUrlGoc;
    if (testUrlGoc === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = testUrlGoc;
  });

  it("không giành được khoá ⇒ ném lỗi và KHÔNG nạp ./setup (không seed vào DB của lượt kia)", async () => {
    giuKhoa.mockRejectedValue(new Error("Có lượt Vitest KHÁC đang chạy"));
    const { setup } = await import("../../global-setup-khoa-chay-chong");

    await expect(setup()).rejects.toThrow(/lượt Vitest KHÁC/);

    expect(giuKhoa).toHaveBeenCalledTimes(1);
    expect(soLanNapSetup.n).toBe(0);
  });

  it("giành được khoá ⇒ nạp ./setup đúng một lần, trả lại DATABASE_URL gốc, hàm dọn nhả khoá", async () => {
    process.env.DATABASE_URL = "postgresql://x:y@localhost:5432/giu_nguyen?schema=app";
    giuKhoa.mockResolvedValue({ nha: nhaKhoa, conGiu: vi.fn() });
    const { setup } = await import("../../global-setup-khoa-chay-chong");

    const don = await setup();

    expect(giuKhoa).toHaveBeenCalledWith(process.env.TEST_DATABASE_URL, 260_818_001, "Vitest");
    expect(soLanNapSetup.n).toBe(1);
    expect(process.env.DATABASE_URL).toBe("postgresql://x:y@localhost:5432/giu_nguyen?schema=app");
    expect(nhaKhoa).not.toHaveBeenCalled();
    await don();
    expect(nhaKhoa).toHaveBeenCalledTimes(1);
  });
});
