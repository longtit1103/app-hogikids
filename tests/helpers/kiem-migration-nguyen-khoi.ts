/**
 * Cổng tĩnh cho migration MỚI (không áp cho 58 file đã áp prod — xem `migration-da-ap-prod-sha256.ts`).
 *
 * Vì sao cần: Prisma 7.4+ (repo đang 7.10.1) tách `migration.sql` thành từng câu và gửi lần lượt, KHÔNG bọc transaction
 * (upstream prisma/orm#30640; đo trên PG15 local 22/11/2026 — báo cáo
 * `plans/reports/khao-sat-261122-2300-prisma-30640-migration-khong-nguyen-khoi-report.md`). Một câu lỗi giữa chừng để DB
 * DỞ: các câu trước đã commit, `resolve --rolled-back` rồi chạy lại vấp "already exists". `BEGIN;`…`COMMIT;` viết tường
 * minh trong file thì cả khối vẫn nguyên tử dù bị tách. Luật:
 *
 *  1. File có ≥ 2 câu (không kể BEGIN/COMMIT) mà có câu ghi dữ liệu hoặc đổi schema ⇒ PHẢI có đúng một `BEGIN;` và một
 *     `COMMIT;` tường minh, `COMMIT;` là câu cuối. CHỈ `BEGIN` và `COMMIT` trơn là đúng quy ước — mọi lệnh điều khiển
 *     transaction khác (`START TRANSACTION`, `BEGIN ISOLATION …`, `END`, `COMMIT PREPARED`, `PREPARE TRANSACTION`,
 *     `SAVEPOINT`, `ROLLBACK`…) bị chặn. Ngoài khối CHỈ được các câu thuộc mẫu ĐÃ XÁC ĐỊNH là chỉ đọc (danh sách TRẮNG —
 *     xem `laChiDoc`): `SELECT`/`SHOW`/`VALUES` không `INTO`, không khoá dòng, và khối `DO` chỉ kiểm + RAISE; mọi lời gọi
 *     hàm (kể cả trong đối số của RAISE) phải thuộc `HAM_CHI_DOC` — hàm chưa xác định (kể cả hàm của app) KHÔNG được coi
 *     là chỉ đọc. Thiếu `COMMIT;` là lỗi: Prisma báo "applied" mà không áp gì.
 *  2. `SET LOCAL` chỉ có hiệu lực trong transaction ⇒ phải nằm SAU `BEGIN;` và TRƯỚC `COMMIT;` (ngoài khối Postgres chỉ
 *     cảnh báo và bỏ qua — vd `lock_timeout` thành 0 mà không ai biết). `SET` KHÔNG `LOCAL` ở vị trí câu lệnh — ở mức
 *     ngoài hay trong thân khối `DO` — bị chặn ở MỌI vị trí: nó sống tiếp sau `COMMIT;` / sau khi `DO` xong (đo PG15) nên
 *     ngấm sang các migration sau trên cùng kết nối. Lời gọi hàm `set_config(…)` (kể cả `pg_catalog.set_config`, kể cả
 *     trong thân `DO`) cũng bị chặn ở MỌI vị trí — đối số thứ ba `false` là đúng một `SET` phiên viết dạng hàm; muốn đổi
 *     tham số thì viết `SET LOCAL` sau `BEGIN;`. Chữ `set_config` nằm trong chuỗi / chú thích không tính.
 *  3. Thêm giá trị enum (`ALTER TYPE … ADD VALUE`) phải TÁCH khỏi file dùng giá trị đó: PostgreSQL 15 không cho dùng giá
 *     trị enum mới trước khi transaction thêm nó commit (lỗi 55P04 "unsafe use of new value").
 *  4. `CREATE/DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY` không chạy được trong transaction block ⇒ phải đứng MỘT
 *     MÌNH trong file (không BEGIN/COMMIT, không câu nào khác). Build CONCURRENTLY lỗi để lại index INVALID ⇒ "đạt" chỉ khi
 *     `pg_index.indisvalid` — kiểm ở test áp toàn bộ migration lên DB trắng và ở runbook, không kiểm được bằng đọc file.
 *
 * Phân loại câu là đọc từ khoá theo danh sách TRẮNG (nghiêng về chặt): câu không thuộc mẫu chỉ đọc đã xác định coi là GHI.
 */

export type LoaiCau =
  | "begin"
  | "commit"
  | "dieu-khien-tx-ngoai-quy-uoc"
  | "set-local"
  | "set-phien"
  | "set-config"
  | "chi-doc"
  | "ghi"
  | "concurrently"
  | "them-gia-tri-enum";

export type Cau = { sql: string; loai: LoaiCau; nhanEnumMoi?: string };

/** Một đoạn của SQL theo cú pháp lexer Postgres: mã thường, chuỗi (gồm `E'…'` và `$tag$…$tag$`), định danh nháy, chú thích. */
export type DoanSql = { loai: "ma" | "chuoi" | "dinh-danh" | "chu-thich"; text: string };

/** Vị trí ngay SAU dấu nháy đóng (nháy đôi `''` / `""` bên trong là ký tự thường; chuỗi `E'…'` thì `\` thoát ký tự kế). */
function timDongNhay(s: string, batDau: number, nhay: string, thoatGachNguoc: boolean): number {
  let i = batDau + 1;
  while (i < s.length) {
    if (thoatGachNguoc && s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === nhay) {
      if (s[i + 1] === nhay) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return s.length;
}

/*
 * Quy tắc từ vựng DÙNG CHUNG cho mọi chỗ đọc định danh / thẻ dollar / chuỗi E (theo scan.l của Postgres): ký tự ≥ U+0080
 * là CHỮ (byte cao của UTF-8), nên `ă$x$` là MỘT định danh và `$kiểm$` là thẻ dollar hợp lệ. Thẻ dollar giống định danh
 * nhưng KHÔNG chứa `$`. Định danh nháy kép: `""` bên trong là một dấu `"`.
 */
const CHU_DAU = String.raw`A-Za-z_\u0080-\uffff`;
const CHU_THAN = String.raw`A-Za-z0-9_$\u0080-\uffff`;
const CHU_THAN_THE = String.raw`A-Za-z0-9_\u0080-\uffff`;
const RE_CHU_DAU = new RegExp(`[${CHU_DAU}]`);
const RE_CHU_THAN = new RegExp(`[${CHU_THAN}]`);
/** Một phần tên: nháy kép (`""` thoát) hoặc định danh trơn (nguồn regex — dùng chung cả ở lưới test). */
export const PHAN_TEN = String.raw`(?:"(?:[^"]|"")+"|[${CHU_DAU}][${CHU_THAN}]*)`;
/** Thẻ dollar: `$$` hoặc `$tag$`. */
const THE_DOLLAR = String.raw`\$(?:[${CHU_DAU}][${CHU_THAN_THE}]*)?\$`;
const RE_THE_DOLLAR_DAU = new RegExp(`^${THE_DOLLAR}`);

/**
 * Vị trí bắt đầu của token chữ/số liền trước i (chạy lùi qua ký tự thân định danh). Token mở bằng CHỮ là định danh —
 * `$` / `'` ngay sau nó là một phần của nó hoặc của cú pháp khác; token mở bằng SỐ là hằng số — `$` ngay sau nó mở token
 * mới (PG15 đọc `1$x$…$x$` là số rồi chuỗi dollar).
 */
function dauTokenTruoc(s: string, i: number): number {
  let j = i;
  while (j > 0 && RE_CHU_THAN.test(s[j - 1])) j--;
  return j;
}
const laDuoiDinhDanh = (s: string, i: number) => {
  const j = dauTokenTruoc(s, i);
  return j < i && RE_CHU_DAU.test(s[j]);
};

/** `'` tại i mở chuỗi `E'…'`: ngay trước là `E`/`e` là TRỌN một token (không phải đuôi định danh như `type'…'`). */
const laChuoiE = (s: string, i: number) => /[Ee]/.test(s[i - 1] ?? "") && dauTokenTruoc(s, i) === i - 1;

/** Vị trí ngay SAU chú thích khối bắt đầu tại i — Postgres cho LỒNG `/* … /* … *\/ … *\/`. */
function hetChuThichKhoi(s: string, i: number): number {
  let sau = 0;
  while (i < s.length) {
    if (s[i] === "/" && s[i + 1] === "*") {
      sau++;
      i += 2;
    } else if (s[i] === "*" && s[i + 1] === "/") {
      sau--;
      i += 2;
      if (sau === 0) return i;
    } else i++;
  }
  return s.length;
}

/** `$$` hoặc `$tag$` bắt đầu tại i (không nhận `$1` tham số, không nhận `$` nằm trong một định danh). */
function docTheDollar(s: string, i: number): string | null {
  if (s[i] !== "$" || laDuoiDinhDanh(s, i)) return null;
  const m = RE_THE_DOLLAR_DAU.exec(s.slice(i, i + 64));
  return m ? m[0] : null;
}

/**
 * Tách SQL thành đoạn trong MỘT lượt quét trái → phải — ký tự nào mở trước thì thắng, nên `--` nằm trong chuỗi / định
 * danh nháy / `$tag$` không bị hiểu là chú thích và ngược lại `'` trong chú thích không mở chuỗi. Mọi bộ lọc của cổng
 * (tách câu, bỏ chú thích, bỏ chuỗi) dựng trên đây để không lệch nhau.
 */
export function tachDoanSql(s: string): DoanSql[] {
  const ra: DoanSql[] = [];
  let ma = "";
  const day = (loai: DoanSql["loai"], text: string) => {
    if (ma) ra.push({ loai: "ma", text: ma });
    ma = "";
    ra.push({ loai, text });
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    let het = -1;
    let loai: DoanSql["loai"] = "ma";
    if (c === "-" && s[i + 1] === "-") {
      const j = s.indexOf("\n", i);
      het = j < 0 ? s.length : j;
      loai = "chu-thich";
    } else if (c === "/" && s[i + 1] === "*") {
      het = hetChuThichKhoi(s, i);
      loai = "chu-thich";
    } else if (c === "'") {
      het = timDongNhay(s, i, "'", laChuoiE(s, i));
      loai = "chuoi";
    } else if (c === '"') {
      het = timDongNhay(s, i, '"', false);
      loai = "dinh-danh";
    } else {
      const tag = docTheDollar(s, i);
      if (tag) {
        const j = s.indexOf(tag, i + tag.length);
        het = j < 0 ? s.length : j + tag.length;
        loai = "chuoi";
      }
    }
    if (het < 0) {
      ma += c;
      i++;
      continue;
    }
    day(loai, s.slice(i, het));
    i = het;
  }
  if (ma) ra.push({ loai: "ma", text: ma });
  return ra;
}

/** Tách file SQL thành các câu ở mức ngoài (dấu `;` chỉ tính trong đoạn mã thường), đã bỏ chú thích. */
export function tachCau(sql: string): string[] {
  const cau: string[] = [];
  let hien = "";
  const chot = () => {
    const t = hien.trim();
    if (t) cau.push(t);
    hien = "";
  };
  for (const d of tachDoanSql(sql)) {
    if (d.loai === "chu-thich") hien += " ";
    else if (d.loai !== "ma") hien += d.text;
    else
      d.text.split(";").forEach((phan, k, ds) => {
        hien += phan;
        if (k < ds.length - 1) chot();
      });
  }
  chot();
  return cau;
}

/** Từ khoá ghi / đổi schema / tác dụng phụ — có mặt (ngoài chuỗi, chú thích) ⇒ không phải chỉ đọc. */
const TU_GHI =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|COPY|REFRESH|REINDEX|CLUSTER|VACUUM|ANALYZE|LOCK|CALL|EXECUTE|PERFORM|NOTIFY|LISTEN|DISCARD|RESET|SET|IMPORT|SECURITY|LOAD)\b/i;

/**
 * Danh sách TRẮNG những gì được đứng ngay trước `(` trong một câu chỉ đọc: từ khoá cú pháp + hàm built-in đã biết là
 * không ghi + tên kiểu (khai báo `numeric(12,2)` trong DECLARE). Thiếu một hàm cần thiết ⇒ thêm vào đây có lý do; KHÔNG
 * thêm hàm của app hay hàm có tác dụng phụ (`setval`, `nextval`, `set_config`, `pg_advisory_lock`, `dblink`…).
 */
const HAM_CHI_DOC = new Set(
  (
    // từ khoá cú pháp
    "in exists any all some values select from where and or not on as is then when else case cast using over filter " +
    "partition by array row between like ilike join if elsif while return returning distinct " +
    // hàm built-in chỉ đọc
    "count sum min max avg bool_and bool_or every array_agg string_agg json_agg jsonb_agg coalesce nullif greatest least " +
    "length char_length octet_length lower upper trim btrim ltrim rtrim substr substring position replace split_part concat " +
    "concat_ws format left right abs round floor ceil ceiling mod now current_setting current_database current_schema " +
    "to_regclass to_regtype pg_typeof date_trunc date_part extract age to_char to_date to_timestamp md5 encode " +
    "jsonb_typeof jsonb_array_length json_typeof array_length cardinality unnest generate_series row_number rank " +
    "dense_rank lag lead timezone make_interval regexp_replace regexp_match regexp_matches starts_with " +
    "has_table_privilege has_schema_privilege pg_get_constraintdef obj_description " +
    // tên kiểu có tham số
    "numeric decimal varchar char character timestamp timestamptz time interval bit varbit"
  ).split(/\s+/),
);

/**
 * Thay mọi chuỗi (`'…'`, `E'…'`, `$tag$…$tag$` — nội dung có thể chứa tên bảng / chữ "update" / `--`) bằng `''` và mọi chú
 * thích bằng khoảng trắng; định danh nháy giữ nguyên (cần cho `"app"."count"(`). Một lượt quét qua `tachDoanSql`.
 */
const boChuoiVaChuThich = (s: string) =>
  tachDoanSql(s)
    .map((d) => (d.loai === "chu-thich" ? " " : d.loai === "chuoi" ? "''" : d.text))
    .join("");

/** Chuẩn hoá một phần tên như PG: `"Ten"` giữ nguyên (bỏ nháy, `""` → `"`), tên trơn hạ chữ thường CHỈ ký tự ASCII. */
const chuanHoaPhanTen = (p: string) => {
  const t = p.trim();
  return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.replace(/[A-Z]/g, (c) => c.toLowerCase());
};

/**
 * Mọi tên đứng ngay trước `(`, đã chuẩn hoá. Tên có schema GIỮ schema (`app.count`) — chỉ `pg_catalog.` được bỏ vì đó đúng
 * là schema của hàm built-in; bỏ schema khác là nhận nhầm hàm của app (`app.count(...)`) thành `count` hệ thống.
 */
export function tenGoiHam(s: string): string[] {
  return [...s.matchAll(new RegExp(String.raw`(${PHAN_TEN}(?:\s*\.\s*${PHAN_TEN})*)\s*\(`, "g"))].map((m) => {
    const phan = [...m[1].matchAll(new RegExp(PHAN_TEN, "g"))].map((x) => chuanHoaPhanTen(x[0]));
    if (phan.length === 2 && phan[0] === "pg_catalog") return phan[1];
    return phan.join(".");
  });
}

/** Tên hàm built-in trong danh sách trắng (dùng cho lưới: migration của repo không được tự tạo hàm trùng các tên này). */
export const laHamChiDocDaBiet = (ten: string) => HAM_CHI_DOC.has(ten);

const moiHamDaBiet = (s: string) => tenGoiHam(s).every((t) => HAM_CHI_DOC.has(t));

/**
 * Mẫu chỉ đọc ĐÃ XÁC ĐỊNH (danh sách trắng):
 *  - `SELECT` / `SHOW` / `VALUES` / `TABLE` ở mức ngoài: không `INTO` (tạo bảng), không khoá dòng (`FOR UPDATE|SHARE`),
 *    không từ khoá ghi (CTE ghi dữ liệu), mọi lời gọi hàm thuộc `HAM_CHI_DOC`;
 *  - khối `DO` (plpgsql): thân bỏ chú thích + chuỗi không còn từ khoá ghi nào (kể cả `SET`), mọi lời gọi hàm — CẢ trong
 *    đối số của RAISE (`RAISE NOTICE '%', setval(…)`) — thuộc `HAM_CHI_DOC` (`SELECT … INTO biến` trong thân là gán biến).
 */
function laChiDoc(sql: string): boolean {
  const s = boChuoiVaChuThich(sql).trim();
  if (/^(SELECT|SHOW|VALUES|TABLE)\b/i.test(s)) {
    return !/\bINTO\b/i.test(s) && !/\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b/i.test(s) && !TU_GHI.test(s) && moiHamDaBiet(s);
  }
  const than = thanKhoiDo(sql);
  return than !== null && !TU_GHI.test(than) && moiHamDaBiet(than);
}

const RE_KHOI_DO = new RegExp(String.raw`^DO\s+(?:LANGUAGE\s+plpgsql\s+)?(${THE_DOLLAR})([\s\S]*)\1\s*(?:LANGUAGE\s+plpgsql\s*)?$`, "i");

/** Thân khối `DO $tag$ … $tag$` đã bỏ chuỗi + chú thích; `null` nếu câu không phải khối DO. */
function thanKhoiDo(sql: string): string | null {
  const m = RE_KHOI_DO.exec(sql.trim());
  return m ? boChuoiVaChuThich(m[2]) : null;
}

/**
 * Thân plpgsql có `SET` không `LOCAL` ở VỊ TRÍ CÂU LỆNH: đầu thân, sau `;`, sau `BEGIN`/`THEN`/`ELSE`/`LOOP`, hoặc sau
 * nhãn `<<…>>`. (`UPDATE … SET`, `ALTER … SET` không ở vị trí câu lệnh — chúng đã là ghi theo `TU_GHI`.)
 */
const coSetPhienTrongThan = (than: string) => /(?:^|;|\bBEGIN\b|\bTHEN\b|\bELSE\b|\bLOOP\b|>>)\s*SET\s+(?!LOCAL\b)/i.test(than);

/** `ALTER TYPE <tên, có thể có schema / nháy kép / dấu cách> ADD VALUE [IF NOT EXISTS] <chuỗi '…' hoặc $tag$…$tag$>`. */
const RE_THEM_ENUM = new RegExp(
  String.raw`^ALTER\s+TYPE\s+${PHAN_TEN}(?:\s*\.\s*${PHAN_TEN})*\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?('(?:[^']|'')*'|(${THE_DOLLAR})[\s\S]*?\2)`,
  "i",
);

/** Giá trị của một đoạn chuỗi (`'…'` hoặc `$tag$…$tag$`). */
function giaTriChuoi(doan: string): string {
  const the = RE_THE_DOLLAR_DAU.exec(doan)?.[0];
  return the ? doan.slice(the.length, doan.length - the.length) : doan.slice(1, -1).replace(/''/g, "'");
}

/** Mọi giá trị chuỗi trong câu, đi cả vào thân chuỗi dollar (thân `DO $$ … $$` chứa chuỗi lồng như `$x$…$x$`, `'…'`). */
function cacGiaTriChuoi(sql: string): string[] {
  return tachDoanSql(sql).flatMap((d) => {
    if (d.loai !== "chuoi") return [];
    const v = giaTriChuoi(d.text);
    return RE_THE_DOLLAR_DAU.test(d.text) ? [v, ...cacGiaTriChuoi(v)] : [v];
  });
}

/** Phân loại một câu đã bỏ chú thích ngoài. */
export function phanLoaiCau(sql: string): Cau {
  const t = sql.replace(/\s+/g, " ").trim();
  const u = t.toUpperCase();
  if (u === "BEGIN") return { sql: t, loai: "begin" };
  if (u === "COMMIT") return { sql: t, loai: "commit" };
  if (/^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE TRANSACTION|SET TRANSACTION|SET SESSION CHARACTERISTICS)\b/.test(u)) {
    return { sql: t, loai: "dieu-khien-tx-ngoai-quy-uoc" };
  }
  if (/^SET LOCAL\b/.test(u)) return { sql: t, loai: "set-local" };
  // `SET CONSTRAINTS` chỉ sống trong transaction ⇒ là câu thường; mọi `SET` khác (kể cả `SET SESSION`) sống cả phiên.
  if (/^SET\b/.test(u) && !/^SET CONSTRAINTS\b/.test(u)) return { sql: t, loai: "set-phien" };
  const thanDo = thanKhoiDo(sql);
  if (thanDo !== null && coSetPhienTrongThan(thanDo)) return { sql: t, loai: "set-phien" };
  // `set_config(…)` là built-in (`tenGoiHam` đã bỏ `pg_catalog.`); xét cả câu ngoài lẫn thân DO, đều đã bỏ chuỗi + chú thích.
  if ([boChuoiVaChuThich(sql), thanDo ?? ""].some((x) => tenGoiHam(x).includes("set_config"))) return { sql: t, loai: "set-config" };
  if (/^(CREATE (UNIQUE )?INDEX CONCURRENTLY|DROP INDEX CONCURRENTLY|REINDEX\b.*\bCONCURRENTLY)\b/.test(u)) {
    return { sql: t, loai: "concurrently" };
  }
  const enumMoi = RE_THEM_ENUM.exec(sql.trim());
  if (enumMoi) return { sql: t, loai: "them-gia-tri-enum", nhanEnumMoi: giaTriChuoi(enumMoi[1]) };
  return { sql: t, loai: laChiDoc(sql) ? "chi-doc" : "ghi" };
}

/** Kiểm một migration theo 4 luật ở đầu file. Trả danh sách vi phạm (rỗng = đạt). */
export function kiemMigrationNguyenKhoi(sql: string): string[] {
  const ds = tachCau(sql).map(phanLoaiCau);
  const loi: string[] = [];
  const viTri = (loai: LoaiCau) => ds.flatMap((c, k) => (c.loai === loai ? [k] : []));
  const begins = viTri("begin");
  const commits = viTri("commit");
  const hieuLuc = ds.filter((c) => c.loai !== "begin" && c.loai !== "commit");
  const coGhi = hieuLuc.some((c) => c.loai !== "chi-doc");

  for (const k of viTri("dieu-khien-tx-ngoai-quy-uoc")) {
    loi.push(`lệnh điều khiển transaction ngoài quy ước (chỉ nhận BEGIN; và COMMIT; trơn): ${ds[k].sql.slice(0, 80)}`);
  }

  // Luật 4: CONCURRENTLY đứng một mình.
  if (viTri("concurrently").length > 0) {
    if (ds.length !== 1) loi.push("CREATE/DROP INDEX CONCURRENTLY phải là câu DUY NHẤT trong file (không BEGIN/COMMIT, không câu khác)");
    return loi;
  }

  // Luật 3: giá trị enum mới không được dùng trong cùng file.
  for (const c of ds.filter((x) => x.loai === "them-gia-tri-enum")) {
    const nhan = `'${(c.nhanEnumMoi ?? "").replace(/'/g, "''")}'`;
    if (ds.some((x) => x !== c && (x.sql.includes(nhan) || cacGiaTriChuoi(x.sql).includes(c.nhanEnumMoi ?? "")))) {
      loi.push(`giá trị enum mới ${nhan} được thêm và dùng trong cùng file — tách ADD VALUE sang migration riêng (PG 55P04)`);
    }
  }

  // Luật 1: cặp BEGIN/COMMIT.
  const canBoc = coGhi && hieuLuc.length >= 2;
  if (begins.length > 1 || commits.length > 1) loi.push("chỉ được MỘT cặp BEGIN;…COMMIT; trong file");
  if (begins.length === 1 && commits.length === 0) loi.push("có BEGIN; mà thiếu COMMIT; (Prisma báo applied nhưng không áp gì)");
  if (commits.length === 1 && begins.length === 0) loi.push("có COMMIT; mà thiếu BEGIN;");
  if (canBoc && begins.length === 0) loi.push("file nhiều câu có ghi/đổi schema phải bọc BEGIN;…COMMIT; tường minh");
  const b = begins[0];
  const e = commits[0];
  if (b !== undefined && e !== undefined) {
    if (e < b) loi.push("COMMIT; đứng trước BEGIN;");
    if (e !== ds.length - 1) loi.push("COMMIT; phải là câu cuối cùng của file");
    ds.forEach((c, k) => {
      if ((k < b || k > e) && c.loai !== "chi-doc" && c.loai !== "begin" && c.loai !== "commit") {
        loi.push(`câu chưa xác định là chỉ đọc nằm ngoài BEGIN;…COMMIT;: ${c.sql.slice(0, 80)}`);
      }
    });
  }

  // Luật 2: SET không LOCAL bị chặn ở mọi vị trí; SET LOCAL chỉ trong khối.
  for (const k of viTri("set-config")) {
    loi.push(`gọi set_config(…) đổi tham số ngoài quy ước (is_local=false sống cả phiên) — dùng SET LOCAL sau BEGIN;: ${ds[k].sql.slice(0, 80)}`);
  }
  for (const k of viTri("set-phien")) {
    loi.push(`SET không LOCAL sống cả phiên, ngấm sang migration sau — dùng SET LOCAL trong BEGIN;…COMMIT;: ${ds[k].sql.slice(0, 80)}`);
  }
  ds.forEach((c, k) => {
    if (c.loai === "set-local" && !(b !== undefined && e !== undefined && k > b && k < e)) {
      loi.push(`SET LOCAL ngoài BEGIN;…COMMIT; (không có hiệu lực): ${c.sql.slice(0, 80)}`);
    }
  });
  return [...new Set(loi)];
}
