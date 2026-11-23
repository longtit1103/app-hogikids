import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Ghi một file dấu rỗng vào thư mục tạm do test hợp đồng truyền qua `THU_MUC_DAU_QUA_TRAN` — test hợp đồng đọc lại
 * danh sách dấu để biết ca / hook / file nào của lượt con đã chạy.
 */
export function ghiDau(ten: string): void {
  const thuMuc = process.env.THU_MUC_DAU_QUA_TRAN;
  if (!thuMuc || !path.isAbsolute(thuMuc)) {
    throw new Error("Fixture quá trần cần THU_MUC_DAU_QUA_TRAN là đường dẫn tuyệt đối (do test hợp đồng đặt).");
  }
  writeFileSync(path.join(thuMuc, ten), "");
}
