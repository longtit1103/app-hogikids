import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { capNhatSoLechGiaVon } from "@/lib/gia-von/cap-nhat-so-lech";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { withSyncLog } from "@/lib/ingest/sync-log";
import { MODE_BUOC_CUOI_DONG_BO_NGAY } from "@/lib/ingest/tien-do-dong-bo-ngay";
import {
  cauLoiKeo,
  docTomTatLoiKeo,
  type TomTatLoiKeo,
} from "@/lib/ingest/tom-tat-loi-keo-dong-bo-ngay";
import { capNhatSoPhieuNhapChuaGhi } from "@/lib/nhap-hang/cap-nhat-so-phieu-nhap";

/**
 * POST /api/ingest/dem-gia-von — bước ĐẾM NHẮC VIỆC cuối lượt "Đồng bộ ngay": đếm lại (1) số biến
 * thể lệch giá vốn với Pancake và (2) số phiếu nhập Pancake chưa vào Sổ chi phí, chốt vào `Setting`.
 *
 * VÌ SAO TÁCH RIÊNG khỏi `resync-products` (thêm 2026-09-07, ngay sau khi tính năng lên prod):
 * bước đếm đang nằm ở CUỐI lượt đêm, còn nút "Đồng bộ ngay" chạy workflow khác (`pancake-sync-now`,
 * chỉ kéo luồng nhẹ rồi dừng). Hệ quả: chủ shop nhập hàng xong bấm "Đồng bộ ngay", giá vốn mới ĐÃ
 * về app nhưng dải nhắc việc vẫn im tới 03:00 hôm sau — bấm mà không thấy gì nhúc nhích thì tưởng
 * nút không ăn. Đúng loại "hỏng lặng" mà cả tính năng này sinh ra để chống.
 *
 * PHIẾU NHẬP (thêm 2026-10-07): `pancake-sync-now` nay kéo cả stream `purchases` shop kho, nên phép
 * đếm phiếu nhập chưa ghi (trước chỉ chạy trong `resync-products` lượt đêm) cũng phải chạy ở đây —
 * phiếu mới đã land Bronze mà dải "N phiếu nhập chờ ghi" vẫn đứng số đêm trước là cùng loại hỏng lặng.
 * GIỮ TÊN route `dem-gia-von` (không đổi đường dẫn) để thứ tự triển khai app ↔ workflow không quan
 * trọng: workflow bản cũ gọi đúng route này nên app mới lên trước là phiếu nhập đã được đếm ngay.
 *
 * KHÔNG gọi thẳng `resync-products` từ workflow đó: endpoint kia còn dựng lại TOÀN BỘ tồn kho và có
 * chốt chặn riêng ("lượt kéo products shop kho phải còn sống trong 2 giờ") — kéo nguyên khối đó vào
 * một nút bấm tay là đổi hẳn ý nghĩa của nút, và thêm một đường ghi tồn không ai yêu cầu.
 *
 * Endpoint này CHỈ ĐỌC Bronze + Sổ chi phí và ghi 5 ô cấu hình. KHÔNG chạm `Variant`, KHÔNG ghi
 * `Expense` (ghi chi phí nhập hàng chỉ đi qua lượt duyệt tay `ghiChiPhiNhapHang`), KHÔNG chạm tiền.
 * Cả hai phép đếm là TÍNH LẠI từ đầu rồi ghi đè ô (không cộng dồn) ⇒ bấm nhiều lần không đếm đôi.
 * KHÔNG khoá: đọc (Bronze + Sổ chi phí) rồi mới ghi, nên hai lượt CHỒNG nhau (vd chủ shop vừa duyệt
 * một phiếu đúng lúc lượt này đang đếm) có thể để lượt ghi sau đè số cũ hơn ⇒ dải nhắc việc báo lệch
 * TẠM tới lượt đếm kế tiếp. Không ghi sai tiền: màn duyệt tính trực tiếp từ Bronze + Sổ mỗi lần mở.
 *
 * Dòng SyncLog của route này là MỐC KẾT THÚC lượt "Đồng bộ ngay" mà nút bấm chờ — gắn
 * `stats.mode` ngay từ lúc RUNNING và giữ cả khi ERROR (`dauNhanDien`), xem `tien-do-dong-bo-ngay.ts`.
 *
 * Lỗi thì trả lỗi THẬT (khác lượt đêm — bên đó nuốt vì vá tồn quan trọng hơn): ở đây đếm là việc
 * DUY NHẤT, nuốt lỗi thì endpoint thành cái vỏ luôn báo thành công. Hai phép đếm ĐỘC LẬP: một cái
 * hỏng KHÔNG được chặn cái kia chốt số — chạy đủ cả hai rồi mới ném.
 *
 * LỖI KÉO PANCAKE (body `{ soLoiKeo, loiKeo }`, thêm 2026-10-07 — `tom-tat-loi-keo-dong-bo-ngay.ts`):
 * lỗi phía Pancake không để lại dòng SyncLog nào, nên workflow gửi tóm tắt kèm lời gọi này. Có lỗi
 * kéo ⇒ vẫn đếm + chốt ô như thường, rồi trả `loiSauKhiGhi` ⇒ dòng bước cuối ERROR, HTTP 200 (n8n
 * đã tự đánh đỏ lượt của nó, trả 500 chỉ nhân đôi lỗi) ⇒ nút "Đồng bộ ngay" báo lỗi nêu stream/shop
 * thay vì "Đồng bộ xong". Body cũ `{}`/không body ⇒ như trước; body hỏng ⇒ bỏ qua + cảnh báo, KHÔNG
 * ảnh hưởng phép đếm.
 */
export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  // Đọc body TRƯỚC `withSyncLog` (stream chỉ đọc được một lần). Đọc hỏng = không có tóm tắt.
  const bodyTho = await req.text().catch(() => "");
  const tomTat = docTomTatLoiKeo(bodyTho);

  return withSyncLog("PANCAKE", (warnings) => demNhacViec(tomTat, warnings), {
    dauNhanDien: { mode: MODE_BUOC_CUOI_DONG_BO_NGAY },
  });
}

/** Hai phép đếm nhắc việc + gắn lỗi kéo — xem doc-comment của `POST` về luật lỗi. */
async function demNhacViec(tomTat: TomTatLoiKeo, warnings: string[]): Promise<Record<string, unknown>> {
  if (tomTat.canhBao) warnings.push(tomTat.canhBao);
  const loiKeo = cauLoiKeo(tomTat);
  const loi: string[] = [];
  const thongDiep = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let soLech: number | null = null;
  try {
    soLech = await capNhatSoLechGiaVon();
  } catch (e) {
    loi.push(`Đếm lệch giá vốn hỏng: ${thongDiep(e)}`);
  }

  let phieuNhap: Awaited<ReturnType<typeof capNhatSoPhieuNhapChuaGhi>> | null = null;
  try {
    phieuNhap = await capNhatSoPhieuNhapChuaGhi();
  } catch (e) {
    loi.push(`Đếm phiếu nhập chưa ghi hỏng: ${thongDiep(e)}`);
  }

  // Đếm hỏng ⇒ 500 như cũ; câu lỗi kèm luôn lỗi kéo (nếu có) để không mất tín hiệu nào.
  if (loi.length) throw new Error([...loi, ...(loiKeo ? [loiKeo] : [])].join(" · "));

  return {
    mode: MODE_BUOC_CUOI_DONG_BO_NGAY,
    soLechGiaVon: soLech,
    /** Số phiếu nhập Pancake chưa vào Sổ chi phí (chờ duyệt). */
    soPhieuNhapChuaGhi: phieuNhap?.choDuyet ?? null,
    /** Số phiếu ĐÃ ghi nay bị huỷ/đổi tiền/trạng thái lạ + phiếu trạng thái lạ chưa ghi. */
    soViecHauKiemPhieuNhap: phieuNhap?.hauKiem ?? null,
    /** Lỗi kéo Pancake workflow báo kèm (0 = sạch / workflow bản cũ). */
    soLoiKeo: tomTat.soLoiKeo,
    ...(tomTat.loiKeo.length ? { loiKeo: tomTat.loiKeo } : {}),
    // Có lỗi kéo ⇒ dòng ERROR mà HTTP vẫn 200 (khuôn `loiSauKhiGhi` của `withSyncLog`).
    ...(loiKeo ? { loiSauKhiGhi: loiKeo } : {}),
  };
}
