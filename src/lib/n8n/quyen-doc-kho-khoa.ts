import { prisma } from "@/lib/prisma";

import { N8N_RO_ROLE, N8N_SETTING_VIEW } from "./role-doc-kho-khoa";

/**
 * Lớp phòng thủ THỨ HAI cho quyền đọc kho khoá của n8n.
 *
 * Lớp thứ nhất là CODE: cả hai đường phục hồi đều cấp lại `USAGE` + `SELECT` sau khi nạp dump
 * (`lib/backup/run-restore.ts`, `deploy/restore.sh`), vì restore xoá bảng/schema là ACL chết theo.
 * Nhưng lớp đó chỉ chạy khi phục hồi ĐI QUA hai đường ấy — nạp tay bằng psql, dựng lại cụm theo
 * runbook DR, hay ai đó REVOKE nhầm thì không có gì cấp lại.
 *
 * Vì sao cần báo động: mất quyền này thì **10 workflow n8n chết câm** ở node lấy khoá từ bảng
 * `Setting` — ingest, ads và webhook tắt hết — trong khi app vẫn đăng nhập bình thường, biểu đồ vẫn
 * vẽ, không có lỗi nào nổi lên. Hỏng kiểu đó chỉ lộ ra khi có người tình cờ so doanh thu với sàn.
 *
 * ⚠️ **Chỉ đo, KHÔNG tự cấp lại.** Cấp quyền là việc của lượt phục hồi và của người vận hành; một
 * trang xem báo cáo mà âm thầm `GRANT` là vượt quyền và giấu mất sự cố thật.
 */

/** Kết quả thô đọc từ Postgres — tách khỏi phần phân loại để test được mà không cần DB. */
export type QuyenN8nThô = {
  /** Tên database đang nối. Đường test dùng database riêng đuôi `_test`. */
  database: string;
  /** Schema Prisma đang trỏ tới (prod + dev đều là `app`). */
  schema: string;
  /** Role có tồn tại trong cụm không. Cụm chưa dựng role ⇒ không có gì để mất. */
  coRole: boolean;
  /** `USAGE` trên schema. `null` khi không có role để hỏi. */
  coUsage: boolean | null;
  /** `SELECT` trên view `SettingN8n` (kho khoá cho n8n). `null` khi không có role, hoặc view chưa tồn tại. */
  coSelect: boolean | null;
  /**
   * `SELECT` trên BẢNG `Setting` GỐC — chiều NGƯỢC: phải là `false`. Grant cũ trên prod do
   * `supabase_admin` cấp; REVOKE trong migration chạy bằng role app KHÔNG gỡ được grant của
   * grantor khác ⇒ nếu không đo thì view SettingN8n bảo vệ ZERO mà panel vẫn xanh (n8n vẫn đọc
   * được n8nApiKey/n8nDbRoPassword). `null` khi không có role/bảng.
   */
  coSelectBangGoc: boolean | null;
};

export type TrangThaiQuyenN8n =
  /** Không áp dụng ở môi trường này — KHÔNG hiển thị gì. */
  | { trangThai: "KHONG_AP_DUNG"; lyDo: string }
  | { trangThai: "DU_QUYEN" }
  | { trangThai: "THIEU_QUYEN"; thieu: string[]; schema: string };

/**
 * Phân loại quyền đọc thành thứ hiển thị được. Hàm THUẦN.
 *
 * Hai cửa trả `KHONG_AP_DUNG` — cả hai đều để tránh báo động giả, thứ nguy hiểm hơn không báo:
 *
 *  - **Database đuôi `_test`.** Vitest và Playwright chạy trên database riêng (`hogikids_test`,
 *    `hogikids_e2e_test`) mà n8n không bao giờ đọc. Role thì nằm ở mức CỤM nên vẫn thấy tồn tại,
 *    còn GRANT lại theo từng database ⇒ không lọc thì mọi lượt e2e đều dựng một banner đỏ vô nghĩa,
 *    và người ta học cách phớt lờ nó. Dùng đúng quy ước đuôi `_test` mà guard chống-xoá-nhầm-DB đã
 *    dùng (`tests/setup.ts`), không đoán theo `NODE_ENV`.
 *  - **Role không tồn tại.** Cụm chưa từng dựng role (máy dev dựng Postgres riêng) thì không có
 *    quyền nào để mất. Cùng lý do mà `sqlCapQuyenDocN8n` bỏ qua im lặng khi thiếu role.
 */
export function phanLoaiQuyenN8n(tho: QuyenN8nThô): TrangThaiQuyenN8n {
  if (tho.database.endsWith("_test")) {
    return { trangThai: "KHONG_AP_DUNG", lyDo: `database ${tho.database} là DB test, n8n không đọc` };
  }
  if (!tho.coRole) {
    return { trangThai: "KHONG_AP_DUNG", lyDo: `cụm này chưa có role ${N8N_RO_ROLE}` };
  }

  const thieu: string[] = [];
  if (tho.coUsage !== true) thieu.push(`USAGE trên schema "${tho.schema}"`);
  // THỪA quyền cũng là việc phải sửa — dùng chung banner với thiếu quyền (cùng mức phải-hành-động).
  if (tho.coSelectBangGoc === true) {
    thieu.push(
      `QUYỀN RỘNG chưa gỡ: role vẫn SELECT được BẢNG "${tho.schema}"."Setting" gốc (đọc được cả ` +
        `n8nApiKey/n8nDbRoPassword). Chạy bằng psql supabase_admin: ` +
        `REVOKE ALL ON "${tho.schema}"."Setting" FROM ${N8N_RO_ROLE};`
    );
  }
  // `coSelect === null` = view SettingN8n chưa tồn tại (migration chưa chạy). Vẫn tính là thiếu:
  // n8n đọc khoá ở đúng view đó, không có view thì workflow cũng chết — chỉ khác nguyên nhân.
  if (tho.coSelect !== true) thieu.push(`SELECT trên view "${tho.schema}"."${N8N_SETTING_VIEW}"`);

  return thieu.length === 0 ? { trangThai: "DU_QUYEN" } : { trangThai: "THIEU_QUYEN", thieu, schema: tho.schema };
}

/**
 * Đọc quyền hiện hành từ Postgres.
 *
 * Hỏi catalog bằng `has_*_privilege`, KHÔNG thử nối bằng role đó (app không giữ mật khẩu role này,
 * và mở thêm một kết nối chỉ để thử là đắt hơn hẳn một lượt đọc catalog).
 *
 * Lỗi ở đây KHÔNG được làm vỡ trang: `/cai-dat` còn hiển thị hàng chục thứ khác quan trọng hơn.
 * Đọc hỏng ⇒ coi như không áp dụng, kèm lý do để còn lần ra khi soi log.
 */
export async function docQuyenDocN8n(): Promise<TrangThaiQuyenN8n> {
  try {
    const hang = await prisma.$queryRaw<QuyenN8nThô[]>`
      SELECT
        current_database()::text AS "database",
        current_schema()::text   AS "schema",
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${N8N_RO_ROLE}) AS "coRole",
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${N8N_RO_ROLE})
             THEN has_schema_privilege(${N8N_RO_ROLE}, current_schema(), 'USAGE')
        END AS "coUsage",
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${N8N_RO_ROLE})
              AND to_regclass(quote_ident(current_schema()) || '."' || ${N8N_SETTING_VIEW} || '"') IS NOT NULL
             THEN has_table_privilege(${N8N_RO_ROLE}, quote_ident(current_schema()) || '."' || ${N8N_SETTING_VIEW} || '"', 'SELECT')
        END AS "coSelect",
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${N8N_RO_ROLE})
              AND to_regclass(quote_ident(current_schema()) || '."Setting"') IS NOT NULL
             THEN has_table_privilege(${N8N_RO_ROLE}, quote_ident(current_schema()) || '."Setting"', 'SELECT')
        END AS "coSelectBangGoc"
    `;
    const tho = hang[0];
    if (!tho) return { trangThai: "KHONG_AP_DUNG", lyDo: "truy vấn quyền không trả về dòng nào" };
    return phanLoaiQuyenN8n(tho);
  } catch (e) {
    return { trangThai: "KHONG_AP_DUNG", lyDo: `không đọc được quyền: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Hai câu SQL cấp lại quyền, để chủ shop chép chạy tay.
 *
 * CỐ Ý viết thẳng ở đây thay vì dùng lại `sqlCapQuyenDocN8n` của đường phục hồi: câu kia bọc trong
 * khối `DO $$ ... $$` với hai cửa `pg_roles`/`to_regclass` để lượt restore không gãy giữa chừng —
 * dán khối đó cho người chạy tay thì họ không thấy được câu nào bị bỏ qua và vì sao. Hai câu trần
 * dưới đây chạy là biết ngay kết quả.
 */
export function cauCapLaiQuyen(schema: string): string {
  return [
    `GRANT USAGE ON SCHEMA "${schema}" TO ${N8N_RO_ROLE};`,
    `GRANT SELECT ON "${schema}"."${N8N_SETTING_VIEW}" TO ${N8N_RO_ROLE};`,
  ].join("\n");
}
