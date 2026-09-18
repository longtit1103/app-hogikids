import type { SyncKind } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/** Mọi kind đồng bộ có thể sinh SyncLog. Thứ tự này cũng là thứ tự render cảnh báo. */
export const ALL_SYNC_KINDS: SyncKind[] = [
  "PANCAKE",
  "META_ADS",
  "TIKTOK_ADS",
  "TIKTOK_SHOP",
  // Chỉ số marketing TikTok Shop — luồng RIÊNG (workflow 02:30). CỐ Ý **không** nằm ở
  // `NON_DATA_SYNC_KINDS`: analytics hỏng là chỉ số marketing thiếu, đó vẫn là DỮ LIỆU, phải cảnh báo.
  "TIKTOK_SHOP_ANALYTICS",
  "BACKUP",
];

/**
 * Kind ĐỨNG NGOÀI cảnh báo đồng bộ. ĐỪNG "sửa lại cho đồng bộ" bằng cách nhét nó về danh sách
 * dưới — nó nằm đây có chủ đích:
 *
 * BACKUP — một lượt sao lưu hỏng KHÔNG làm thiếu một đồng doanh thu nào (số liệu vẫn đủ, chỉ là
 * thiếu điểm phục hồi). Để nó chung thì một lượt backup lỗi bật banner đỏ TOÀN APP "số liệu có
 * thể thiếu" suốt `ERROR_WINDOW_HOURS` giờ — khẳng định SAI về dữ liệu. Tệ hơn: lượt sau chạy lại
 * THÀNH CÔNG banner vẫn đỏ cho hết cửa sổ, trong khi thẻ "Sao lưu" ở Cài đặt › Dữ liệu (đọc dòng
 * BACKUP MỚI NHẤT) nói "ok" ⇒ hai chỗ trên cùng màn hình đá nhau. Câu cảnh báo chung ở
 * `sync-section.tsx` ("thường do token hết hạn, kiểm credentials trong n8n") cũng sai với backup:
 * nó chạy `pg_dump` trên host, không đi qua n8n, không có token nào.
 *
 * Tín hiệu backup lỗi KHÔNG bị nuốt, nhưng nó có nơi sở hữu RIÊNG chứ không biến mất khỏi màn
 * hình: thẻ "Sao lưu" (`lib/backup/trang-thai-sao-luu.ts` → `DataSection`) đọc dòng BACKUP MỚI
 * NHẤT — lượt gần nhất lỗi thì thẻ đỏ kèm nguyên văn lỗi, quá `GIO_QUA_HAN_SAO_LUU` giờ không có
 * bản mới thì thẻ cảnh báo — và banner toàn app có NHÁNH RIÊNG cho sao lưu (`ShellChrome`,
 * prop `saoLuuCoVanDe`) với chữ không dính dáng gì tới tính đầy đủ của số liệu.
 *
 * ĐỪNG tính bảng nhật ký đồng bộ là lưới an toàn cho ca này: bảng chỉ lấy 10 dòng mới nhất của
 * MỌI kind, mà một đêm sinh hơn 400 dòng (đo prod: 355 PANCAKE + 63 ads) ⇒ dòng BACKUP lỗi trôi
 * khỏi bảng ngay sau lượt đồng bộ đêm kế tiếp, tức chưa tới 24h — ngắn hơn cả `ERROR_WINDOW_HOURS`.
 */
export const NON_DATA_SYNC_KINDS: SyncKind[] = ["BACKUP"];

/**
 * Kind mà một lượt lỗi = một khoảng SỐ LIỆU chưa vào sổ (doanh thu, chi tiêu quảng cáo hoặc
 * "Tiền đã về") ⇒ đáng bật banner đỏ toàn app.
 *
 * Suy ra từ `ALL_SYNC_KINDS` chứ không liệt kê tay: kind mới thêm vào sẽ MẶC ĐỊNH được cảnh báo
 * (fail-loud), muốn đứng ngoài thì phải khai báo hẳn ở `NON_DATA_SYNC_KINDS` kèm lý do.
 */
export const DATA_SYNC_KINDS: SyncKind[] = ALL_SYNC_KINDS.filter(
  (kind) => !NON_DATA_SYNC_KINDS.includes(kind),
);

/** Cửa sổ soi lỗi: nightly chạy 1 lần/ngày nên 48h phủ ít nhất 1 chu kỳ + biên. */
export const ERROR_WINDOW_HOURS = 48;

/**
 * Kind ẢNH HƯỞNG SỐ LIỆU nào có BẤT KỲ log ERROR nào trong `ERROR_WINDOW_HOURS` gần đây → cảnh báo đỏ.
 *
 * Luật cũ ("2 log gần nhất của kind đều ERROR") KHÔNG BAO GIỜ bật: mỗi lần chạy một
 * kind đẻ NHIỀU SyncLog (mỗi trang/POST một dòng). Khi chỉ trang cuối lỗi mà các trang
 * trước OK, 2 dòng mới nhất = [ERROR, OK] ⇒ không đủ 2 ERROR liên tiếp ⇒ UI sơn xanh
 * trong khi hệ đang mất dữ liệu. Đổi sang "có bất kỳ ERROR nào gần đây" — hợp triết lý
 * fail-loud: một POST lỗi = một khoảng dữ liệu chưa vào sổ.
 *
 * Dùng ở CẢ trang Cài đặt (chi tiết theo kind) LẪN layout toàn app (banner sticky) —
 * để chủ shop không đọc nhầm số P&L khi đồng bộ đang hỏng ở bất kỳ màn nào. Cố ý KHÔNG trả
 * `NON_DATA_SYNC_KINDS` (xem lý do ở hằng đó): cảnh báo của chúng có nơi sở hữu riêng.
 */
export async function getRecentDataErrorKinds(): Promise<SyncKind[]> {
  const since = new Date(Date.now() - ERROR_WINDOW_HOURS * 60 * 60 * 1000);
  const rows = await prisma.syncLog.findMany({
    where: { status: "ERROR", startedAt: { gte: since }, kind: { in: DATA_SYNC_KINDS } },
    distinct: ["kind"],
    select: { kind: true },
  });
  const found = new Set(rows.map((r) => r.kind));
  return DATA_SYNC_KINDS.filter((k) => found.has(k));
}
