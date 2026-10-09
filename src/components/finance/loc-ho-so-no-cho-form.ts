import type { CashMovementKindGhiTay } from "@/lib/cash-movements/cash-movement-kinds";
import { formatVnd } from "@/lib/format";
import type { LuaChonDongTienNo } from "@/lib/no-phai-tra/lua-chon-dong-tien-no";

import type { LuaChonHoSo } from "./ho-so-no-select";

/**
 * Hồ sơ nợ chọn được cho form "Nhập quỹ / rút quỹ" — CÙNG luật với server (`kiemHoSoNo` ở
 * `ho-so-dong-tien-no.ts`) để chủ shop không chọn xong mới bị từ chối:
 *  - thẻ ĐÃ ĐÓNG không nhận dòng nào (trả thẻ, nạp ví bằng thẻ);
 *  - `SUPPLIER_PAY` không trả vào phiếu ĐÃ HUỶ; `SUPPLIER_REFUND` thì được (cách thu hồi tiền).
 * Hồ sơ của chính dòng đang sửa LUÔN giữ lại — không thì mở form Sửa mà ô chọn trống trơn.
 * Thuần (không React) để test được không cần render.
 */

export type DongDangSuaNo = {
  kind: string;
  cardId: string | null;
  phieuNhapId: string | null;
} | null;

export function locTheChoForm(no: LuaChonDongTienNo, dangSua: DongDangSuaNo): LuaChonHoSo[] {
  return no.the
    .filter((t) => !t.dong || t.id === dangSua?.cardId)
    .map((t) => ({ id: t.id, nhan: t.dong ? `${t.ten} (đã đóng)` : t.ten }));
}

export function locPhieuChoForm(
  no: LuaChonDongTienNo,
  kind: CashMovementKindGhiTay | "",
  dangSua: DongDangSuaNo,
): LuaChonHoSo[] {
  const vonLaTraPhieu = (id: string) => dangSua?.kind === "SUPPLIER_PAY" && dangSua.phieuNhapId === id;
  return no.phieu
    .filter((p) => kind !== "SUPPLIER_PAY" || !p.daHuy || vonLaTraPhieu(p.id))
    .map((p) => {
      if (p.daHuy) return { id: p.id, nhan: `${p.maPhieu} — đã huỷ, cần thu hồi ${formatVnd(Math.max(0, -p.conNo))}` };
      if (p.conNo < 0) return { id: p.id, nhan: `${p.maPhieu} — trả thừa ${formatVnd(-p.conNo)}` };
      return { id: p.id, nhan: `${p.maPhieu} — còn nợ ${formatVnd(p.conNo)}` };
    });
}

export function locViChoForm(no: LuaChonDongTienNo): LuaChonHoSo[] {
  return no.vi.map((v) => ({ id: v.id, nhan: v.nenTang === "SHOPEE_ADS" ? "Ví Shopee Ads" : v.nenTang }));
}
