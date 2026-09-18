"use server";

import type { Prisma } from "@prisma/client";
import { format, startOfDay } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { ngayGhiTaySchema } from "@/lib/actions/ngay-ghi-tay-schema";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import {
  CASH_MOVEMENT_KINDS,
  type CashMovementKind,
} from "@/lib/cash-movements/cash-movement-kinds";
import { prisma } from "@/lib/prisma";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { requireUser } from "@/lib/session";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";
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
 * Cùng khung với `expenses.ts`: requireUser → khoá phục hồi → zod → ghi → revalidate. Mọi dòng đều nhập
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
const KIND_KHOAN_VAY: readonly CashMovementKind[] = [
  "LOAN_IN",
  "LOAN_REPAY",
  "DEPOSIT_OUT",
  "DEPOSIT_IN",
];

/**
 * Hai loại buộc phải trỏ về một SỔ TIẾT KIỆM SINH LÃI (zod ở đây + CHECK
 * `CashMovement_savings_bat_buoc` ở DB). Đối xứng `KIND_KHOAN_VAY`, nhưng TUYỆT ĐỐI không trộn:
 * CHECK `CashMovement_loan_savings_loai_tru` cấm một dòng mang cả `loanId` lẫn `savingsId`, và
 * `transform` bên dưới cắt đúng một trong hai về null theo `kind` nên luật đó không thể vỡ từ đây.
 *
 * Khác `DEPOSIT_OUT`/`DEPOSIT_IN` (tiền gửi BẮT BUỘC theo hợp đồng vay, không sinh lãi): cặp này là
 * tiền chủ shop TỰ NGUYỆN gửi lấy lãi, và phần LÃI không bao giờ đi đường này — nó đi bảng `ThuNhap`.
 */
const KIND_SO_TIET_KIEM: readonly CashMovementKind[] = ["SAVINGS_OUT", "SAVINGS_IN"];

/**
 * Nới hạn transaction: DB test/dev đi qua Tailscale, và lượt thứ hai còn phải CHỜ khoá dòng `Loan`
 * của lượt trước nhả ra — mặc định 5s quá sát. Cùng bộ số với `khoan-vay.ts`.
 */
const OPT_TX = { timeout: 10_000, maxWait: 5_000 } as const;

const cashMovementSchema = z
  .object({
    date: ngayGhiTaySchema, // cùng một schema với Expense — lý do + thứ tự refine ở module đó
    kind: z.enum(CASH_MOVEMENT_KINDS),
    // Trần 2 tỷ: Prisma Int (int32) chết ở 2.147.483.647 — cùng ngưỡng, cùng lý do với Expense.amount.
    amount: z.coerce
      .number()
      .int("Số tiền phải là số nguyên")
      .positive("Số tiền phải lớn hơn 0")
      .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
    description: z.string().max(200, "Tối đa 200 ký tự").default(""),
    loanId: z.string().cuid().optional().nullable(),
    savingsId: z.string().cuid().optional().nullable(),
  })
  .superRefine((d, ctx) => {
    if (KIND_KHOAN_VAY.includes(d.kind) && !d.loanId) {
      ctx.addIssue({ code: "custom", path: ["loanId"], message: "Chọn khoản vay" });
    }
    if (KIND_SO_TIET_KIEM.includes(d.kind) && !d.savingsId) {
      ctx.addIssue({ code: "custom", path: ["savingsId"], message: "Chọn sổ tiết kiệm" });
    }
  })
  // Loại khác mà lỡ mang `loanId`/`savingsId` (đổi loại trên form) thì cắt đứt liên kết — không để
  // dòng "Rút vốn" âm thầm nằm trong dư nợ của một khoản vay, cũng không để nó nằm trong số đang
  // gửi của một sổ tiết kiệm (CHECK `CashMovement_savings_dung_cho` sẽ ném lỗi thô nếu lọt).
  .transform((d) => ({
    ...d,
    loanId: KIND_KHOAN_VAY.includes(d.kind) ? (d.loanId as string) : null,
    savingsId: KIND_SO_TIET_KIEM.includes(d.kind) ? (d.savingsId as string) : null,
  }));

type CashMovementData = z.infer<typeof cashMovementSchema>;

/** Lỗi enum/định dạng của zod là tiếng Anh — đổi sang câu tiếng Việt cho đúng ô trên form. */
function mapLoi(error: z.ZodError): { error: string; field?: string } {
  const mapped = mapZodError(error);
  if (mapped.field === "kind") return { error: "Chọn loại khoản", field: "kind" };
  // `.cuid()` hỏng ⇒ message tiếng Anh "Invalid cuid"; với chủ shop nó chỉ có nghĩa "chưa chọn".
  if (mapped.field === "loanId") return { error: "Chọn khoản vay", field: "loanId" };
  if (mapped.field === "savingsId") return { error: "Chọn sổ tiết kiệm", field: "savingsId" };
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
function loiGhi(e: unknown): { error: string; field?: string } {
  if (e instanceof LoiKhoanVay) return { error: e.message, field: e.field };
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
async function docLaiTrongTx(
  tx: Prisma.TransactionClient,
  id: string,
  loanId: string | null,
  savingsId: string | null
) {
  const row = await tx.cashMovement.findUnique({ where: { id } });
  if (!row) throw new LoiKhoanVay("Không tìm thấy khoản tiền", "id");
  if (row.loanId !== loanId || row.savingsId !== savingsId) {
    throw new LoiKhoanVay(
      "Khoản tiền này vừa được sửa sang mục khác — mở lại trang rồi xoá lại",
      "id"
    );
  }
  return row;
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

export async function createCashMovement(input: unknown): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = cashMovementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapLoi(parsed.error) };
  const data = parsed.data;

  try {
    if (data.loanId === null && data.savingsId === null) {
      await prisma.cashMovement.create({ data });
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

          await tx.cashMovement.create({ data });

          // SAU câu ghi (kiểm trước là check-then-act). Một mình vị từ KHÔNG đủ — nó chỉ có răng khi
          // dòng cha đang bị khoá ở trên, nếu không hai lượt cùng đọc một cái tổng cũ.
          if (loanId !== null) {
            await chanDuNoAm(tx, loanId);
            // Trục thứ HAI của khoản vay: `chanDuNoAm` chỉ đếm dòng GỐC nên một dòng "Nhận lại tiền
            // gửi" vượt Σ ngân hàng đang giữ đi lọt qua nó mà quỹ vẫn phồng lên.
            await chanTienGuiAm(tx, loanId);
          }
          if (savingsId !== null) await chanSoDuTietKiemAm(tx, savingsId);
        },
        OPT_TX
      );
      lamMoiTrang();
    }
  } catch (e) {
    return { ok: false, ...loiGhi(e) };
  }

  return { ok: true, data: undefined };
}

export async function updateCashMovement(id: string, input: unknown): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = cashMovementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapLoi(parsed.error) };
  const data = parsed.data;

  try {
    const truoc = await prisma.cashMovement.findUnique({
      where: { id },
      select: { loanId: true, savingsId: true },
    });
    if (!truoc) return { ok: false, error: "Không tìm thấy khoản tiền" };

    // Đổi dòng từ khoản vay A sang B (hay bỏ hẳn liên kết) làm dư nợ của CẢ HAI khoản đổi theo — và
    // đúng luật đó cho trục sổ tiết kiệm. Dòng chuyển HẲN trục (vay → sổ) chạm cả hai bảng cha.
    const khoanVayCanKiem = [...new Set([truoc.loanId, data.loanId])].filter(
      (x): x is string => x !== null
    );
    const soCanKiem = [...new Set([truoc.savingsId, data.savingsId])].filter(
      (x): x is string => x !== null
    );

    if (khoanVayCanKiem.length === 0 && soCanKiem.length === 0) {
      // `update` ném P2025 khi id không có — không cần findUnique trước (một round-trip ít hơn).
      await prisma.cashMovement.update({ where: { id }, data });
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

          await tx.cashMovement.update({ where: { id }, data });

          for (const khoan of khoanVayCanKiem) {
            await chanDuNoAm(tx, khoan);
            await chanTienGuiAm(tx, khoan);
          }
          for (const so of soCanKiem) await chanSoDuTietKiemAm(tx, so);
        },
        OPT_TX
      );
      lamMoiTrang();
    }
  } catch (e) {
    return { ok: false, ...loiGhi(e) };
  }

  return { ok: true, data: undefined };
}

export async function deleteCashMovement(id: string): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    // Đọc NGOÀI transaction chỉ để chọn nhánh (có cha hay không) và báo "không tìm thấy" sớm. Bản
    // đem CHỤP phải đọc lại BÊN TRONG transaction — xem `docLaiTrongTx`.
    const truoc = await prisma.cashMovement.findUnique({
      where: { id },
      select: { loanId: true, savingsId: true },
    });
    if (!truoc) return { ok: false, error: "Không tìm thấy khoản tiền" };

    const loanId = truoc.loanId;
    const savingsId = truoc.savingsId;

    if (loanId === null && savingsId === null) {
      // Dòng trơn vốn xoá thẳng không transaction — nay phải có, vì chụp ảnh và câu xoá bắt buộc
      // đi cùng một lượt: chụp mà không xoá được là để lại dòng rác, xoá mà không chụp là mất hẳn.
      await prisma.$transaction(async (tx) => {
        const row = await docLaiTrongTx(tx, id, null, null);
        await chupVaoThungRac(tx, { bang: "CashMovement", banGhi: row });
        await tx.cashMovement.delete({ where: { id } });
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
          const row = await docLaiTrongTx(tx, id, loanId, savingsId);
          await chupVaoThungRac(tx, { bang: "CashMovement", banGhi: row });
          await tx.cashMovement.delete({ where: { id } });

          if (loanId !== null) {
            await chanDuNoAm(tx, loanId);
            await chanTienGuiAm(tx, loanId);
          }
          if (savingsId !== null) await chanSoDuTietKiemAm(tx, savingsId);
        },
        OPT_TX
      );
      lamMoiTrang();
    }
  } catch (e) {
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
