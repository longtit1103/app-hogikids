import type { SyncKind } from "@prisma/client";

import { chuanBiDongAdsHoacBoQua, type PreparedAdsExpense } from "@/lib/ingest/ads-expense-row";
import {
  napSoChiTieuAds,
  upsertOneAdsExpense,
  type AdsExpenseStats,
} from "@/lib/ingest/ads-expense-upsert";
import { ingestAdsBodySchema } from "@/lib/ingest/ads-schema";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { giuKhoaGhiChiTieuAds } from "@/lib/ingest/khoa-ghi-chi-tieu-ads";
import { withSyncLog } from "@/lib/ingest/sync-log";
import { prisma } from "@/lib/prisma";
import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";

/**
 * POST /api/ingest/ads — n8n đẩy CHI TIÊU ads mỗi đêm (Meta / TikTok ad-account).
 *
 * App là BIÊN TIỀN nên tự nhân VAT (n8n chỉ gửi `spendExVat` + `vatRate`). Khoá `refId`, phép nhân
 * VAT và cách neo ngày nằm ở `prepareAdsExpenseRow`; phép GHI nằm ở `upsertOneAdsExpense` — cả hai
 * DÙNG CHUNG với bước dựng lại chi tiêu ads từ kho thô (`transformFromRaw`). Hai đường ghi phải đi
 * qua ĐÚNG một cổng: khác khoá thì đẻ dòng trùng, khác cổng thì lượt đêm này ghi đè mất khoản chi
 * phí mà lượt kia (hoặc chính chủ shop) vừa quyết.
 * Idempotent theo `refId` → ingest lại chỉ cập nhật amount.
 */
export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = ingestAdsBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const { source, rows } = parsed.data;
  const kind: SyncKind = source === "META" ? "META_ADS" : "TIKTOK_ADS";

  return withSyncLog(kind, async (warnings) => {
    // Chuẩn hoá + tính amount (nhân VAT ở app) trước khi vào transaction. Dòng ngày ngoài biên hợp lý
    // bị BỎ kèm cảnh báo (không đỏ cả lô — lý do ở `chuanBiDongAdsHoacBoQua`), rồi log ERROR ở cuối
    // lượt (`loiSauKhiGhi`) để người soi thấy.
    const prepared: PreparedAdsExpense[] = [];
    let ngayHong = 0;
    for (const row of rows) {
      const r = chuanBiDongAdsHoacBoQua(source, row, warnings);
      if (r === null) ngayHong++;
      else prepared.push(r);
    }

    // Gom theo refId TRƯỚC khi ghi: app là biên tiền, KHÔNG cho phép 2 dòng cùng
    // refId trong 1 payload upsert đè nhau im lặng (auction + GMV Max có thể trùng
    // (campaign, ngày)). Trùng ⇒ THROW để n8n báo đỏ, không ghi số nào (tránh
    // ghi lô nửa vời rồi mất dòng bị đè).
    const seen = new Set<string>();
    for (const r of prepared) {
      if (seen.has(r.refId)) {
        throw new Error(
          `refId trùng trong 1 payload: ${r.refId} — 2 dòng cùng (source, ngày, campaign) sẽ đè nhau. Tách khoá trước khi gửi.`,
        );
      }
      seen.add(r.refId);
    }

    const stats: AdsExpenseStats = { adsExpensesUpserted: 0, skipped: ngayHong, boQuaCoChuDich: 0 };

    // timeout rộng: 1 upsert = 1 round-trip tuần tự; lô tới 2000 dòng qua Tailscale
    // (RTT cao khi chạy tay) sẽ vượt 5s mặc định ⇒ P2028 rollback cả lô = mất chi phí.
    await prisma.$transaction(
      async (tx) => {
        // Khoá TRƯỚC, rồi mới chụp ảnh sổ — và chụp bằng `tx` chứ không phải `prisma`.
        // Ảnh chụp là căn cứ cho cổng "ngày này chủ shop đã ghi đè bằng file import":
        // đọc nó ngoài khoá thì một lượt import commit xen vào giữa lúc chụp và lúc ghi
        // sẽ không được nhìn thấy ⇒ ghi thêm dòng ADS_API cho ngày đã có dòng IMPORT =
        // chi phí quảng cáo ngày đó đếm 2 lần.
        await giuKhoaGhiChiTieuAds(tx);
        const so = await napSoChiTieuAds(tx);
        for (const r of prepared) {
          await upsertOneAdsExpense(tx, source, r, so, stats, warnings);
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    // `rowsUpserted` là số dòng THỰC SỰ vào sổ — dòng bị cổng chặn bỏ qua nằm ở `rowsSkipped` kèm
    // cảnh báo, để n8n không đọc nhầm "đã ghi đủ".
    //
    // `rowsSkipped` GIỮ NGUYÊN nghĩa cũ = MỌI dòng gửi lên mà không vào sổ (kẹt + bỏ có chủ đích).
    // Đây là con số n8n và nhật ký đồng bộ đã đọc từ trước; thu hẹp nó lại sẽ làm một lượt bỏ dòng
    // thật báo về 0 với người đang soi, tức là mất tín hiệu. Phần "bỏ vì đúng ý chủ shop" tách ra ở
    // `rowsBoQuaCoChuDich` để đọc được ngay lượt nào là bình thường (ngày đã ghi đè bằng file) và
    // lượt nào cần xem lại (hỏng shape / ghi lỗi = `rowsSkipped − rowsBoQuaCoChuDich`).
    return {
      rowsUpserted: stats.adsExpensesUpserted,
      rowsSkipped: stats.skipped + stats.boQuaCoChuDich,
      rowsBoQuaCoChuDich: stats.boQuaCoChuDich,
      // Dòng ngày hỏng bị bỏ = một khoản chi thật có thể không vào sổ (lãi báo cao lên) ⇒ log ERROR để
      // banner đồng bộ bật, dù phần còn lại đã ghi và HTTP vẫn 200 (xem `withSyncLog`).
      ...(ngayHong > 0
        ? {
            loiSauKhiGhi:
              `Bỏ ${ngayHong}/${rows.length} dòng chi tiêu ads có ngày ngoài khoảng hợp lệ (xem cảnh báo) — ` +
              `các dòng còn lại ĐÃ ghi. Kiểm lại cách workflow tính ngày.`,
          }
        : {}),
    };
  });
}
