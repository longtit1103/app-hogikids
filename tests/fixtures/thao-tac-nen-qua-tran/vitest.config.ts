import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Lượt Vitest CON mà test hợp đồng `tests/thao-tac-nen-cho-xong-truoc-khi-don.integration.test.ts` tự khởi chạy để đo
 * nhánh "thao tác nền còn sống quá trần" bằng hành động THẬT (huỷ cả lượt) — chạy trong lượt chính thì nó giết chính
 * lượt chính. Các file fixture KHÔNG chạm DB (chỉ ghi file dấu vào thư mục tạm), nên không có `setupFiles` /
 * `globalSetup` (khoá độc quyền DB test đang do lượt chính giữ). Cùng pool mặc định (`forks`, `isolate`) như
 * `vitest.config.ts` gốc — đúng cơ chế mỗi file một tiến trình con cần đo.
 */
const dirname = path.dirname(fileURLToPath(import.meta.url));
const goc = path.resolve(dirname, "../../..");

/** File chạy theo tên: file "kế tiếp" mang tiền tố `z-` để luôn chạy SAU file gặp thao tác quá trần (a/c/d). */
class TheoTen extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((x, y) => x.moduleId.localeCompare(y.moduleId));
  }
}

export default defineConfig({
  root: goc,
  resolve: { alias: { "@": path.resolve(goc, "src") } },
  test: {
    environment: "node",
    include: ["tests/fixtures/thao-tac-nen-qua-tran/*.fixture.ts"],
    fileParallelism: false,
    sequence: { sequencer: TheoTen },
  },
});
