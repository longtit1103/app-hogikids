import { Prisma } from "@/generated/prisma/client";

import {
  TRAN_DONG_XUAT_DON_HANG,
  type BoLocDonHang,
  type KetQuaXuatDonHang,
} from "@/lib/orders/don-hang-kieu-du-lieu";
import { prisma } from "@/lib/prisma";

import type { QuyenGiaVon } from "./che-gia-von-types";
import { dongCheTuHang, dongDayTuHang, soNguyenAnToan, type HangDon } from "./orders-lai-tung-don-doi-dong";
import { chonDongDon, kepBoLocTheoQuyen } from "./orders-lai-tung-don-sql";

/**
 * Dữ liệu file Excel đơn hàng: ĐÚNG tập lọc + thứ tự của danh sách, không phân trang. Lấy `TRAN + 1` dòng
 * để biết có vượt trần mà không phải đếm riêng; vượt ⇒ `vuotTran: true` và chỉ trả `TRAN` dòng (route từ
 * chối xuất). Nhánh đủ quyền kèm `giaVon` = giá vốn đơn (cùng cột `cogs` của CTE dùng chung).
 */
export async function getDonHangXuat(boLocVao: BoLocDonHang, quyen: QuyenGiaVon, now: Date): Promise<KetQuaXuatDonHang> {
  const boLoc = kepBoLocTheoQuyen(boLocVao, quyen);
  const hangs = await prisma.$queryRaw<HangDon[]>(
    chonDongDon(boLoc, quyen, now, Prisma.sql`LIMIT ${TRAN_DONG_XUAT_DON_HANG + 1}`),
  );
  const vuotTran = hangs.length > TRAN_DONG_XUAT_DON_HANG;
  const trongTran = vuotTran ? hangs.slice(0, TRAN_DONG_XUAT_DON_HANG) : hangs;

  if (quyen.coQuyenGiaVon) {
    return {
      coQuyenGiaVon: true,
      vuotTran,
      rows: trongTran.map((h) => ({ ...dongDayTuHang(h), giaVon: soNguyenAnToan(h.cogs, "cogs") })),
    };
  }
  return { coQuyenGiaVon: false, vuotTran, rows: trongTran.map(dongCheTuHang) };
}
