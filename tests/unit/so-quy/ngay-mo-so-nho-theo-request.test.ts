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

/**
 * Cùng luật cho ngữ cảnh nợ phải trả nhớ theo request (mốc M + lịch sử gắn nền tảng ↔ thẻ): chỉ đường đọc
 * lúc render. Action bật công tắc / sửa gắn thẻ rồi đọc lại quỹ trong cùng lượt mà dùng bản nhớ là tính
 * quỹ theo công thức CŨ ngay sau khi bật. Đường ghi gọi `docNguCanhLoc()` trần.
 */
const DUOC_DUNG_NGU_CANH_NHO = [
  "lib/no-phai-tra/doc-ngu-canh-loc.ts", // nơi định nghĩa
  "lib/so-quy/so-quy-queries.ts", // `tinhSoQuyThang` thiếu ctx
  "lib/so-quy/dong-chay-so-quy-queries.ts", // `docSoQuyDongChay` thiếu ctx
  "lib/so-quy/du-bao-quy-queries.ts", // biểu đồ + banner dự báo (chỉ render)
  "lib/reports/cash-flow.ts", // `computeCashFlow` — tab Dòng tiền, cùng bản chụp với thẻ Quỹ cùng trang
  "lib/no-phai-tra/the-tin-dung-queries.ts", // `docTheKemTrangThai` — khối Nợ phải trả, cùng trang với thẻ Quỹ
];

describe("docNguCanhLocTrongRequest chỉ dùng trên đường đọc lúc render", () => {
  it("đúng danh sách file được dùng bản nhớ", () => {
    const dungBanNho = docTatCa(SRC)
      .filter((f) => f.noiDung.includes("docNguCanhLocTrongRequest"))
      .map((f) => f.file);
    expect(dungBanNho.sort()).toEqual([...DUOC_DUNG_NGU_CANH_NHO].sort());
  });
});
