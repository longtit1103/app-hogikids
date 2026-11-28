import type { OrderStatus } from "@/generated/prisma/client";

import { PANCAKE_STATUS_MAP, parseVnDate } from "@/lib/ingest/pancake-mapping";
import type { MocTrangThaiDon, ThongTinPhuDon } from "@/lib/orders/don-hang-kieu-du-lieu";

/**
 * Đọc dòng thời gian trạng thái của một đơn từ `Order.raw.status_history` (Pancake). CHỈ chạy ở server
 * (kéo `pancake-mapping`); drawer client chỉ nhận kết quả.
 *
 * Quy tắc:
 *  - Mã trạng thái đi qua `PANCAKE_STATUS_MAP` (bảng ingest dùng) — mã lạ BỎ mục, không đoán thành Hủy.
 *  - `updated_at` là giờ naive của Pancake = UTC ⇒ `parseVnDate`; ngày hỏng BỎ mục.
 *  - Sắp tăng theo thời điểm; mục liền nhau cùng trạng thái app gộp thành một mốc, giữ mốc SỚM nhất
 *    (đơn đã xác nhận rồi chờ giao vẫn là "Chờ xử lý" kể từ lúc tạo).
 *  - Tối đa `TOI_DA_MOC` mốc, giữ các mốc CUỐI (gần hiện tại nhất).
 *  - Kết quả chỉ mang `status` + `luc` + `hienTai`: không tên người sửa, ghi chú hay trường PII nào khác
 *    của `raw` được đọc hay trả ra.
 *
 * Không bao giờ ném: `raw` thiếu/sai dạng ⇒ `{ dongThoiGian: [] }` (drawer ẩn khối).
 */
const TOI_DA_MOC = 20;

const RONG: ThongTinPhuDon = { dongThoiGian: [] };

function laObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Một mục lịch sử hợp lệ → mốc thô; mục hỏng → null. */
function docMuc(muc: unknown): { status: OrderStatus; luc: Date } | null {
  if (!laObject(muc)) return null;
  const { status, updated_at: capNhat } = muc;
  if (typeof status !== "number" && typeof status !== "string") return null;
  const ma = String(status);
  // `hasOwn`: mã như "__proto__"/"constructor" không được lọt qua nguyên mẫu của object.
  if (!Object.hasOwn(PANCAKE_STATUS_MAP, ma)) return null;
  if (typeof capNhat !== "string") return null;
  const luc = parseVnDate(capNhat);
  if (Number.isNaN(luc.getTime())) return null;
  return { status: PANCAKE_STATUS_MAP[ma], luc };
}

export function docThongTinPhuDon(raw: unknown, trangThaiHienTai: OrderStatus): ThongTinPhuDon {
  try {
    if (!laObject(raw)) return RONG;
    const lichSu = raw.status_history;
    if (!Array.isArray(lichSu)) return RONG;

    const moc = lichSu
      .map(docMuc)
      .filter((m): m is { status: OrderStatus; luc: Date } => m !== null)
      .sort((a, b) => a.luc.getTime() - b.luc.getTime());

    const gop: { status: OrderStatus; luc: Date }[] = [];
    for (const m of moc) {
      if (gop.at(-1)?.status !== m.status) gop.push(m);
    }

    const cuoi = gop.slice(-TOI_DA_MOC);
    const dongThoiGian: MocTrangThaiDon[] = cuoi.map((m, i) => ({
      status: m.status,
      luc: m.luc,
      hienTai: i === cuoi.length - 1 && m.status === trangThaiHienTai,
    }));
    return { dongThoiGian };
  } catch {
    // Phòng thủ: dữ liệu phụ không bao giờ được làm hỏng drawer.
    return RONG;
  }
}
