/**
 * Bộ quét VĂN BẢN SQL plain dùng cho guard `assertPlainSqlOnlySchema`: lexer theo
 * trạng thái (chuỗi nháy, comment khối lồng nhau, dollar-quote) + các phép CHE dữ
 * liệu trước khi soi câu lệnh.
 *
 * Tách riêng vì đây là phần dễ sai nhất và phải đọc như một đơn vị: mỗi hàm che một
 * loại dữ liệu, và thứ tự che quyết định guard có bị mù cả một vùng file hay không.
 * KHÔNG nới lỏng luật ở đây để "cho dump lạ chạy được" — xem lý do từng chỗ.
 */

/** Mốc câu lệnh `COPY … FROM stdin;`. CHỈ được nhận ở TRẠNG THÁI GỐC (xem stripCopyStdinData). */
const COPY_STMT_LINE = /^COPY\b.*\bFROM\s+stdin;[ \t]*$/i;

/** Mốc kết payload COPY: ĐÚNG dòng `\.` (thụt đầu dòng là DỮ LIỆU, không phải mốc). */
export const COPY_END_LINE = /^\\\.[ \t]*$/;

/**
 * Tag dollar-quote HỢP LỆ của PostgreSQL: rỗng (`$$`) hoặc một định danh không nháy
 * (`$tag$`). Định danh KHÔNG ĐƯỢC bắt đầu bằng chữ số.
 *
 * ĐO THẬT trên PostgreSQL 15.8: `SELECT $0$abc$0$;` → `ERROR: unterminated dollar-quoted
 * string`, còn `SELECT $x$abc$x$;` trả về `abc`. Tức `$0$` KHÔNG mở dollar-quote. Nếu ta
 * cho phép chữ số ở đầu tag thì `$0$ \! id $0$` bị coi là THÂN dollar-quote và bị xoá khỏi
 * bản soi, trong khi psql vẫn thực thi `\! id` — đúng kiểu "lọt, IM LẶNG" mà guard này
 * phải chặn.
 */
const DOLLAR_OPEN = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/;

type SqlLexState = { dollarTag: string | null; blockDepth: number };

/**
 * Quét MỘT dòng SQL để cập nhật trạng thái VẮT-QUA-DÒNG (thân dollar-quote, comment khối
 * lồng nhau). Chỉ theo dõi trạng thái, KHÔNG sửa nội dung dòng.
 *
 * NÉM LỖI khi chuỗi nháy đơn `'…'` hoặc định danh nháy kép `"…"` chưa đóng lúc hết dòng —
 * xem guard (h) ở `assertPlainSqlOnlySchema`.
 */
function lexSqlLine(line: string, st: SqlLexState): SqlLexState {
  let { dollarTag, blockDepth } = st;
  let i = 0;
  const n = line.length;

  /** Nuốt chuỗi mở bằng `q` tại vị trí i (đã trỏ vào dấu mở). Trả về true nếu ĐÓNG trong dòng. */
  const eatQuoted = (q: string): boolean => {
    i++; // bỏ qua dấu mở
    while (i < n) {
      if (line[i] === q) {
        if (line[i + 1] === q) {
          i += 2; // `''` / `""` = dấu nháy escape, chuỗi CHƯA đóng
          continue;
        }
        i++;
        return true;
      }
      i++;
    }
    return false;
  };

  while (i < n) {
    if (blockDepth > 0) {
      if (line.startsWith("/*", i)) {
        blockDepth++;
        i += 2;
      } else if (line.startsWith("*/", i)) {
        blockDepth--;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (dollarTag !== null) {
      if (line.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        dollarTag = null;
      } else {
        i++;
      }
      continue;
    }
    const c = line[i];
    if (c === "-" && line[i + 1] === "-") break; // comment dòng → hết dòng là hết
    if (c === "/" && line[i + 1] === "*") {
      blockDepth = 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      if (!eatQuoted(c)) {
        throw new Error(
          `SQL có chuỗi nháy ${c === "'" ? "đơn" : "kép"} TRẢI QUA XUỐNG DÒNG ngoài khối ` +
            `COPY — pg_dump plain THẬT không bao giờ phát ra dạng này — TỪ CHỐI (chuỗi đa ` +
            `dòng che được mốc COPY giả, làm guard mù cả một vùng file).`,
        );
      }
      continue;
    }
    if (c === "$") {
      const open = DOLLAR_OPEN.exec(line.slice(i));
      if (open) {
        dollarTag = open[0];
        i += open[0].length;
        continue;
      }
    }
    i++;
  }
  return { dollarTag, blockDepth };
}

/**
 * Bỏ phần DỮ LIỆU của mọi khối `COPY … FROM stdin;` … `\.` (giữ lại DÒNG LỆNH COPY để
 * guard (e) vẫn soi schema đích của nó, và giữ dòng `\.` để guard (g) thấy đúng dạng hợp lệ).
 * Dữ liệu COPY là text tab-phân-tách, có thể chứa `public.`/`;`/từ trông giống động từ →
 * nếu không bỏ sẽ bị hiểu nhầm là câu lệnh.
 *
 * PHẢI THEO TRẠNG THÁI, KHÔNG ĐƯỢC dùng regex thuần trên SQL thô: một dòng `COPY t FROM
 * stdin;` GIẢ nằm BÊN TRONG chuỗi nháy đơn đa dòng (hoặc bên trong thân dollar-quote) sẽ
 * mở chế độ bỏ-payload tới dòng `\.`, xoá cả vùng đó khỏi bản soi ⇒ guard (b)/(e)/(g) mù
 * hết vùng đó trong khi psql vẫn chạy các câu lệnh ở giữa. Vì vậy chỉ vào chế độ COPY khi
 * đang ở TRẠNG THÁI GỐC (ngoài chuỗi/comment khối/dollar-quote).
 *
 * FAIL-CLOSED khi khối COPY KHÔNG có dòng `\.` kết: trả lại nguyên văn payload để các guard
 * sau vẫn soi được (thà từ chối oan còn hơn bỏ lọt lệnh giấu sau một khối COPY dở dang).
 */
export function stripCopyStdinData(sql: string): string {
  const out: string[] = [];
  let st: SqlLexState = { dollarTag: null, blockDepth: 0 };
  let copyPayload: string[] | null = null;

  for (const line of sql.split("\n")) {
    if (copyPayload) {
      if (COPY_END_LINE.test(line)) {
        copyPayload = null;
        out.push(line);
      } else {
        copyPayload.push(line);
      }
      continue;
    }
    if (st.dollarTag === null && st.blockDepth === 0 && COPY_STMT_LINE.test(line)) {
      out.push(line);
      copyPayload = [];
      continue;
    }
    st = lexSqlLine(line, st);
    out.push(line);
  }
  if (copyPayload) out.push(...copyPayload);
  return out.join("\n");
}

/**
 * Xoá thân dollar-quote (`$$…$$` / `$tag$…$tag$` — thân function/DO) để `.` bên trong
 * không bị soi. Tag phải theo ĐÚNG luật PostgreSQL (xem `DOLLAR_OPEN`) — nới lỏng cho
 * tag bắt đầu bằng chữ số sẽ tạo lỗ hổng xoá-nhầm-vùng-thật.
 */
export function stripDollarQuoted(sql: string): string {
  return sql.replace(/\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1\$/g, "");
}

/** Che nội dung chuỗi nháy đơn `'…'` (kể cả `''` escape) bằng `''` — `.`/`;` trong dữ liệu không bị soi. */
export function maskSingleQuotedStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Xoá comment SQL → " " để guard KHÔNG bị né bằng cách chèn comment giữa token (vd
 * `set_config/`+`* x *`+`/(…)` hay `SET/**​/search_path`). Scanner đếm-độ-sâu, KHÔNG dùng regex:
 *  - Comment khối `/* … *​/` LỒNG NHAU (PostgreSQL cho phép nesting — mở rộng ngoài chuẩn SQL):
 *    `/* a /* b *​/ *​/` là MỘT comment; regex non-greedy dừng ở `*​/` đầu tiên nên né được → phải
 *    đếm độ sâu `/*`↔`*​/` cân bằng.
 *  - Comment dòng `-- … tới hết dòng`.
 *  - GIỮ NGUYÊN chuỗi nháy đơn `'…'` (kể cả `''` escape): `/*`/`--` bên trong là DỮ LIỆU, KHÔNG
 *    phải comment — nếu coi là comment sẽ nuốt nhầm câu lệnh sau (vd `'/*' ); SELECT set_config(…`
 *    → mất câu set_config → bypass). Đủ dùng cho guard (d)/(f) vì chỉ soi tên hàm/động từ.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // Chuỗi nháy đơn — giữ nguyên (comment marker bên trong là dữ liệu).
    if (c === "'") {
      out += "'";
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''"; // '' = nháy escape, chưa kết thúc chuỗi
          i += 2;
          continue;
        }
        out += sql[i];
        const closed = sql[i] === "'";
        i++;
        if (closed) break;
      }
      continue;
    }
    // Comment dòng `-- … EOL`.
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // Comment khối lồng nhau `/* … */` (đếm độ sâu).
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
