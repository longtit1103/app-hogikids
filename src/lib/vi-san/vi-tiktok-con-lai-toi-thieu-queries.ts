import { epochToDate } from "@/lib/ingest/tiktok-settlement-mapping";
import { prisma } from "@/lib/prisma";
import { ngayMoSoTrongRequest } from "@/lib/so-quy/so-quy-queries";
import {
  tinhViTiktokConLaiToiThieu,
  type ViTiktokConLaiToiThieu,
} from "@/lib/vi-san/vi-tiktok-con-lai-toi-thieu";

/**
 * Trạng thái statement DUY NHẤT được coi là tiền ĐÃ VÀO ví: sàn đã chốt kỳ và ghi có số dư. Statement
 * mang trạng thái khác chưa làm ví đổi đồng nào — cộng vào là ví "có" tiền chưa về (dương) hoặc bị
 * trừ khoản chưa trừ (âm; ~90% statement prod là net âm vì ads trừ ví), và nhãn "≈ tối thiểu" hết
 * đúng. So chính xác chuỗi sàn trả (`payment_status`, in hoa). Prod 25/09: 1632/1632 statement SETTLED.
 *
 * Cái giá phải biết: n8n chỉ kéo lại statement trong cửa sổ 7 ngày theo `statement_time`. Một statement
 * lúc kéo còn trạng thái khác rồi mới SETTLED sau 7 ngày sẽ KẸT trạng thái cũ và bị bỏ khỏi ô này tới
 * khi kéo lại rộng hơn (key `tiktokShopManualDays` ở bảng Setting — xem `n8n/tiktokshop-nightly.json`).
 * Bỏ một khoản vào DƯƠNG chỉ làm số hiển thị THẤP đi — vẫn là cận dưới.
 */
const STATEMENT_DA_VAO_VI = "SETTLED";

/**
 * Đọc đủ hai chuỗi sự kiện ví TikTok rồi giao cho hàm thuần. CHỈ ĐỌC, CHỈ để hiển thị: kết quả
 * không được đi vào `tinhSoQuyThang` / dự báo quỹ / Excel Sổ quỹ (xem đầu file hàm thuần).
 *
 * Toàn lịch sử, không lọc kỳ: đáy chuỗi (⇒ B0 cận dưới) phụ thuộc MỌI sự kiện từ statement đầu tiên.
 * Đọc thẳng từng dòng (3 cột) thay vì gộp dưới SQL: prod 25/09 có ~1,6 nghìn statement (tăng ~7/ngày
 * ≈ 2,5 nghìn/năm) + vài chục lệnh rút — vài chục KB, một lượt quét bảng nhỏ. Hàm thuần đã GỘP các
 * khoản cùng (thời điểm, chiều) nên kết quả không phụ thuộc số dòng trả về; chỉ đáng đẩy phần gộp
 * xuống SQL khi bảng statement cỡ hàng chục nghìn dòng hoặc lượt đọc này hiện rõ trong thời gian trang.
 *
 * Mọi `TiktokPayment` ≠ FAILED đều là tiền rời ví — chủ shop xác nhận 25/09 cả hai tài khoản nhận
 * (`****4017`, `****4025`) đều thuộc quỹ, nên KHÔNG lọc theo tài khoản.
 */
export async function docViTiktokConLaiToiThieu(): Promise<ViTiktokConLaiToiThieu | null> {
  const [statement, lenhRut, d0] = await Promise.all([
    prisma.tiktokSettlement.findMany({
      where: { paymentStatus: STATEMENT_DA_VAO_VI },
      select: { statementTime: true, paymentTime: true, settlementAmount: true },
    }),
    prisma.tiktokPayment.findMany({
      where: { status: { not: "FAILED" } },
      select: { status: true, settlementValue: true, paidTime: true, syncedAt: true, raw: true },
    }),
    // Bản nhớ theo request: thẻ Quỹ ngay bên cạnh đọc đúng D0 này trong cùng lượt render.
    ngayMoSoTrongRequest(),
  ]);

  return tinhViTiktokConLaiToiThieu(
    // Tiền vào ví lúc sàn ghi có (`paymentTime`); thiếu thì lùi về ngày sao kê.
    statement.map((s) => ({ thoiDiem: s.paymentTime ?? s.statementTime, soTien: s.settlementAmount })),
    lenhRut.map((p) => ({
      thoiDiem: thoiDiemTaoLenh(p.raw) ?? p.paidTime ?? p.syncedAt,
      soTien: p.settlementValue,
      trangThai: p.status,
    })),
    d0
  );
}

/**
 * Tiền rời ví lúc TẠO lệnh rút (`create_time` trong payload gốc — Silver không có cột riêng), không
 * phải lúc bank báo đã trả: lệnh đang chờ trả vẫn đã trừ số dư khả dụng. Thiếu ⇒ `paidTime`, rồi tới
 * lúc app biết lệnh (`syncedAt`) — vẫn trừ, chỉ lệch vị trí trong chuỗi.
 */
function thoiDiemTaoLenh(raw: unknown): Date | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return epochToDate((raw as Record<string, unknown>).create_time);
}
