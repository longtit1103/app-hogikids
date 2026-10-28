import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * DÒNG NHẬN GỐC DO LƯỢT TẤT TOÁN SINH — thuần (không Prisma), dùng chung cho `tatToanSoTietKiem` (đặt mô tả),
 * `moLaiSoTietKiem` (chặn sổ tất toán trước khi có cột `SoTietKiem.dongNhanGocTatToanId`) và script gán dấu
 * `scripts/danh-dau-dong-nhan-goc-tat-toan.ts`.
 *
 * Nguồn sự thật để XOÁ là id lưu trên sổ, KHÔNG BAO GIỜ là mô tả hay số lượng dòng: chủ shop gõ được mô
 * tả bất kỳ, còn đếm dòng từng xoá nhầm dòng nhận gốc ghi tay. Mô tả chỉ dùng theo chiều AN TOÀN: (a) từ
 * chối mở lại sổ cũ còn dòng mang mẫu app sinh; (b) đề xuất ứng viên cho chủ shop duyệt trước khi gán.
 */

/** Câu từ chối mở lại sổ tất toán bởi bản cũ chưa gán dấu dòng nhận gốc. */
export const LOI_SO_TAT_TOAN_TRUOC_BAN_VA =
  "Sổ này tất toán trước bản vá — chủ shop chạy script gán dấu dòng nhận gốc rồi mở lại";

/** "dd/MM/yyyy" theo ngày VN — không phụ thuộc TZ tiến trình (script chạy được cả ngoài container). */
function ngayVnDdMmYyyy(ngay: Date): string {
  const [y, m, d] = khoaNgayVn(ngay).split("-");
  return `${d}/${m}/${y}`;
}

/** Mô tả dòng `SAVINGS_IN` mà lượt tất toán ghi. Đổi khuôn này là sổ cũ không còn được nhận diện. */
export function moTaNhanGocTatToan(tenSo: string, ngayTatToan: Date): string {
  return `Nhận lại gốc tiết kiệm ${tenSo} — tất toán ${ngayVnDdMmYyyy(ngayTatToan)}`;
}

/**
 * Mẫu RỘNG (mọi tên sổ, mọi ngày) — chỉ để TỪ CHỐI mở lại sổ cũ. Rộng là cố ý: khớp thừa chỉ làm chủ shop
 * phải chạy script, khớp thiếu là xoá mất một dòng tiền.
 */
const MAU_MO_TA_NHAN_GOC = /^Nhận lại gốc tiết kiệm .* — tất toán \d{2}\/\d{2}\/\d{4}$/;

export function laMoTaMauNhanGocTatToan(moTa: string): boolean {
  return MAU_MO_TA_NHAN_GOC.test(moTa);
}

export type DongTienSo = {
  id: string;
  kind: string;
  amount: number;
  date: Date;
  description: string;
};

export type KetQuaChonDongDiSan = { ok: true; id: string } | { ok: false; lyDo: string };

/**
 * Chọn dòng nhận gốc mà lượt tất toán CŨ đã sinh cho một sổ đã đóng, khi cột trỏ dòng còn NULL. Dòng phải
 * khớp ĐỒNG THỜI ba dấu và là ứng viên DUY NHẤT của sổ:
 *   1. `description` đúng khuôn `moTaNhanGocTatToan(tên sổ, closedAt)` (sổ đã đóng không đổi tên được);
 *   2. `date` cùng ngày VN với `closedAt` (tất toán ghi cả hai bằng cùng một ngày);
 *   3. `amount` = Σ SAVINGS_OUT − Σ SAVINGS_IN KHÁC — đúng số `soDuDangGui` trả lúc tất toán ghi dòng.
 * Không đủ ⇒ trả lý do, KHÔNG đoán.
 */
export function chonDongNhanGocDiSan(
  so: { name: string; closedAt: Date },
  dong: readonly DongTienSo[]
): KetQuaChonDongDiSan {
  const tongGui = dong.filter((d) => d.kind === "SAVINGS_OUT").reduce((s, d) => s + d.amount, 0);
  const nhan = dong.filter((d) => d.kind === "SAVINGS_IN");
  const tongNhan = nhan.reduce((s, d) => s + d.amount, 0);
  const moTa = moTaNhanGocTatToan(so.name, so.closedAt);
  const ngay = khoaNgayVn(so.closedAt);

  const khop = nhan.filter(
    (d) =>
      d.description === moTa &&
      khoaNgayVn(d.date) === ngay &&
      d.amount > 0 &&
      d.amount === tongGui - (tongNhan - d.amount)
  );
  if (khop.length === 1) return { ok: true, id: khop[0].id };
  if (khop.length === 0) {
    return {
      ok: false,
      lyDo: "Không dòng nhận nào khớp đủ ba dấu (mô tả · ngày tất toán · số tiền) — đối chiếu tay với sao kê",
    };
  }
  return {
    ok: false,
    lyDo: `Có ${khop.length} dòng cùng khớp đủ ba dấu — không chọn được, đối chiếu tay với sao kê`,
  };
}
