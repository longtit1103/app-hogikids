/**
 * Vitest globalSetup — chạy MỘT LẦN cho cả lượt, trong tiến trình runner.
 *
 * Đặt ở đây chứ không ở `setupFiles`: `setupFiles` chạy LẠI cho từng file test, nên khoá sẽ bị
 * giành/nhả liên tục và không có cái nào sống suốt lượt. `globalSetup` có đúng một cặp
 * "vào lượt / hết lượt", là vòng đời mà khoá cần.
 */
import { giuKhoaDocQuyenDbTest, KHOA_VITEST } from "./helpers/khoa-doc-quyen-db-test";

export async function setup() {
  // Nhập ĐỘNG `./setup` để dùng lại ĐÚNG guard chống trỏ nhầm DB prod của nó (bắt buộc có
  // `TEST_DATABASE_URL`, tên database kết thúc `_test`, phải KHÁC `DATABASE_URL`). Chép mấy phép
  // kiểm đó sang đây là đẻ bản song sinh, mà bản song sinh sớm muộn cũng trôi khỏi bản gốc.
  //
  // ⚠️ PHẢI TRẢ LẠI `DATABASE_URL` NGAY SAU ĐÓ. `./setup` ép `DATABASE_URL = TEST_DATABASE_URL`;
  // worker của Vitest được fork từ tiến trình NÀY nên thừa kế nguyên `process.env`, rồi chạy lại
  // `setup.ts` — tới đó phép "phải KHÁC DATABASE_URL" sẽ so URL với CHÍNH NÓ và từ chối oan.
  // Đo thật 18/08 khi chưa trả lại: **120/120 file test đỏ** kèm "TEST_DATABASE_URL trùng
  // DATABASE_URL". Đây đúng là cái bẫy mà bộ e2e đã gặp và ghi lại trong
  // `tests/e2e/test-database-url.ts` (biến cờ `E2E_DATABASE_URL_FORCED`) — cùng một hình dạng lỗi,
  // khác đường đi.
  const dbUrlGoc = process.env.DATABASE_URL;
  await import("./setup");
  const urlDbTest = process.env.DATABASE_URL!;
  if (dbUrlGoc === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = dbUrlGoc;

  const khoa = await giuKhoaDocQuyenDbTest(urlDbTest, KHOA_VITEST, "Vitest");
  return async () => {
    await khoa.nha();
  };
}
