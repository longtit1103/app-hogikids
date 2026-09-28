import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SUPABASE_SYSTEM_SCHEMAS } from "@/lib/backup/assert-plain-sql-only-schema";

/**
 * Danh sách schema HỆ THỐNG Supabase tồn tại HAI BẢN SONG SINH, và cả hai đều nằm trên đường phục
 * hồi thảm hoạ:
 *
 *  - `SUPABASE_SYSTEM_SCHEMAS` (TS) — guard của nút "Phục hồi từ file" trong app.
 *  - `SYSTEM_SCHEMAS` (bash) — guard của `deploy/restore.sh`, đường chạy bằng `supabase_admin` khi
 *    sự cố thật.
 *
 * Trước test này, parity giữa hai bên CHỈ được kiểm gián tiếp qua phán quyết trên fixture
 * (`restore-sh-guard.test.ts`): một schema hệ thống MỚI thêm vào một bên mà quên bên kia sẽ không
 * làm đỏ gì cả, vì fixture chỉ chứa các schema cũ. Hậu quả là đúng lúc phục hồi thật, một trong hai
 * đường để lọt dump full-DB Supabase và đè dữ liệu hệ thống.
 *
 * So theo TẬP (không theo thứ tự): thứ tự trong bash là chuỗi phân tách bằng khoảng trắng, trong TS
 * là mảng — ràng buộc thứ tự chỉ đẻ ra đỏ giả khi ai đó sắp xếp lại một bên.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const RESTORE_SH = path.join(repoRoot, "deploy/restore.sh");

/**
 * Rút `SYSTEM_SCHEMAS="a b c"` từ restore.sh. Cố ý KHÔNG `source` file rồi đọc biến: test này phải
 * đỏ cả khi ai đó đổi dòng gán thành thứ bash vẫn chạy được nhưng người đọc không còn thấy danh
 * sách (vd ghép từ 2 biến) — lúc đó regex không khớp và ta muốn biết.
 */
function docSystemSchemasCuaShell(): string[] {
  const sh = readFileSync(RESTORE_SH, "utf8");
  const m = sh.match(/^SYSTEM_SCHEMAS="([^"]*)"/m);
  if (!m) {
    throw new Error(
      'Không tìm thấy dòng gán `SYSTEM_SCHEMAS="…"` trong deploy/restore.sh — twin bash đã đổi hình ' +
        "dạng. Sửa test này CÙNG LÚC với việc đổi đó, đừng xoá nó: đây là chốt duy nhất ép hai bản " +
        "song sinh không trôi khỏi nhau.",
    );
  }
  return m[1].split(/\s+/).filter(Boolean);
}

describe("SYSTEM_SCHEMAS — hai bản song sinh phải khớp", () => {
  it("tập schema hệ thống trong deploy/restore.sh KHỚP TUYỆT ĐỐI với bản TS", () => {
    const shell = docSystemSchemasCuaShell();
    const ts = [...SUPABASE_SYSTEM_SCHEMAS];

    // So theo tập đã sắp xếp để thông báo lỗi chỉ ra ĐÚNG phần tử lệch, thay vì in cả hai mảng.
    expect([...new Set(shell)].sort()).toEqual([...new Set(ts)].sort());
  });

  it("không bên nào có phần tử lặp (lặp = dấu hiệu vừa merge tay hỏng)", () => {
    const shell = docSystemSchemasCuaShell();
    expect(shell).toHaveLength(new Set(shell).size);
    expect(SUPABASE_SYSTEM_SCHEMAS).toHaveLength(new Set(SUPABASE_SYSTEM_SCHEMAS).size);
  });

  it("danh sách không rỗng — bản rỗng làm guard mất hiệu lực trong im lặng", () => {
    expect(docSystemSchemasCuaShell().length).toBeGreaterThan(0);
    expect(SUPABASE_SYSTEM_SCHEMAS.length).toBeGreaterThan(0);
  });
});
