import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docPhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { prisma } from "@/lib/prisma";

/**
 * Dữ liệu cho form "Nhập quỹ / rút quỹ" khi đã bật theo dõi nợ phải trả: mốc M (ô ngày chặn trước M) +
 * hồ sơ chọn được cho 4 loại nợ (`CARD_PAY` ⇒ thẻ, `SUPPLIER_*` ⇒ phiếu, `ADS_TOPUP` ⇒ ví). Chưa bật ⇒
 * `null` — form KHÔNG liệt kê loại nợ nào (action cũng từ chối `CHUA_BAT_NO_PHAI_TRA`).
 *
 * Server component (tab Dòng tiền) đọc rồi truyền xuống prop `noPhaiTra` của khối ghi tay; client chỉ
 * `import type`. Lọc theo luật server (thẻ đóng, phiếu huỷ) làm ở form — dòng đang sửa luôn giữ lại.
 */

export type TheChon = { id: string; ten: string; dong: boolean };
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
  return {
    mocM,
    the: the.map((t) => ({ id: t.id, ten: t.ten, dong: t.closedAt !== null })),
    phieu: phieu.map((p) => ({ id: p.id, maPhieu: p.maPhieu, conNo: p.conNo, daHuy: p.daHuy })),
    vi,
  };
}
