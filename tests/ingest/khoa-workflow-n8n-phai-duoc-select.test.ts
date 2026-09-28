import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * BẤT BIẾN: mọi khoá mà node Code của workflow n8n ĐỌC (`KHOA.x` hoặc khai trong `KHOA_THIEU`)
 * PHẢI nằm trong mệnh đề `key in (...)` của node Postgres "Lấy khoá từ bảng Setting" CÙNG file.
 *
 * Vì sao phải khoá bằng test: hai nửa nằm ở hai node khác nhau trong cùng một file JSON — sửa
 * jsCode mà quên câu SELECT thì workflow throw "THIẾU KHOÁ" ngay lượt chạy đầu (đồng bộ đơn +
 * chi tiêu ads đứng im), và thông báo lỗi chỉ trỏ tới bảng Setting, dẫn người sửa đi sai hướng
 * (khoá CÓ trong bảng, chỉ là không được nạp). Review đối kháng 21/08 bắt được đúng lỗi này ở
 * 5/9 file sau đợt chuyển shop id sang cấu hình.
 */

const N8N_DIR = path.resolve(process.cwd(), "n8n");

type NodeN8n = { type: string; parameters?: { query?: string; jsCode?: string } };

function docWorkflow(file: string): NodeN8n[] {
  const raw = JSON.parse(readFileSync(path.join(N8N_DIR, file), "utf8")) as
    | { nodes: NodeN8n[] }
    | Array<{ nodes: NodeN8n[] }>;
  return (Array.isArray(raw) ? raw[0] : raw).nodes;
}

describe("khoá workflow n8n phải được node Postgres SELECT", () => {
  const files = readdirSync(N8N_DIR).filter((f) => f.endsWith(".json"));
  it.each(files)("%s", (file) => {
    const nodes = docWorkflow(file);
    const daSelect = new Set<string>();
    const daDung = new Set<string>();
    for (const n of nodes) {
      if (n.type.endsWith(".postgres")) {
        for (const [, k] of (n.parameters?.query ?? "").matchAll(/'([A-Za-z0-9_]+)'/g)) daSelect.add(k);
      }
      const js = n.parameters?.jsCode ?? "";
      for (const [, k] of js.matchAll(/KHOA\.([A-Za-z0-9_]+)/g)) daDung.add(k);
      for (const [, arr] of js.matchAll(/KHOA_THIEU\s*=\s*\[([^\]]*)\]/g)) {
        for (const [, k] of arr.matchAll(/"([A-Za-z0-9_]+)"/g)) daDung.add(k);
      }
    }
    if (daDung.size === 0) return; // workflow không đọc khoá nào (không có node Code dùng KHOA)
    const thieu = [...daDung].filter((k) => !daSelect.has(k));
    expect(thieu, `jsCode đọc khoá chưa được SELECT trong node Postgres: ${thieu.join(", ")}`).toEqual([]);
  });
});
