import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BANG_LAN_THAY, mocPhienBanSql, thuTuPhienBanSql } from "@/lib/bronze/transform-raw-helpers";

/**
 * LƯỚI: mọi bộ đọc "bản đứng đầu" của bảng có cột lần thấy (`BANG_LAN_THAY`) phải xếp theo thứ tự phiên bản CHUNG
 * (`thuTuPhienBanSql` / `thuTuPhienBan` — mốc `COALESCE("mocChup","lanThayCuoi","fetchedAt")`), KHÔNG `"fetchedAt" DESC` trần.
 *
 * Vì sao: nguồn trả lại nội dung cũ (A → B → A) chỉ đưa A lên đầu qua cột lần thấy. Một bộ đọc còn xếp `fetchedAt`
 * trần thì nó vẫn thấy B — và hai nơi đọc cùng một bảng ra hai con số (Silver sản phẩm nói A, đề xuất giá vốn nói B;
 * sổ chi phí dựng lại nói A, màn /marketing nói B) mà không log nào đỏ. Lần rà 28/10 tìm ra 3 bộ đọc như vậy ngoài
 * `latestPayloads`.
 *
 * Cách dò (tự quét `src/` + `scripts/`, KHÔNG khai tay file), fail-closed:
 *  1. Bảng TĨNH: với mỗi `"fetchedAt" DESC`, bảng của câu là mệnh đề `FROM`/`JOIN` "Raw…" GẦN NHẤT phía trước (có hay
 *     không tiền tố schema `app.`). Bảng thuộc danh sách ⇒ vi phạm.
 *  2. Bảng NỘI SUY (`FROM "${table}"` — chính `latestPayloads`): lưới không biết bảng nào ⇒ file có câu nội suy bảng
 *     mà còn bất kỳ `"fetchedAt" DESC` trần nào là vi phạm. Bộ đọc chung phải đi qua `thuTuPhienBanSql(table)`.
 *  3. ORM: file chạm model Prisma của bảng trong danh sách mà có `fetchedAt: "desc"` hoặc `_max: { fetchedAt`.
 *  4. Hằng: `thuTuPhienBanSql`/`mocPhienBanSql` của MỌI bảng trong danh sách phải xếp theo lần thấy (đột biến đổi
 *     helper về `"fetchedAt" DESC` thì quy tắc 1–3 không thấy gì — chỗ này bắt).
 *  5. Mốc chép tay `COALESCE("lanThayCuoi", …)` (thiếu `mocChup` đứng đầu) — bộ đọc đó lại để trang trễ của lượt chụp
 *     trước đẩy bản cũ lên đầu.
 */

const GOC = resolve(fileURLToPath(import.meta.url), "../../..");
const THU_MUC_QUET = ["src", "scripts"];
/** Thư mục build/sinh mã — tên ghép để dòng mã không chứa nguyên văn tên thư mục ẩn. */
const BO_QUA = new Set(["node_modules", "." + "next", "dist", "coverage", "generated"]);

function lietKeFileTs(thuMuc: string): string[] {
  const ket: string[] = [];
  for (const muc of readdirSync(thuMuc, { withFileTypes: true })) {
    if (BO_QUA.has(muc.name)) continue;
    const duong = join(thuMuc, muc.name);
    if (muc.isDirectory()) ket.push(...lietKeFileTs(duong));
    else if (/\.(ts|tsx|mts)$/.test(muc.name)) ket.push(duong);
  }
  return ket;
}

const DESC_TRAN = /"fetchedAt"\s+DESC/g;
const BANG_TINH = /\b(?:FROM|JOIN)\s+(?:\w+\.)?"(Raw[A-Za-z]+)"/g;
const BANG_NOI_SUY = /\b(?:FROM|JOIN)\s+(?:\w+\.)?"\$\{/;
/**
 * Mốc phiên bản chép tay mà mở đầu bằng `lanThayCuoi` = thiếu `mocChup` (chỉ có ở 3 bảng này nên không cần biết bảng).
 * Helper chung dựng mốc từ danh sách cột nên không chứa nguyên văn mẫu này.
 */
const MOC_THIEU_CHUP = /COALESCE\(\s*(?:\w+\.)?"lanThayCuoi"/g;

/** Các vi phạm SQL thô trong một đoạn mã nguồn. Thuần — để test tự kiểm bằng mẫu. */
function viPhamSql(noiDung: string, bang: ReadonlySet<string>): string[] {
  const ket: string[] = [];
  for (const m of noiDung.matchAll(MOC_THIEU_CHUP)) {
    ket.push(`mốc phiên bản chép tay thiếu "mocChup" @ dòng ${noiDung.slice(0, m.index ?? 0).split("\n").length}`);
  }
  const cacBang = [...noiDung.matchAll(BANG_TINH)].map((m) => ({ viTri: m.index ?? 0, bang: m[1] }));
  const coNoiSuy = BANG_NOI_SUY.test(noiDung);
  for (const m of noiDung.matchAll(DESC_TRAN)) {
    const viTri = m.index ?? 0;
    const dong = noiDung.slice(0, viTri).split("\n").length;
    if (coNoiSuy) {
      ket.push(`bảng nội suy + "fetchedAt" DESC trần @ dòng ${dong}`);
      continue;
    }
    const truoc = cacBang.filter((f) => f.viTri < viTri);
    const gan = truoc[truoc.length - 1];
    if (gan && bang.has(gan.bang)) ket.push(`${gan.bang} @ dòng ${dong}`);
  }
  return ket;
}

/** Tên model Prisma (camelCase trên client) của bảng — `RawMetaAdsReport` ⇒ `rawMetaAdsReport`. */
const tenModel = (bang: string) => bang[0].toLowerCase() + bang.slice(1);

/**
 * Mỗi chỗ xếp `fetchedAt: "desc"` / `_max: { fetchedAt` quy về lời gọi model Prisma GẦN NHẤT phía trước
 * (`.<model>.<hàm>(`) — chỉ vi phạm khi CHÍNH model đó thuộc danh sách. Soi theo cả file sẽ báo nhầm file vừa
 * đọc bảng trong danh sách (lọc thường) vừa lấy max `fetchedAt` ở bảng KHÁC.
 */
function viPhamOrm(noiDung: string, bang: ReadonlySet<string>): string[] {
  const modelTrongDs = new Map([...bang].map((b) => [tenModel(b), b] as const));
  const loiGoi = [...noiDung.matchAll(/\.(\w+)\.(?:findMany|findFirst|findFirstOrThrow|findUnique|groupBy|aggregate)\(/g)].map(
    (m) => ({ viTri: m.index ?? 0, model: m[1] }),
  );
  const ket: string[] = [];
  for (const m of noiDung.matchAll(/fetchedAt:\s*["']desc["']|_max:\s*\{[^}]*\bfetchedAt\b/g)) {
    const truoc = loiGoi.filter((g) => g.viTri < (m.index ?? 0));
    const gan = truoc[truoc.length - 1];
    const b = gan ? modelTrongDs.get(gan.model) : undefined;
    if (b) ket.push(`${b} (ORM xếp/lấy max theo fetchedAt)`);
  }
  return ket;
}

describe("lưới thứ tự phiên bản kho thô", () => {
  it("không bộ đọc nào xếp bảng có cột lần thấy theo fetchedAt trần", () => {
    const viPham: string[] = [];
    for (const thuMuc of THU_MUC_QUET) {
      for (const file of lietKeFileTs(join(GOC, thuMuc))) {
        const noiDung = readFileSync(file, "utf8");
        for (const v of [...viPhamSql(noiDung, BANG_LAN_THAY), ...viPhamOrm(noiDung, BANG_LAN_THAY)]) {
          viPham.push(`${relative(GOC, file)}: ${v}`);
        }
      }
    }
    expect(viPham, "dùng thuTuPhienBanSql/thuTuPhienBan từ transform-raw-helpers.ts").toEqual([]);
  });

  it("hằng thứ tự của MỌI bảng trong danh sách xếp theo lần thấy cuối (đột biến helper ⇒ đỏ)", () => {
    expect(BANG_LAN_THAY.size).toBeGreaterThan(0);
    for (const b of BANG_LAN_THAY) {
      expect(mocPhienBanSql(b), b).toBe(`COALESCE("mocChup", "lanThayCuoi", "fetchedAt")`);
      expect(thuTuPhienBanSql(b), b).toBe(`COALESCE("mocChup", "lanThayCuoi", "fetchedAt") DESC, "id" DESC`);
    }
    // Bảng ngoài danh sách KHÔNG có cột ⇒ helper phải trả `fetchedAt` (nhắc tới cột không có là câu SQL nổ).
    expect(mocPhienBanSql("RawTiktokShopStatement")).toBe(`"fetchedAt"`);
  });

  it("tự kiểm: mẫu vi phạm bị bắt, mẫu đúng / bảng ngoài danh sách thì không", () => {
    const bang = new Set(["RawMetaAdsReport"]);
    const sai = `SELECT DISTINCT ON ("externalId") payload FROM "RawMetaAdsReport" WHERE x ORDER BY "externalId", "fetchedAt" DESC, "id" DESC`;
    expect(viPhamSql(sai, bang)).toHaveLength(1);
    expect(viPhamSql(`SELECT 1 FROM app."RawMetaAdsReport" r ORDER BY "fetchedAt" DESC`, bang)).toHaveLength(1);
    expect(viPhamSql(`FROM "Product" p JOIN "RawMetaAdsReport" r ON 1=1 ORDER BY r."fetchedAt" DESC`, bang)).toHaveLength(
      1,
    );
    expect(viPhamSql("const t = 'x'; q(`SELECT 1 FROM \"${t}\" ORDER BY \"fetchedAt\" DESC`)", bang)).toHaveLength(1);
    const dung = `FROM "RawMetaAdsReport" ORDER BY "externalId", COALESCE("mocChup", "lanThayCuoi", "fetchedAt") DESC, "id" DESC`;
    expect(viPhamSql(dung, bang)).toEqual([]);
    // Mốc chép tay kiểu cũ (thiếu `mocChup`) — trang trễ của lượt chụp trước lại đẩy bản cũ lên đầu ở bộ đọc đó.
    const thieuChup = `FROM "RawMetaAdsReport" ORDER BY "externalId", COALESCE("lanThayCuoi", "fetchedAt") DESC, "id" DESC`;
    expect(viPhamSql(thieuChup, bang)).toHaveLength(1);
    expect(viPhamSql(`AND (COALESCE(o."lanThayCuoi", o."fetchedAt"), o."id") > x`, bang)).toHaveLength(1);
    const bangKhac = `FROM "RawMetaAdsReport" x; FROM "RawPancakePurchase" ORDER BY "fetchedAt" DESC`;
    expect(viPhamSql(bangKhac, bang)).toEqual([]);
    expect(viPhamOrm(`prisma.rawMetaAdsReport.findFirst({ orderBy: { fetchedAt: "desc" } })`, bang)).toHaveLength(1);
    expect(viPhamOrm(`prisma.rawMetaAdsReport.groupBy({ by: ["shopId"], _max: { fetchedAt: true } })`, bang)).toHaveLength(
      1,
    );
    expect(viPhamOrm(`prisma.rawTiktokBusinessCost.groupBy({ _max: { fetchedAt: true } })`, bang)).toEqual([]);
    // Cùng file: lọc thường bảng trong danh sách + lấy max ở bảng KHÁC ⇒ không vi phạm; max ở chính bảng ⇒ vi phạm.
    const honHop = `db.rawMetaAdsReport.findMany({ where: { fetchedAt: { gte: d } } }); db.rawTiktokBusinessCost.groupBy({ _max: { fetchedAt: true } })`;
    expect(viPhamOrm(honHop, bang)).toEqual([]);
    const honHopSai = `db.rawTiktokBusinessCost.findMany({}); db.rawMetaAdsReport.groupBy({ _max: { fetchedAt: true } })`;
    expect(viPhamOrm(honHopSai, bang)).toHaveLength(1);
  });

  it("mỗi bảng trong danh sách có cột lanThayCuoi + mocChup trong schema (danh sách và migration đi cặp)", () => {
    const schema = readFileSync(join(GOC, "prisma/schema.prisma"), "utf8");
    for (const b of BANG_LAN_THAY) {
      const khoi = schema.match(new RegExp(`model ${b} \\{[^}]*\\}`))?.[0] ?? "";
      expect(khoi, b).toMatch(/\n\s+lanThayCuoi\s+DateTime\?/);
      expect(khoi, b).toMatch(/\n\s+mocChup\s+DateTime\?/);
    }
  });
});
