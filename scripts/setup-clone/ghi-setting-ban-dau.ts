import { KEY_SHOP_ID } from "@/lib/ket-noi/cau-hinh-shop";
import { chanDoiShopIdKhiCoDuLieu } from "@/lib/ket-noi/chan-doi-shop-id";
import { N8N_RO_ROLE } from "@/lib/n8n/role-doc-kho-khoa";
import { prisma } from "@/lib/prisma";

import { tenDbTu, type ThamSo } from "./kiem-env-va-chan-db";

/**
 * Ghi các key `Setting` ban đầu cho bản clone: shop ID (đi qua ĐÚNG lưới chặn-đổi của app —
 * setup không được lách luật mà /cai-dat phải theo) + bộ `n8nDb*` cho lượt "Cài workflows"
 * dựng credential Postgres.
 */

export async function ghiShopIdBanDau(thamSo: ThamSo): Promise<{ daGhi: string[]; loi: string | null }> {
  const canGhi: Array<[string, string]> = [];
  const them = (key: string, giaTri?: string) => {
    if (giaTri && giaTri.trim()) canGhi.push([key, giaTri.trim()]);
  };
  them(KEY_SHOP_ID.kho, thamSo.shopKho);
  them(KEY_SHOP_ID.shopee, thamSo.shopShopee);
  them(KEY_SHOP_ID.tiktok, thamSo.shopTiktok);
  them(KEY_SHOP_ID.tiktokShop, thamSo.tiktokShopId);
  them("metaAdsAccountId", thamSo.metaAccountId);
  if (canGhi.length === 0) return { daGhi: [], loi: null };

  const loi = await chanDoiShopIdKhiCoDuLieu(canGhi);
  if (loi) return { daGhi: [], loi };

  await prisma.$transaction(
    canGhi.map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    )
  );
  return { daGhi: canGhi.map(([k]) => k), loi: null };
}

/**
 * Bộ khoá `n8nDb*` — địa chỉ DB mà CREDENTIAL của n8n sẽ nối tới. Host/port/db parse từ
 * `DATABASE_URL` (n8n thường nhìn DB qua CÙNG host với app trong docker network); override
 * `--n8n-db-host` khi topology khác. `ssl` tự suy cho Supabase cloud.
 */
export async function ghiN8nDb(databaseUrl: string, thamSo: ThamSo, matKhauMoi: string | null): Promise<string[]> {
  const { db, host, port } = tenDbTu(databaseUrl);
  const hostN8n = thamSo.n8nDbHost?.trim() || host;
  const sslRequire = hostN8n.endsWith(".supabase.co") || /sslmode=require/.test(databaseUrl);

  if (port === "6543") {
    console.warn(
      "⚠ DATABASE_URL trỏ cổng 6543 (supavisor pooler) — app này yêu cầu nối DIRECT 5432 " +
        "(raw SQL dựa session search_path). Sửa .env trước khi chạy thật."
    );
  }

  const canGhi: Array<[string, string]> = [
    ["n8nDbHost", hostN8n],
    ["n8nDbPort", port],
    ["n8nDbName", db],
    ["n8nDbUser", N8N_RO_ROLE],
    ["n8nDbSsl", sslRequire ? "require" : "disable"],
  ];
  if (matKhauMoi) canGhi.push(["n8nDbRoPassword", matKhauMoi]);

  await prisma.$transaction(
    canGhi.map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    )
  );
  return canGhi.map(([k]) => k);
}
