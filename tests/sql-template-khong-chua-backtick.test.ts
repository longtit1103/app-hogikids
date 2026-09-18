import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Cổng chặn: chú thích SQL KHÔNG được chứa dấu backtick.
 *
 * Vì sao cần: khối SQL nằm trong template literal của JS, nên MỘT dấu backtick là
 * cắt đứt chuỗi ngay tại đó và biến phần SQL còn lại thành mã JS. Mà phản xạ tự
 * nhiên khi viết chú thích lại là bọc tên cột/tên hàm bằng backtick như trong
 * Markdown. Lỗi này tái phạm BỐN lần trong một đợt làm việc (18–19/08/2026), lần
 * nào cũng chỉ lộ khi tsc nôn ra một tràng lỗi cú pháp ở dòng cách xa chỗ gõ sai.
 *
 * Ba quyết định thiết kế của lưới, đều rút từ ca hỏng thật:
 *
 * 0. **Quét cả `tests/`, không chỉ mã chạy thật.** Raw SQL trong test cũng nằm trong template
 *    literal, cũng vỡ y hệt. Mở phạm vi kéo theo việc file NÀY tự lọt lưới (nó buộc phải chứa các
 *    chuỗi trông y như chú thích SQL có backtick) — giải bằng hằng `GACH_SQL` ngay dưới, KHÔNG bằng
 *    danh sách miễn trừ.
 *
 * 1. **Tự dò file, KHÔNG khai tay.** Bản đầu khai tay 3 file và thủng ngay 4 file
 *    lúc vừa viết — trong đó `land-raw.ts` (đường land Bronze) rủi ro cao hơn hẳn
 *    mấy file báo cáo đang được canh. Đây đúng lớp lỗi lưới `DUONG_GHI` khai tay
 *    từng giấu 3 lỗ phủ (18/08). Nay quét thư mục, thêm file mới là tự vào lưới.
 *
 * 2. **Bắt cả chú thích CUỐI DÒNG.** Bản đầu chỉ dò `^\s*--`, bỏ lọt kiểu viết đã
 *    có thật trong repo, trong land-raw.ts: WHERE ... IS NOT NULL   -- ghi chú.
 *
 * 3. **KHÔNG cắt khối template rồi tìm backtick trong thân.** Đã thử và thấy nó
 *    bắt hụt đúng ca cần bắt: backtick lạc làm khối bị cắt SỚM nên phần trích ra
 *    lại không chứa nó.
 *
 * Quy ước thay thế: trong chú thích SQL, viết tên cột/hàm TRẦN, không bọc gì.
 *
 * ⚠️ Lưới không đọc database, nhưng `globalSetup` của Vitest vẫn giành khoá DB test
 * trước khi chạy bất kỳ file nào — nên vẫn cần DB test sống.
 */

/**
 * Dấu gạch mở đầu chú thích SQL, viết thành hằng thay vì gõ thẳng.
 *
 * Vì sao: lưới nay quét CẢ `tests/`, mà file này buộc phải chứa các chuỗi "trông y như chú thích SQL
 * có backtick" — đó chính là fixture chứng minh lưới bắt đúng. Gõ thẳng thì lưới nêu chính nó, và
 * cách chữa duy nhất còn lại là loại file này khỏi phép quét — tức mở một lỗ miễn trừ, thứ lâu dài
 * sẽ có người khác nhét file của họ vào. Ghép qua hằng thì DÒNG MÃ không còn khớp mẫu, còn CHUỖI lúc
 * chạy vẫn y nguyên ⇒ fixture giữ nguyên sức nặng, lưới không cần biết đến ngoại lệ nào.
 */
const GACH_SQL = "--";

const GOC = resolve(fileURLToPath(import.meta.url), "../..");
const THU_MUC_QUET = ["src", "scripts", "tests"];
const BO_QUA = new Set(["node_modules", ".next", "dist", "coverage"]);

/** Dấu hiệu một dòng là chú thích SQL: dấu gạch đôi ở đầu dòng, hoặc ở cuối dòng sau khoảng trắng. */
const CO_CHU_THICH_SQL = /^\s*--|\s--\s/m;

/** Mọi file .ts có dùng raw SQL — tự dò, không khai tay. */
export function timFileCoSql(goc: string = GOC): string[] {
  const ket: string[] = [];
  const di = (thuMuc: string) => {
    for (const muc of readdirSync(thuMuc, { withFileTypes: true })) {
      if (muc.name.startsWith(".") || BO_QUA.has(muc.name)) continue;
      const duong = join(thuMuc, muc.name);
      if (muc.isDirectory()) di(duong);
      else if (muc.name.endsWith(".ts") && /\$(queryRaw|executeRaw)/.test(readFileSync(duong, "utf8")))
        ket.push(duong);
    }
  };
  for (const t of THU_MUC_QUET) di(join(goc, t));
  return ket.sort();
}

/**
 * Dòng chú thích SQL có backtick.
 *
 * Nhận cả hai kiểu: gạch đôi đầu dòng, và gạch đôi cuối dòng. Chỉ tính backtick
 * nằm SAU dấu `--` — backtick trước đó là phần của mã TS (vd mở template literal),
 * hoàn toàn hợp lệ.
 *
 * Đòi khoảng trắng quanh `--` ở kiểu cuối dòng để không dính toán tử giảm của JS
 * (`i--`), thứ không bao giờ viết kèm khoảng trắng hai bên.
 */
export function timChuThichSqlCoBacktick(nguon: string): { dong: number; noiDung: string }[] {
  return nguon
    .split("\n")
    .map((noiDung, i) => ({ dong: i + 1, noiDung }))
    .filter(({ noiDung }) => {
      const m = /^\s*--|\s--\s/.exec(noiDung);
      return m !== null && noiDung.slice(m.index).includes("`");
    });
}

describe("chú thích SQL không được chứa backtick", () => {
  const file = timFileCoSql();

  // Phép đếm này là một assert: đổi cấu trúc thư mục / đổi tên hàm mà lưới lặng lẽ
  // canh tập rỗng thì tệ hơn không có lưới.
  //
  // ⚠️ Đếm ĐÚNG ĐẠI LƯỢNG mà lưới canh: số file CÓ CHÚ THÍCH SQL, không phải số
  // file có raw SQL. Bản trước ghim `file.length >= 7` — mà `file` là 25 file có
  // raw SQL, còn 7 là số file có chú thích. Ngưỡng đặt nhầm đại lượng như vậy thì
  // mất 18/25 file lưới vẫn xanh. Đúng lớp lỗi "guard đếm một con số không nối với
  // thứ nó canh" mà chính file này sinh ra để chặn.
  it("tự dò ra được các file có chú thích SQL", () => {
    const coChuThich = file.filter((f) => CO_CHU_THICH_SQL.test(readFileSync(f, "utf8")));
    // Ngưỡng 8 có BIÊN ĐỘ 0 — repo đang có đúng 8 file. Nên khi đỏ, người sửa phải phân
    // biệt được hai ca ngược nhau hoàn toàn, kẻo hạ ngưỡng đúng lúc lưới vừa thủng.
    expect(
      coChuThich.length,
      `Đếm được ${coChuThich.length} file có chú thích SQL, ngưỡng là 8 (repo đang có ĐÚNG 8, biên độ 0).\n` +
        `Hai ca hoàn toàn khác nhau — đọc kỹ trước khi sửa:\n` +
        `• Vừa gộp/xoá file, hoặc dời một chú thích SQL lên docblock TS: đúng là còn ít hơn thật ⇒ ` +
        `hạ ngưỡng xuống con số mới, KÈM lý do.\n` +
        `• Không đụng gì tới chú thích SQL: LƯỚI VỪA THỦNG (phép dò file hỏng, đổi tên thư mục, ` +
        `regex sai) ⇒ sửa lưới, TUYỆT ĐỐI đừng hạ ngưỡng.\n` +
        `Danh sách đang thấy: ${JSON.stringify(coChuThich.map((f) => relative(GOC, f)), null, 2)}`
    ).toBeGreaterThanOrEqual(8);

    const tuongDoi = coChuThich.map((f) => relative(GOC, f));
    // Hai file mốc rủi ro cao nhất: đường land Bronze và lõi đối soát tiền.
    expect(tuongDoi).toContain("src/lib/bronze/land-raw.ts");
    expect(tuongDoi).toContain("src/lib/reports/doi-soat-tien-ve.ts");
  });

  it("không file nào có backtick trong chú thích SQL", () => {
    const xau = file
      .map((f) => ({ file: relative(GOC, f), dong: timChuThichSqlCoBacktick(readFileSync(f, "utf8")) }))
      .filter((x) => x.dong.length > 0);
    expect(
      xau,
      `Backtick trong chú thích SQL — bỏ backtick đi, viết tên cột/hàm trần:\n` +
        `${JSON.stringify(xau, null, 2)}\n` +
        `(Nếu dòng bị nêu là chú thích TS chứ không phải SQL: BỎ BACKTICK khỏi dòng đó là xong. ` +
        `ĐỪNG đổi dấu gạch kép thành "—" khi dòng chứa lệnh shell — vd "npm test ${GACH_SQL} ${GACH_SQL}run" — ` +
        `đổi thế là hỏng lệnh, chép ra chạy không được.)`
    ).toEqual([]);
  });

  it("lưới TỰ ĐỨNG — bắt chú thích ĐẦU DÒNG", () => {
    expect(timChuThichSqlCoBacktick(`  ${GACH_SQL} lấy \`cot\` mới nhất`)).toHaveLength(1);
  });

  it("lưới TỰ ĐỨNG — bắt chú thích CUỐI DÒNG (kiểu land-raw.ts đang viết)", () => {
    expect(timChuThichSqlCoBacktick(`    WHERE x IS NOT NULL   ${GACH_SQL} cần \`externalId\``)).toHaveLength(1);
  });

  it("không báo oan: chú thích TS, SQL sạch, và toán tử giảm của JS", () => {
    const sach = [
      "  // docblock TS nhắc `Order.status` — hợp lệ",
      "  -- lay cot moi nhat",
      "  for (let i = n; i--; ) x(`a`);",
      "  const q = prisma.$queryRaw`",
    ].join("\n");
    expect(timChuThichSqlCoBacktick(sach)).toEqual([]);
  });
});
