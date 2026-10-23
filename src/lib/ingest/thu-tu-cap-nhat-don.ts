import { parseVnDate } from "./pancake-mapping";

/**
 * So mốc `updated_at` (Pancake) của bản đơn SẮP ghi với bản Silver ĐANG giữ.
 *
 * Vì sao cần, ngoài số phiên bản `rawFetchedAt` (mốc LAND): bản thắng ở Silver vốn chọn theo lúc
 * land, nên một trang API CHỤP TRƯỚC một sự kiện webhook mà POST SAU (n8n phân trang, "Đồng bộ
 * ngay") vẫn land muộn hơn ⇒ Silver lùi về nội dung cũ (vd RETURNED → COMPLETED, đơn quay lại
 * doanh thu) cho tới lượt API kế tiếp phủ đơn đó. `updated_at` là mốc NỘI DUNG phía Pancake nên
 * chặn đúng ca này.
 *
 * So bằng `parseVnDate`, KHÔNG so chuỗi: naive datetime Pancake là giờ UTC (bất biến #3) và
 * separator `T`/khoảng trắng, phần lẻ giây có thể khác nhau giữa API và webhook. Độ phân giải là
 * mili-giây (phần micro-giây bị cắt) — hai bản lệch dưới 1ms coi là BẰNG, rơi về luật mốc land.
 *
 * - `MOI_HON` / `CU_HON`: so được và khác nhau.
 * - `BANG`: cùng mốc — KHÔNG đủ để quyết (Pancake có sửa phí lúc đối soát mà GIỮ NGUYÊN
 *   `updated_at`, đo 2026-07-27), người gọi phải dùng luật mốc land cũ.
 * - `KHONG_SO_DUOC`: thiếu hoặc sai định dạng ở một trong hai bên ⇒ giữ hành vi cũ.
 */
export type ThuTuCapNhat = "MOI_HON" | "CU_HON" | "BANG" | "KHONG_SO_DUOC";

/** Rút `updated_at` từ payload đơn (đã qua Prisma Json) — chỉ nhận chuỗi không rỗng. */
export function updatedAtCuaPayload(raw: unknown): string | null {
  const v = (raw as { updated_at?: unknown } | null)?.updated_at;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Mốc CÓ MẶT nhưng không đọc được (Pancake đổi khuôn ngày giờ) — đáng nói ra để guard không tắt
 * âm thầm. Vắng hẳn (bản cũ lưu `raw` rỗng, fixture tối giản) thì KHÔNG kêu: đó là dữ liệu không
 * mang mốc, giữ hành vi cũ là đúng ý, kêu ở đó chỉ sinh nhiễu.
 */
export function mocCapNhatHong(updatedAt: string | null): boolean {
  return updatedAt !== null && Number.isNaN(parseVnDate(updatedAt).getTime());
}

export function soThuTuCapNhatDon(updatedAtMoi: string | null, updatedAtDangCo: string | null): ThuTuCapNhat {
  if (updatedAtMoi === null || updatedAtDangCo === null) return "KHONG_SO_DUOC";
  const tMoi = parseVnDate(updatedAtMoi).getTime();
  const tCu = parseVnDate(updatedAtDangCo).getTime();
  if (Number.isNaN(tMoi) || Number.isNaN(tCu)) return "KHONG_SO_DUOC";
  if (tMoi > tCu) return "MOI_HON";
  if (tMoi < tCu) return "CU_HON";
  return "BANG";
}
