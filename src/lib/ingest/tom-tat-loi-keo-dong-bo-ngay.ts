import { z } from "zod";

/**
 * Tóm tắt LỖI KÉO PANCAKE mà workflow `pancake-sync-now` gửi kèm lời gọi bước cuối
 * (`POST /api/ingest/dem-gia-von`, body `{ soLoiKeo, loiKeo: [{scope, stream, shop, lyDo}] }`).
 *
 * VÌ SAO: lỗi phía Pancake (GET hỏng 2 lần, key bị chặn 401/403, trang lẻ 429/timeout) xảy ra TRƯỚC
 * khi n8n POST sang app ⇒ không để lại dòng SyncLog nào. App chỉ thấy bước đếm OK ⇒ nút "Đồng bộ
 * ngay" báo XANH dù phiếu nhập/đơn không về. Body này là kênh DUY NHẤT để app biết.
 *
 * TƯƠNG THÍCH NGƯỢC + PHÒNG THỦ: workflow bản cũ gửi `{}` (hoặc không body) ⇒ "không có lỗi kéo",
 * chạy y như trước. Body sai hình / quá lớn / không phải JSON ⇒ BỎ QUA tóm tắt kèm một cảnh báo —
 * TUYỆT ĐỐI không được làm hỏng phép đếm (đếm là việc chính của route). Endpoint có bearer
 * `INGEST_SECRET` nên kẻ gửi là n8n nhà mình; các trần chỉ để một bản workflow lỗi không phình SyncLog.
 */

/** Trần kích thước body (byte, đo trên chuỗi). 20 dòng × ~300 byte còn dư nhiều. */
export const TRAN_BODY_LOI_KEO = 16_384;
/** Trần số dòng tóm tắt giữ lại (workflow cũng cắt 20). */
export const TRAN_DONG_LOI_KEO = 20;

const DongLoiKeo = z.object({
  scope: z.string().max(40),
  stream: z.string().max(80),
  shop: z.string().max(20),
  lyDo: z.string().max(200).optional(),
});

const BodyLoiKeo = z.object({
  soLoiKeo: z.number().int().min(0).max(1_000_000).optional(),
  loiKeo: z.array(DongLoiKeo).max(TRAN_DONG_LOI_KEO).optional(),
});

export type DongLoiKeo = z.infer<typeof DongLoiKeo>;

export type TomTatLoiKeo = {
  /** Tổng số lỗi kéo (có thể > số dòng giữ lại). 0 = lượt kéo sạch hoặc workflow cũ. */
  soLoiKeo: number;
  loiKeo: DongLoiKeo[];
  /** Có giá trị khi body bị BỎ QUA (sai hình/quá lớn) — để route đẩy vào cảnh báo SyncLog. */
  canhBao: string | null;
};

const KHONG_LOI: TomTatLoiKeo = { soLoiKeo: 0, loiKeo: [], canhBao: null };

/** Đọc body THÔ. Không bao giờ ném. */
export function docTomTatLoiKeo(bodyTho: string): TomTatLoiKeo {
  if (!bodyTho.trim()) return KHONG_LOI;
  if (bodyTho.length > TRAN_BODY_LOI_KEO) {
    return { ...KHONG_LOI, canhBao: `Tóm tắt lỗi kéo bị bỏ qua: body ${bodyTho.length} ký tự vượt trần ${TRAN_BODY_LOI_KEO}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(bodyTho);
  } catch {
    return { ...KHONG_LOI, canhBao: "Tóm tắt lỗi kéo bị bỏ qua: body không phải JSON" };
  }
  const kq = BodyLoiKeo.safeParse(json);
  if (!kq.success) {
    return { ...KHONG_LOI, canhBao: "Tóm tắt lỗi kéo bị bỏ qua: body sai hình" };
  }
  const loiKeo = kq.data.loiKeo ?? [];
  // `soLoiKeo` thiếu hoặc NHỎ hơn số dòng gửi kèm ⇒ lấy số dòng (không để tổng nói ít hơn chi tiết).
  return { soLoiKeo: Math.max(kq.data.soLoiKeo ?? 0, loiKeo.length), loiKeo, canhBao: null };
}

/**
 * Câu lỗi ghi vào dòng SyncLog bước cuối (và nút hiện nguyên văn). Nêu stream/shop TRƯỚC — chủ shop
 * cần biết ngay "phiếu nhập (purchases/kho) không về", lý do kỹ thuật để sau.
 */
export function cauLoiKeo(t: TomTatLoiKeo): string | null {
  if (t.soLoiKeo === 0) return null;
  const chiTiet = t.loiKeo.map((d) => `${d.stream}/${d.shop} (${d.scope}${d.lyDo ? `: ${d.lyDo}` : ""})`);
  const conLai = t.soLoiKeo - t.loiKeo.length;
  if (conLai > 0) chiTiet.push(`${conLai} lượt khác (xem execution pancake-sync-now trong n8n)`);
  return `Kéo Pancake lỗi ${t.soLoiKeo} lượt — dữ liệu có thể thiếu: ${chiTiet.join("; ")}`;
}
