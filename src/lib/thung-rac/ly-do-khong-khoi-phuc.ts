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
export type ChaDaMat = "category" | "channel" | "loan" | "savings" | "the" | "phieu" | "viAds";

/** Cha có cột `closedAt` — khoản vay / sổ tiết kiệm ĐÃ CHỐT SỔ thì không nhận thêm dòng tiền nào. */
export type ChaDaTatToan = "loan" | "savings" | "the";

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
  the: "Thẻ tín dụng gốc đã bị xoá — khôi phục cái đó trước",
  phieu: "Phiếu nợ nhập hàng gốc đã bị xoá — khôi phục cái đó trước",
  viAds: "Ví quảng cáo gốc đã bị xoá — khôi phục cái đó trước",
};

const CAU_CHA_DA_TAT_TOAN: Record<ChaDaTatToan, string> = {
  loan: "Khoản vay đã tất toán — mở lại khoản vay trước khi khôi phục mục này",
  savings: "Sổ tiết kiệm đã tất toán — mở lại sổ trước khi khôi phục mục này",
  the: "Thẻ tín dụng đã đóng — không khôi phục dòng tiền / khoản chi vào thẻ đã đóng",
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
   * `ensureRecurringExpenses` tự sinh lại dòng thay thế ngay lần render sau — khôi phục thêm nữa là
   * HAI dòng cùng một khoản chi (lãi ròng và quỹ cùng hụt đúng một lần tiền); UNIQUE
   * `(recurringId, recurringMonth)` dưới DB cũng từ chối câu ghi đó.
   */
  thangDaCoDinhKy: boolean;
  /** Trục số dư mà lượt khôi phục sẽ đẩy xuống âm (dò TRƯỚC khi ghi), hoặc null. */
  seLamAmSoDu: TrucSoDuAm | null;
  /**
   * Câu từ chối của luật NỢ PHẢI TRẢ (spec §5.3, §5.8): Nhập hàng sau M, dòng tiền nợ ngoài cửa sổ ngày /
   * chưa bật / thẻ đã đóng… Câu do CHÍNH cổng của đường ghi sinh ra (một luật, một câu). `doTinhTrang` luôn
   * điền; tuỳ chọn chỉ để các fixture dựng tay trước khi có trường này vẫn hợp lệ.
   */
  viPhamNoPhaiTra?: string | null;
};

/** Câu cho Expense "Nhập hàng" ngày ≥ M — đường ghi đó đã đóng (spec §5.3). */
export const CAU_NHAP_HANG_SAU_M =
  "Không khôi phục được: Nhập hàng sau ngày bật theo dõi nợ — tiền hàng từ mốc đó theo dõi ở sổ nợ phiếu nhập";

/**
 * Câu cho hồ sơ ví/thẻ khôi phục SAU khi bật theo dõi nợ (spec §5.4, §5.8, §5.9). Ví/thẻ trong thùng rác lúc đã
 * bật CHẮC CHẮN không tham gia bước bật (hồ sơ đã khai ở bước bật không xoá được) — số dư neo của nó KHÔNG nằm
 * trong điều chỉnh mở sổ, nên khôi phục = tạo mới sau bật và phải qua đúng luật đó, cộng thêm luật chống HỒI TỐ:
 * dựng lại ví là nhánh (c) của bộ lọc quỹ bật lại cho mọi ngày từ `max(M, ngayNeo + 1)` — khoản chi ads đã trừ
 * quỹ những ngày đó bỗng thôi trừ, quỹ của các ngày đã qua đổi mà không ai ghi gì.
 */
export const CAU_HO_SO_NO_SAU_BAT = {
  viNeoTruocM: (ngayNeo: string, mTru1: string) =>
    `Không khôi phục được: ví neo số dư ngày ${ngayNeo}, trước ngày ${mTru1} (ngày trước khi bật theo dõi nợ) — bước bật không tính ví này. Tạo hồ sơ ví mới thay vì khôi phục`,
  viSoDuKhac0:
    "Không khôi phục được: ví có số dư ban đầu khác 0 — ví thêm sau khi bật theo dõi nợ phải có số dư 0 (tiền trong ví đã rời ngân hàng mà quỹ chưa trừ, khôi phục là quỹ cao hơn ngân hàng đúng số đó). Tạo hồ sơ ví mới khi ví đã dùng hết tiền",
  viCoChiSauNeo: (soDong: number, tuNgay: string) =>
    `Không khôi phục được: đã có ${soDong} khoản chi quảng cáo của nền tảng này từ ${tuNgay} — khôi phục ví sẽ làm các khoản đó thôi trừ quỹ cho những ngày đã qua (quỹ đổi hồi tố). Tạo hồ sơ ví mới (neo hôm qua, số dư 0) thay vì khôi phục`,
  theNeoKhac0: (mTru1: string) =>
    `Không khôi phục được: thẻ có dư nợ ban đầu khác 0 mà không phải neo của bước bật (ngày ${mTru1}) — thẻ thêm sau khi bật theo dõi nợ phải có dư nợ ban đầu 0. Tạo thẻ mới với neo 0 thay vì khôi phục`,
} as const;

/**
 * Câu cho ca "tháng đó đã có dòng định kỳ thay thế" — dùng CHUNG cho phép dò trước (cột "Trạng thái")
 * và cho va chạm UNIQUE `(recurringId, recurringMonth)` lúc ghi (lượt sinh song song chen vào sau phép
 * dò): một sự cố, một câu.
 */
export const CAU_THANG_DA_CO_DINH_KY =
  "Tháng này đã có khoản định kỳ thay thế — xoá dòng đó trước khi khôi phục mục này";

export function lyDoKhongKhoiPhuc(t: TinhTrangKhoiPhuc): string | null {
  if (t.daKhoiPhuc) return "Mục này đã được khôi phục";
  if (t.idDaTonTaiLai) return "Bản ghi này đã tồn tại lại trong sổ";
  if (t.refIdBiChiem !== null) {
    return `Khoá chống trùng "${t.refIdBiChiem}" đang thuộc một dòng khác`;
  }
  if (t.chaDaMat !== null) return CAU_CHA_DA_MAT[t.chaDaMat];
  // "Cha đã mất" thắng "cha đã tất toán": không có cha thì `closedAt` còn chẳng đọc được.
  if (t.chaDaTatToan !== null) return CAU_CHA_DA_TAT_TOAN[t.chaDaTatToan];
  if (t.viPhamNoPhaiTra) return t.viPhamNoPhaiTra;
  if (t.thangDaCoDinhKy) return CAU_THANG_DA_CO_DINH_KY;
  if (t.seLamAmSoDu !== null) return CAU_SO_DU_AM[t.seLamAmSoDu];
  return null;
}
