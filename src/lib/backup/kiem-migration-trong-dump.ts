/**
 * Cổng "dump đời trước phân quyền": trước khi phá DB để nạp một bản backup, đọc bảng
 * `_prisma_migrations` TRONG chính file dump và đòi migration phân quyền (M1) đã HOÀN TẤT ở đời đó.
 *
 * Vì sao: dump chụp trước M1 không có cột `role`/bảng `ShopProfile`/`AuditLog` — nạp qua giao diện
 * là app đời mới chạy trên schema đời cũ (route restore cố ý KHÔNG tự chạy migrate). Dump cũ phải
 * đi quy trình host của runbook ("Phục hồi dump đời trước phân quyền").
 *
 * Parser THUẦN, chỉ đọc text SQL:
 *  - `.dump` (custom): người gọi bung riêng dữ liệu bảng bằng
 *    `pg_restore -a -n <schema> -t _prisma_migrations -f - <file>` (không nối DB) rồi đưa text vào.
 *  - `.sql.gz` (plain): người gọi đưa nguyên text SQL đã giải nén.
 *
 * Nhận diện ĐÚNG bảng, ĐÚNG schema, cột theo TÊN trong header — thấy chuỗi tên M1 ở đâu đó trong
 * file KHÔNG đủ (có thể nằm trong bảng khác, bảng tên gần giống, schema khác). Đang ở trong một khối
 * COPY bất kỳ thì mọi dòng tới `\.` là DỮ LIỆU của khối đó — dữ liệu trông như header cũng không mở
 * khối mới.
 *
 * Mô hình mối đe doạ: cổng chống NHẦM FILE (chọn nhầm bản backup cũ), không chống người cố tình
 * dựng dump giả — người bấm phục hồi là chủ shop, vốn toàn quyền với DB. Vì vậy không dựng lại bộ
 * lexer SQL (`assert-plain-sql-only-schema.ts` có mục đích khác: săn câu nguy hiểm); một dòng
 * `COPY … FROM stdin;` giả nằm trong thân hàm dollar-quote của plain dump là ngoài phạm vi.
 *
 * Mọi chỗ mơ hồ đều nghiêng về TỪ CHỐI (fail-closed): header thiếu cột bắt buộc ⇒ không nhận khối;
 * dòng sai số cột ⇒ bỏ dòng; khối không có `\.` kết (file cụt) ⇒ bỏ trọn khối. Hệ quả của mọi
 * nhánh đó là không thấy dòng M1 hoàn tất ⇒ `assertDumpCoM1HoanTat` ném ⇒ không đụng DB.
 */

export const TEN_MIGRATION_PHAN_QUYEN = "20260930170000_tai_khoan_phu_phan_quyen";

export type DongPrismaMigration = {
  migration_name: string;
  finished_at: string | null;
  rolled_back_at: string | null;
};

const THONG_BAO_DUMP_TRUOC_PHAN_QUYEN =
  "Bản backup chụp trước bản phân quyền (hoặc migration chưa hoàn tất) — phục hồi qua quy trình " +
  "trên host, mục 'Phục hồi dump đời trước phân quyền' của runbook";

/** Dump không chứng minh được M1 đã hoàn tất ở đời của nó. `message` là chuỗi hiển thị cho 422. */
export class LoiBackupTruocPhanQuyen extends Error {
  constructor() {
    super(THONG_BAO_DUMP_TRUOC_PHAN_QUYEN);
    this.name = "LoiBackupTruocPhanQuyen";
  }
}

/** Nhóm 1 = schema (tuỳ chọn), nhóm 2 = danh sách cột. */
const HEADER_MIGRATION =
  /^COPY\s+(?:"?([A-Za-z_]\w*)"?\.)?"?_prisma_migrations"?\s*\(([^)]*)\)\s+FROM\s+stdin;$/;
/** Header COPY bất kỳ — để biết đang ở trong khối dữ liệu của bảng khác mà bỏ qua trọn khối. */
const HEADER_BAT_KY = /^COPY\s.*\sFROM\s+stdin;$/;
const KET_KHOI = "\\.";
const COT_BAT_BUOC = ["migration_name", "finished_at", "rolled_back_at"] as const;

type TrangThai =
  | { loai: "ngoai" }
  | { loai: "khac" }
  | { loai: "migration"; viTri: Record<(typeof COT_BAT_BUOC)[number], number>; soCot: number; dem: DongPrismaMigration[] };

/**
 * Trích mọi dòng của bảng `<schemaDich>._prisma_migrations` từ các khối `COPY … FROM stdin;` …
 * `\.` trong `sqlText`. Header không qualify schema cũng nhận (thực tế pg_dump luôn qualify).
 * Không có khối hợp lệ ⇒ `[]`. Nhiều khối ⇒ hợp tất cả, giữ thứ tự xuất hiện.
 */
export function docDongPrismaMigrationsTuCopy(sqlText: string, schemaDich: string): DongPrismaMigration[] {
  const ketQua: DongPrismaMigration[] = [];
  let tt: TrangThai = { loai: "ngoai" };

  for (const dongTho of sqlText.split("\n")) {
    const dong = dongTho.endsWith("\r") ? dongTho.slice(0, -1) : dongTho;

    if (tt.loai === "ngoai") {
      if (!dong.startsWith("COPY")) continue;
      tt = moKhoi(dong, schemaDich);
      continue;
    }

    if (dong === KET_KHOI) {
      // Chỉ khối đóng trọn vẹn mới được tính — khối cụt (file hỏng) bị bỏ ở cuối vòng lặp.
      if (tt.loai === "migration") ketQua.push(...tt.dem);
      tt = { loai: "ngoai" };
      continue;
    }
    if (tt.loai === "khac") continue;

    const truong = dong.split("\t");
    if (truong.length !== tt.soCot) continue; // dòng hỏng: không đoán cột
    tt.dem.push({
      migration_name: docGiaTri(truong[tt.viTri.migration_name]) ?? "",
      finished_at: docGiaTri(truong[tt.viTri.finished_at]),
      rolled_back_at: docGiaTri(truong[tt.viTri.rolled_back_at]),
    });
  }
  return ketQua;
}

function moKhoi(dong: string, schemaDich: string): TrangThai {
  const m = HEADER_MIGRATION.exec(dong);
  if (!m) return HEADER_BAT_KY.test(dong) ? { loai: "khac" } : { loai: "ngoai" };

  const [, schema, dsCot] = m;
  if (schema !== undefined && schema !== schemaDich) return { loai: "khac" };

  const cot = dsCot.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
  const viTri = {} as Record<(typeof COT_BAT_BUOC)[number], number>;
  for (const ten of COT_BAT_BUOC) {
    const i = cot.indexOf(ten);
    if (i < 0) return { loai: "khac" }; // header thiếu cột bắt buộc: không nhận, nhưng vẫn bỏ qua thân khối
    viTri[ten] = i;
  }
  return { loai: "migration", viTri, soCot: cot.length, dem: [] };
}

/** Một trường của định dạng COPY text: `\N` = null; unescape `\b \f \n \r \t \v \\` (khác ⇒ giữ ký tự). */
function docGiaTri(tho: string): string | null {
  if (tho === "\\N") return null;
  if (!tho.includes("\\")) return tho;
  let ra = "";
  for (let i = 0; i < tho.length; i++) {
    const c = tho[i];
    if (c !== "\\" || i === tho.length - 1) {
      ra += c;
      continue;
    }
    const k = tho[++i];
    ra += THOAT[k] ?? k;
  }
  return ra;
}

const THOAT: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };

/** Có dòng tên M1 với `finished_at` khác null và `rolled_back_at` null (áp lại sau rolled-back vẫn tính). */
export function m1HoanTat(rows: DongPrismaMigration[]): boolean {
  return rows.some(
    (r) => r.migration_name === TEN_MIGRATION_PHAN_QUYEN && r.finished_at !== null && r.rolled_back_at === null,
  );
}

/** Ném `LoiBackupTruocPhanQuyen` nếu dump không chứng minh được M1 hoàn tất — gọi TRƯỚC mọi bước phá huỷ. */
export function assertDumpCoM1HoanTat(rows: DongPrismaMigration[]): void {
  if (!m1HoanTat(rows)) throw new LoiBackupTruocPhanQuyen();
}
