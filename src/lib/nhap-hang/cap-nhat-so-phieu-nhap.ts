import { prisma } from "@/lib/prisma";

import { demPhieuNhapChuaGhi, type SoViecPhieuNhap } from "./dem-phieu-nhap-chua-ghi";
import {
  KEY_MOC_KIEM_PHIEU_NHAP,
  KEY_SO_PHIEU_NHAP_CHUA_GHI,
  KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
} from "./trang-thai-phieu-nhap";

/**
 * Đếm lại việc phiếu nhập còn treo rồi chốt vào 3 ô `Setting` — nguồn số cho dải nhắc việc toàn app.
 * Khuôn y hệt `capNhatSoLechGiaVon`, chỉ khác là có HAI loại việc (chờ duyệt / hậu kiểm).
 *
 * MỘT CHỖ DUY NHẤT vì có hai đường gọi: lượt đêm (`POST /api/ingest/resync-products`, chạy SAU khi
 * stream `purchases` đã land) và ngay sau lượt ghi ở `ghiChiPhiNhapHang` — không có đường thứ hai
 * thì dải vẫn kêu "4 phiếu chờ" bằng số của đêm trước cho tới 03:00 hôm sau, chủ shop vừa duyệt
 * xong vẫn thấy y nguyên và tưởng nút không ăn.
 *
 * NÉM khi hỏng — bên gọi tự quyết nuốt hay không. Chỉ ghi 3 ô cấu hình: KHÔNG chạm tiền.
 */
export async function capNhatSoPhieuNhapChuaGhi(): Promise<SoViecPhieuNhap> {
  const soViec = await demPhieuNhapChuaGhi();
  const bayGio = new Date().toISOString();

  // MỘT transaction cho cả 3 ô: đọc lẻ ra giữa hai lượt ghi thì banner có thể ghép số chờ duyệt của
  // lượt này với số hậu kiểm của lượt trước và nói sai việc.
  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: KEY_SO_PHIEU_NHAP_CHUA_GHI },
      create: { key: KEY_SO_PHIEU_NHAP_CHUA_GHI, value: String(soViec.choDuyet) },
      update: { value: String(soViec.choDuyet) },
    }),
    prisma.setting.upsert({
      where: { key: KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP },
      create: { key: KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP, value: String(soViec.hauKiem) },
      update: { value: String(soViec.hauKiem) },
    }),
    prisma.setting.upsert({
      where: { key: KEY_MOC_KIEM_PHIEU_NHAP },
      create: { key: KEY_MOC_KIEM_PHIEU_NHAP, value: bayGio },
      update: { value: bayGio },
    }),
  ]);

  return soViec;
}
