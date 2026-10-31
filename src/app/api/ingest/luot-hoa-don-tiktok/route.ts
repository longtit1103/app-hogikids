import { routeQuaCua } from "@/lib/backup/cong-ghi-toan-cuc";
import { docBodyCoTran } from "@/lib/ingest/doc-body-co-tran";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { withSyncLog } from "@/lib/ingest/sync-log";
import { ghiNhanDauBcTiktok } from "@/lib/no-phai-tra/bc-tiktok-hoa-don";
import {
  docThanDauLuot,
  KET_QUA_KHONG_QUYEN_FINANCE,
  lyDoKetThucChuaDu,
  MODE_DAU_BAT_DAU,
  MODE_DAU_KET_THUC,
  STREAM_HOA_DON_TIKTOK,
} from "@/lib/no-phai-tra/dau-luot-hoa-don-tiktok";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/ingest/luot-hoa-don-tiktok — n8n (`tiktok-business-nightly`) báo BẮT ĐẦU / KẾT THÚC lượt kéo hoá đơn
 * TikTok Business của MỘT BC. Khuôn + luật: `src/lib/no-phai-tra/dau-luot-hoa-don-tiktok.ts`.
 *
 * Body: `{ luotId, bcId, giaiDoan: "bat-dau", phamVi? }` hoặc `{ luotId, bcId, giaiDoan: "ket-thuc", phamVi?,
 * tongTrangNguon, tongHoaDonNguon, soTrangDaGet, soTrangLand, soTrangRong, soTrangLoi, soHoaDon, hoanTat, ketQua, loi }`;
 * `phamVi = { startTime, endTime, muiGio: "UTC+07:00" }` = đúng `filtering{start_time, end_time}` n8n đã gửi GET hoá
 * đơn. Sai khuôn (kể cả `phamVi` có mà sai: giờ không có thật, múi khác, bắt đầu ≥ kết thúc, khoá lạ) hoặc số liệu tự
 * mâu thuẫn ⇒ 400 TRƯỚC khi mở SyncLog (không ghi dòng nào — cổng thấy thiếu dấu ⇒ chặn). VẮNG `phamVi` (workflow bản
 * trước) ⇒ vẫn ghi dấu — lượt hỏng vẫn hiện ra với cổng — nhưng lượt đó không bao giờ làm bằng chứng phủ ngày sao kê
 * (fail-closed ở cổng, không ở route: 400 dấu bản cũ thì cổng mất luôn tín hiệu lượt hỏng).
 *
 * Mỗi dấu = một dòng `SyncLog` kind `TIKTOK_ADS`, `stats` = `{ stream: "tiktokbusiness/invoice", shopId: bcId, luotId,
 * giaiDoan, mode: "luot-bat-dau" | "luot-ket-thuc", …số liệu kết thúc }` (gắn từ dòng RUNNING). Dấu kết thúc mà số khai
 * nói lượt chưa đủ (lỗi, đứt giữa chừng, GET < total_page, trang rỗng khi nguồn báo ≥ 1 trang, land < total_number)
 * ⇒ dòng ERROR, HTTP 200 (khuôn `loiSauKhiGhi`): banner đồng bộ bật đỏ, n8n không thử lại. Riêng `ketQua`
 * `khong-quyen-finance` (TikTok báo BC thiếu quyền finance) ⇒ dòng OK: BC chưa từng cấp quyền thì đêm nào cũng vậy,
 * banner đỏ mỗi đêm là báo động giả; cổng chốt sao kê CHẶN ca đó (mất quyền / chưa xác nhận) tới khi cấp quyền hoặc
 * chủ shop đánh dấu BC "không dùng thẻ". Cổng chốt sao kê thẻ (`lyDoHoaDonTiktokChuaDu`) đọc lại số khai, không tin
 * trạng thái dòng một mình.
 *
 * Mỗi dấu hợp lệ còn ghi nhận BC vào bảng bền `TiktokBcHoaDon` (`ghiNhanDauBcTiktok`, idempotent): lần đầu có dấu (bật
 * chế độ dấu lượt toàn cục) + lần cuối đọc được (dấu kết thúc đã GET ≥ 1 trang). Ghi hỏng ⇒ dòng dấu ERROR, HTTP 500
 * (cổng chặn — fail-closed).
 *
 * Không chạm tiền, Bronze hay Silver.
 */

/** Thân hợp lệ vài trăm byte (tối đa 20 câu lỗi × 500 ký tự); 32 KB đủ rộng mà không nhận MB. */
const TRAN_BODY_BYTE = 32 * 1024;

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  return routeQuaCua(() => xuLyPost(req));
}

/** Thân POST sau cửa ghi (đếm suốt request — lượt phục hồi chờ nó xong). */
async function xuLyPost(req: Request): Promise<Response> {
  const doc = await docBodyCoTran(req, TRAN_BODY_BYTE).catch(() => null);
  if (doc === null) return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  if (!doc.ok) {
    return Response.json({ ok: false, error: `body ${doc.bytes} byte vượt trần ${TRAN_BODY_BYTE} byte` }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.text);
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const kq = docThanDauLuot(parsed);
  if (!kq.ok) return Response.json({ ok: false, error: kq.loi }, { status: 400 });

  const { luotId, bcId, ...dau } = kq.dau;
  const dauNhanDien = {
    stream: STREAM_HOA_DON_TIKTOK,
    shopId: bcId,
    luotId,
    giaiDoan: dau.giaiDoan,
    mode: dau.giaiDoan === "bat-dau" ? MODE_DAU_BAT_DAU : MODE_DAU_KET_THUC,
  };

  return withSyncLog(
    "TIKTOK_ADS",
    async () => {
      // TikTok cho GET được ≥ 1 trang ⇒ BC đọc được hoá đơn (thiếu quyền finance luôn khai 0 trang).
      await ghiNhanDauBcTiktok(prisma, bcId, dau.giaiDoan === "ket-thuc" && dau.soTrangDaGet > 0);
      // Phạm vi thời gian lượt đã gửi TikTok — lưu ở CẢ hai dấu (cổng đọc ở dấu bắt đầu, đòi dấu kết thúc khai trùng).
      if (dau.giaiDoan === "bat-dau") return dau.phamVi ? { phamVi: dau.phamVi } : {};
      const chuaDu = dau.ketQua === KET_QUA_KHONG_QUYEN_FINANCE ? [] : lyDoKetThucChuaDu(dau);
      return {
        ...dau,
        ...(chuaDu.length > 0
          ? { loiSauKhiGhi: `Lượt kéo hoá đơn TikTok (BC ${bcId}, lượt ${luotId}) chưa đủ: ${chuaDu.join("; ")}` }
          : {}),
      };
    },
    { dauNhanDien },
  );
}
