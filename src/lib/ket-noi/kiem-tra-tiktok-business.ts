import { prisma } from "@/lib/prisma";

import { gopKetQua, KIEM_TRA_TIMEOUT_MS, type KetQuaKiemTra } from "./kiem-tra-types";

/**
 * Probe TikTok Ads (Business API): GET `/oauth2/advertiser/get/` — đúng lời gọi ĐẦU TIÊN
 * của `tiktok-business-nightly` mỗi đêm (liệt kê mọi tài khoản quảng cáo token được cấp quyền).
 * Qua probe này là workflow đêm cũng qua bước xác thực.
 */

const TTB_BASE = "https://business-api.tiktok.com/open_api/v1.3";

export async function kiemTraTiktokBusiness(): Promise<KetQuaKiemTra> {
  // App id nay đọc từ `Setting` (key `tiktokBusinessAppId`) — soi gương n8n/tiktok-business-nightly.json
  // (clone-and-go 2026-08-21: bản clone đăng ký app TikTok for Business riêng, id khác).
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["tiktokBusinessAppId", "tiktokBusinessAppSecret", "tiktokBusinessToken"] } },
  });
  const theoKey = new Map(rows.map((r) => [r.key, r.value]));
  const appId = theoKey.get("tiktokBusinessAppId") ?? "";
  const appSecret = theoKey.get("tiktokBusinessAppSecret") ?? "";
  const token = theoKey.get("tiktokBusinessToken") ?? "";

  if (!appId || !appSecret || !token) {
    return gopKetQua([{ nhan: "Cấu hình", ok: false, chiTiet: "Chưa lưu đủ App ID + App Secret + Access Token." }]);
  }

  const qs = new URLSearchParams({ app_id: appId, secret: appSecret });
  let body: { code?: number; message?: string; data?: { list?: Array<{ advertiser_name?: string }> } };
  try {
    body = (await (
      await fetch(`${TTB_BASE}/oauth2/advertiser/get/?${qs}`, {
        headers: { "Access-Token": token },
        signal: AbortSignal.timeout(KIEM_TRA_TIMEOUT_MS),
      })
    ).json()) as typeof body;
  } catch {
    return gopKetQua([{ nhan: "TikTok Ads", ok: false, chiTiet: "Không gọi được TikTok Ads (mạng hoặc TikTok đang lỗi)." }]);
  }

  if (body.code !== 0) {
    return gopKetQua([
      {
        nhan: "TikTok Ads",
        ok: false,
        chiTiet: `TikTok từ chối (mã ${body.code ?? "?"}): ${body.message ?? "không rõ"} — kiểm tra App Secret/token.`,
      },
    ]);
  }

  const soTaiKhoan = body.data?.list?.length ?? 0;
  if (soTaiKhoan === 0) {
    // Cùng kết luận với workflow đêm: không advertiser nào = token sống nhưng vô dụng.
    return gopKetQua([
      { nhan: "TikTok Ads", ok: false, chiTiet: "Token hợp lệ nhưng KHÔNG có tài khoản quảng cáo nào được cấp quyền." },
    ]);
  }
  return gopKetQua([
    { nhan: "TikTok Ads", ok: true, chiTiet: `Token hợp lệ — thấy ${soTaiKhoan} tài khoản quảng cáo được cấp quyền.` },
  ]);
}
