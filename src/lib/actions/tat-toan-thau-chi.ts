"use server";

import { Prisma } from "@prisma/client";
import { format, startOfDay } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import {
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
import { chanDuNoAm, duNoSauKhiGhi, khoaKhoanVay } from "@/lib/so-quy/vi-tu-du-no";

/**
 * TẤT TOÁN THẤU CHI (spec thấu chi §5) — action thứ 6 của khối Khoản vay, ở file riêng vì
 * `khoan-vay.ts` đã dài và đây là một luồng khép kín: đóng khoản trong MỘT lượt.
 *
 * Thấu chi khác vay kỳ hạn ở chỗ ngân hàng KHÔNG có lịch trả gốc — gốc trả trọn lúc tất toán, kèm
 * phần lãi tính theo ngày chưa thu. Nên `tatToanKhoanVay` (đòi dư nợ đã về 0) không dùng được: nó
 * chỉ đóng hồ sơ, không ghi đồng nào. Ở đây tất toán là một KỲ CUỐI gộp lãi + toàn bộ gốc.
 *
 * Bất biến giữ nguyên như mọi đường ghi khác: gốc CHỈ qua `CashMovement.LOAN_REPAY` gắn `loanId`,
 * lãi CHỈ qua `Expense` danh mục `interest`; khoá dòng `Loan` FOR UPDATE ngay đầu transaction;
 * isolation ReadCommitted; `chanDuNoAm` gọi SAU câu ghi. Hai cổng chống ghi trùng vẫn là con dấu
 * `lastDueHandled` nằm TRONG câu UPDATE + `Expense.refId @unique`, cộng thêm cổng thứ ba cho phần
 * LÃI: `conDauDaThay` (ảnh chụp con dấu ở client) phải khớp con dấu thật — xem schema bên dưới.
 *
 * PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` — phép quét AST chỉ đọc THÂN
 * HÀM export nên `dangPhucHoi()` gọi trực tiếp ở đây, không uỷ quyền.
 */

const KIND_GOC = ["LOAN_IN", "LOAN_REPAY"] as const;

const tatToanSchema = z.object({
  loanId: z.string().min(1, "Chọn khoản vay"),
  /** Tiền đã chuyển cho ngân hàng rồi mới bấm ⇒ dùng schema ghi tay (chặn ngày tương lai). */
  ngayTatToan: ngayGhiTaySchema,
  /** Chỉ ĐỀ XUẤT ở client (`deXuatTatToan`); chủ shop sửa theo giấy báo ngân hàng, 0 là hợp lệ. */
  lai: soTienKySchema,
  /**
   * Con dấu `lastDueHandled` mà CLIENT nhìn thấy lúc tính đề xuất lãi (null = chưa thu kỳ nào).
   * Bắt buộc: `lai` là số client gửi, mà mốc bắt đầu tính lãi lại suy từ chính con dấu này — một
   * tab mở từ trước lượt duyệt kỳ sẽ đề xuất lãi TÍNH TRÙNG những ngày kỳ vừa duyệt đã thu, và
   * fencing (chỉ canh NGÀY tất toán) không bắt được. Đây là dấu "ảnh chụp còn tươi" chứ không phải
   * trần lãi — chủ shop vẫn sửa lãi theo giấy báo ngân hàng như quyết định đã chốt.
   */
  conDauDaThay: z.coerce.date().nullable(),
});

type ThamSoTatToan = z.infer<typeof tatToanSchema>;

async function chayTatToan({
  loanId,
  ngayTatToan,
  lai,
  conDauDaThay,
}: ThamSoTatToan): Promise<{ lai: number; goc: number }> {
  const ngay = startOfDay(ngayTatToan);

  return prisma.$transaction(async (tx) => {
    // Khoá dòng `Loan` NGAY ĐẦU: dưới đây vừa ĐỌC dư nợ vừa ghi dòng trả gốc, mà `chanDuNoAm` cộng
    // lại từ bảng `CashMovement` nên một dòng trả gốc commit chen giữa sẽ để lại khoản "đã đóng" mà
    // dư nợ khác 0. Lý do đầy đủ ở `vi-tu-du-no.ts`.
    await khoaKhoanVay(tx, loanId);

    const loan = await tx.loan.findUnique({
      where: { id: loanId },
      select: {
        name: true,
        kind: true,
        closedAt: true,
        startDate: true,
        lastDueHandled: true,
      },
    });
    if (!loan) throw new LoiHopDong("Không tìm thấy khoản vay");
    if (loan.kind !== "OVERDRAFT") {
      throw new LoiHopDong("Chỉ dùng cho thấu chi — khoản vay kỳ hạn tất toán bằng lịch kỳ");
    }
    if (loan.closedAt !== null) throw new LoiHopDong("Khoản vay đã tất toán");

    // Ảnh chụp của client phải còn tươi: `lai` client gửi được tính từ mốc `max(ngày rút, con dấu)`,
    // nên con dấu đổi giữa chừng (tab khác vừa duyệt kỳ lãi) nghĩa là số lãi kia đang tính TRÙNG
    // những ngày kỳ vừa duyệt đã thu. Fencing bên dưới chỉ canh NGÀY tất toán nên mù ca này.
    const conDauThat = loan.lastDueHandled === null ? null : startOfDay(loan.lastDueHandled).getTime();
    const conDauClient = conDauDaThay === null ? null : startOfDay(conDauDaThay).getTime();
    if (conDauThat !== conDauClient) {
      throw new LoiHopDong(
        "Kỳ lãi vừa được duyệt ở nơi khác — tải lại trang rồi tất toán lại (số lãi đề xuất đã đổi)"
      );
    }

    if (ngay < startOfDay(loan.startDate)) {
      throw new LoiHopDong(
        `Ngày tất toán phải từ ngày rút (${format(loan.startDate, "dd/MM/yyyy")}) trở đi`,
        "ngayTatToan"
      );
    }

    // Tất toán LÙI trước một lần trả gốc đã ghi = tính lãi cho những ngày mà dòng tiền nói là đã
    // trả xong, và con dấu nhảy về trước dòng đó. Chặn thẳng thay vì tính ra một số khó giải thích.
    const mocCuoi = await tx.cashMovement.aggregate({
      where: { loanId, kind: { in: [...KIND_GOC] } },
      _max: { date: true },
    });
    const dongCuoi = mocCuoi._max.date;
    if (dongCuoi !== null && ngay < startOfDay(dongCuoi)) {
      throw new LoiHopDong(
        `Ngày tất toán phải từ dòng gốc gần nhất (${format(dongCuoi, "dd/MM/yyyy")}) trở đi`,
        "ngayTatToan"
      );
    }

    // Danh mục hệ thống "Lãi vay" xoá được tay ở màn Cài đặt ⇒ báo câu hiểu được thay vì để Postgres
    // ném lỗi khoá ngoại (cùng luật với `chayGhiKy`).
    if (lai > 0) {
      const danhMuc = await tx.expenseCategory.findUnique({
        where: { id: "interest" },
        select: { id: true },
      });
      if (!danhMuc) throw new LoiHopDong("Thiếu danh mục Lãi vay — chạy seed");
    }

    // Gốc KHÔNG do client gửi: luôn là TOÀN BỘ dư nợ còn lại, suy lại từ chính các dòng tiền.
    const goc = await duNoSauKhiGhi(tx, loanId);

    // CỔNG 1 — fencing: mọi điều kiện nằm NGAY TRONG câu UPDATE, không phải check-then-act. Hai tab
    // bấm cùng lúc thì chỉ một câu đổi được dòng.
    const dong = await tx.loan.updateMany({
      where: {
        id: loanId,
        kind: "OVERDRAFT",
        closedAt: null,
        OR: [{ lastDueHandled: null }, { lastDueHandled: { lt: ngay } }],
      },
      data: { lastDueHandled: ngay, closedAt: new Date() },
    });
    if (dong.count === 0) {
      // Dòng `Loan` đang bị KHOÁ từ đầu transaction và `closedAt`/con dấu vừa đọc xong ở trên, nên
      // 0 dòng chỉ còn một nghĩa: ngày tất toán KHÔNG sau con dấu. Nói thẳng ngày phải chọn — câu
      // gộp "đã tất toán hoặc…" để chủ shop tự đoán là cụt đường.
      throw new LoiHopDong(
        loan.lastDueHandled === null
          ? "Không tất toán được — tải lại trang"
          : `Kỳ lãi ngày ${format(loan.lastDueHandled, "dd/MM/yyyy")} đã thu — chọn ngày tất toán sau ngày đó`,
        "ngayTatToan"
      );
    }

    if (lai > 0) {
      // CỔNG 2 — `refId @unique`. `source: MANUAL` để chủ shop sửa/xoá được (khoá sửa chỉ áp ADS_API).
      await tx.expense.create({
        data: {
          date: ngay,
          categoryId: "interest",
          amount: lai,
          description: `Lãi vay ${loan.name} — tất toán ${format(ngay, "dd/MM/yyyy")}`,
          source: "MANUAL",
          refId: `LOAN:${loanId}:${format(ngay, "yyyy-MM-dd")}`,
        },
      });
    }

    if (goc > 0) {
      await tx.cashMovement.create({
        data: {
          date: ngay,
          kind: "LOAN_REPAY",
          amount: goc,
          loanId,
          description: `Trả gốc ${loan.name} — tất toán ${format(ngay, "dd/MM/yyyy")}`,
        },
      });
    }

    // Tất toán = trả TRỌN: dư nợ sau lượt ghi phải bằng ĐÚNG 0. Khác 0 nghĩa là dư nợ đang âm (sổ
    // ghi trả thừa) hoặc có dòng chen ngang — đóng khoản trong trạng thái đó là giấu một con số sai.
    const duNo = await chanDuNoAm(tx, loanId);
    if (duNo !== 0) {
      throw new LoiHopDong(`Dư nợ sau tất toán phải bằng 0 (đang ${formatVnd(duNo)}) — tải lại trang`);
    }

    return { lai, goc };
  }, OPT_TX);
}

/**
 * P2034 = write conflict / deadlock → retry ĐÚNG 1 lần (khuôn `chayGhiKyCoRetry`). Khoá dòng vẫn có
 * thể deadlock khi chạy chồng một lượt ghi khác cũng chạm khoản vay.
 */
async function chayTatToanCoRetry(tham: ThamSoTatToan): Promise<{ lai: number; goc: number }> {
  try {
    return await chayTatToan(tham);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") {
      return await chayTatToan(tham);
    }
    throw e;
  }
}

/**
 * Tất toán một khoản THẤU CHI = "đã chuyển tiền cho ngân hàng": ghi lãi chưa thu vào Sổ chi phí +
 * trả TOÀN BỘ gốc còn lại vào dòng tiền + đóng khoản, trong MỘT transaction. Bất kỳ bước nào ném
 * thì cả cụm rollback — không có trạng thái "đã ghi lãi mà khoản chưa đóng".
 */
export async function tatToanThauChi(
  input: unknown
): Promise<ActionResult<{ lai: number; goc: number }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = tatToanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };

  try {
    const ket = await chayTatToanCoRetry(parsed.data);
    lamMoiTrang();
    return { ok: true, data: ket };
  } catch (e) {
    return { ok: false, ...loiKhoanVay(e, "Lỗi khi tất toán thấu chi") };
  }
}
