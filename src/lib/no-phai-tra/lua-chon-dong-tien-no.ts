import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docDuNoCacThe } from "@/lib/no-phai-tra/du-no-the";
import { docPhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { theChoOChon } from "@/lib/no-phai-tra/the-da-dong-con-no";
import { prisma } from "@/lib/prisma";

/**
 * Dữ liệu cho form "Nhập quỹ / rút quỹ" khi đã bật theo dõi nợ phải trả: mốc M (ô ngày chặn trước M) +
 * hồ sơ chọn được cho 4 loại nợ (`CARD_PAY` ⇒ thẻ, `SUPPLIER_*` ⇒ phiếu, `ADS_TOPUP` ⇒ ví). Chưa bật ⇒
 * `null` — form KHÔNG liệt kê loại nợ nào (action cũng từ chối `CHUA_BAT_NO_PHAI_TRA`).
 *
 * Server component (tab Dòng tiền) đọc rồi truyền xuống prop `noPhaiTra` của khối ghi tay; client chỉ
 * `import type`. Lọc theo luật server (thẻ đóng, phiếu huỷ) làm ở form — dòng đang sửa luôn giữ lại.
 */

/**
 * `dong` = thẻ KHÔNG nhận dòng mới nào (form ẩn đi, trừ dòng đang sửa). Thẻ đã đóng mà còn nợ ước tính > 0
 * (ads về muộn gán thẻ đóng) thì `dong = false`, `chiTraThe = true` + nhãn nói rõ — form chỉ liệt kê nó cho
 * `CARD_PAY`; server chỉ nhận `CARD_PAY` vào thẻ đó (`xetTraVaoTheDaDong`), loại khác từ chối với lý do cụ thể.
 */
export type TheChon = { id: string; ten: string; dong: boolean; chiTraThe?: boolean };
export type PhieuChon = { id: string; maPhieu: string; conNo: number; daHuy: boolean };
export type ViChon = { id: string; nenTang: string };

export type LuaChonDongTienNo = { mocM: Date; the: TheChon[]; phieu: PhieuChon[]; vi: ViChon[] };

export async function docLuaChonDongTienNo(): Promise<LuaChonDongTienNo | null> {
  const mocM = await docMocM();
  if (mocM === null) return null;
  const [the, phieu, vi] = await Promise.all([
    prisma.theTinDung.findMany({ select: { id: true, ten: true, closedAt: true }, orderBy: { createdAt: "asc" } }),
    docPhieuConNo(),
    prisma.viAdsTraTruoc.findMany({ select: { id: true, nenTang: true }, orderBy: { nenTang: "asc" } }),
  ]);
  // Dư nợ chỉ cần cho thẻ ĐÃ ĐÓNG (thẻ mở luôn chọn được) — không có thẻ đóng thì khỏi đọc giao dịch thẻ.
  const duNoTheDong = the.some((t) => t.closedAt !== null)
    ? new Map((await docDuNoCacThe(new Date())).map((d) => [d.cardId, d.duNo] as const))
    : new Map<string, number | null>();
  return {
    mocM,
    the: the.map((t) => theChoOChon(t, duNoTheDong.get(t.id) ?? null)),
    phieu: phieu.map((p) => ({ id: p.id, maPhieu: p.maPhieu, conNo: p.conNo, daHuy: p.daHuy })),
    vi,
  };
}
