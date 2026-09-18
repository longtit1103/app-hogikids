/**
 * Đổi token Meta ngắn hạn (Graph API Explorer, sống 1–2h) sang token DÀI HẠN (60 ngày) rồi hỏi
 * hạn THẬT — port đúng bước ①② của `scripts/meta-ads-lay-token.ts` để trang Cài đặt tự làm được,
 * chủ shop không phải chạy script trên máy dev nữa. Script vẫn giữ nguyên (đường dự phòng).
 *
 * ⚠️ Chỉ SINH LỢI khi token vào là token TƯƠI vừa lấy ở Graph API Explorer: đổi lại token dài hạn
 * đang chạy thì Meta trả token mới nhưng GIỮ NGUYÊN hạn cũ (đo 2026-07-25, chênh 0 ngày).
 *
 * Bất biến: mọi Error ném ra từ đây KHÔNG chứa giá trị token/app secret — message sẽ hiện
 * nguyên văn trên UI. (Message lỗi của Meta chỉ mô tả nguyên nhân, không nhại lại input.)
 */

const META_GRAPH_VERSION = "v25.0";
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
/** Meta thường trả lời <2s; 15s là đủ phân biệt "chậm" với "không tới nơi". */
const TIMEOUT_MS = 15_000;

export type KetQuaDoiTokenMeta = {
  tokenMoi: string;
  /** epoch GIÂY. 0 = không hết hạn. */
  hetHanEpoch: number;
  dataAccessHetHanEpoch: number;
  conSong: boolean;
  quyen: string[];
};

type LoiGraph = { message?: string; code?: number };

export async function doiTokenMetaDaiHan(args: {
  tokenTuoi: string;
  appId: string;
  appSecret: string;
}): Promise<KetQuaDoiTokenMeta> {
  const { tokenTuoi, appId, appSecret } = args;

  // ① Đổi sang token dài hạn (60 ngày).
  const qs = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: tokenTuoi,
  });
  let doi: { access_token?: string; error?: LoiGraph };
  try {
    doi = (await (
      await fetch(`${GRAPH}/oauth/access_token?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    ).json()) as typeof doi;
  } catch {
    throw new Error("Không gọi được Facebook (mạng hoặc Facebook đang lỗi) — thử lại sau ít phút.");
  }
  if (doi.error || !doi.access_token) {
    throw new Error(
      `Facebook từ chối đổi token: ${doi.error?.message ?? "không rõ nguyên nhân"} (mã ${doi.error?.code ?? "?"}). ` +
        "Kiểm tra lại App ID/App Secret và lấy token TƯƠI ở Graph API Explorer."
    );
  }
  const tokenMoi = doi.access_token;

  // ② Hỏi Facebook hạn THẬT của token mới — `expires_in` của bước ① không phải lúc nào cũng có.
  let dbg: { data?: { expires_at?: number; is_valid?: boolean; scopes?: string[]; data_access_expires_at?: number } };
  try {
    dbg = (await (
      await fetch(`${GRAPH}/debug_token?input_token=${tokenMoi}&access_token=${appId}|${appSecret}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    ).json()) as typeof dbg;
  } catch {
    throw new Error("Đổi token xong nhưng không hỏi được hạn — thử lại (token vừa đổi chưa được lưu).");
  }
  const d = dbg.data ?? {};

  return {
    tokenMoi,
    hetHanEpoch: Number(d.expires_at ?? 0),
    dataAccessHetHanEpoch: Number(d.data_access_expires_at ?? 0),
    conSong: d.is_valid === true,
    quyen: d.scopes ?? [],
  };
}
