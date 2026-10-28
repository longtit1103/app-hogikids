/**
 * Vitest globalSetup — chạy MỘT LẦN cho cả lượt, trong tiến trình runner.
 *
 * Đặt ở đây chứ không ở `setupFiles`: `setupFiles` chạy LẠI cho từng file test, nên khoá sẽ bị
 * giành/nhả liên tục và không có cái nào sống suốt lượt. `globalSetup` có đúng một cặp
 * "vào lượt / hết lượt", là vòng đời mà khoá cần.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { giuKhoaDocQuyenDbTest, KHOA_VITEST } from "./helpers/khoa-doc-quyen-db-test";

export async function setup() {
  const dbUrlGoc = process.env.DATABASE_URL;

  // THỨ TỰ LÀ CHỦ ĐÍCH: giành khoá TRƯỚC, nạp `./setup` SAU. `./setup` không chỉ kiểm URL — nó còn
  // GHI vào DB test (upsert 4 shop id vào `Setting`) ngay lúc import. Nạp nó trước khi giữ khoá thì
  // lượt bị từ chối vì có lượt khác đang chạy vẫn kịp ghi đè `Setting` của lượt kia (cùng giá trị
  // hằng, nhưng sai nếu một test đang đổi các key đó giữa chừng).
  //
  // Muốn có URL để giành khoá thì phải nạp `.env` trước — đúng một dòng như `./setup` làm (Node ≥ 20.6,
  // KHÔNG đè biến shell đã set). Các phép kiểm chống trỏ nhầm DB prod (tên DB kết thúc `_test`, khác
  // `DATABASE_URL`) KHÔNG chép sang đây — chúng ở lại MỘT chỗ duy nhất là `./setup`, và chạy ngay sau
  // khi giữ khoá (cũng chạy lại ở mọi worker trước khi test nào chạm DB). Khoá tư vấn chỉ là một số
  // trong `pg_locks`, không ghi dữ liệu nên vô hại kể cả khi URL sai; nhưng nếu `./setup` từ chối thì
  // phải NHẢ khoá ngay (xem `catch` dưới), đừng để lượt hỏng giữ khoá tới khi tiến trình thoát.
  const envPath = path.resolve(process.cwd(), ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const urlDbTest = process.env.TEST_DATABASE_URL;
  if (!urlDbTest) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Refusing to run tests without an explicit test database — dev Postgres is shared with prod.",
    );
  }

  const khoa = await giuKhoaDocQuyenDbTest(urlDbTest, KHOA_VITEST, "Vitest");

  try {
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
    await import("./setup");
  } catch (loi) {
    await khoa.nha();
    throw loi;
  } finally {
    if (dbUrlGoc === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = dbUrlGoc;
  }

  return async () => {
    await khoa.nha();
  };
}
