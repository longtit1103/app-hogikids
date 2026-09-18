"use server";

import { Prisma } from "@prisma/client";
import { format, startOfDay } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import {
  cungNgay,
  LoiHopDong,
  loiKhoanVay,
  OPT_TX,
  soTienKySchema,
} from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { ngayGhiTaySchema } from "@/lib/actions/ngay-ghi-tay-schema";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { formatVnd } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { listKhoanVay, type KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import { lyDoKhongXoaKhoanVay } from "@/lib/so-quy/ly-do-khong-xoa-khoan-vay";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";
import { chanDuNoAm, khoaKhoanVay, tienGuiDangGiu } from "@/lib/so-quy/vi-tu-du-no";

/**
 * 5 server action quản lý khoản vay (spec §5.3) — khối "Khoản vay" trong tab Dòng tiền. Action thứ
 * 6, `tatToanThauChi`, ở file riêng `tat-toan-thau-chi.ts` (phần dùng chung ở `khoan-vay-chung.ts`).
 *
 * Bất biến của cả file: bảng `Loan` chỉ là HỒ SƠ, TUYỆT ĐỐI không tự sinh dòng tiền ngoài luồng.
 * Mọi đồng vào/ra vẫn đi qua đúng một cửa — GỐC vay qua `CashMovement` (`LOAN_IN`/`LOAN_REPAY` gắn
 * `loanId`), LÃI vay qua `Expense` danh mục `interest`, TIỀN GỬI tiết kiệm bắt buộc qua
 * `CashMovement` (`DEPOSIT_OUT`/`DEPOSIT_IN` gắn `loanId`) — tiền gửi TUYỆT ĐỐI không bao giờ là
 * `Expense`: nó vẫn là tiền của chủ shop, ngân hàng giữ hộ rồi cấn trừ vào gốc lúc tất toán. Dư nợ
 * không có cột riêng: luôn suy lại từ chính các dòng GỐC (`vi-tu-du-no.ts`) — tiền gửi KHÔNG nằm
 * trong phép cộng đó nên không có chỗ nào để lệch với sổ.
 *
 * Hai cổng chống ghi trùng kỳ, cố ý độc lập nhau:
 *  1. `loan.updateMany` kèm điều kiện con dấu `lastDueHandled` NGAY TRONG câu UPDATE (fencing) —
 *     hai tab bấm cùng lúc thì chỉ một câu đổi được dòng;
 *  2. `Expense.refId @unique` = `LOAN:{loanId}:{yyyy-MM-dd}`.
 * Con dấu so bằng phép "<" (đơn điệu) nên sửa `firstDueDate`/`termMonths` sau này không làm kẹt.
 *
 * Mọi action ở đây PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` — phép quét
 * AST chỉ đọc THÂN HÀM export nên `dangPhucHoi()` phải gọi trực tiếp ở đây, không uỷ quyền.
 */

/** Trần 2 tỷ: Prisma Int (int32) chết ở 2.147.483.647 — cùng ngưỡng, cùng câu với `expenses.ts`. */
const soTienDuongSchema = z.coerce
  .number()
  .int("Số tiền phải là số nguyên")
  .positive("Số tiền phải lớn hơn 0")
  .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)");

/**
 * Ngày trả kỳ ĐẦU nằm ở TƯƠNG LAI trong đại đa số ca ⇒ KHÔNG dùng `ngayGhiTaySchema` (schema đó
 * chặn ngày tương lai vì nó dành cho dòng tiền đã phát sinh). Vẫn giữ chốt sanity năm ≥ 2000 để ô
 * Ngày bị xoá trống (null ⇒ 01/01/1970) không lọt.
 */
const ngayKyDauSchema = z.coerce
  .date()
  .refine((d) => d.getFullYear() >= 2000, "Ngày không hợp lệ");

const LOI_LAI_SUAT = "Lãi suất 0–100%/năm";
const LOI_KY_HAN = "Kỳ hạn 1–600 tháng";

/**
 * BULLET (vay trả gốc cuối kỳ) KHÔNG có ca "không lịch trả": không biết kỳ hạn thì không biết kỳ nào
 * là kỳ trả TRỌN gốc, và CHECK `Loan_lich_theo_loai` dưới DB cũng đòi đủ `termMonths` +
 * `firstDueDate`. Form gốc cuối kỳ luôn gửi `coLich = true`, nhưng suy lại ở đây để một payload
 * thiếu cờ không rơi xuống `transform` — chỗ đó ép NULL cả hai rồi khoản vay im lặng mất lịch, sau
 * đó DB mới ném lỗi Postgres thô.
 */
function coLichTheoLoai(kind: "TERM" | "OVERDRAFT" | "BULLET", coLich: boolean): boolean {
  return kind === "BULLET" || coLich;
}

const khoanVaySchema = z
  .object({
    name: z.string().trim().min(1, "Nhập tên khoản vay").max(60, "Tối đa 60 ký tự"),
    lender: z.string().trim().max(60, "Tối đa 60 ký tự").default(""),
    // Lãi %/năm × 100 (10,5% = 1050) — Int, không Decimal (repo tuyệt đối Int).
    annualRateBp: z.coerce.number().int(LOI_LAI_SUAT).min(0, LOI_LAI_SUAT).max(10_000, LOI_LAI_SUAT),
    /**
     * TERM = vay kỳ hạn (mặc định, giữ nguyên mọi hành vi cũ). OVERDRAFT = thấu chi: KHÔNG có lịch
     * trả gốc nên `termMonths` LUÔN bị ép NULL ở `transform`, còn `coLich` chỉ còn điều khiển ngày
     * THU LÃI kỳ đầu. BULLET = trả gốc cuối kỳ: đủ `termMonths` + `firstDueDate` như vay kỳ hạn,
     * gốc dồn hết vào kỳ cuối, lãi thường khai CỐ ĐỊNH theo số tiền. Khoá vĩnh viễn sau khi tạo
     * (xem `suaKhoanVay`).
     *
     * ⚠️ `.default("TERM")`: quên thêm một loại vào danh sách này là khoản mới ÂM THẦM thành vay kỳ
     * hạn — zod chạy lúc runtime nên `tsc` KHÔNG bắt được.
     */
    kind: z
      .enum(["TERM", "OVERDRAFT", "BULLET"], { message: "Loại khoản vay không hợp lệ" })
      .default("TERM"),
    coLich: z.boolean().default(false),
    termMonths: z.coerce.number().int(LOI_KY_HAN).min(1, LOI_KY_HAN).max(600, LOI_KY_HAN).nullable().optional(),
    firstDueDate: ngayKyDauSchema.nullable().optional(),
    // Trần 2000 khớp `GIOI_HAN_GHI_CHU`: app tự nối dòng "Bỏ qua kỳ …" vào chính ô này, nên trần
    // của ô nhập phải chứa nổi cả phần vết — nếu không, sau vài kỳ bỏ qua thì form Sửa prefill
    // nguyên ghi chú rồi gửi lại sẽ bị chính zod chặn, khoá luôn nút Sửa.
    note: z.string().trim().max(2000, "Tối đa 2000 ký tự").default(""),
    cheDo: z.enum(["moi", "mang-sang"], { message: "Chọn cách khai khoản vay" }),
    soTienGiaiNgan: soTienDuongSchema.optional(),
    ngayGiaiNgan: ngayGhiTaySchema.optional(),
    duNoMoSo: soTienDuongSchema.optional(),
    startDate: ngayGhiTaySchema.optional(),
    /**
     * Lãi CỐ ĐỊNH mỗi kỳ theo số tiền ngân hàng chốt trên giấy — CHỈ khoản BULLET được khai. Dùng
     * `soTienKySchema` (cho phép 0) chứ không `soTienDuongSchema`: vay không lãi là trạng thái hợp
     * lệ, và 0 KHÔNG được làm sentinel "chưa khai" — vắng/`null` mới là "tính theo %/năm như cũ".
     */
    laiCoDinhMoiKy: soTienKySchema.nullable().optional(),
    /**
     * Tiền gửi tiết kiệm bắt buộc mỗi kỳ (0 = không có) — thuộc tính CHỈ CỦA `BULLET`, xem
     * `superRefine`. DÒNG TIỀN thuần — TUYỆT ĐỐI không bao giờ thành `Expense`.
     */
    tienGuiBatBuocMoiKy: soTienKySchema.default(0),
  })
  .superRefine((d, ctx) => {
    const thauChi = d.kind === "OVERDRAFT";
    // Khai lãi cố định cho khoản TERM/OVERDRAFT là số CHẾT: `deXuatKy` chỉ đọc nó ở nhánh BULLET.
    // Nhận im lặng rồi lờ đi là hứa một con số app không dùng ⇒ từ chối thẳng tại ô.
    if (d.kind !== "BULLET" && d.laiCoDinhMoiKy !== undefined && d.laiCoDinhMoiKy !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["laiCoDinhMoiKy"],
        message: "Chỉ khoản vay trả gốc cuối kỳ mới khai lãi cố định",
      });
    }
    /**
     * SỔ TIẾT KIỆM BẮT BUỘC chỉ thuộc về BULLET. Không phải vì ngân hàng khác không kèm điều kiện
     * đó, mà vì đường TẤT TOÁN của loại khác KHÔNG biết hoàn: `tat-toan-thau-chi.ts` set `closedAt`
     * mà không ghi `DEPOSIT_IN`, rồi `kiemKhoanVay` chặn mọi lượt ghi vào khoản đã đóng ⇒ tiền của
     * chủ shop mất dấu VĨNH VIỄN khỏi quỹ. Chặn tận cửa vào rẻ và chắc hơn dạy mọi đường tất toán.
     *
     * BÁO LỖI tại ô chứ KHÔNG ép 0 im lặng: ép im lặng là nuốt mất con số chủ shop vừa gõ, rồi mỗi
     * kỳ ngân hàng thu 300k mà sổ không có dòng nào.
     */
    if (d.kind !== "BULLET" && d.tienGuiBatBuocMoiKy > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["tienGuiBatBuocMoiKy"],
        message: "Chỉ khoản vay trả gốc cuối kỳ mới có tiền gửi tiết kiệm bắt buộc",
      });
    }
    if (coLichTheoLoai(d.kind, d.coLich)) {
      // Thấu chi KHÔNG có kỳ hạn gốc: đòi `termMonths` ở đây là chặn nhầm đúng ca hợp lệ của nó.
      if (!thauChi && (d.termMonths === undefined || d.termMonths === null)) {
        ctx.addIssue({ code: "custom", path: ["termMonths"], message: "Nhập kỳ hạn (số tháng)" });
      }
      if (!d.firstDueDate) {
        ctx.addIssue({
          code: "custom",
          path: ["firstDueDate"],
          message: thauChi ? "Chọn ngày thu lãi kỳ đầu" : "Chọn ngày trả kỳ đầu",
        });
      }
    }
    if (d.cheDo === "moi") {
      if (d.soTienGiaiNgan === undefined) {
        ctx.addIssue({ code: "custom", path: ["soTienGiaiNgan"], message: "Nhập số tiền giải ngân" });
      }
      if (!d.ngayGiaiNgan) {
        ctx.addIssue({ code: "custom", path: ["ngayGiaiNgan"], message: "Chọn ngày giải ngân" });
      }
    } else {
      if (d.duNoMoSo === undefined) {
        ctx.addIssue({ code: "custom", path: ["duNoMoSo"], message: "Nhập dư nợ còn lại" });
      }
      if (!d.startDate) {
        ctx.addIssue({ code: "custom", path: ["startDate"], message: "Chọn ngày bắt đầu" });
      }
    }
    // `startDate` = due_0; kỳ 1 phải dài hơn 0 ngày, nếu không lãi kỳ đầu luôn bằng 0.
    const batDau = d.cheDo === "moi" ? d.ngayGiaiNgan : d.startDate;
    if (
      coLichTheoLoai(d.kind, d.coLich) &&
      d.firstDueDate &&
      batDau &&
      startOfDay(d.firstDueDate) <= startOfDay(batDau)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["firstDueDate"],
        message: thauChi
          ? "Ngày thu lãi kỳ đầu phải sau ngày rút"
          : "Ngày trả kỳ đầu phải sau ngày giải ngân",
      });
    }
  })
  .transform((d) => ({
    name: d.name,
    lender: d.lender,
    annualRateBp: d.annualRateBp,
    note: d.note,
    kind: d.kind,
    /** Giữ lại để `suaKhoanVay` từ chối lượt đổi chế độ (xem ở đó); `taoKhoanVay` không dùng. */
    cheDo: d.cheDo,
    /** Khoản mới: ngày giải ngân. Khoản mang sang: ngày chủ shop chọn làm mốc. Luôn `startOfDay`. */
    startDate: startOfDay((d.cheDo === "moi" ? d.ngayGiaiNgan : d.startDate) as Date),
    duNoMoSo: d.cheDo === "mang-sang" ? (d.duNoMoSo as number) : 0,
    /** > 0 ⇒ phải có ĐÚNG một dòng LOAN_IN đi kèm; 0 ⇒ khoản mang sang, KHÔNG dòng tiền nào. */
    giaiNgan: d.cheDo === "moi" ? (d.soTienGiaiNgan as number) : 0,
    /**
     * Thấu chi: ÉP NULL thay vì từ chối. Form ẩn ô kỳ hạn nhưng vẫn có thể gửi kèm giá trị cũ khi
     * chủ shop đổi loại giữa chừng — từ chối ở đó là một câu lỗi không ô nào sáng lên. CHECK
     * `Loan_lich_theo_loai` dưới DB là hàng rào cuối cho đường ghi thẳng.
     */
    termMonths:
      d.kind === "OVERDRAFT" || !coLichTheoLoai(d.kind, d.coLich)
        ? null
        : (d.termMonths as number),
    firstDueDate: coLichTheoLoai(d.kind, d.coLich)
      ? startOfDay(d.firstDueDate as Date)
      : null,
    /**
     * Ép NULL cho mọi loại KHÁC BULLET (`superRefine` đã từ chối ca khai nhầm — đây là hàng rào thứ
     * hai): một khoản còn sót số lãi cố định của lần khai trước sẽ đề xuất SAI tiền mỗi kỳ nếu về
     * sau `deXuatKy` được nới ra đọc cột này cho loại khác.
     */
    laiCoDinhMoiKy: d.kind === "BULLET" ? (d.laiCoDinhMoiKy ?? null) : null,
    /** Hàng rào thứ hai của cùng luật (`superRefine` đã từ chối ca khai nhầm), cùng khuôn lãi cố định. */
    tienGuiBatBuocMoiKy: d.kind === "BULLET" ? d.tienGuiBatBuocMoiKy : 0,
  }));

/**
 * Cờ MỞ LẠI khoản đã tất toán — tách khỏi `khoanVaySchema` vì `taoKhoanVay` dùng chung schema đó mà
 * không có khái niệm này. Đây là ĐƯỜNG DUY NHẤT xoá `closedAt`: tất toán nhầm (hoặc ngân hàng đòi
 * thêm một kỳ) mà không mở lại được thì chủ shop phải tạo khoản vay mới, dư nợ và lịch sử tách đôi.
 */
const moLaiSchema = z.object({ moLai: z.boolean().optional() });

const ghiKySchema = z.object({
  loanId: z.string().min(1, "Chọn khoản vay"),
  dueDate: ngayKyDauSchema,
  lai: soTienKySchema,
  goc: soTienKySchema,
  /**
   * Tiền gửi tiết kiệm bắt buộc của kỳ — như lãi/gốc, đây chỉ là ĐỀ XUẤT client gửi lên (chủ shop
   * sửa được theo giấy báo). `.default(0)` để mọi lượt gọi cũ (không biết khái niệm này) vẫn chạy
   * đúng như trước, không phải ca "tiền gửi undefined thành NaN".
   */
  tienGui: soTienKySchema.default(0),
  boQua: z.boolean().default(false),
});

export async function taoKhoanVay(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = khoanVaySchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const d = parsed.data;

  try {
    const id = await prisma.$transaction(async (tx) => {
      const loan = await tx.loan.create({
        data: {
          name: d.name,
          lender: d.lender,
          note: d.note,
          kind: d.kind,
          annualRateBp: d.annualRateBp,
          startDate: d.startDate,
          duNoMoSo: d.duNoMoSo,
          termMonths: d.termMonths,
          firstDueDate: d.firstDueDate,
          laiCoDinhMoiKy: d.laiCoDinhMoiKy,
          tienGuiBatBuocMoiKy: d.tienGuiBatBuocMoiKy,
        },
      });
      // BẤT BIẾN `LOAN_IN.date = startOfDay(Loan.startDate)`: dư nợ đếm theo NGÀY DÒNG TIỀN, còn
      // `startDate` là due_0 để đếm ngày kỳ 1 — hai mốc lệch nhau là dư nợ kỳ 1 sai.
      if (d.giaiNgan > 0) {
        await tx.cashMovement.create({
          data: {
            date: startOfDay(loan.startDate),
            kind: "LOAN_IN",
            amount: d.giaiNgan,
            loanId: loan.id,
            description: `Giải ngân ${d.name}`,
          },
        });
      }
      return loan.id;
    }, OPT_TX);

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    return { ok: false, ...loiKhoanVay(e, "Lỗi khi ghi khoản vay") };
  }
}

/**
 * Tên / bên cho vay / lãi suất / kỳ hạn / ngày trả kỳ đầu / ghi chú: LUÔN sửa được (con dấu đơn
 * điệu chịu được việc đổi lịch). Ngày bắt đầu, dư nợ mở sổ và số tiền giải ngân thì CHỈ khi khoản
 * chưa ghi kỳ nào và chưa có lần trả gốc — sửa sau đó là viết lại quá khứ đã vào Lãi/Lỗ.
 *
 * `moLai = true` gỡ `closedAt` (nút "Mở lại" ở khoản đã tất toán) — xem `moLaiSchema`.
 */
export async function suaKhoanVay(id: string, input: unknown): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = khoanVaySchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const d = parsed.data;
  const moLai = moLaiSchema.safeParse(input).data?.moLai === true;

  try {
    await prisma.$transaction(async (tx) => {
      // Khoá dòng `Loan` TRƯỚC khi đọc: lượt này ghi cả `note` lẫn nền dư nợ, chạy chồng với một
      // lượt duyệt kỳ hay một dòng trả gốc là mất vết / lệch dư nợ (xem `vi-tu-du-no.ts`).
      await khoaKhoanVay(tx, id);
      const loan = await tx.loan.findUnique({
        where: { id },
        select: { kind: true, startDate: true, duNoMoSo: true, lastDueHandled: true },
      });
      if (!loan) throw new LoiHopDong("Không tìm thấy khoản vay");

      // Loại khoản vay khoá VĨNH VIỄN, cùng lý do với chế độ: TERM và OVERDRAFT tính lãi bằng hai
      // công thức khác nhau (dư nợ đầu kỳ × số ngày · lãi theo ngày từng đoạn), nên đổi loại là
      // viết lại ý nghĩa của những kỳ ĐÃ ghi vào Sổ chi phí. Muốn khai lại thì tạo khoản mới.
      if (d.kind !== loan.kind) throw new LoiHopDong("Không đổi loại khoản vay sau khi tạo");

      // Chế độ khoá VĨNH VIỄN sau khi tạo. Đổi "moi" → "mang-sang" xoá dòng LOAN_IN — một dòng tiền
      // THẬT đã vào tài khoản — nên quỹ tụt đúng bằng số giải ngân, im lặng. Giả định ngầm "tiền đó
      // nằm trong số dư mở sổ" chỉ đúng khi giải ngân trước D0; muốn khai lại thì xoá rồi tạo mới.
      // Chế độ của bản ghi suy từ `duNoMoSo` — cùng luật với form (`trangThaiBanDau`).
      const cheDoCu = loan.duNoMoSo > 0 ? "mang-sang" : "moi";
      if (d.cheDo !== cheDoCu) {
        throw new LoiHopDong("Không đổi chế độ khoản vay sau khi tạo");
      }

      const dongGiaiNgan = await tx.cashMovement.findFirst({
        where: { loanId: id, kind: "LOAN_IN" },
        select: { id: true, amount: true },
      });
      const soTraGoc = await tx.cashMovement.count({
        where: { loanId: id, kind: "LOAN_REPAY" },
      });

      const doiNenTang =
        !cungNgay(d.startDate, loan.startDate) ||
        d.duNoMoSo !== loan.duNoMoSo ||
        d.giaiNgan !== (dongGiaiNgan?.amount ?? 0);
      if (doiNenTang && (loan.lastDueHandled !== null || soTraGoc > 0)) {
        throw new LoiHopDong(
          "Đã ghi kỳ trả — không sửa được ngày/số tiền giải ngân, chỉ tất toán"
        );
      }

      await tx.loan.update({
        where: { id },
        data: {
          name: d.name,
          lender: d.lender,
          note: d.note,
          annualRateBp: d.annualRateBp,
          termMonths: d.termMonths,
          firstDueDate: d.firstDueDate,
          // Sửa được cả sau khi đã ghi kỳ, cùng luật với `annualRateBp`: hai số này chỉ nuôi ĐỀ XUẤT
          // của kỳ SAU. Kỳ đã duyệt là dòng `Expense`/`CashMovement` có thật, sửa ở đây không đụng.
          laiCoDinhMoiKy: d.laiCoDinhMoiKy,
          tienGuiBatBuocMoiKy: d.tienGuiBatBuocMoiKy,
          // Chỉ chạm phần nền khi thật sự đổi: ghi đè `startDate` bằng giá trị "cùng ngày nhưng
          // khác giờ" sẽ lệch với ngày dòng LOAN_IN mà không ai thấy.
          ...(doiNenTang ? { startDate: d.startDate, duNoMoSo: d.duNoMoSo } : {}),
          // Đường DUY NHẤT xoá `closedAt`. Không set `closedAt` khi `moLai` tắt: một lượt sửa tên
          // của khoản đã tất toán không được âm thầm mở lại nó.
          ...(moLai ? { closedAt: null } : {}),
        },
      });

      if (doiNenTang) {
        if (d.giaiNgan > 0) {
          const data = { amount: d.giaiNgan, date: startOfDay(d.startDate) };
          if (dongGiaiNgan) {
            await tx.cashMovement.update({ where: { id: dongGiaiNgan.id }, data });
          } else {
            await tx.cashMovement.create({
              data: { ...data, kind: "LOAN_IN", loanId: id, description: `Giải ngân ${d.name}` },
            });
          }
        } else if (dongGiaiNgan) {
          // Không còn đường tới được từ UI/action (chế độ đã khoá ở trên): giữ làm hàng rào cuối cho
          // bản ghi cũ lỡ ở trạng thái lai (duNoMoSo > 0 mà vẫn còn dòng LOAN_IN).
          await tx.cashMovement.delete({ where: { id: dongGiaiNgan.id } });
        }
      }

      await chanDuNoAm(tx, id);
    }, OPT_TX);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiKhoanVay(e, "Lỗi khi sửa khoản vay") };
  }
}

export async function xoaKhoanVay(id: string): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    await prisma.$transaction(async (tx) => {
      await khoaKhoanVay(tx, id);
      const loan = await tx.loan.findUnique({
        where: { id },
        select: { lastDueHandled: true, duNoMoSo: true },
      });
      if (!loan) throw new LoiHopDong("Không tìm thấy khoản vay");

      const soTraGoc = await tx.cashMovement.count({
        where: { loanId: id, kind: "LOAN_REPAY" },
      });
      // Luật chặn KHÔNG đổi một chữ (con dấu kỳ hoặc dòng trả gốc ⇒ không xoá). Chỉ câu nói đổi:
      // bản cũ nói "Đã ghi kỳ trả" cho CẢ ca khoản trả gốc cuối kỳ mới duyệt đúng một kỳ lãi — chưa
      // trả đồng gốc nào — rồi chỉ sang "chỉ tất toán", mà tất toán lại đòi dư nợ về 0. Hai câu vòng
      // vào nhau. `lyDoKhongXoaKhoanVay` nói đúng trạng thái và chỉ đúng đường gỡ (hoặc nói thẳng là
      // không có), dùng chung với menu ⋯ ở client nên hai nơi không thể lệch nhau.
      // Tiền gửi tiết kiệm ghi TAY (không qua kỳ nên không có con dấu `lastDueHandled`) vẫn là tiền
      // THẬT đã rời tài khoản. Không chặn thì `deleteMany` bên dưới xoá luôn nó và quỹ nhảy lên đúng
      // bằng số ngân hàng đang giữ, im lặng. Đếm DÒNG chứ không cộng tiền: khoản đã gửi rồi nhận lại
      // hết có Σ = 0 mà dòng vẫn còn.
      //
      // Cổng này đi CHUNG vị từ với hai cổng trên thay vì giữ câu riêng: menu ⋯ ở client đọc cùng vị
      // từ, tách ra là hộp hứa "xoá được" rồi server mới ném toast đỏ cho đúng khoản đó.
      const soTienGui = await tx.cashMovement.count({
        where: { loanId: id, kind: { in: ["DEPOSIT_OUT", "DEPOSIT_IN"] } },
      });
      const lyDo = lyDoKhongXoaKhoanVay({
        coTraGoc: soTraGoc > 0,
        daDuyetKy: loan.lastDueHandled !== null,
        mangSang: loan.duNoMoSo > 0,
        coTienGui: soTienGui > 0,
      });
      if (lyDo !== null) throw new LoiHopDong(lyDo);

      // THÙNG RÁC — chụp CẢ CỤM sau khi mọi cổng đã qua, trước câu xoá đầu tiên.
      //
      // `SoTietKiem.loanId` là FK `SetNull`: xoá khoản vay làm liên kết sổ↔vay biến mất VĨNH VIỄN
      // và không bảng nào giữ lại dấu vết — phải chụp danh sách sổ đang trỏ tới TRƯỚC, nếu không
      // khôi phục sẽ trả về một khoản vay không còn sổ nào nhận là nguồn tiền của nó.
      const banGhi = await tx.loan.findUniqueOrThrow({ where: { id } });
      const dongTien = await tx.cashMovement.findMany({ where: { loanId: id } });
      const soTietKiemIds = (
        await tx.soTietKiem.findMany({ where: { loanId: id }, select: { id: true } })
      ).map((s) => s.id);
      await chupVaoThungRac(tx, {
        bang: "Loan",
        banGhi,
        cashMovements: dongTien,
        ghiChu: { soTietKiemIds },
      });

      // FK `onDelete: Restrict` là hàng rào cuối: phải dọn dòng LOAN_IN TRƯỚC rồi mới xoá hồ sơ.
      await tx.cashMovement.deleteMany({ where: { loanId: id } });
      await tx.loan.delete({ where: { id } });
    }, OPT_TX);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiKhoanVay(e, "Lỗi khi xoá khoản vay") };
  }
}

/**
 * Ngày tất toán — TUỲ CHỌN, mặc định hôm nay ⇒ hợp đồng cũ của `tatToanKhoanVay` KHÔNG đổi, mọi lượt
 * gọi một tham số vẫn chạy y như trước.
 *
 * Vì sao phải cho khai: lượt tất toán này nay GHI TIỀN THẬT (dòng `DEPOSIT_IN` hoàn sổ tiết kiệm).
 * Kỳ cuối đến hạn 10/05 mà chủ shop bấm ngày 03/06 thì cả 10.800.000đ rơi sang tháng 6, sổ quỹ
 * tháng 5 hụt đúng số đó. Dùng `ngayGhiTaySchema` (chặn ngày tương lai) như `tat-toan-thau-chi.ts`:
 * tiền đã chuyển rồi mới bấm.
 */
const tatToanInputSchema = z
  .object({ ngayTatToan: ngayGhiTaySchema.optional() })
  .optional();

export async function tatToanKhoanVay(id: string, input?: unknown): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = tatToanInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  // Không khai ⇒ hôm nay, đúng hành vi cũ. `startOfDay` giờ VN như mọi mốc dòng tiền khác.
  const ngayHoan = startOfDay(parsed.data?.ngayTatToan ?? new Date());

  try {
    await prisma.$transaction(async (tx) => {
      // Khoá TRƯỚC khi đọc dư nợ: không có nó, một dòng trả gốc/giải ngân commit ngay sau phép
      // kiểm sẽ để lại khoản "đã tất toán" mà dư nợ khác 0.
      await khoaKhoanVay(tx, id);
      const loan = await tx.loan.findUnique({
        where: { id },
        select: { name: true, closedAt: true, startDate: true },
      });
      if (!loan) throw new LoiHopDong("Không tìm thấy khoản vay");
      if (loan.closedAt !== null) throw new LoiHopDong("Khoản vay đã tất toán");

      // CẬN DƯỚI của ngày tất toán — cùng khuôn với `tat-toan-thau-chi.ts`, và cần vì đúng lý do đó:
      // lượt này GHI TIỀN THẬT (dòng hoàn `DEPOSIT_IN` = Σ tiền gửi). Kỳ cuối đến hạn 10/05 mà gõ
      // nhầm 30/04 thì cả Σ tiền gửi — phần lớn chưa hề rời tài khoản trước tháng 5 — đề ngày 30/04:
      // Sổ quỹ tháng 4 phồng đúng số đó, tháng 5 hụt đúng số đó. Ngày quá cũ còn kéo lùi D0 của Sổ
      // quỹ (`ngayMoSo()` = min(date) TOÀN BẢNG `CashMovement`), đổi số mọi tháng chủ shop đã xem.
      // Ô ngày ở client đã khai `min`; đây mới là cổng thật.
      if (ngayHoan < startOfDay(loan.startDate)) {
        throw new LoiHopDong(
          `Ngày tất toán phải từ ngày bắt đầu khoản vay (${format(loan.startDate, "dd/MM/yyyy")}) trở đi`,
          "ngayTatToan"
        );
      }

      // Lùi trước một dòng đã ghi (trả gốc / gửi tiết kiệm) = nói tiền về TRƯỚC ngày nó đi ra. Chặn
      // thẳng thay vì để lại một tháng có số không giải thích được.
      const mocCuoi = await tx.cashMovement.aggregate({
        where: { loanId: id, kind: { in: ["LOAN_REPAY", "DEPOSIT_OUT"] } },
        _max: { date: true },
      });
      const dongCuoi = mocCuoi._max.date;
      if (dongCuoi !== null && ngayHoan < startOfDay(dongCuoi)) {
        throw new LoiHopDong(
          `Ngày tất toán phải từ dòng tiền gần nhất của khoản (${format(dongCuoi, "dd/MM/yyyy")}) trở đi`,
          "ngayTatToan"
        );
      }

      const duNo = await chanDuNoAm(tx, id);
      if (duNo !== 0) {
        throw new LoiHopDong(`Còn dư nợ ${formatVnd(duNo)} — trả hết gốc trước khi tất toán`);
      }

      // CẤN TRỪ SỔ TIẾT KIỆM BẮT BUỘC: ngân hàng trả lại phần đang giữ hộ ⇒ ĐÚNG một dòng DEPOSIT_IN
      // bằng Σ đang giữ. Đọc SAU `khoaKhoanVay` nên không có ca một dòng tiền gửi commit chen giữa
      // lượt đọc và lượt ghi. Khoản không có tiền gửi (mọi khoản TERM/OVERDRAFT cũ) ⇒ Σ = 0 ⇒ KHÔNG
      // ghi dòng nào, hợp đồng cũ của action không đổi một chữ.
      //
      // PHẢI ghi TRƯỚC câu set `closedAt`: `kiemKhoanVay`/`kiemKhoanConHieuLuc` ở `cash-movements.ts`
      // từ chối mọi dòng gắn khoản đã đóng — dòng này không được là ngoại lệ ngầm của luật đó.
      //
      // KHÔNG gọi lại `chanDuNoAm` sau đây: DEPOSIT_IN không nằm trong `KIND_GOC` nên không thể đụng
      // dư nợ; phép kiểm ở trên vẫn là phép kiểm cuối của mọi dòng GỐC trong transaction này.
      const tienGui = await tienGuiDangGiu(tx, id);
      if (tienGui > 0) {
        await tx.cashMovement.create({
          data: {
            date: ngayHoan,
            kind: "DEPOSIT_IN",
            amount: tienGui,
            loanId: id,
            description: `Nhận lại tiền gửi tiết kiệm ${loan.name} — tất toán`,
          },
        });
      }

      await tx.loan.update({ where: { id }, data: { closedAt: new Date() } });
    }, OPT_TX);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiKhoanVay(e, "Lỗi khi tất toán khoản vay") };
  }
}

/** Ghi chú khoản vay chỉ để lại VẾT — cắt phần đầu khi quá dài thay vì để nó phình vô hạn. */
const GIOI_HAN_GHI_CHU = 2000;

/** Đọc ghi chú TRONG transaction (sau khi đã khoá dòng) — bản đọc ngoài tx có thể đã cũ. */
async function docGhiChu(tx: Prisma.TransactionClient, loanId: string): Promise<string> {
  const loan = await tx.loan.findUnique({ where: { id: loanId }, select: { note: true } });
  return loan?.note ?? "";
}

function themVetBoQua(cu: string, nhan: string): string {
  const moi = `${cu}\nBỏ qua kỳ ${nhan}`.trim();
  return moi.length <= GIOI_HAN_GHI_CHU ? moi : moi.slice(moi.length - GIOI_HAN_GHI_CHU);
}

type ThamSoGhiKy = {
  loan: KhoanVayRow;
  ngayKy: Date;
  nhan: string;
  lai: number;
  goc: number;
  tienGui: number;
  boQua: boolean;
};

/**
 * MỘT transaction duy nhất cho cả 4 phép ghi: đóng dấu kỳ → lãi → gốc → tiền gửi → kiểm dư nợ. Bất
 * kỳ bước nào ném thì cả cụm rollback, nên KHÔNG có trạng thái nửa vời.
 *
 * Dòng TIỀN GỬI nằm cùng transaction với câu đóng dấu là BẮT BUỘC, không phải cho gọn: `CashMovement`
 * không có `refId @unique` như `Expense`, nên con dấu `lastDueHandled` trong câu `updateMany` là cổng
 * chống ghi trùng DUY NHẤT của nó. Tách sang một đường ghi khác = mỗi lần bấm lại đẻ thêm 300k.
 *
 * Isolation để MẶC ĐỊNH (ReadCommitted), chỗ dựa đúng đắn là khoá dòng `Loan` + điều kiện con dấu
 * nằm trong chính câu UPDATE — lý do đầy đủ ở khối chú thích cạnh `OPT_TX` bên dưới.
 */
async function chayGhiKy({
  loan,
  ngayKy,
  nhan,
  lai,
  goc,
  tienGui,
  boQua,
}: ThamSoGhiKy): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      // Khoá dòng `Loan` NGAY ĐẦU. Câu `updateMany` bên dưới tự nó cũng khoá dòng, nhưng nhánh bỏ
      // qua kỳ cần ĐỌC `note` TRƯỚC đó để nối vết — đọc mà chưa khoá là hai lượt cùng đọc một bản
      // note rồi lượt sau ghi đè mất vết của lượt trước. Khoá ở đây cho cả hai nhánh đi một luật.
      await khoaKhoanVay(tx, loan.id);

      // CỔNG SERVER của luật "tiền gửi CHỈ thuộc BULLET" — `tienGui` là số CLIENT gửi lên, không
      // được tin. Loại khác nhận được một dòng DEPOSIT_OUT là tiền đi ra mà không có đường về:
      // `tat-toan-thau-chi.ts` đóng khoản mà không hoàn, sau đó mọi lượt ghi vào khoản đã đóng đều
      // bị chặn. Ném ⇒ rollback trọn, không có ca "ghi lãi rồi mới phát hiện tiền gửi sai loại".
      if (tienGui > 0 && loan.kind !== "BULLET") {
        throw new LoiHopDong("Chỉ khoản vay trả gốc cuối kỳ mới có tiền gửi tiết kiệm bắt buộc");
      }

      // Danh mục hệ thống "Lãi vay" có thể bị xoá tay ở màn Cài đặt ⇒ báo câu hiểu được thay vì
      // để Postgres ném lỗi khoá ngoại.
      if (!boQua && lai > 0) {
        const danhMuc = await tx.expenseCategory.findUnique({
          where: { id: "interest" },
          select: { id: true },
        });
        if (!danhMuc) throw new LoiHopDong("Thiếu danh mục Lãi vay — chạy seed");
      }

      // CỔNG 1 — fencing: điều kiện con dấu nằm NGAY TRONG câu UPDATE, không phải check-then-act.
      const dong = await tx.loan.updateMany({
        where: {
          id: loan.id,
          closedAt: null,
          OR: [{ lastDueHandled: null }, { lastDueHandled: { lt: ngayKy } }],
        },
        data: boQua
          ? { lastDueHandled: ngayKy, note: themVetBoQua(await docGhiChu(tx, loan.id), nhan) }
          : { lastDueHandled: ngayKy },
      });
      if (dong.count === 0) throw new LoiHopDong("Kỳ này đã được ghi");

      if (!boQua && lai > 0) {
        // CỔNG 2 — `refId @unique`. `source: MANUAL` để chủ shop sửa/xoá được (khoá sửa chỉ áp ADS_API).
        await tx.expense.create({
          data: {
            date: ngayKy,
            categoryId: "interest",
            amount: lai,
            description: `Lãi vay ${loan.name} — kỳ ${nhan}`,
            source: "MANUAL",
            refId: `LOAN:${loan.id}:${format(ngayKy, "yyyy-MM-dd")}`,
          },
        });
      }

      if (!boQua && goc > 0) {
        await tx.cashMovement.create({
          data: {
            date: ngayKy,
            kind: "LOAN_REPAY",
            amount: goc,
            loanId: loan.id,
            description: `Trả gốc ${loan.name} — kỳ ${nhan}`,
          },
        });
      }

      // TIỀN GỬI TIẾT KIỆM BẮT BUỘC — `CashMovement` DEPOSIT_OUT, TUYỆT ĐỐI KHÔNG `Expense`: tiền
      // vẫn của chủ shop, ngân hàng chỉ giữ hộ tới lúc tất toán rồi cấn trừ vào gốc. Ghi thành chi
      // phí là vừa báo lỗ khống ở Lãi/Lỗ (Sổ quỹ trừ Σ Expense MỌI danh mục, P&L trừ mọi danh mục
      // trừ `purchase`) vừa mất dấu số phải đòi lại.
      //
      // Ngày = ĐÚNG ngày đến hạn của kỳ, giống dòng trả gốc: cả kỳ là một lần chuyển tiền.
      if (!boQua && tienGui > 0) {
        await tx.cashMovement.create({
          data: {
            date: ngayKy,
            kind: "DEPOSIT_OUT",
            amount: tienGui,
            loanId: loan.id,
            description: `Gửi tiết kiệm bắt buộc ${loan.name} — kỳ ${nhan}`,
          },
        });
      }

      return chanDuNoAm(tx, loan.id);
    },
    // CỐ Ý ĐỂ ISOLATION MẶC ĐỊNH (ReadCommitted), KHÔNG Serializable — spec §5.3 viết Serializable,
    // đo lại 08/09 cho thấy chọn thế là SAI ở đúng chỗ nó định đỡ:
    //
    //   Serializable đóng băng snapshot tại câu ĐẦU của transaction. Sau khi giành được khoá dòng
    //   `Loan` của một lượt ghi tay vừa commit, `chanDuNoAm` VẪN đọc theo snapshot cũ ⇒ thấy Σ trả
    //   gốc = 0 (đo thật: 150.000.000 vừa commit mà lượt này thấy 0). Vị từ dư nợ thành ra mù, hai
    //   lượt cùng ghi 150tr lên khoản 200tr đều lọt.
    //   SSI cũng không cứu: nó chỉ bắt khi CẢ HAI phía Serializable, mà dòng "Trả nợ gốc" ghi tay ở
    //   `cash-movements.ts` chạy ReadCommitted.
    //
    // ReadCommitted lấy snapshot MỚI cho từng câu, nên sau khi khoá nhả ra ta đọc đúng cái vừa
    // commit. Cái đỡ tính đúng đắn ở đây là khoá dòng `Loan` (`khoaKhoanVay` ngay đầu) + điều kiện
    // con dấu nằm trong chính câu UPDATE — cả hai đều KHÔNG phụ thuộc isolation.
    // Nới timeout vì DB test/dev đi qua Tailscale và lượt sau còn phải chờ khoá (mặc định 5s quá sát).
    OPT_TX
  );
}

/**
 * P2034 = write conflict / deadlock → retry ĐÚNG 1 lần (khuôn `ensure-recurring-expenses.ts`).
 * Vẫn giữ dù không còn Serializable: khoá dòng vẫn có thể deadlock khi chạy chồng lượt ghi khác.
 */
async function chayGhiKyCoRetry(tham: ThamSoGhiKy): Promise<number> {
  try {
    return await chayGhiKy(tham);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") {
      return await chayGhiKy(tham);
    }
    throw e;
  }
}

/**
 * Duyệt MỘT kỳ trả nợ = "đã chuyển tiền cho ngân hàng": ghi lãi vào Sổ chi phí + gốc và tiền gửi tiết
 * kiệm bắt buộc vào dòng tiền, rồi đóng dấu kỳ. Kỳ do SERVER tính lại từ lịch + con dấu; `dueDate`
 * client gửi chỉ để đối chiếu (tab mở lâu có thể đang xem lịch cũ). `boQua` = ngân hàng không thu kỳ
 * này: chỉ đóng dấu + để vết.
 */
export async function ghiKyTraNo(input: unknown): Promise<ActionResult<{ duNoConLai: number }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = ghiKySchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { loanId, dueDate, lai, goc, tienGui, boQua } = parsed.data;

  const loan = (await listKhoanVay()).find((r) => r.id === loanId);
  if (!loan) return { ok: false, error: "Không tìm thấy khoản vay" };

  // Bấm hai lần / bấm lại sau khi back: kỳ vừa ghi KHÔNG còn là kỳ chờ duyệt nữa nên nhánh dưới sẽ
  // kêu "Kỳ không hợp lệ" — câu đó làm chủ shop tưởng hỏng dữ liệu. Nói đúng chuyện đã xảy ra, theo
  // CÙNG vị từ với câu UPDATE fencing (`lastDueHandled < dueDate` mới được ghi).
  if (loan.lastDueHandled !== null && startOfDay(dueDate) <= startOfDay(loan.lastDueHandled)) {
    return { ok: false, error: "Kỳ này đã được ghi" };
  }

  const ky = loan.kyCho;
  if (ky === null || !cungNgay(ky.denNgay, dueDate)) {
    return { ok: false, error: "Kỳ không hợp lệ — tải lại trang" };
  }

  // Không lãi, không gốc, không tiền gửi, mà cũng không khai là bỏ qua: lượt này chỉ đóng dấu kỳ rồi
  // biến mất, không để lại dòng nào lẫn vết nào — sau này không ai giải thích được vì sao kỳ đó trống.
  if (!boQua && lai === 0 && goc === 0 && tienGui === 0) {
    return {
      ok: false,
      error: "Kỳ không có lãi, gốc lẫn tiền gửi — dùng nút 'Ngân hàng không thu kỳ này'",
    };
  }

  const ngayKy = startOfDay(ky.denNgay);
  const nhan = format(ngayKy, "dd/MM/yyyy");

  try {
    const duNoConLai = await chayGhiKyCoRetry({ loan, ngayKy, nhan, lai, goc, tienGui, boQua });
    lamMoiTrang();
    return { ok: true, data: { duNoConLai } };
  } catch (e) {
    return { ok: false, ...loiKhoanVay(e, "Lỗi khi ghi kỳ trả nợ") };
  }
}
