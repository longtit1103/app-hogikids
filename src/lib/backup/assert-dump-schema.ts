/**
 * Chặn restore đè object NGOÀI schema đích (vd dump full-DB cũ hoặc dump hệ thống
 * Supabase) — đường CUSTOM DUMP (`.dump`, đọc TOC `pg_restore -l`). Chạy TRƯỚC mọi
 * thao tác DB — cùng chốt an toàn với assertNotArchive.
 *
 * Đường PLAIN (`.sql.gz`) ở `assert-plain-sql-only-schema.ts`: nó KHÔNG có backstop
 * `-n <schema>` của pg_restore nên guard phải mạnh hơn hẳn, và quét văn bản SQL là
 * một bài toán khác (lexer theo trạng thái) — tách ra để hai đường không đọc nhầm
 * hằng số của nhau.
 */

/**
 * Tập DESC (loại object) mà `pg_restore -l` in ra ở đầu mỗi dòng TOC. NHIỀU DESC là
 * ĐA TỪ (`TABLE DATA`, `SEQUENCE OWNED BY`, `MATERIALIZED VIEW`, `DEFAULT ACL`…), nên
 * KHÔNG thể coi DESC là 1 token. Cách parse đúng: khớp DESC là TIỀN TỐ dài-nhất-trước
 * của phần sau cột số, rồi token kế tiếp mới là schema/namespace.
 *
 * Danh sách này KHÔNG cần vét cạn: DESC lạ (không khớp) sẽ được BỎ QUA chứ không từ
 * chối — đường custom còn chốt cứng bằng `-n <schema>` của pg_restore; over-reject dump
 * hợp lệ mới là lỗi nguy hiểm (tập cho vận hành viên thói quen tắt guard). Vẫn fail-closed
 * với schema lạ thật sự (TABLE/SCHEMA… của schema ≠ đích vẫn bị bắt).
 */
const PG_RESTORE_DESCS = [
  "TABLE DATA",
  // Bảng partition: pg_dump phát `TABLE ATTACH`/`INDEX ATTACH` — thiếu thì chữ ATTACH bị đọc thành
  // schema ⇒ từ chối oan dump hợp lệ (DR lượt 3, 25/09). Song sinh với `restore.sh`.
  "TABLE ATTACH",
  "TABLE",
  "SEQUENCE OWNED BY",
  "SEQUENCE SET",
  "SEQUENCE",
  "MATERIALIZED VIEW DATA",
  "MATERIALIZED VIEW",
  "VIEW",
  "INDEX ATTACH",
  "INDEX",
  "FK CONSTRAINT",
  "CHECK CONSTRAINT",
  "CONSTRAINT",
  "DEFAULT ACL",
  "DEFAULT",
  "ACL",
  "TRIGGER",
  "EVENT TRIGGER",
  "FUNCTION",
  "PROCEDURE",
  "AGGREGATE",
  "TYPE",
  "DOMAIN",
  "SCHEMA",
  "EXTENSION",
  "COMMENT",
  "POLICY",
  "ROW SECURITY",
  "PUBLICATION TABLE",
  "PUBLICATION",
  "RULE",
  "STATISTICS",
  "FOREIGN TABLE",
  "ENCODING",
  "STDSTRINGS",
  "SEARCHPATH",
  "DATABASE PROPERTIES",
  "DATABASE",
  "TEXT SEARCH CONFIGURATION",
  "TEXT SEARCH DICTIONARY",
  "TEXT SEARCH PARSER",
  "TEXT SEARCH TEMPLATE",
  "COLLATION",
  "CONVERSION",
  "OPERATOR CLASS",
  "OPERATOR FAMILY",
  "OPERATOR",
  "CAST",
  "TRANSFORM",
  "SERVER",
  "FOREIGN DATA WRAPPER",
  "USER MAPPING",
  "LARGE OBJECT",
  "BLOB",
  "BLOBS",
  "ACCESS METHOD",
  "PROCEDURAL LANGUAGE",
  "SHELL TYPE",
]
  // Khớp tiền tố DÀI NHẤT trước (theo số từ giảm dần) để `DEFAULT ACL` không bị `DEFAULT`
  // nuốt mất, `TABLE DATA` không bị `TABLE` nuốt, `SEQUENCE OWNED BY` không bị `SEQUENCE`…
  .map((desc) => desc.split(" "))
  .sort((a, b) => b.length - a.length);

/**
 * Khớp DESC (đa từ) ở đầu chuỗi token. Trả về số TỪ của DESC nếu nhận diện được, ngược
 * lại null (DESC lạ → bỏ qua ở nơi gọi). Token sau DESC là cột namespace/schema.
 */
function matchDescWordCount(tokens: string[]): number | null {
  for (const words of PG_RESTORE_DESCS) {
    if (words.length > tokens.length) continue;
    if (words.every((w, i) => tokens[i] === w)) return words.length;
  }
  return null;
}

/** Parse output `pg_restore -l` (TOC custom dump). Throw nếu có object schema ≠ target. */
export function assertDumpOnlySchema(tocText: string, schema: string): void {
  const bad = new Set<string>();
  for (const raw of tocText.split("\n")) {
    const line = raw.trim();
    // Dòng object: "<id>; <tableoid> <oid> <DESC…> <namespace> <tag> <owner>".
    // Bỏ comment/header (dòng bắt đầu bằng ";"). Chỉ tách phần SỐ cố định, còn lại tự parse.
    const prefix = line.match(/^\d+;\s+\d+\s+\d+\s+/);
    if (!prefix) continue;
    const rest = line.slice(prefix[0].length).trim();
    if (!rest) continue;
    const tokens = rest.split(/\s+/);

    const descWords = matchDescWordCount(tokens);
    if (descWords === null) continue; // DESC lạ → bỏ qua (đã có -n <schema> chốt cứng).
    const desc = tokens.slice(0, descWords).join(" ");
    const after = tokens.slice(descWords); // [namespace, tag, owner…]

    if (desc === "SCHEMA") {
      // "SCHEMA - <tên schema> <owner>": schema đang được TẠO nằm ở cột tag (sau "-"),
      // vì object SCHEMA không thuộc namespace nào (namespace = "-").
      const created = after[0] === "-" ? after[1] : after[0];
      if (created && created !== schema) bad.add(created);
      continue;
    }

    // Object thường: cột đầu sau DESC là namespace. "-"/pg_catalog = toàn cục → bỏ qua.
    const ns = after[0];
    if (!ns || ns === "-" || ns === "pg_catalog") continue;
    if (ns !== schema) bad.add(ns);
  }
  if (bad.size) {
    throw new Error(
      `Dump chứa object ngoài schema '${schema}': ${[...bad].join(", ")} — TỪ CHỐI để không đè dữ liệu hệ thống Supabase.`,
    );
  }
}
