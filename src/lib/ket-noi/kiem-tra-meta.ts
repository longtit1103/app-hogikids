import { prisma } from "@/lib/prisma";
import { KEY_META_ACCESS_TOKEN } from "@/lib/tokens/luu-token-meta";

import { gopKetQua, KIEM_TRA_TIMEOUT_MS, type DongKiemTra, type KetQuaKiemTra } from "./kiem-tra-types";

/**
 * Probe Meta Ads: `debug_token` — hỏi Facebook token trong kho còn sống không + hạn THẬT
 * của CẢ HAI mốc (token ~60 ngày và data access ~90 ngày; cái ngắn hơn mới là cái giết ta).
 * Cần đủ bộ ba App ID + App Secret + token trong kho.
 */

const META_GRAPH_VERSION = "v25.0";

function ngayVn(epochGiay: number): string {
  return new Date(epochGiay * 1000).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

function dongHan(nhan: string, epochGiay: number): DongKiemTra {
  if (!epochGiay) return { nhan, ok: true, chiTiet: "Không hết hạn." };
  const conNgay = Math.floor((epochGiay * 1000 - Date.now()) / 86_400_000);
  return {
    nhan,
    ok: conNgay > 0,
    chiTiet: conNgay > 0 ? `Còn ${conNgay} ngày (đến ${ngayVn(epochGiay)}).` : `ĐÃ HẾT HẠN từ ${ngayVn(epochGiay)}.`,
  };
}

export async function kiemTraMeta(): Promise<KetQuaKiemTra> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["metaAdsAppId", "metaAdsAppSecret", KEY_META_ACCESS_TOKEN] } },
  });
  const theoKey = new Map(rows.map((r) => [r.key, r.value]));
  const appId = theoKey.get("metaAdsAppId") ?? "";
  const appSecret = theoKey.get("metaAdsAppSecret") ?? "";
  const token = theoKey.get(KEY_META_ACCESS_TOKEN) ?? "";

  if (!appId || !appSecret) {
    return gopKetQua([{ nhan: "Cấu hình", ok: false, chiTiet: "Chưa lưu App ID / App Secret — điền và lưu ở trên trước." }]);
  }
  if (!token) {
    return gopKetQua([
      { nhan: "Token", ok: false, chiTiet: "Kho chưa có token — dán token tươi ở khối “Thay token” bên dưới." },
    ]);
  }

  let dbg: { data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] }; error?: { message?: string } };
  try {
    dbg = (await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`,
        { signal: AbortSignal.timeout(KIEM_TRA_TIMEOUT_MS) }
      )
    ).json()) as typeof dbg;
  } catch {
    return gopKetQua([{ nhan: "Facebook", ok: false, chiTiet: "Không gọi được Facebook (mạng hoặc Facebook đang lỗi)." }]);
  }

  if (dbg.error || !dbg.data) {
    // Message của Meta mô tả nguyên nhân, không nhại lại input — an toàn để hiện.
    return gopKetQua([
      { nhan: "Facebook", ok: false, chiTiet: `Facebook từ chối: ${dbg.error?.message ?? "không rõ"} — kiểm tra App ID/App Secret.` },
    ]);
  }

  const d = dbg.data;
  const dong: DongKiemTra[] = [
    d.is_valid
      ? { nhan: "Token", ok: true, chiTiet: `Còn sống, ${(d.scopes ?? []).length} quyền.` }
      : { nhan: "Token", ok: false, chiTiet: "Token KHÔNG còn hiệu lực — lấy token tươi rồi dùng khối “Thay token”." },
    dongHan("Hạn token", Number(d.expires_at ?? 0)),
    dongHan("Hạn quyền đọc dữ liệu", Number(d.data_access_expires_at ?? 0)),
  ];
  return gopKetQua(dong);
}
