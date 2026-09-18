"use server";

import type { SyncKind } from "@prisma/client";

import type { ActionResult } from "@/lib/actions/action-result";
import type { LatestSync } from "@/lib/actions/sync-types";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { giaiUrlSyncNow } from "@/lib/n8n/giai-url-sync-now";
import { SYNC_NOW_AUTH_HEADER } from "@/lib/n8n/provision/doc-goi-workflow-tu-repo";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/** SyncLog kind gần nhất (cho badge "Đồng bộ lúc …" + poll sau khi bấm). */
export async function getLatestSync(kind: SyncKind): Promise<LatestSync> {
  await requireUser();
  const log = await prisma.syncLog.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } });
  if (!log) return null;
  return {
    status: log.status,
    startedAt: log.startedAt.toISOString(),
    finishedAt: log.finishedAt?.toISOString() ?? null,
    error: log.error,
  };
}

/** Bấm "Đồng bộ ngay" → kích webhook n8n (POST kèm header auth). Không tiết lộ URL xuống client. */
export async function triggerSyncNow(): Promise<ActionResult> {
  await requireUser();
  // Không ghi DB, nhưng vẫn phải chặn: mọi trang n8n đẩy về sẽ bị 503 ở `/api/ingest/raw` TRƯỚC
  // `withSyncLog` ⇒ không có dòng nhật ký nào, badge "Đồng bộ lúc…" giữ mốc cũ, mà action này lại
  // trả ok ⇒ toast xanh nhưng không có gì xảy ra.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  // MỘT nguồn giải URL cho cả nút này lẫn badge trạng thái — xem `giai-url-sync-now.ts`.
  const dich = await giaiUrlSyncNow();
  if (!dich) {
    return { ok: false, error: "Chưa cấu hình kết nối n8n — điền n8n URL ở Cài đặt › Kết nối n8n" };
  }
  try {
    // Header auth của webhook sync-now: khoá RIÊNG `n8nSyncNowSecret` do lượt "Cài workflows"
    // sinh (KHÔNG phải INGEST_SECRET — header nằm plaintext trong execution data của n8n, còn
    // INGEST_SECRET mở được cả kho token). Workflow bản cũ chưa bật auth thì header thừa vô hại.
    const secretRow = await prisma.setting.findUnique({ where: { key: "n8nSyncNowSecret" } });
    const res = await fetch(dich.url, {
      method: "POST",
      headers: { [SYNC_NOW_AUTH_HEADER]: secretRow?.value ?? "" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, error: "Không gọi được n8n — kiểm tra Cài đặt kết nối" };
    }
    return { ok: true, data: undefined };
  } catch {
    return { ok: false, error: "Không gọi được n8n — kiểm tra Cài đặt kết nối" };
  }
}
