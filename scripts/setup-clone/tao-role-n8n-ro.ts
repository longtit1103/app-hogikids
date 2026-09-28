import { randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { N8N_RO_ROLE, N8N_SETTING_VIEW } from "@/lib/n8n/role-doc-kho-khoa";

/**
 * Tạo role chỉ-đọc cho n8n bằng ADMIN DSN (role app không có CREATEROLE). Không có admin DSN thì
 * KHÔNG chặn setup — in sẵn khối SQL để chạy tay (tự thấy câu nào, không nuốt lặng như DO-block).
 *
 * Password: sinh crypto 24 byte base64url, KHÔNG in console — chỉ ghi vào `Setting`
 * (`n8nDbRoPassword`) để lượt "Cài workflows" dựng credential; view `SettingN8n` đã loại key đó
 * khỏi tầm mắt của chính role này.
 */

// 4 câu, KHÔNG cấp gì thêm — role này cố ý chỉ đọc được đúng một view.
export function sqlTaoRoleChayTay(tenDb: string, schema: string): string {
  return [
    `create role ${N8N_RO_ROLE} login password '<tu-dien-mat-khau>';`,
    `grant connect on database "${tenDb}" to ${N8N_RO_ROLE};`,
    `grant usage on schema ${schema} to ${N8N_RO_ROLE};`,
    `grant select on ${schema}."${N8N_SETTING_VIEW}" to ${N8N_RO_ROLE};`,
  ].join("\n");
}

export type KetQuaTaoRole =
  | { ket: "tao-moi" | "da-co" | "rotate"; matKhauMoi: string | null }
  | { ket: "skip"; lyDo: string };

export async function taoRoleN8nRo(opts: {
  adminUrl: string | undefined;
  tenDb: string;
  schema: string;
  rotate: boolean;
}): Promise<KetQuaTaoRole> {
  if (!opts.adminUrl) {
    return { ket: "skip", lyDo: "không có --admin-url — chạy tay khối SQL bên dưới rồi Cài workflows ở /cai-dat" };
  }

  // HAI kết nối admin: CREATE/ALTER ROLE là việc mức CỤM (chạy ở db nào cũng được — dùng đúng
  // DSN người dùng đưa, thường trỏ db `postgres`); còn GRANT USAGE/SELECT trên schema/view phải
  // nối vào ĐÚNG database đích — chạy nhầm db là `relation does not exist` (diễn tập 22/08 bắt).
  const admin = new PrismaClient({ datasources: { db: { url: opts.adminUrl } } });
  const urlDbDich = new URL(opts.adminUrl);
  urlDbDich.pathname = `/${opts.tenDb}`;
  const adminTrenDbDich = new PrismaClient({ datasources: { db: { url: urlDbDich.toString() } } });
  try {
    const [role] = await admin.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_roles WHERE rolname = ${N8N_RO_ROLE}
    `;
    const daCo = Number(role?.n ?? 0) > 0;

    let matKhauMoi: string | null = null;
    if (!daCo) {
      matKhauMoi = randomBytes(24).toString("base64url");
      // Tên role/mật khẩu là hằng/giá trị tự sinh — không phải input người dùng.
      await admin.$executeRawUnsafe(`CREATE ROLE ${N8N_RO_ROLE} LOGIN PASSWORD '${matKhauMoi}'`);
    } else if (opts.rotate) {
      matKhauMoi = randomBytes(24).toString("base64url");
      await admin.$executeRawUnsafe(`ALTER ROLE ${N8N_RO_ROLE} PASSWORD '${matKhauMoi}'`);
    }

    await admin.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${opts.tenDb}" TO ${N8N_RO_ROLE}`);
    await adminTrenDbDich.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${opts.schema}" TO ${N8N_RO_ROLE}`);
    await adminTrenDbDich.$executeRawUnsafe(`GRANT SELECT ON "${opts.schema}"."${N8N_SETTING_VIEW}" TO ${N8N_RO_ROLE}`);
    // Dọn grant CŨ trên bảng gốc (nếu từng cấp) — admin gỡ được mọi grantor, khác REVOKE trong
    // migration (chạy bằng role app, chỉ gỡ được grant do chính nó cấp).
    await adminTrenDbDich.$executeRawUnsafe(`REVOKE ALL ON "${opts.schema}"."Setting" FROM ${N8N_RO_ROLE}`);

    return { ket: !daCo ? "tao-moi" : opts.rotate ? "rotate" : "da-co", matKhauMoi };
  } finally {
    await admin.$disconnect();
    await adminTrenDbDich.$disconnect();
  }
}
