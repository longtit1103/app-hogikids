import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * BẤT BIẾN: **SOI ĐÚNG VĂN BẢN SẼ CHẠY.**
 *
 * `deploy/restore.sh` nhánh custom nay bung `.dump` ra SQL phẳng rồi đẩy qua `assert_sql_only_schema`
 * (không còn chỉ soi TOC). Bản bung CHỈ có giá trị khi nó dựng ra ĐÚNG văn bản mà lệnh nạp sẽ chạy —
 * tức cùng bộ cờ CHỌN-LỌC, khác đúng phần kết nối:
 *
 *  - Bung THIẾU `-n <schema>` ⇒ văn bản soi có entry NGOÀI schema mà lệnh nạp vốn sẽ bỏ qua ⇒ guard
 *    (a)/(e) TỪ CHỐI OAN chính bản dump HỢP LỆ. Đây là lỗi nguy hiểm nhất của đường DR: nó chỉ nổ
 *    đúng lúc chủ shop cần phục hồi.
 *  - Bung THIẾU `--no-owner`/`--no-privileges` ⇒ soi cả `ALTER … OWNER TO` / `GRANT` vốn không chạy.
 *  - Bung THỪA cờ so với lệnh nạp ⇒ soi một văn bản khác với văn bản chạy, guard thành trang trí.
 *
 * Test đọc thẳng `deploy/restore.sh` thay vì `source` rồi gọi: nó phải đỏ cả khi ai đó đổi dòng
 * lệnh thành thứ bash vẫn chạy được nhưng người đọc không còn đối chiếu được hai bộ cờ.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const RESTORE_SH = path.join(here, "../../..", "deploy/restore.sh");

/** Cờ KẾT NỐI — phần được phép khác nhau giữa lượt bung và lượt nạp. */
const CO_KET_NOI = new Set(["-U", "-d", "-h", "-p"]);
/** Cờ chỉ có ở lượt BUNG: ghi SQL ra stdout thay vì nạp vào DB. */
const CO_CHI_CO_KHI_BUNG = new Set(["-f"]);

/**
 * Rút mọi lệnh `pg_restore` CÓ `--clean` trong restore.sh (bỏ `pg_restore -l` đọc TOC), trả về tập
 * cờ của từng lệnh. Nối dòng gãy bằng `\` trước khi tách.
 */
function boCoCuaCacLenhPgRestore(): Array<Set<string>> {
  const sh = readFileSync(RESTORE_SH, "utf8")
    // Bỏ dòng COMMENT trước: comment trong file này cũng nhắc tên cờ, đếm cả chúng là đỏ giả.
    .split("\n")
    .filter((d) => !d.trimStart().startsWith("#"))
    .join("\n")
    // Nối dòng gãy bằng `\` để một lệnh nằm trọn trên một dòng.
    .replace(/\\\n\s*/g, " ");
  const lenh = [...sh.matchAll(/pg_restore\s+([^\n<|]*)/g)]
    .map((m) => m[1].trim())
    .filter((x) => x.includes("--clean"));
  return lenh.map((x) => {
    const tok = x.split(/\s+/);
    const co = new Set<string>();
    for (let i = 0; i < tok.length; i++) {
      // `-` trần là THAM SỐ của `-f` (ghi ra stdout), không phải cờ.
      if (!tok[i].startsWith("-") || tok[i] === "-") continue;
      // `-n` mang GIÁ TRỊ vào tập: so tên cờ không thôi thì `-n "$SCHEMA"` và `-n public` vẫn xanh,
      // mà đó đúng là ca từ-chối-oan nguy hiểm nhất (bung khác schema với lệnh nạp).
      co.add(tok[i] === "-n" ? `-n ${tok[i + 1]}` : tok[i]);
    }
    return co;
  });
}

describe("cờ bung `.dump` ⊂ cờ nạp — soi đúng văn bản sẽ chạy", () => {
  it("restore.sh có ĐÚNG 2 lệnh pg_restore mang --clean (một bung, một nạp)", () => {
    expect(boCoCuaCacLenhPgRestore()).toHaveLength(2);
  });

  it("hai lệnh chỉ khác nhau ở phần KẾT NỐI và cờ `-f` của lượt bung", () => {
    const [bung, nap] = boCoCuaCacLenhPgRestore();
    // Lượt bung là lượt có `-f`; không phụ thuộc thứ tự xuất hiện trong file.
    const [coF, khongF] = bung.has("-f") ? [bung, nap] : [nap, bung];

    const thuaOBung = [...coF].filter((c) => !khongF.has(c));
    const thieuOBung = [...khongF].filter((c) => !coF.has(c));

    expect(thuaOBung.filter((c) => !CO_CHI_CO_KHI_BUNG.has(c))).toEqual([]);
    expect(thieuOBung.filter((c) => !CO_KET_NOI.has(c))).toEqual([]);
  });

  it("lượt bung GIỮ `-n <schema>` — thiếu nó là từ chối oan dump HỢP LỆ", () => {
    const bung = boCoCuaCacLenhPgRestore().find((c) => c.has("-f"));
    expect(bung).toBeDefined();
    // Giá trị phải là CHÍNH biến schema của lệnh nạp, không phải một hằng gõ tay.
    expect([...bung!]).toContain('-n "$SCHEMA"');
    expect([...bung!]).toContain("--no-owner");
    expect([...bung!]).toContain("--no-privileges");
  });

  it("lượt bung KHÔNG mở kết nối DB (không `-d`) — mọi bước kiểm phải xong trước khi đụng dữ liệu", () => {
    const bung = boCoCuaCacLenhPgRestore().find((c) => c.has("-f"));
    expect([...bung!]).not.toContain("-d");
    expect([...bung!]).not.toContain("-U");
  });
});

/**
 * Bước soi nội dung chạy TRỌN bộ guard của đường plain, gồm cả (h) "chuỗi nháy trải nhiều dòng". Đo
 * 22/09/2026: dump HỢP LỆ có `COMMENT ON … IS '…\n…'` (Supabase Studio ghi khi điền ô "Description")
 * bị (h) từ chối. Trước bản vá, đường `.dump` nhận nó — và chính vì vậy nó đang được ghi khắp code
 * là lối thoát khi guard plain từ chối oan. Siết mà không chừa cửa = chủ shop mất đường phục hồi
 * cuối cùng đúng lúc thảm hoạ (bài học `total_discount` âm).
 */
describe("lối thoát cho từ-chối-oan trên đường `.dump`", () => {
  const sh = readFileSync(RESTORE_SH, "utf8");

  it("có cờ bỏ-qua `BO_QUA_KIEM_NOI_DUNG_DUMP` cho nhánh custom", () => {
    expect(sh).toContain("BO_QUA_KIEM_NOI_DUNG_DUMP");
  });

  it("câu TỪ CHỐI chỉ thẳng cách chạy lại — không bắt người dùng tự mò lúc DR", () => {
    const iTuChoi = sh.indexOf('assert_sql_only_schema "$SCHEMA" "$sql_bung"');
    expect(iTuChoi).toBeGreaterThan(-1);
    // Khối xử lý lỗi nằm ngay sau lời gọi; 600 ký tự đủ phủ và không nuốt sang phần khác.
    expect(sh.slice(iTuChoi, iTuChoi + 600)).toContain("BO_QUA_KIEM_NOI_DUNG_DUMP=1");
  });

  it("bỏ qua kiểm NỘI DUNG vẫn giữ guard TOC và `-n <schema>` khi nạp", () => {
    // Hai chốt cứng này nằm NGOÀI nhánh bỏ-qua, nên cờ không bao giờ tắt được chúng.
    // Neo vào CÂU LỆNH `if`, không phải lần nhắc tên cờ đầu tiên (comment đầu file cũng nhắc nó).
    const iCo = sh.indexOf('if [[ "${BO_QUA_KIEM_NOI_DUNG_DUMP:-}" == "1" ]]');
    expect(iCo).toBeGreaterThan(-1);
    expect(sh.indexOf('assert_toc_only_schema "$SCHEMA"')).toBeLessThan(iCo);
    expect(sh).toContain('-n "$SCHEMA" -U supabase_admin -d "$DB"');
  });
});
