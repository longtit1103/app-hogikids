"use server";

import type { Prisma } from "@/generated/prisma/client";
import { format, startOfDay } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong, maLoiNhatKy } from "@/lib/actions/khoan-vay-chung";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { ngayGhiTaySchema } from "@/lib/actions/ngay-ghi-tay-schema";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import {
  CASH_MOVEMENT_KINDS_GHI_TAY,
  isCashMovementKindGhiTay,
  isKindNoPhaiTraGhiTay,
  KIND_CAN_PHIEU,
  KIND_CAN_THE,
  KIND_CUTOVER,
  KIND_GAN_KHOAN_VAY,
  KIND_GAN_SO_TIET_KIEM,
  KIND_VI_ADS,
  kindGanSoQuy,
  kindNoPhaiTra,
  type CashMovementKindGhiTay,
  type CashMovementKindTatCa,
} from "@/lib/cash-movements/cash-movement-kinds";
import { daBatNoPhaiTra, LoiChuaBat } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import {
  chanHoanVuotDaTra,
  khoaHoSoNo,
  kiemHoSoNo,
  LoiHoSoNo,
  type DongHoSoNo,
} from "@/lib/no-phai-tra/ho-so-dong-tien-no";
import { ngayTienMoiSchema } from "@/lib/no-phai-tra/ngay-tien-moi-schema";
import { prisma } from "@/lib/prisma";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { congAction, congChuShopAction, kiemThemQuyen, type KetQuaCong } from "@/lib/quyen/cong-action";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";
import {
  laLoiDongTienBan,
  OPT_TX_DONG_TIEN,
  THONG_BAO_KHOA_DONG_TIEN_BAN,
} from "@/lib/so-quy/khoa-dong-tien-co-han";
import {
  chanSoDuTietKiemAm,
  khoaCacSoTietKiem,
  kiemSoTietKiemConHieuLuc,
  LoiSoDuTietKiemAm,
  LoiSoTietKiemKhongHopLe,
} from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";
import {
  chanDuNoAm,
  chanTienGuiAm,
  khoaCacKhoanVay,
  LoiDuNoAm,
  LoiTienGuiAm,
} from "@/lib/so-quy/vi-tu-du-no";

/**
 * CRUD "Khoản tiền khác" ghi tay (bảng `CashMovement`) — khối trong tab Dòng tiền của hub Tài chính.
 * Cùng khung với `expenses.ts`: cổng quyền → khoá phục hồi → zod → ghi (+ nhật ký cùng transaction) →
 * revalidate. Mọi dòng đều nhập
 * tay nên KHÔNG có khoá kiểu ADS_API; xoá là xoá cứng. Trục DÒNG TIỀN thuần — không bao giờ vào P&L
 * (bất biến #1; lưới tests/unit/cash-movements/khong-ro-ri-vao-pnl.test.ts).
 *
 * Bốn loại phải gắn `loanId` (zod ở đây + CHECK `CashMovement_loan_bat_buoc` ở DB): GỐC VAY
 * (`LOAN_IN`/`LOAN_REPAY`) và SỔ TIẾT KIỆM BẮT BUỘC (`DEPOSIT_OUT`/`DEPOSIT_IN`). Mọi dòng gắn khoản
 * vay đều phải qua VỊ TỪ DƯ NỢ dùng chung (`vi-tu-du-no.ts`) trên CẢ BA đường ghi — thiếu một đường
 * là dư nợ âm lọt vào sổ mà không có test số nào khác đỏ. Vị từ chỉ có răng khi transaction ĐÃ khoá
 * dòng `Loan` (`khoaCacKhoanVay`) — xem lý do ở `vi-tu-du-no.ts`.
 *
 * Ba action này PHẢI nằm trong `DUONG_GHI` của tests/khoa-bao-tri-duong-ghi.test.ts (phép quét AST).
 *
 * QUYỀN hai tầng: cổng `tai-chinh-dong-tien:sua` cho mọi dòng; dòng thuộc khối Sổ quỹ (loại gắn khoản
 * vay / sổ tiết kiệm, trước HOẶC sau khi sửa) đòi thêm `tai-chinh-so-quy:sua` — `kiemQuyenDongGanSoQuy`.
 */

/**
 * Bốn loại buộc phải trỏ về một khoản vay cụ thể. Thiếu một loại ở đây thì `transform` bên dưới CẮT
 * `loanId` về null, rồi CHECK `CashMovement_loan_bat_buoc` dưới DB ném lỗi Postgres thô lên mặt chủ
 * shop — im lặng hỏng đúng chỗ khó đoán nhất.
 *
 * Danh sách này CHỈ nói "phải gắn khoản vay", KHÔNG phải danh sách dòng tính dư nợ: dư nợ vẫn chỉ
 * đếm `LOAN_IN`/`LOAN_REPAY` (`KIND_GOC` ở `vi-tu-du-no.ts`) — tiền gửi tiết kiệm không trả nợ, nó
 * chỉ cấn trừ MỘT LẦN lúc tất toán.
 */
const KIND_KHOAN_VAY: readonly CashMovementKindGhiTay[] = KIND_GAN_KHOAN_VAY;

/**
 * Hai loại buộc phải trỏ về một SỔ TIẾT KIỆM SINH LÃI (zod ở đây + CHECK
 * `CashMovement_savings_bat_buoc` ở DB). Đối xứng `KIND_KHOAN_VAY`, nhưng TUYỆT ĐỐI không trộn:
 * CHECK `CashMovement_loan_savings_loai_tru` cấm một dòng mang cả `loanId` lẫn `savingsId`, và
 * `transform` bên dưới cắt đúng một trong hai về null theo `kind` nên luật đó không thể vỡ từ đây.
 *
 * Khác `DEPOSIT_OUT`/`DEPOSIT_IN` (tiền gửi BẮT BUỘC theo hợp đồng vay, không sinh lãi): cặp này là
 * tiền chủ shop TỰ NGUYỆN gửi lấy lãi, và phần LÃI không bao giờ đi đường này — nó đi bảng `ThuNhap`.
 */
const KIND_SO_TIET_KIEM: readonly CashMovementKindGhiTay[] = KIND_GAN_SO_TIET_KIEM;

/**
 * Loại nợ phải trả (spec §5.1, CHECK `CashMovement_kind_khoa_bat_buoc`): `CARD_PAY` ⇒ thẻ; `SUPPLIER_*`
 * ⇒ phiếu nhập; `ADS_TOPUP` ⇒ ví ads (+ thẻ TUỲ CHỌN khi nạp bằng thẻ — dòng đó không chạm quỹ).
 */
const coTrong = (ds: readonly CashMovementKindTatCa[], kind: CashMovementKindTatCa) => ds.includes(kind);
const giuThe = (kind: CashMovementKindTatCa) => coTrong(KIND_CAN_THE, kind) || coTrong(KIND_VI_ADS, kind);

const cashMovementSchema = z
  .object({
    date: ngayGhiTaySchema, // cùng một schema với Expense — lý do + thứ tự refine ở module đó
    // 14 kind: 10 cũ + 4 nợ phải trả (cổng bật + cửa sổ ngày kiểm SAU zod, cần đọc M). `CUTOVER_*`
    // KHÔNG BAO GIỜ ở đây — chỉ bước xác nhận bật tạo (lưới `trang-thai-p1-chua-mo-kind-no-phai-tra`).
    kind: z.enum(CASH_MOVEMENT_KINDS_GHI_TAY),
    // Trần 2 tỷ: Prisma Int (int32) chết ở 2.147.483.647 — cùng ngưỡng, cùng lý do với Expense.amount.
    amount: z.coerce
      .number()
      .int("Số tiền phải là số nguyên")
      .positive("Số tiền phải lớn hơn 0")
      .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
    description: z.string().max(200, "Tối đa 200 ký tự").default(""),
    loanId: z.string().cuid().optional().nullable(),
    savingsId: z.string().cuid().optional().nullable(),
    cardId: z.string().cuid().optional().nullable(),
    phieuNhapId: z.string().cuid().optional().nullable(),
    viAdsId: z.string().cuid().optional().nullable(),
  })
  .superRefine((d, ctx) => {
    if (KIND_KHOAN_VAY.includes(d.kind) && !d.loanId) {
      ctx.addIssue({ code: "custom", path: ["loanId"], message: "Chọn khoản vay" });
    }
    if (KIND_SO_TIET_KIEM.includes(d.kind) && !d.savingsId) {
      ctx.addIssue({ code: "custom", path: ["savingsId"], message: "Chọn sổ tiết kiệm" });
    }
    if (coTrong(KIND_CAN_THE, d.kind) && !d.cardId) {
      ctx.addIssue({ code: "custom", path: ["cardId"], message: "Chọn thẻ" });
    }
    if (coTrong(KIND_CAN_PHIEU, d.kind) && !d.phieuNhapId) {
      ctx.addIssue({ code: "custom", path: ["phieuNhapId"], message: "Chọn phiếu nhập" });
    }
    if (coTrong(KIND_VI_ADS, d.kind) && !d.viAdsId) {
      ctx.addIssue({ code: "custom", path: ["viAdsId"], message: "Chọn ví quảng cáo" });
    }
  })
  // Loại khác mà lỡ mang `loanId`/`savingsId` (đổi loại trên form) thì cắt đứt liên kết — không để
  // dòng "Rút vốn" âm thầm nằm trong dư nợ của một khoản vay, cũng không để nó nằm trong số đang
  // gửi của một sổ tiết kiệm (CHECK `CashMovement_savings_dung_cho` sẽ ném lỗi thô nếu lọt).
  .transform((d) => ({
    ...d,
    loanId: KIND_KHOAN_VAY.includes(d.kind) ? (d.loanId as string) : null,
    savingsId: KIND_SO_TIET_KIEM.includes(d.kind) ? (d.savingsId as string) : null,
    // Cùng luật cắt cho 3 khoá nợ phải trả: CHECK `CashMovement_toi_da_mot_ho_so` cấm dòng dính 2 hồ sơ
    // (trừ `ADS_TOPUP` thẻ + ví) — form đổi loại mà còn sót khoá cũ thì cắt ở đây, không để Postgres ném.
    cardId: giuThe(d.kind) ? (d.cardId ?? null) : null,
    phieuNhapId: coTrong(KIND_CAN_PHIEU, d.kind) ? (d.phieuNhapId as string) : null,
    viAdsId: coTrong(KIND_VI_ADS, d.kind) ? (d.viAdsId as string) : null,
  }));

type CashMovementData = z.infer<typeof cashMovementSchema>;

/** Lỗi enum/định dạng của zod là tiếng Anh — đổi sang câu tiếng Việt cho đúng ô trên form. */
function mapLoi(error: z.ZodError): { error: string; field?: string } {
  const mapped = mapZodError(error);
  if (mapped.field === "kind") return { error: "Chọn loại khoản", field: "kind" };
  // `.cuid()` hỏng ⇒ message tiếng Anh "Invalid cuid"; với chủ shop nó chỉ có nghĩa "chưa chọn".
  if (mapped.field === "loanId") return { error: "Chọn khoản vay", field: "loanId" };
  if (mapped.field === "savingsId") return { error: "Chọn sổ tiết kiệm", field: "savingsId" };
  if (mapped.field === "cardId") return { error: "Chọn thẻ", field: "cardId" };
  if (mapped.field === "phieuNhapId") return { error: "Chọn phiếu nhập", field: "phieuNhapId" };
  if (mapped.field === "viAdsId") return { error: "Chọn ví quảng cáo", field: "viAdsId" };
  return mapped;
}

/** Lỗi hợp đồng khoản vay — ném TRONG transaction để cả cụm ghi rollback. */
class LoiKhoanVay extends Error {
  constructor(
    message: string,
    public readonly field: string
  ) {
    super(message);
    this.name = "LoiKhoanVay";
  }
}

/**
 * P2025 = "record not found" của Prisma — CHỈ mã này mới là "không tìm thấy". Lỗi khác (mạng, hết
 * pool kết nối…) mà đội lốt "không tìm thấy" thì chủ shop sẽ tạo lại dòng tưởng bị mất → đếm 2 lần.
 * Dùng chung cho update/delete — module-private, KHÔNG export (file "use server" chỉ được export
 * async function).
 */
function loiGhi(e: unknown): { error: string; field?: string; code?: string } {
  // `"id"` KHÔNG phải ô nhập nào trên form. Trả kèm `field` thì modal rẽ vào nhánh `setFieldErrors`
  // (`cash-movement-form-modal.tsx`) — nó chỉ render 6 khoá date/kind/loanId/savingsId/amount/
  // description, nên câu báo rơi vào khoá không ai đọc: chủ shop bấm Lưu, bị từ chối, mà KHÔNG có
  // toast, không dòng đỏ, không đóng dialog ⇒ tưởng đã lưu. Bỏ `field` để rơi về `toast.error`.
  if (e instanceof LoiKhoanVay) {
    return e.field === "id" ? { error: e.message } : { error: e.message, field: e.field };
  }
  // Trục SỔ TIẾT KIỆM dùng `LoiHopDong` (lớp dùng chung với `so-tiet-kiem.ts`) thay vì đẻ thêm một
  // lớp song song: mọi lượt ném `LoiHopDong` trong file này đều thuộc trục đó, nên thiếu `field`
  // thì tô ô "Sổ tiết kiệm" là đúng ô, không phải đoán.
  if (e instanceof LoiHopDong) return { error: e.message, field: e.field ?? "savingsId" };
  if (e instanceof LoiDuNoAm) return { error: e.message, field: "amount" };
  if (e instanceof LoiTienGuiAm) return { error: e.message, field: "amount" };
  if (e instanceof LoiSoDuTietKiemAm) return { error: e.message, field: "amount" };
  // Vị từ `kiemSoTietKiemConHieuLuc` ném lớp RIÊNG (`vi-tu-so-tiet-kiem.ts`) chứ không phải
  // `LoiHopDong` — nó là vị từ thuần, không biết gì về tầng action. Quên nhánh này là câu "Sổ tiết
  // kiệm đã tất toán…" rơi xuống câu chung "Lỗi khi ghi khoản tiền" và chủ shop không biết vì sao.
  if (e instanceof LoiSoTietKiemKhongHopLe) return { error: e.message, field: e.field };
  if (e instanceof LoiHoSoNo) {
    return e.field === "id" ? { error: e.message, code: e.code } : { error: e.message, field: e.field, code: e.code };
  }
  // Chờ khoá dòng khoản vay / sổ quá hạn, hoặc transaction quá hạn (P2028) — đã lùi, không ghi gì.
  // Không `field` ⇒ rơi về toast.
  if (laLoiDongTienBan(e)) return { error: THONG_BAO_KHOA_DONG_TIEN_BAN };
  const code = (e as { code?: string })?.code;
  return { error: code === "P2025" ? "Không tìm thấy khoản tiền" : "Lỗi khi ghi khoản tiền" };
}

/**
 * Cổng cho mọi dòng gắn khoản vay, chạy TRONG transaction ghi:
 *  - khoản phải tồn tại và còn hiệu lực;
 *  - 1 khoản vay = TỐI ĐA 1 lần giải ngân (vay thêm ⇒ tạo khoản vay mới), và khoản MANG SANG thì
 *    không được thêm giải ngân nào — tiền của nó đã nằm trong số dư mở sổ, ghi nữa là thổi phồng quỹ;
 *  - ngày dòng giải ngân phải trùng ngày bắt đầu khoản vay (bất biến `LOAN_IN.date =
 *    startOfDay(Loan.startDate)`, spec §5.2 đếm dư nợ theo ngày dòng tiền).
 *
 * Hai loại TIỀN GỬI (`DEPOSIT_OUT`/`DEPOSIT_IN`) thêm một điều kiện: khoản phải là BULLET. Sổ tiết
 * kiệm bắt buộc là thuộc tính CHỈ CỦA loại vay đó — khoản thấu chi tất toán qua
 * `tat-toan-thau-chi.ts`, đường ghi vốn mù `DEPOSIT_*`: nó set `closedAt` mà KHÔNG hoàn, rồi chính
 * hàm này chặn mọi lượt ghi vào khoản đã đóng ⇒ tiền của chủ shop mất dấu vĩnh viễn khỏi quỹ. Chặn
 * ở cửa vào rẻ và chắc hơn là dạy mọi đường tất toán biết hoàn. Ngoài điều kiện đó thì gửi/rút bao
 * nhiêu lần, ngày nào cũng được (ngân hàng thu theo lịch riêng).
 *
 * `LOAN_REPAY` chỉ đi qua hai phép kiểm ĐẦU rồi thoát.
 */
async function kiemKhoanVay(
  tx: Prisma.TransactionClient,
  d: CashMovementData & { loanId: string },
  idDangSua: string | null
): Promise<void> {
  const loan = await tx.loan.findUnique({
    where: { id: d.loanId },
    select: { closedAt: true, duNoMoSo: true, startDate: true, kind: true },
  });
  if (!loan) throw new LoiKhoanVay("Không tìm thấy khoản vay", "loanId");
  if (loan.closedAt !== null) throw new LoiKhoanVay("Khoản vay đã tất toán", "loanId");
  if (
    (d.kind === "DEPOSIT_OUT" || d.kind === "DEPOSIT_IN") &&
    loan.kind !== "BULLET"
  ) {
    throw new LoiKhoanVay(
      "Chỉ khoản vay trả gốc cuối kỳ mới có sổ tiết kiệm bắt buộc",
      "loanId"
    );
  }
  if (d.kind !== "LOAN_IN") return;

  if (loan.duNoMoSo > 0) {
    throw new LoiKhoanVay(
      "Khoản vay này khai dư nợ mang sang — không thêm được lần giải ngân, vay thêm thì tạo khoản vay mới",
      "loanId"
    );
  }
  const daGiaiNgan = await tx.cashMovement.count({
    where: {
      loanId: d.loanId,
      kind: "LOAN_IN",
      ...(idDangSua === null ? {} : { id: { not: idDangSua } }),
    },
  });
  if (daGiaiNgan > 0) {
    throw new LoiKhoanVay(
      "Khoản vay này đã giải ngân — vay thêm thì tạo khoản vay mới",
      "loanId"
    );
  }
  if (startOfDay(d.date).getTime() !== startOfDay(loan.startDate).getTime()) {
    throw new LoiKhoanVay(
      `Ngày giải ngân phải trùng ngày bắt đầu khoản vay ${format(loan.startDate, "dd/MM/yyyy")}`,
      "date"
    );
  }
}

/**
 * NĂM khoá hồ sơ cha của một dòng tiền: khoản vay · sổ tiết kiệm · thẻ · phiếu nhập · ví ads. Hàng rào
 * "cha không đổi" (`docLaiTrongTx`, `ghiCoHangRaoCha`) so ĐỦ năm: khoá `FOR UPDATE` giành theo cha của
 * bản đọc NGOÀI transaction, dòng vừa bị chuyển sang cha khác thì ta đang khoá nhầm cha.
 */
const KHOA_CHA = ["loanId", "savingsId", "cardId", "phieuNhapId", "viAdsId"] as const;
type KhoaCha = Record<(typeof KHOA_CHA)[number], string | null>;
const SELECT_CHA = { loanId: true, savingsId: true, cardId: true, phieuNhapId: true, viAdsId: true } as const;

/**
 * Đọc LẠI bản ghi TRONG transaction, sau khi đã giành khoá dòng cha — đây mới là bản để CHỤP vào
 * thùng rác.
 *
 * Vì sao không dùng bản đọc ngoài transaction: giữa lượt đọc đó và lượt chụp bên trong, một lượt sửa
 * khác có thể đã commit. Ảnh chụp khi ấy là phiên bản CŨ còn câu xoá lại xoá phiên bản MỚI ⇒ bấm
 * Khôi phục dựng về một số tiền chưa bao giờ đúng, mà không có dấu vết nào cho thấy đã lệch.
 *
 * Còn kiểm cha không đổi: khoá `FOR UPDATE` ở trên giành theo `loanId`/`savingsId` của bản đọc NGOÀI
 * transaction. Nếu dòng vừa được chuyển sang khoản vay / sổ khác thì ta đang khoá nhầm cha, và mọi
 * hậu kiểm sau đó cộng nhầm sổ. Bảo chủ shop mở lại trang rẻ hơn nhiều so với đoán.
 */
async function docLaiTrongTx(tx: Prisma.TransactionClient, id: string, cha: KhoaCha) {
  const row = await tx.cashMovement.findUnique({ where: { id } });
  if (!row) throw new LoiKhoanVay("Không tìm thấy khoản tiền", "id");
  if (KHOA_CHA.some((k) => row[k] !== cha[k])) {
    throw new LoiKhoanVay(
      "Khoản tiền này vừa được sửa sang mục khác — mở lại trang rồi xoá lại",
      "id"
    );
  }
  return row;
}

/**
 * Ghi bản sửa KÈM HÀNG RÀO cha: câu UPDATE chỉ khớp khi dòng VẪN đang gắn đúng khoản vay / sổ tiết
 * kiệm của bản đọc ngoài transaction.
 *
 * Vì sao cần: khoá `FOR UPDATE` phía trên giành theo `loanId`/`savingsId` đọc NGOÀI transaction. Nếu
 * giữa lượt đọc đó và lượt giành khoá có một lượt sửa khác chuyển dòng sang cha KHÁC, ta đang khoá
 * nhầm cha — cha mới không bị khoá, không `chanDuNoAm`/`chanTienGuiAm`/`chanSoDuTietKiemAm` nào chạm
 * tới nó, và dư nợ / số đang gửi của nó lệch IM LẶNG. Đường XOÁ đã có hàng rào này (`docLaiTrongTx`);
 * đây là bản soi gương cho đường SỬA.
 *
 * Dùng `updateMany` thay vì đọc-rồi-ghi: điều kiện nằm TRONG chính câu ghi nên không còn khe giữa
 * phép kiểm và phép ghi. Rẻ hơn `docLaiTrongTx` một round-trip vì đường SỬA không phải chụp thùng rác.
 *
 * `count === 0` gộp hai ca "dòng không còn" và "cha đã đổi" — cùng một cách xử lý cho chủ shop là mở
 * lại trang, nên không tách thông điệp.
 *
 * ⚠️ Kẹp theo `truoc.*`, TUYỆT ĐỐI không theo `data.*`: `transform` của `cashMovementSchema` đã đặt
 * lại `loanId`/`savingsId` theo `kind`, nên `data.*` là giá trị MỚI muốn ghi — lấy nó làm điều kiện
 * thì hàng rào tự khớp chính mình và mất tác dụng.
 */
async function ghiCoHangRaoCha(
  db: Prisma.TransactionClient,
  id: string,
  truoc: KhoaCha,
  data: CashMovementData
): Promise<void> {
  const { count } = await db.cashMovement.updateMany({
    where: {
      id,
      loanId: truoc.loanId,
      savingsId: truoc.savingsId,
      cardId: truoc.cardId,
      phieuNhapId: truoc.phieuNhapId,
      viAdsId: truoc.viAdsId,
    },
    data,
  });
  if (count === 0) {
    throw new LoiKhoanVay(
      "Khoản tiền này vừa được sửa sang mục khác — mở lại trang rồi sửa lại",
      "id"
    );
  }
}

/**
 * Khoản đã TẤT TOÁN là sổ đã chốt: không nhận dòng mới, mà cũng không cho gỡ/xoá dòng cũ ra khỏi
 * nó — dư nợ đang bằng 0 nhờ đúng những dòng đó.
 */
async function kiemKhoanConHieuLuc(tx: Prisma.TransactionClient, loanId: string): Promise<void> {
  const loan = await tx.loan.findUnique({ where: { id: loanId }, select: { closedAt: true } });
  if (!loan) throw new LoiKhoanVay("Không tìm thấy khoản vay", "loanId");
  if (loan.closedAt !== null) throw new LoiKhoanVay("Khoản vay đã tất toán", "loanId");
}

/**
 * Cổng cho mọi dòng gắn SỔ TIẾT KIỆM, chạy TRONG transaction ghi (sau khi đã giành khoá dòng
 * `SoTietKiem`):
 *  - sổ phải tồn tại và còn hiệu lực (`kiemSoTietKiemConHieuLuc` — vị từ DÙNG CHUNG với đường app
 *    tự sinh ở `so-tiet-kiem.ts`, để hai đường không bao giờ lệch luật);
 *  - 1 sổ = TỐI ĐA 1 dòng GỬI. Spec §2 đã loại "gửi thêm vào sổ đang có" khỏi v1, và cả
 *    `xoaSoTietKiem` lẫn `moLaiSoTietKiem` đều nhận diện dòng do app sinh bằng chỗ dựa "dòng
 *    `SAVINGS_OUT` DUY NHẤT" — để lọt dòng gửi thứ hai là hai action đó mất mốc, sổ không xoá cũng
 *    không mở lại được.
 *
 * `SAVINGS_IN` chỉ đi qua phép kiểm ĐẦU rồi thoát: nhận lại bao nhiêu lần cũng được (ngân hàng có
 * thể trả làm nhiều đợt), cái chặn nó là `chanSoDuTietKiemAm` chạy SAU câu ghi.
 */
async function kiemSoTietKiem(
  tx: Prisma.TransactionClient,
  d: CashMovementData & { savingsId: string },
  idDangSua: string | null
): Promise<void> {
  await kiemSoTietKiemConHieuLuc(tx, d.savingsId);
  if (d.kind !== "SAVINGS_OUT") return;

  const daGui = await tx.cashMovement.count({
    where: {
      savingsId: d.savingsId,
      kind: "SAVINGS_OUT",
      ...(idDangSua === null ? {} : { id: { not: idDangSua } }),
    },
  });
  if (daGui > 0) {
    throw new LoiHopDong("Sổ này đã có dòng gửi — gửi thêm thì tạo sổ tiết kiệm mới", "savingsId");
  }
}

/** Dòng nhật ký OK của một lượt ghi `CashMovement` — gọi là câu CUỐI trong transaction ghi. */
async function ghiNhatKyDongTien(
  tx: Prisma.TransactionClient,
  nguoiDung: NguoiDung,
  hanhDong: "DONG_TIEN_TAO" | "DONG_TIEN_SUA" | "DONG_TIEN_XOA",
  id: string
): Promise<void> {
  await ghiNhatKy(tx, { actor: nguoiDung, hanhDong, doiTuong: { loai: "CashMovement", id } });
}

/**
 * Quyền THÊM cho dòng thuộc khối SỔ QUỸ (gắn khoản vay hoặc sổ tiết kiệm): ghi/sửa/xoá dòng đó là
 * đổi dư nợ / số đang gửi — đúng việc của `ghiKyTraNo`, tất toán, sổ tiết kiệm, vốn đều đòi
 * `tai-chinh-so-quy:sua`. Chỉ có quyền dòng tiền thì chỉ được đụng dòng trơn.
 *
 * Gọi SAU cổng dòng tiền và TRƯỚC mọi lượt đọc dư nợ / số đang gửi: câu lỗi của vị từ ("Vượt dư nợ
 * còn lại (thiếu X)") mang số tiền, để nó chạy trước cổng này là biến action thành máy dò dư nợ cho
 * người không được xem khoản vay.
 */
async function kiemQuyenDongGanSoQuy(nguoiDung: NguoiDung, ganSoQuy: boolean): Promise<KetQuaCong> {
  return ganSoQuy ? kiemThemQuyen(nguoiDung, "tai-chinh-so-quy:sua") : { ok: true, nguoiDung };
}

/**
 * Cổng của 4 loại nợ phải trả, chạy SAU zod (cần `kind`) và TRƯỚC transaction: đã bật theo dõi nợ
 * (`daBatNoPhaiTra` — chưa bật ⇒ `CHUA_BAT_NO_PHAI_TRA`) và ngày ∈ [M, hôm nay] (`ngayTienMoiSchema`,
 * spec §5.8: tiền trước M đã nằm trong số mở đầu, ghi lùi là trừ hai lần). `null` = qua cổng.
 */
async function congNoPhaiTra(date: Date): Promise<ActionResult | null> {
  let mocM: Date;
  try {
    mocM = await daBatNoPhaiTra();
  } catch (e) {
    if (e instanceof LoiChuaBat) return { ok: false, code: e.code, error: e.message };
    throw e;
  }
  const ngay = ngayTienMoiSchema(mocM).safeParse(date);
  if (!ngay.success) {
    return { ok: false, field: "date", error: ngay.error.issues[0]?.message ?? "Ngày không hợp lệ" };
  }
  return null;
}

/** Một phía (trước/sau) của lượt ghi dòng nợ phải trả, cho `kiemHoSoNo`. */
function phiaNo(d: KhoaCha & { kind: CashMovementKindTatCa; date: Date; amount: number }): DongHoSoNo {
  return {
    kind: d.kind,
    date: d.date,
    amount: d.amount,
    cardId: d.cardId,
    phieuNhapId: d.phieuNhapId,
    viAdsId: d.viAdsId,
  };
}

/** Đòi quyền Sổ quỹ khi dòng gắn khoản vay / sổ tiết kiệm HOẶC thuộc trục nợ phải trả (spec §5.7). */
function canQuyenSoQuy(kind: CashMovementKindTatCa): boolean {
  return kindGanSoQuy(kind) || kindNoPhaiTra(kind);
}

export async function createCashMovement(input: unknown): Promise<ActionResult> {
  const c = await congAction("tai-chinh-dong-tien:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = cashMovementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapLoi(parsed.error) };
  const data = parsed.data;
  const quyenSoQuy = await kiemQuyenDongGanSoQuy(nguoiDung, canQuyenSoQuy(data.kind));
  if (!quyenSoQuy.ok) return quyenSoQuy;

  try {
    if (isKindNoPhaiTraGhiTay(data.kind)) {
      const cong = await congNoPhaiTra(data.date);
      if (cong) return cong;
      await prisma.$transaction(async (tx) => {
        // Khoá hồ sơ TRƯỚC khi đọc trạng thái (thẻ đóng? phiếu huỷ?) — xem `ho-so-dong-tien-no.ts`.
        await khoaHoSoNo(tx, [data]);
        await kiemHoSoNo(tx, { truoc: null, sau: phiaNo(data) });
        const row = await tx.cashMovement.create({ data });
        // SAU câu ghi, phiếu đã khoá: hoàn tiền không vượt số đã trả (khuôn `chanDuNoAm`).
        await chanHoanVuotDaTra(tx, [data.phieuNhapId]);
        await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_TAO", row.id);
      }, OPT_TX_DONG_TIEN);
      lamMoiTrang();
    } else if (data.loanId === null && data.savingsId === null) {
      // Bọc transaction chỉ để dòng nhật ký đi CÙNG câu ghi: nhật ký ném ⇒ dòng tiền không lưu.
      await prisma.$transaction(async (tx) => {
        const row = await tx.cashMovement.create({ data });
        await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_TAO", row.id);
      });
      revalidatePath("/tai-chinh");
    } else {
      const loanId = data.loanId;
      const savingsId = data.savingsId;
      await prisma.$transaction(
        async (tx) => {
          // THỨ TỰ KHOÁ CỐ ĐỊNH TOÀN APP: `Loan` trước, `SoTietKiem` sau. Một dòng không thể mang cả
          // hai (CHECK `CashMovement_loan_savings_loai_tru`), nhưng `updateCashMovement` CÓ thể
          // chuyển dòng từ trục này sang trục kia ⇒ hai bảng cùng bị khoá trong một transaction. Đảo
          // thứ tự ở một đường ghi là hai lượt giữ chéo nhau rồi Postgres huỷ một bên.
          //
          // Khoá TRƯỚC mọi thứ: vị từ dư nợ / số đang gửi đều cộng lại từ bảng dòng tiền, mà
          // isolation mặc định không thấy dòng chưa commit của lượt song song (xem `vi-tu-du-no.ts`).
          if (loanId !== null) await khoaCacKhoanVay(tx, [loanId]);
          if (savingsId !== null) await khoaCacSoTietKiem(tx, [savingsId]);

          if (loanId !== null) await kiemKhoanVay(tx, { ...data, loanId }, null);
          if (savingsId !== null) await kiemSoTietKiem(tx, { ...data, savingsId }, null);

          const row = await tx.cashMovement.create({ data });

          // SAU câu ghi (kiểm trước là check-then-act). Một mình vị từ KHÔNG đủ — nó chỉ có răng khi
          // dòng cha đang bị khoá ở trên, nếu không hai lượt cùng đọc một cái tổng cũ.
          if (loanId !== null) {
            await chanDuNoAm(tx, loanId);
            // Trục thứ HAI của khoản vay: `chanDuNoAm` chỉ đếm dòng GỐC nên một dòng "Nhận lại tiền
            // gửi" vượt Σ ngân hàng đang giữ đi lọt qua nó mà quỹ vẫn phồng lên.
            await chanTienGuiAm(tx, loanId);
          }
          if (savingsId !== null) await chanSoDuTietKiemAm(tx, savingsId);
          // Câu CUỐI của transaction: mọi cổng dư nợ/số đang gửi đã qua ⇒ chỉ lượt ghi thật có dấu vết.
          await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_TAO", row.id);
        },
        OPT_TX_DONG_TIEN
      );
      lamMoiTrang();
    }
  } catch (e) {
    return { ok: false, ...loiGhi(e) };
  }

  return { ok: true, data: undefined };
}

/**
 * Dòng thuộc loại MỚI (nợ phải trả: `CARD_PAY`, `SUPPLIER_*`, `CUTOVER_*`, `ADS_TOPUP`) chỉ được sửa/xoá
 * ở khối riêng của nó — nơi giữ cổng mốc M, khoá hồ sơ cha và bất biến riêng. Action thường mà cho qua
 * thì (a) xoá được dòng theo id, (b) đổi `CUTOVER_ADJ_IN` thành `CAPITAL_IN` lọt êm CHECK (mọi khoá
 * hồ sơ NULL) ⇒ điều chỉnh mở sổ đổi nghĩa không ai biết, (c) đổi `CARD_PAY` sang kind cũ nổ 23514
 * chung chung vì `cardId` không được gỡ. Bảng đã ẩn nút, nhưng action nhận id thẳng nên phải chặn ở đây.
 */
const TU_CHOI_KIND_NO_PHAI_TRA = {
  ok: false,
  code: "KIND_CHUA_HO_TRO",
  error: "Dòng này thuộc loại mới (nợ phải trả) — sửa/xoá ở khối tương ứng",
} as const satisfies ActionResult;

/**
 * Đổi dòng giữa nhóm loại CŨ (khoản vay / sổ tiết kiệm / dòng trơn) và nhóm NỢ PHẢI TRẢ: hai nhóm có
 * hai bộ cổng + hai bộ khoá cha khác nhau (`Loan`/`SoTietKiem` vs thẻ/phiếu/ví), và nhóm nợ còn cửa sổ
 * ngày ≥ M. Gộp cả hai vào một lượt sửa là bốn bảng cha trong một transaction — rẻ hơn hẳn là bảo xoá
 * rồi ghi lại (dòng xoá vào thùng rác, khôi phục được).
 */
const TU_CHOI_DOI_NHOM = {
  ok: false,
  code: "DOI_NHOM_LOAI",
  field: "kind",
  error: "Không đổi được giữa loại nợ phải trả và loại thường — xoá dòng này rồi ghi lại đúng loại",
} as const satisfies ActionResult;

export async function updateCashMovement(id: string, input: unknown): Promise<ActionResult> {
  const c = await congAction("tai-chinh-dong-tien:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = cashMovementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapLoi(parsed.error) };
  const data = parsed.data;

  try {
    const truoc = await prisma.cashMovement.findUnique({
      where: { id },
      select: { kind: true, date: true, amount: true, ...SELECT_CHA },
    });
    if (!truoc) return { ok: false, error: "Không tìm thấy khoản tiền" };
    // `CUTOVER_*` (điều chỉnh mở sổ): chỉ sửa số/mô tả qua `suaDieuChinhChuyenDoi` (chủ shop).
    if (!isCashMovementKindGhiTay(truoc.kind)) return TU_CHOI_KIND_NO_PHAI_TRA;
    if (isKindNoPhaiTraGhiTay(truoc.kind) !== isKindNoPhaiTraGhiTay(data.kind)) return TU_CHOI_DOI_NHOM;
    // Loại MỚI hoặc dòng CŨ thuộc khối Sổ quỹ — gỡ một dòng ra khỏi khoản vay cũng đổi dư nợ khoản đó.
    const quyenSoQuy = await kiemQuyenDongGanSoQuy(
      nguoiDung,
      canQuyenSoQuy(data.kind) || canQuyenSoQuy(truoc.kind) || truoc.loanId !== null || truoc.savingsId !== null
    );
    if (!quyenSoQuy.ok) return quyenSoQuy;

    if (isKindNoPhaiTraGhiTay(data.kind)) {
      const cong = await congNoPhaiTra(data.date);
      if (cong) return cong;
      await prisma.$transaction(async (tx) => {
        // Đổi thẻ A → B (hay phiếu, ví) đổi nợ của CẢ HAI ⇒ khoá cả cha cũ lẫn cha mới, thứ tự cố định.
        await khoaHoSoNo(tx, [truoc, data]);
        await kiemHoSoNo(tx, { truoc: phiaNo(truoc), sau: phiaNo(data) });
        await ghiCoHangRaoCha(tx, id, truoc, data);
        // Cả phiếu cũ (bớt một dòng trả) lẫn phiếu mới (thêm một dòng hoàn) đều có thể vượt trần.
        await chanHoanVuotDaTra(tx, [truoc.phieuNhapId, data.phieuNhapId]);
        await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_SUA", id);
      }, OPT_TX_DONG_TIEN);
      lamMoiTrang();
      return { ok: true, data: undefined };
    }

    // Đổi dòng từ khoản vay A sang B (hay bỏ hẳn liên kết) làm dư nợ của CẢ HAI khoản đổi theo — và
    // đúng luật đó cho trục sổ tiết kiệm. Dòng chuyển HẲN trục (vay → sổ) chạm cả hai bảng cha.
    const khoanVayCanKiem = [...new Set([truoc.loanId, data.loanId])].filter(
      (x): x is string => x !== null
    );
    const soCanKiem = [...new Set([truoc.savingsId, data.savingsId])].filter(
      (x): x is string => x !== null
    );

    if (khoanVayCanKiem.length === 0 && soCanKiem.length === 0) {
      // Vẫn phải có hàng rào: dòng đang trơn có thể vừa được gắn vào một khoản vay / sổ ở lượt khác,
      // mà nhánh này KHÔNG giành khoá cha nào — ghi đè thẳng sẽ gỡ dòng khỏi cha đó không ai hay.
      await prisma.$transaction(async (tx) => {
        await ghiCoHangRaoCha(tx, id, truoc, data);
        await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_SUA", id);
      });
      revalidatePath("/tai-chinh");
    } else {
      await prisma.$transaction(
        async (tx) => {
          // Thứ tự khoá cố định: `Loan` trước, `SoTietKiem` sau (xem chú thích ở `createCashMovement`).
          await khoaCacKhoanVay(tx, khoanVayCanKiem);
          await khoaCacSoTietKiem(tx, soCanKiem);

          // Gỡ/chuyển dòng RA KHỎI khoản cũ cũng đổi dư nợ khoản đó ⇒ khoản cũ phải còn hiệu lực.
          if (truoc.loanId !== null && truoc.loanId !== data.loanId) {
            await kiemKhoanConHieuLuc(tx, truoc.loanId);
          }
          // Cùng luật cho sổ: sổ đã tất toán là sổ đã chốt, không cho rút dòng cũ ra khỏi nó.
          if (truoc.savingsId !== null && truoc.savingsId !== data.savingsId) {
            await kiemSoTietKiemConHieuLuc(tx, truoc.savingsId);
          }

          if (data.loanId !== null) await kiemKhoanVay(tx, { ...data, loanId: data.loanId }, id);
          if (data.savingsId !== null) {
            await kiemSoTietKiem(tx, { ...data, savingsId: data.savingsId }, id);
          }

          await ghiCoHangRaoCha(tx, id, truoc, data);

          for (const khoan of khoanVayCanKiem) {
            await chanDuNoAm(tx, khoan);
            await chanTienGuiAm(tx, khoan);
          }
          for (const so of soCanKiem) await chanSoDuTietKiemAm(tx, so);
          await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_SUA", id);
        },
        OPT_TX_DONG_TIEN
      );
      lamMoiTrang();
    }
  } catch (e) {
    return { ok: false, ...loiGhi(e) };
  }

  return { ok: true, data: undefined };
}

export async function deleteCashMovement(id: string): Promise<ActionResult> {
  const c = await congAction("tai-chinh-dong-tien:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    // Đọc NGOÀI transaction chỉ để chọn nhánh (có cha hay không) và báo "không tìm thấy" sớm. Bản
    // đem CHỤP phải đọc lại BÊN TRONG transaction — xem `docLaiTrongTx`.
    const truoc = await prisma.cashMovement.findUnique({
      where: { id },
      select: { kind: true, date: true, amount: true, ...SELECT_CHA },
    });
    if (!truoc) return { ok: false, error: "Không tìm thấy khoản tiền" };
    // `CUTOVER_*` cố định một lần ở bước bật (spec §5.8) — không có đường xoá thường.
    if (!isCashMovementKindGhiTay(truoc.kind)) return TU_CHOI_KIND_NO_PHAI_TRA;

    const loanId = truoc.loanId;
    const savingsId = truoc.savingsId;
    const quyenSoQuy = await kiemQuyenDongGanSoQuy(
      nguoiDung,
      loanId !== null || savingsId !== null || canQuyenSoQuy(truoc.kind)
    );
    if (!quyenSoQuy.ok) return quyenSoQuy;

    if (isKindNoPhaiTraGhiTay(truoc.kind)) {
      await prisma.$transaction(async (tx) => {
        await khoaHoSoNo(tx, [truoc]);
        // Xoá trả thẻ của thẻ ĐÃ ĐÓNG là làm dư nợ của nó khác 0 — cùng luật "sổ đã chốt" với khoản vay.
        await kiemHoSoNo(tx, { truoc: phiaNo(truoc), sau: null });
        const row = await docLaiTrongTx(tx, id, truoc);
        await chupVaoThungRac(tx, { bang: "CashMovement", banGhi: row });
        await tx.cashMovement.delete({ where: { id } });
        // Xoá một dòng TRẢ khi phiếu đã được hoàn là hạ trần dưới số đã hoàn — ca đối xứng của hoàn vượt.
        await chanHoanVuotDaTra(tx, [truoc.phieuNhapId]);
        await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_XOA", id);
      }, OPT_TX_DONG_TIEN);
      lamMoiTrang();
    } else if (loanId === null && savingsId === null) {
      // Dòng trơn vốn xoá thẳng không transaction — nay phải có, vì chụp ảnh và câu xoá bắt buộc
      // đi cùng một lượt: chụp mà không xoá được là để lại dòng rác, xoá mà không chụp là mất hẳn.
      await prisma.$transaction(async (tx) => {
        const row = await docLaiTrongTx(tx, id, truoc);
        await chupVaoThungRac(tx, { bang: "CashMovement", banGhi: row });
        await tx.cashMovement.delete({ where: { id } });
        await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_XOA", id);
      });
      revalidatePath("/tai-chinh");
    } else {
      await prisma.$transaction(
        async (tx) => {
          // Thứ tự khoá cố định: `Loan` trước, `SoTietKiem` sau.
          if (loanId !== null) await khoaCacKhoanVay(tx, [loanId]);
          if (savingsId !== null) await khoaCacSoTietKiem(tx, [savingsId]);

          if (loanId !== null) await kiemKhoanConHieuLuc(tx, loanId);
          if (savingsId !== null) await kiemSoTietKiemConHieuLuc(tx, savingsId);

          // Chụp SAU các cổng, TRƯỚC câu xoá: cổng ném là rollback trọn nên không đẻ dòng rác cho
          // một lượt xoá bị từ chối. Bản ghi đọc lại ở đây (đã giữ khoá cha) mới là bản THẬT sắp xoá.
          const row = await docLaiTrongTx(tx, id, truoc);
          await chupVaoThungRac(tx, { bang: "CashMovement", banGhi: row });
          await tx.cashMovement.delete({ where: { id } });

          if (loanId !== null) {
            await chanDuNoAm(tx, loanId);
            await chanTienGuiAm(tx, loanId);
          }
          if (savingsId !== null) await chanSoDuTietKiemAm(tx, savingsId);
          await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_XOA", id);
        },
        OPT_TX_DONG_TIEN
      );
      lamMoiTrang();
    }
  } catch (e) {
    // Lượt XOÁ tiền bị từ chối/hỏng cũng để dấu vết (LOI) — ghi bằng client gốc sau rollback.
    await ghiNhatKyLoi({
      actor: nguoiDung,
      hanhDong: "DONG_TIEN_XOA",
      doiTuong: { loai: "CashMovement", id },
      ghiChu: { lyDo: maLoiNhatKy(e) },
    });
    // Xoá KHÔNG BAO GIỜ làm dư nợ âm trừ đúng một ca: bỏ dòng giải ngân khi đã trả bớt gốc. Nói
    // thẳng ca đó thay vì câu "vượt dư nợ" chung chung (chủ shop đang xoá, không nhập số nào).
    if (e instanceof LoiDuNoAm) {
      return {
        ok: false,
        error: "Khoản vay này đã có lần trả gốc — xoá dòng giải ngân sẽ làm dư nợ âm",
      };
    }
    // Cùng khuôn cho trục tiền gửi BẮT BUỘC: xoá một dòng GỬI mà phần NHẬN LẠI đã ghi rồi thì số
    // ngân hàng đang giữ hoá âm — nói thẳng ca đó thay vì câu "vượt tiền gửi".
    if (e instanceof LoiTienGuiAm) {
      return {
        ok: false,
        error: "Khoản vay này đã nhận lại tiền gửi — xoá dòng gửi sẽ làm số ngân hàng giữ âm",
      };
    }
    // Và cho trục SỔ TIẾT KIỆM SINH LÃI. Câu phải nhắc đúng chữ "sổ tiết kiệm" để chủ shop không
    // đọc nhầm sang khoản vay — hai trục dùng hai bảng cha khác nhau.
    if (e instanceof LoiSoDuTietKiemAm) {
      return {
        ok: false,
        error: "Sổ tiết kiệm này đã nhận lại gốc — xoá dòng gửi sẽ làm số đang gửi âm",
      };
    }
    return { ok: false, ...loiGhi(e) };
  }

  return { ok: true, data: undefined };
}

const suaDieuChinhSchema = z.object({
  amount: z.coerce
    .number()
    .int("Số tiền phải là số nguyên")
    .positive("Số tiền phải lớn hơn 0")
    .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
  // CHECK `CUTOVER_* ⇒ btrim(description) <> ''` không bắt TAB/NBSP — `trim()` của JS bắt (review P1 (c)).
  description: z.string().trim().min(1, "Ghi rõ lý do điều chỉnh").max(200, "Tối đa 200 ký tự"),
});

/**
 * Sửa một dòng ĐIỀU CHỈNH MỞ SỔ NỢ (`CUTOVER_ADJ_IN`/`OUT`) — CHỈ chủ shop, CHỈ số tiền + mô tả (spec
 * §5.8: "một lần, cố định"; ngày luôn = M, loại không đổi). Đường sửa/xoá thường từ chối kind này
 * (`KIND_CHUA_HO_TRO`): đổi nó thành `CAPITAL_IN` lọt êm CHECK DB mà điều chỉnh đổi nghĩa không ai biết.
 *
 * Câu ghi kẹp `kind ∈ CUTOVER_*` NGAY TRONG `updateMany` — không có khe đọc-rồi-ghi.
 */
export async function suaDieuChinhChuyenDoi(id: string, input: unknown): Promise<ActionResult> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = suaDieuChinhSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };

  try {
    // Dòng điều chỉnh chỉ tồn tại sau bước bật; cổng vẫn gọi để mọi đường ghi tiền mới đi cùng một cửa.
    await daBatNoPhaiTra();
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.cashMovement.updateMany({
        where: { id, kind: { in: [...KIND_CUTOVER] as ("CUTOVER_ADJ_IN" | "CUTOVER_ADJ_OUT")[] } },
        data: { amount: parsed.data.amount, description: parsed.data.description },
      });
      if (count === 0) throw new LoiKhoanVay("Không tìm thấy dòng điều chỉnh mở sổ nợ", "id");
      await ghiNhatKyDongTien(tx, nguoiDung, "DONG_TIEN_SUA", id);
    });
  } catch (e) {
    if (e instanceof LoiChuaBat) return { ok: false, code: e.code, error: e.message };
    return { ok: false, ...loiGhi(e) };
  }
  lamMoiTrang();
  return { ok: true, data: undefined };
}
