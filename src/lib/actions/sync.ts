"use server";

import type { SyncKind } from "@/generated/prisma/client";

import type { ActionResult } from "@/lib/actions/action-result";
import type { LatestSync } from "@/lib/actions/sync-types";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import {
  MA_MOC_NGOAI_DAI,
  mocBamHopLe,
  MODE_BUOC_CUOI_DONG_BO_NGAY,
  type SoLieuTienDoDongBoNgay,
} from "@/lib/ingest/tien-do-dong-bo-ngay";
import { giaiUrlSyncNow } from "@/lib/n8n/giai-url-sync-now";
import { laChuyenHuong } from "@/lib/n8n/kiem-dich-den-n8n";
import { SYNC_NOW_AUTH_HEADER } from "@/lib/n8n/provision/doc-goi-workflow-tu-repo";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import { congAction } from "@/lib/quyen/cong-action";

/**
 * SyncLog kind gần nhất (cho badge "Đồng bộ lúc …" + poll sau khi bấm). Trả kèm `error` thô của
 * lượt đồng bộ (lỗi hệ thống) ⇒ cần `cai-dat:xem`; nơi gọi coi nhánh từ chối như "chưa có lượt nào".
 */
export async function getLatestSync(kind: SyncKind): Promise<ActionResult<LatestSync>> {
  const cong = await congAction("cai-dat:xem");
  if (!cong.ok) return cong;
  const log = await prisma.syncLog.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } });
  if (!log) return { ok: true, data: null };
  return {
    ok: true,
    data: {
      status: log.status,
      startedAt: log.startedAt.toISOString(),
      finishedAt: log.finishedAt?.toISOString() ?? null,
      error: log.error,
    },
  };
}

/**
 * Tiến độ lượt "Đồng bộ ngay" bấm lúc `mocBam` (ISO, do `triggerSyncNow` cấp — giờ SERVER). Nút bấm
 * poll hàm này rồi tự quyết "xong chưa" bằng `ketLuanTienDo` (`tien-do-dong-bo-ngay.ts`). Chỉ đọc
 * SyncLog; cùng quyền với `getLatestSync` (trả kèm `error` thô).
 *
 * Bước cuối nhận bằng `stats.mode` qua bộ lọc JSON DƯƠNG (`path`/`equals`) — dòng `stats` NULL tự
 * rơi ra ngoài, không dính bẫy `{ not: X }` trên cột nullable.
 *
 * `mocBam` do máy khách gửi lại ⇒ KẸP theo `mocBamHopLe` (giờ server): ngoài dải ⇒ từ chối với mã
 * `MA_MOC_NGOAI_DAI` (nút dừng theo dõi), không quét bảng.
 */
export async function getTienDoDongBoNgay(mocBam: string): Promise<ActionResult<SoLieuTienDoDongBoNgay>> {
  const cong = await congAction("cai-dat:xem");
  if (!cong.ok) return cong;
  if (typeof mocBam !== "string") return { ok: false, error: "Mốc bấm không hợp lệ" };
  const tu = new Date(mocBam);
  if (Number.isNaN(tu.getTime())) return { ok: false, error: "Mốc bấm không hợp lệ" };
  if (!mocBamHopLe(tu.getTime(), Date.now())) {
    return { ok: false, code: MA_MOC_NGOAI_DAI, error: "Mốc bấm ngoài khoảng theo dõi — tải lại trang rồi bấm lại" };
  }

  const tuMoc = { kind: "PANCAKE" as const, startedAt: { gte: tu } };
  const [buocCuoi, theoTrangThai, moc] = await Promise.all([
    prisma.syncLog.findFirst({
      where: { ...tuMoc, stats: { path: ["mode"], equals: MODE_BUOC_CUOI_DONG_BO_NGAY } },
      orderBy: { startedAt: "desc" },
      select: { status: true, error: true },
    }),
    prisma.syncLog.groupBy({ by: ["status"], where: tuMoc, _count: { _all: true } }),
    prisma.syncLog.aggregate({ where: tuMoc, _max: { startedAt: true, finishedAt: true } }),
  ]);

  const dem = (st: string) => theoTrangThai.find((r) => r.status === st)?._count._all ?? 0;
  const soLuot = theoTrangThai.reduce((tong, r) => tong + r._count._all, 0);
  const mocHoatDong = [moc._max.startedAt, moc._max.finishedAt]
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((a, b) => (a && a > b ? a : b), null);

  return {
    ok: true,
    data: {
      buocCuoi: buocCuoi ? { status: buocCuoi.status, error: buocCuoi.error } : null,
      soLuot,
      soLuotLoi: dem("ERROR") - (buocCuoi?.status === "ERROR" ? 1 : 0),
      coLuotDangChay: dem("RUNNING") > 0,
      hoatDongCuoi: mocHoatDong?.toISOString() ?? null,
      mocBam: tu.toISOString(),
      bayGio: new Date().toISOString(),
    },
  };
}

/**
 * Bấm "Đồng bộ ngay" → kích webhook n8n (POST kèm header auth). Không tiết lộ URL xuống client.
 * Trả `mocBam` = giờ SERVER chụp TRƯỚC khi gọi n8n — nút dùng mốc này để chỉ nhận dòng SyncLog của
 * lượt vừa bấm (không so đồng hồ máy khách với `startedAt` trong DB).
 */
export async function triggerSyncNow(): Promise<ActionResult<{ mocBam: string }>> {
  const cong = await congAction("cai-dat:sua");
  if (!cong.ok) return cong;
  // Không ghi DB, nhưng vẫn phải chặn: mọi trang n8n đẩy về sẽ bị 503 ở `/api/ingest/raw` TRƯỚC
  // `withSyncLog` ⇒ không có dòng nhật ký nào, badge "Đồng bộ lúc…" giữ mốc cũ, mà action này lại
  // trả ok ⇒ toast xanh nhưng không có gì xảy ra.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  // MỘT nguồn giải URL cho cả nút này lẫn badge trạng thái — xem `giai-url-sync-now.ts`.
  const dich = await giaiUrlSyncNow();
  const mocBam = new Date().toISOString();
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
      // Đây là đường THỨ BA mang secret ra ngoài (cùng họ với lượt Cài workflows và probe). Đo thật
      // 22/09 trên undici: qua chuyển hướng KHÁC ORIGIN, chỉ `Authorization` bị strip — **header
      // custom như header auth ở đây đi tiếp nguyên vẹn**. Nên không chặn là `n8nSyncNowSecret`
      // chảy sang đích lạ chỉ bằng một lượt 302.
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (laChuyenHuong(res.status)) {
      return {
        ok: false,
        error: "n8n URL trả chuyển hướng — đã dừng, không gửi tiếp. Kiểm tra lại địa chỉ n8n ở Cài đặt",
      };
    }
    if (!res.ok) {
      return { ok: false, error: "Không gọi được n8n — kiểm tra Cài đặt kết nối" };
    }
  } catch {
    return { ok: false, error: "Không gọi được n8n — kiểm tra Cài đặt kết nối" };
  }
  // Không có DB write nào để ghi kèm (lượt đồng bộ tự ghi SyncLog phía ingest) ⇒ nhật ký ghi sau khi
  // n8n nhận lệnh, NGOÀI `try`: nhật ký hỏng là lỗi hệ thống, không được báo nhầm "không gọi được n8n".
  await ghiNhatKy(prisma, { actor: cong.nguoiDung, hanhDong: HANH_DONG.DONG_BO_KICH_HOAT });
  return { ok: true, data: { mocBam } };
}
