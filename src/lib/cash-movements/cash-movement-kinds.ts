/**
 * MỘT định nghĩa duy nhất cho các loại dòng tiền ghi tay (bảng `CashMovement`): nhãn tiếng Việt,
 * chiều tiền, câu gợi ý dưới ô chọn loại. Chiều VÀO/RA SUY từ loại — không lưu cột riêng nên không có
 * ca "loại nói vào mà cột nói ra".
 *
 * HAI danh sách, CỐ Ý tách:
 *  - `CASH_MOVEMENT_KINDS` (10 kind) — enum hợp lệ của form "+ Nhập quỹ" và action ghi tay thường
 *    (`cash-movements.ts`, `cash-movement-form-modal.tsx` lấy THẲNG tuple này). Kind nợ phải trả KHÔNG
 *    BAO GIỜ được thêm vào đây: chúng có đường ghi riêng sau cổng `daBatNoPhaiTra`.
 *  - `CASH_MOVEMENT_KINDS_TAT_CA` (16 kind = enum Prisma) — cho META, chiều tiền, Sổ quỹ, dòng chạy,
 *    thùng rác: mọi chỗ ĐỌC dòng từ DB.
 *
 * Trục DÒNG TIỀN thuần — KHÔNG BAO GIỜ vào P&L (CLAUDE.md bất biến #1; lưới
 * `tests/unit/cash-movements/khong-ro-ri-vao-pnl.test.ts`). Không import Prisma: test thuần chạy không
 * cần DB; đồng bộ với enum Prisma `CashMovementKind` được kiểm ở mức KIỂU trong
 * `cash-movement-queries.ts`.
 */

export type CashDirection = "IN" | "OUT";

/** Chiều của MỘT dòng: `KHONG_QUY` = dòng có thật nhưng không đổi quỹ (nạp ví ads bằng thẻ). */
export type ChieuTien = CashDirection | "KHONG_QUY";

/** Thứ tự = thứ tự hiển thị: 6 loại VÀO trước, 4 loại RA sau. Form + action thường — xem đầu file. */
export const CASH_MOVEMENT_KINDS = [
  "LOAN_IN",
  "CAPITAL_IN",
  "DIRECT_SALE",
  "OTHER_IN",
  "DEPOSIT_IN",
  "SAVINGS_IN",
  "LOAN_REPAY",
  "CAPITAL_OUT",
  "DEPOSIT_OUT",
  "SAVINGS_OUT",
] as const;

/** 10 kind của form + action ghi tay thường. */
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

/**
 * Đủ 16 kind = enum Prisma `CashMovementKind`. Thứ tự hiển thị: VÀO (6 cũ + NCC hoàn + điều chỉnh vào)
 * rồi RA (4 cũ + trả thẻ + trả NCC + điều chỉnh ra), `ADS_TOPUP` cuối vì chiều theo nguồn nạp.
 */
export const CASH_MOVEMENT_KINDS_TAT_CA = [
  "LOAN_IN",
  "CAPITAL_IN",
  "DIRECT_SALE",
  "OTHER_IN",
  "DEPOSIT_IN",
  "SAVINGS_IN",
  "SUPPLIER_REFUND",
  "CUTOVER_ADJ_IN",
  "LOAN_REPAY",
  "CAPITAL_OUT",
  "DEPOSIT_OUT",
  "SAVINGS_OUT",
  "CARD_PAY",
  "SUPPLIER_PAY",
  "CUTOVER_ADJ_OUT",
  "ADS_TOPUP",
] as const;

/** Mọi kind có thể đọc từ DB. */
export type CashMovementKindTatCa = (typeof CASH_MOVEMENT_KINDS_TAT_CA)[number];

/** Kind có chiều tiền CỐ ĐỊNH theo loại — tất cả trừ `ADS_TOPUP`. Chỉ kiểu này được hỏi `isInflow`. */
export type KindChieuCoDinh = Exclude<CashMovementKindTatCa, "ADS_TOPUP">;

export type CashMovementKindMeta = { label: string; direction: CashDirection; hint: string };

/** `ADS_TOPUP`: chiều không cố định — nạp từ ngân hàng là RA, nạp bằng thẻ không chạm quỹ (`chieuTien`). */
export type CashMovementKindMetaTheoNguon = { label: string; direction: "THEO_NGUON"; hint: string };

/**
 * META theo kiểu ÁNH XẠ: tra bằng kind cố định chiều ⇒ `direction` là `CashDirection` như cũ; tra
 * bằng kind đọc từ DB (có thể là `ADS_TOPUP`) ⇒ kiểu buộc người gọi xử lý nhánh `THEO_NGUON`.
 */
export const CASH_MOVEMENT_KIND_META: {
  [K in CashMovementKindTatCa]: K extends "ADS_TOPUP" ? CashMovementKindMetaTheoNguon : CashMovementKindMeta;
} = {
  LOAN_IN: {
    label: "Vay vốn",
    direction: "IN",
    hint: "Tiền vay về tài khoản shop — chọn khoản vay bên dưới. Phần LÃI app sẽ đề xuất mỗi kỳ.",
  },
  CAPITAL_IN: {
    label: "Góp vốn / nhập quỹ",
    direction: "IN",
    hint: "Chủ shop bỏ tiền túi vào shop — kể cả số dư sẵn có lúc mở sổ quỹ.",
  },
  DIRECT_SALE: {
    label: "Bán trực tiếp",
    direction: "IN",
    hint: "Thu tiền bán KHÔNG lên đơn Pancake. Đơn lên ở màn Bán hàng Pancake đã TỰ vào quỹ — ghi thêm ở đây là đếm tiền 2 lần.",
  },
  DEPOSIT_IN: {
    label: "Nhận lại tiền gửi",
    direction: "IN",
    hint: "Ngân hàng trả lại sổ tiết kiệm bắt buộc — chọn khoản vay. Tất toán khoản vay ghi dòng này tự động.",
  },
  SAVINGS_IN: {
    label: "Nhận lại gốc tiết kiệm",
    direction: "IN",
    hint: "Ngân hàng trả lại GỐC sổ tiết kiệm sinh lãi — chọn sổ tiết kiệm. Chỉ gõ phần gốc: lãi app ghi riêng thành Thu nhập tài chính.",
  },
  OTHER_IN: {
    label: "Thu khác",
    direction: "IN",
    hint: "Khoản thu không thuộc loại nào ở trên (nhà cung cấp hoàn tiền, thanh lý…).",
  },
  LOAN_REPAY: {
    label: "Trả nợ gốc",
    direction: "OUT",
    hint: "Trả phần GỐC — chọn khoản vay. Không phải chi phí.",
  },
  CAPITAL_OUT: {
    label: "Rút vốn",
    direction: "OUT",
    hint: "Chủ shop rút tiền về túi cá nhân — không phải chi phí.",
  },
  DEPOSIT_OUT: {
    label: "Gửi tiết kiệm bắt buộc",
    direction: "OUT",
    hint: "Tiền gửi ngân hàng bắt buộc theo khoản vay — chọn khoản vay. Tiền vẫn của shop, ngân hàng giữ hộ tới lúc tất toán nên KHÔNG phải chi phí.",
  },
  SAVINGS_OUT: {
    label: "Gửi tiết kiệm sinh lãi",
    direction: "OUT",
    hint: "Tiền shop tự gửi ngân hàng lấy lãi — chọn sổ tiết kiệm. Tiền vẫn của shop nên KHÔNG phải chi phí; tiền gửi BẮT BUỘC theo hợp đồng vay thì chọn 'Gửi tiết kiệm bắt buộc'.",
  },
  CARD_PAY: {
    label: "Trả thẻ tín dụng",
    direction: "OUT",
    hint: "Tiền chuyển từ tài khoản để trả nợ thẻ — chọn thẻ. Quảng cáo/chi đã cà thẻ vào Lãi/Lỗ từ trước; dòng này chỉ là lúc tiền thật rời quỹ, KHÔNG phải chi phí.",
  },
  SUPPLIER_PAY: {
    label: "Trả tiền hàng",
    direction: "OUT",
    hint: "Trả nhà cung cấp cho phiếu nhập còn nợ — chọn phiếu. Tiền rời quỹ ngày trả; Nhập hàng KHÔNG vào Lãi/Lỗ.",
  },
  SUPPLIER_REFUND: {
    label: "NCC hoàn tiền",
    direction: "IN",
    hint: "Nhà cung cấp trả lại tiền (trả thừa, phiếu huỷ sau khi đã trả) — chọn phiếu.",
  },
  CUTOVER_ADJ_IN: {
    label: "Điều chỉnh mở sổ nợ (vào)",
    direction: "IN",
    hint: "Điều chỉnh MỘT LẦN tại ngày bật theo dõi nợ để quỹ khớp số dư ngân hàng — app tự tạo ở bước xác nhận, không ghi tay.",
  },
  CUTOVER_ADJ_OUT: {
    label: "Điều chỉnh mở sổ nợ (ra)",
    direction: "OUT",
    hint: "Điều chỉnh MỘT LẦN tại ngày bật theo dõi nợ để quỹ khớp số dư ngân hàng — app tự tạo ở bước xác nhận, không ghi tay.",
  },
  ADS_TOPUP: {
    label: "Nạp ví quảng cáo",
    direction: "THEO_NGUON",
    hint: "Nạp tiền trước vào ví quảng cáo (Shopee Ads). Nạp từ ngân hàng thì trừ quỹ ngày nạp; nạp bằng thẻ thì không trừ quỹ mà cộng vào nợ thẻ.",
  },
};

/** Bốn loại BẮT BUỘC trỏ về một khoản vay: gốc vay + tiền gửi bắt buộc theo hợp đồng vay. */
export const KIND_GAN_KHOAN_VAY: readonly CashMovementKind[] = [
  "LOAN_IN",
  "LOAN_REPAY",
  "DEPOSIT_OUT",
  "DEPOSIT_IN",
];

/** Hai loại BẮT BUỘC trỏ về một sổ tiết kiệm sinh lãi. */
export const KIND_GAN_SO_TIET_KIEM: readonly CashMovementKind[] = ["SAVINGS_OUT", "SAVINGS_IN"];

/** Loại BẮT BUỘC gắn thẻ tín dụng (CHECK `CashMovement_kind_khoa_bat_buoc`). */
export const KIND_CAN_THE: readonly CashMovementKindTatCa[] = ["CARD_PAY"];

/** Loại BẮT BUỘC gắn phiếu nhập còn nợ (CHECK `CashMovement_kind_khoa_bat_buoc`). */
export const KIND_CAN_PHIEU: readonly CashMovementKindTatCa[] = ["SUPPLIER_PAY", "SUPPLIER_REFUND"];

/**
 * Điều chỉnh quỹ MỘT LẦN tại mốc bật theo dõi nợ: không hồ sơ, mô tả bắt buộc. KHÔNG BAO GIỜ vào enum
 * form/action thường — chỉ bước xác nhận bật tạo.
 */
export const KIND_CUTOVER: readonly CashMovementKindTatCa[] = ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"];

/** Loại BẮT BUỘC gắn ví ads trả trước; được kèm `cardId` khi nạp bằng thẻ. */
export const KIND_VI_ADS: readonly CashMovementKindTatCa[] = ["ADS_TOPUP"];

/**
 * Kind nợ phải trả GHI ĐƯỢC qua form + action thường (`cash-movements.ts`) — CHỈ sau cổng
 * `daBatNoPhaiTra()` và chỉ khi ngày ∈ [M, hôm nay] (`ngayTienMoiSchema`). Tuple để zod dựng enum.
 * `CUTOVER_*` CỐ Ý VẮNG: chỉ bước xác nhận bật tạo; sửa số/mô tả đi action riêng của chủ shop.
 */
export const KIND_NO_PHAI_TRA_GHI_TAY = ["CARD_PAY", "SUPPLIER_PAY", "SUPPLIER_REFUND", "ADS_TOPUP"] as const;

export type KindNoPhaiTraGhiTay = (typeof KIND_NO_PHAI_TRA_GHI_TAY)[number];

/** 14 kind action thường nhận: 10 cũ + 4 nợ phải trả (không bao giờ `CUTOVER_*`). */
export const CASH_MOVEMENT_KINDS_GHI_TAY = [...CASH_MOVEMENT_KINDS, ...KIND_NO_PHAI_TRA_GHI_TAY] as const;

export type CashMovementKindGhiTay = (typeof CASH_MOVEMENT_KINDS_GHI_TAY)[number];

/** Thuộc 4 kind nợ phải trả ghi tay được (sau cổng bật). */
export function isKindNoPhaiTraGhiTay(value: unknown): value is KindNoPhaiTraGhiTay {
  return typeof value === "string" && (KIND_NO_PHAI_TRA_GHI_TAY as readonly string[]).includes(value);
}

/** Thuộc 14 kind action thường nhận. */
export function isCashMovementKindGhiTay(value: unknown): value is CashMovementKindGhiTay {
  return typeof value === "string" && (CASH_MOVEMENT_KINDS_GHI_TAY as readonly string[]).includes(value);
}

/**
 * Kind thuộc trục NỢ PHẢI TRẢ (6 kind mới, kể cả `CUTOVER_*`). Ghi/sửa/xoá dòng đó đổi nợ thẻ / nợ phiếu
 * / số dư ví hoặc điều chỉnh mở sổ ⇒ đòi `tai-chinh-so-quy:sua` (cùng tầng với khoản vay, spec §5.7).
 */
export function kindNoPhaiTra(kind: CashMovementKindTatCa): boolean {
  return isKindNoPhaiTraGhiTay(kind) || (KIND_CUTOVER as readonly string[]).includes(kind);
}

/**
 * Dòng thuộc khối SỔ QUỸ (khoản vay / sổ tiết kiệm) chứ không chỉ dòng tiền trơn — ghi/sửa/xoá dòng
 * này làm đổi dư nợ hoặc số đang gửi, nên đòi thêm `tai-chinh-so-quy:sua` ngoài quyền dòng tiền.
 * Nhận cả kind đọc từ DB; kind nợ phải trả trả `false` (quyền của chúng do phase riêng quyết).
 */
export function kindGanSoQuy(kind: CashMovementKindTatCa): boolean {
  return (
    (KIND_GAN_KHOAN_VAY as readonly string[]).includes(kind) ||
    (KIND_GAN_SO_TIET_KIEM as readonly string[]).includes(kind)
  );
}

/**
 * Chiều VÀO? CHỈ cho kind chiều cố định. `ADS_TOPUP` bị cấm ở mức kiểu VÀ ném lúc chạy (giá trị lọt
 * qua `as`/JS): trả bừa `false` là âm thầm trừ quỹ khoản nạp bằng thẻ — dòng không hề chạm quỹ.
 */
export function isInflow(kind: KindChieuCoDinh): boolean {
  if ((kind as CashMovementKindTatCa) === "ADS_TOPUP") {
    throw new Error("isInflow: ADS_TOPUP không có chiều cố định — dùng chieuTien(kind, { coCard })");
  }
  return CASH_MOVEMENT_KIND_META[kind].direction === "IN";
}

/**
 * Chiều tiền của MỘT dòng — hàm DUY NHẤT nhận mọi kind đọc từ DB. `ADS_TOPUP`: có thẻ ⇒ `KHONG_QUY`
 * (nạp ví bằng thẻ: tiền chưa rời quỹ, nợ thẻ tăng), không thẻ ⇒ `OUT` (nạp từ ngân hàng). Kind khác
 * theo META bất kể cờ thẻ (vd `CARD_PAY` luôn RA dù dòng mang `cardId`).
 */
export function chieuTien(kind: CashMovementKindTatCa, { coCard }: { coCard: boolean }): ChieuTien {
  if (kind === "ADS_TOPUP") return coCard ? "KHONG_QUY" : "OUT";
  return isInflow(kind) ? "IN" : "OUT";
}

/** Số CÓ DẤU để cộng dồn/hiển thị: vào +, ra −. `amount` luôn dương (CHECK ở DB + zod ở action). */
export function signedAmount(kind: KindChieuCoDinh, amount: number): number {
  return isInflow(kind) ? amount : -amount;
}

/** Thuộc 10 kind của form + action thường (KHÔNG gồm kind nợ phải trả). */
export function isCashMovementKind(value: unknown): value is CashMovementKind {
  return typeof value === "string" && (CASH_MOVEMENT_KINDS as readonly string[]).includes(value);
}

/** Thuộc đủ 16 kind của enum Prisma. */
export function isCashMovementKindTatCa(value: unknown): value is CashMovementKindTatCa {
  return typeof value === "string" && (CASH_MOVEMENT_KINDS_TAT_CA as readonly string[]).includes(value);
}
