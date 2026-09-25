import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `ngayMoSoTrongRequest` là D0 NHỚ THEO REQUEST (React `cache`) — chỉ an toàn trên đường đọc lúc
 * render, nơi không ai ghi `CashMovement` giữa hai lần đọc. Một server action / script ghi rồi đọc lại
 * D0 qua bản nhớ có thể nhận D0 CŨ (vd dòng ghi tay đầu tiên vừa tạo ⇒ vẫn "chưa mở sổ") nếu một ngày
 * `cache` nhớ cả ngoài render. Đường ghi phải gọi `ngayMoSo()` trần.
 *
 * Đọc MÃ NGUỒN cả `src/` và khoá ĐÚNG danh sách file được dùng bản nhớ: thêm nơi dùng mới là phải qua
 * đây và tự trả lời "file này có chạy sau một lần ghi `CashMovement` trong cùng lượt không?".
 */
const SRC = path.resolve(__dirname, "../../../src");

const DUOC_DUNG_BAN_NHO = [
  // Nơi định nghĩa + `tinhSoQuyThang` (thẻ Quỹ, Sổ quỹ dòng chạy, banner dự báo — đều chỉ đọc lúc render).
  "lib/so-quy/so-quy-queries.ts",
  // Ô "Còn ở ví TikTok" cạnh thẻ Quỹ — chỉ gọi từ trang `/tai-chinh`.
  "lib/vi-san/vi-tiktok-con-lai-toi-thieu-queries.ts",
];

function docTatCa(thuMuc: string, tienTo = ""): { file: string; noiDung: string }[] {
  const ra: { file: string; noiDung: string }[] = [];
  for (const ten of readdirSync(thuMuc)) {
    const duongDan = path.join(thuMuc, ten);
    const nhan = tienTo === "" ? ten : `${tienTo}/${ten}`;
    if (statSync(duongDan).isDirectory()) ra.push(...docTatCa(duongDan, nhan));
    else if (/\.tsx?$/.test(ten)) ra.push({ file: nhan, noiDung: readFileSync(duongDan, "utf8") });
  }
  return ra;
}

describe("ngayMoSoTrongRequest chỉ dùng trên đường đọc lúc render", () => {
  const moiFile = docTatCa(SRC);

  it("quét được mã nguồn (lưới không bao giờ rỗng)", () => {
    expect(moiFile.length).toBeGreaterThan(100);
  });

  it("đúng danh sách file được dùng bản nhớ", () => {
    const dungBanNho = moiFile.filter((f) => f.noiDung.includes("ngayMoSoTrongRequest")).map((f) => f.file);
    expect(dungBanNho.sort()).toEqual([...DUOC_DUNG_BAN_NHO].sort());
  });

  it("đường ghi rồi đọc D0 vẫn đọc tươi bằng `ngayMoSo()` trần", () => {
    for (const file of ["lib/actions/so-du-chot-thang.ts", "lib/nhap-hang/doc-phieu-nhap-bronze.ts"]) {
      const f = moiFile.find((x) => x.file === file);
      expect(f, `${file} phải tồn tại — đổi tên thì sửa lưới`).toBeDefined();
      expect(f!.noiDung).toMatch(/\bngayMoSo\(\)/);
    }
  });
});
