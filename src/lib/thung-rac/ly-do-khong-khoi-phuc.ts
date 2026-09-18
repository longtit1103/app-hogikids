/**
 * Vị từ THUẦN trả lý do KHÔNG khôi phục được một mục trong thùng rác (null = khôi phục được).
 *
 * Tách khỏi `khoi-phuc-ban-ghi.ts` theo đúng khuôn `ly-do-khong-xoa-khoan-vay.ts`: màn thùng rác
 * cũng cần biết TRƯỚC để làm mờ nút, và hai nơi tự viết câu riêng là chúng lệch nhau âm thầm khi
 * thêm trạng thái mới.
 *
 * Câu chữ là HỢP ĐỒNG với người dùng: phải nói được PHẢI LÀM GÌ, không chỉ "không được".
 */

/** Loại bản ghi CHA mà bản ghi được khôi phục trỏ tới bằng khoá ngoại. */
export type ChaDaMat = "category" | "channel" | "loan" | "savings";

/** Cha có cột `closedAt` — khoản vay / sổ tiết kiệm ĐÃ CHỐT SỔ thì không nhận thêm dòng tiền nào. */
export type ChaDaTatToan = "loan" | "savings";

/**
 * Ba TRỤC SỐ DƯ mà một lượt khôi phục có thể đẩy xuống âm. Ba trục tách hẳn nhau vì đếm ba tập
 * `CashMovement.kind` khác nhau (`vi-tu-du-no.ts` · `vi-tu-so-tiet-kiem.ts`) và hỏng theo ba cách
 * chủ shop phải gỡ khác nhau.
 */
export type TrucSoDuAm = "duNo" | "tienGui" | "soDuTietKiem";

const CAU_CHA_DA_MAT: Record<ChaDaMat, string> = {
  category: "Danh mục gốc đã bị xoá — khôi phục cái đó trước",
  channel: "Kênh gốc đã bị xoá — khôi phục cái đó trước",
  loan: "Khoản vay gốc đã bị xoá — khôi phục cái đó trước",
  savings: "Sổ tiết kiệm gốc đã bị xoá — khôi phục cái đó trước",
};

const CAU_CHA_DA_TAT_TOAN: Record<ChaDaTatToan, string> = {
  loan: "Khoản vay đã tất toán — mở lại khoản vay trước khi khôi phục mục này",
  savings: "Sổ tiết kiệm đã tất toán — mở lại sổ trước khi khôi phục mục này",
};

/**
 * Câu cho ca số dư âm. Export vì `khoi-phuc-ban-ghi.ts` còn dùng LẠI đúng ba câu này khi HẬU KIỂM
 * (`chanDuNoAm`/`chanTienGuiAm`/`chanSoDuTietKiemAm`) ném trong lượt chạy song song mà phép dò
 * trước không thấy — hai đường phải nói CÙNG một câu, nếu không chủ shop đọc ra hai chuyện khác nhau
 * cho cùng một sự cố.
 */
export const CAU_SO_DU_AM: Record<TrucSoDuAm, string> = {
  duNo: "Khôi phục sẽ làm dư nợ khoản vay âm — phần gốc này đã được trả bằng dòng khác, xoá dòng đó trước",
  tienGui:
    "Khôi phục sẽ làm tiền gửi ngân hàng đang giữ âm — phần gửi này đã được nhận lại bằng dòng khác, xoá dòng đó trước",
  soDuTietKiem:
    "Khôi phục sẽ làm số đang gửi ở sổ tiết kiệm âm — phần gốc này đã được nhận lại bằng dòng khác, xoá dòng đó trước",
};

export type TinhTrangKhoiPhuc = {
  /** `khoiPhucLuc` đã có giá trị — mục đã khôi phục một lần rồi. */
  daKhoiPhuc: boolean;
  /** Id cũ nay đã có chủ (ai đó tạo lại một bản ghi trùng id) — ghi đè là mất bản ghi đang sống. */
  idDaTonTaiLai: boolean;
  /**
   * Giá trị `refId` của ảnh chụp đang thuộc một dòng SỐNG khác, hoặc null. `Expense.refId` và
   * `ThuNhap.refId` là cổng chống ghi trùng kỳ vay / lãi tiết kiệm: khôi phục đè lên là vỡ cổng đó.
   */
  refIdBiChiem: string | null;
  chaDaMat: ChaDaMat | null;
  /**
   * Cha CÒN SỐNG nhưng đã tất toán. Mọi đường ghi khác đều chặn ca này (`kiemKhoanConHieuLuc` /
   * `kiemSoTietKiemConHieuLuc`); thiếu ở đây thì khôi phục là cái cửa DUY NHẤT nhét được tiền vào
   * một khoản đã chốt — ngân hàng đã hoàn đúng số đang giữ mà sổ app bỗng báo còn giữ tiếp.
   */
  chaDaTatToan: ChaDaTatToan | null;
  /**
   * Bản ghi là một khoản chi ĐỊNH KỲ mà tháng đó nay ĐÃ có dòng khác cùng `recurringId`.
   * `ensureRecurringExpenses` tự sinh lại dòng thay thế ngay lần render sau (cổng idempotent của nó
   * chỉ là `findFirst` theo tháng, không có unique dưới DB) — khôi phục thêm nữa là HAI dòng cùng
   * một khoản chi, lãi ròng và quỹ cùng hụt đúng một lần tiền.
   */
  thangDaCoDinhKy: boolean;
  /** Trục số dư mà lượt khôi phục sẽ đẩy xuống âm (dò TRƯỚC khi ghi), hoặc null. */
  seLamAmSoDu: TrucSoDuAm | null;
};

export function lyDoKhongKhoiPhuc(t: TinhTrangKhoiPhuc): string | null {
  if (t.daKhoiPhuc) return "Mục này đã được khôi phục";
  if (t.idDaTonTaiLai) return "Bản ghi này đã tồn tại lại trong sổ";
  if (t.refIdBiChiem !== null) {
    return `Khoá chống trùng "${t.refIdBiChiem}" đang thuộc một dòng khác`;
  }
  if (t.chaDaMat !== null) return CAU_CHA_DA_MAT[t.chaDaMat];
  // "Cha đã mất" thắng "cha đã tất toán": không có cha thì `closedAt` còn chẳng đọc được.
  if (t.chaDaTatToan !== null) return CAU_CHA_DA_TAT_TOAN[t.chaDaTatToan];
  if (t.thangDaCoDinhKy) {
    return "Tháng này đã có khoản định kỳ thay thế — xoá dòng đó trước khi khôi phục mục này";
  }
  if (t.seLamAmSoDu !== null) return CAU_SO_DU_AM[t.seLamAmSoDu];
  return null;
}
