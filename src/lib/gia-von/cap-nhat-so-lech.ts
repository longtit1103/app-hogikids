import { prisma } from "@/lib/prisma";

import { demLechGiaVon } from "./doc-de-xuat-gia-von";
import { KEY_MOC_KIEM_GIA_VON, KEY_SO_LECH_GIA_VON } from "./trang-thai-lech-gia-von";

/**
 * Đếm lại số biến thể lệch giá vốn với Pancake rồi chốt vào 2 ô `Setting` — nguồn số cho dải nhắc
 * việc toàn app.
 *
 * MỘT CHỖ DUY NHẤT vì có BA đường gọi, và ba bản chép tay sẽ lệch nhau lúc nào không hay:
 *  - lượt đêm `POST /api/ingest/resync-products` (sau khi vá tồn — Bronze products tươi nhất);
 *  - nút "Đồng bộ ngay" qua `POST /api/ingest/dem-gia-von` (thêm 07/09: bấm xong mà dải không nhúc
 *    nhích thì chủ shop tưởng nút không ăn);
 *  - ngay sau lượt ghi ở `apGiaVonTheoPancake` (không có bước này thì dải kêu bằng số cũ tới 03:00
 *    hôm sau).
 *
 * NÉM khi hỏng — bên gọi tự quyết nuốt hay không. Lượt đêm nuốt (vá tồn quan trọng hơn), endpoint
 * riêng thì trả lỗi thật.
 *
 * Chỉ ghi 2 ô cấu hình: KHÔNG chạm `Variant`, KHÔNG chạm tiền.
 */
export async function capNhatSoLechGiaVon(): Promise<number> {
  const soLech = await demLechGiaVon("theo-pancake");
  const bayGio = new Date().toISOString();

  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: KEY_SO_LECH_GIA_VON },
      create: { key: KEY_SO_LECH_GIA_VON, value: String(soLech) },
      update: { value: String(soLech) },
    }),
    prisma.setting.upsert({
      where: { key: KEY_MOC_KIEM_GIA_VON },
      create: { key: KEY_MOC_KIEM_GIA_VON, value: bayGio },
      update: { value: bayGio },
    }),
  ]);

  return soLech;
}
