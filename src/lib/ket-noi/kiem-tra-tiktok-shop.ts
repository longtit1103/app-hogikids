import { createHmac } from "node:crypto";

import { prisma } from "@/lib/prisma";

import { gopKetQua, KIEM_TRA_TIMEOUT_MS, type DongKiemTra, type KetQuaKiemTra } from "./kiem-tra-types";

/**
 * Probe TikTok Shop: GET danh sách shop đã cấp quyền (`/authorization/202309/shops`) —
 * xác thực trọn bộ App Key + App Secret + access token, và đối chiếu Shop ID đã lưu có
 * nằm trong danh sách được cấp quyền không.
 *
 * Chữ ký bê ĐÚNG từ `tiktokshop-nightly` (n8n): HMAC-SHA256(app_secret,
 * app_secret + path + Σ(key+value đã SORT, bỏ `sign` & `access_token`) + app_secret).
 * Token đọc từ kho (`tiktokShopAccessToken`) — máy tự gia hạn, probe không đụng refresh.
 */

const TTS_BASE = "https://open-api.tiktokglobalshop.com";
const PATH_SHOPS = "/authorization/202309/shops";

function kyChuKy(appSecret: string, path: string, qs: Record<string, string>): string {
  const joined = Object.keys(qs)
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort()
    .map((k) => `${k}${qs[k]}`)
    .join("");
  return createHmac("sha256", appSecret).update(`${appSecret}${path}${joined}${appSecret}`, "utf8").digest("hex");
}

export async function kiemTraTiktokShop(): Promise<KetQuaKiemTra> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["tiktokShopAppKey", "tiktokShopAppSecret", "tiktokShopShopId", "tiktokShopAccessToken"] } },
  });
  const theoKey = new Map(rows.map((r) => [r.key, r.value]));
  const appKey = theoKey.get("tiktokShopAppKey") ?? "";
  const appSecret = theoKey.get("tiktokShopAppSecret") ?? "";
  const shopId = theoKey.get("tiktokShopShopId") ?? "";
  const accessToken = theoKey.get("tiktokShopAccessToken") ?? "";

  if (!appKey || !appSecret) {
    return gopKetQua([{ nhan: "Cấu hình", ok: false, chiTiet: "Chưa lưu App Key / App Secret." }]);
  }
  if (!accessToken) {
    return gopKetQua([
      {
        nhan: "Token",
        ok: false,
        chiTiet: "Kho token rỗng — chuỗi gia hạn đã đứt, phải cấp quyền lại (scripts/tiktok-shop-lay-token.ts).",
      },
    ]);
  }

  const qs: Record<string, string> = { app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
  qs.sign = kyChuKy(appSecret, PATH_SHOPS, qs);

  let body: { code?: number; message?: string; data?: { shops?: Array<{ id?: string; name?: string }> } };
  try {
    body = (await (
      await fetch(`${TTS_BASE}${PATH_SHOPS}?${new URLSearchParams(qs)}`, {
        headers: { "x-tts-access-token": accessToken },
        signal: AbortSignal.timeout(KIEM_TRA_TIMEOUT_MS),
      })
    ).json()) as typeof body;
  } catch {
    return gopKetQua([{ nhan: "TikTok Shop", ok: false, chiTiet: "Không gọi được TikTok Shop (mạng hoặc TikTok đang lỗi)." }]);
  }

  if (body.code !== 0) {
    return gopKetQua([
      {
        nhan: "TikTok Shop",
        ok: false,
        chiTiet: `TikTok từ chối (mã ${body.code ?? "?"}): ${body.message ?? "không rõ"} — kiểm tra App Key/App Secret/token.`,
      },
    ]);
  }

  const shops = body.data?.shops ?? [];
  const dong: DongKiemTra[] = [
    { nhan: "Kết nối", ok: true, chiTiet: `Khóa hợp lệ — thấy ${shops.length} shop được cấp quyền.` },
  ];
  if (shopId) {
    const thay = shops.some((s) => String(s.id ?? "") === shopId);
    dong.push(
      thay
        ? { nhan: "Shop ID", ok: true, chiTiet: "Shop ID đã lưu nằm trong danh sách được cấp quyền." }
        : { nhan: "Shop ID", ok: false, chiTiet: "Shop ID đã lưu KHÔNG nằm trong danh sách được cấp quyền — kiểm tra lại." }
    );
  }
  return gopKetQua(dong);
}
