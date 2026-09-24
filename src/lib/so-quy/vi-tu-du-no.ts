import type { Prisma } from "@prisma/client";

import { formatVnd } from "@/lib/format";

/**
 * VỊ TỪ DƯ NỢ DUY NHẤT, dùng chung cho MỌI đường ghi chạm dòng gốc vay:
 * `ghiKyTraNo` · `createCashMovement` · `updateCashMovement` · `deleteCashMovement`.
 *
 * Luật: sau khi ghi/sửa/xoá, `duNoMoSo + Σ LOAN_IN − Σ LOAN_REPAY` TOÀN THỜI GIAN của khoản đó phải
 * ≥ 0. Cố ý KHÔNG lọc theo ngày: một dòng trả gốc đề ngày cũ vẫn là tiền đã ra, và "dư nợ âm" là
 * trạng thái sổ sách không có thật ở BẤT KỲ mốc nào.
 *
 * BẮT BUỘC gọi TRONG transaction và SAU câu ghi: kiểm trước khi ghi là check-then-act — hai lượt
 * bấm song song đều thấy "còn đủ dư nợ" rồi cùng ghi. Ném ⇒ Prisma rollback trọn transaction, đúng
 * ý; caller PHẢI bắt `LoiDuNoAm` và trả câu tiếng Việt thay vì để nó thành 500.
 */

const KIND_GOC = ["LOAN_IN", "LOAN_REPAY"] as const;

/**
 * Hai loại dòng tiền của SỔ TIẾT KIỆM BẮT BUỘC — CỐ Ý tách khỏi `KIND_GOC`. Gộp vào đó là trừ tiền
 * gửi thẳng vào dư nợ vay: dư nợ hiện thiếu đi, kỳ cuối đề xuất trả gốc hụt đúng bằng số ngân hàng
 * đang giữ hộ. Tiền gửi KHÔNG trả nợ — nó chỉ cấn trừ MỘT LẦN lúc tất toán, qua một dòng riêng.
 */
const KIND_TIEN_GUI = ["DEPOSIT_OUT", "DEPOSIT_IN"] as const;

/**
 * KHOÁ DÒNG `Loan` — gọi ĐẦU TIÊN trong MỌI transaction chạm dòng gốc vay, TRƯỚC cả câu ghi.
 *
 * Vì sao bắt buộc: `chanDuNoAm` cộng lại tổng từ bảng `CashMovement`, mà transaction ở isolation
 * mặc định (ReadCommitted) KHÔNG thấy dòng chưa commit của lượt song song. Hai lượt trả gốc 150tr
 * cùng lúc trên khoản dư nợ 200tr vì thế đều thấy "còn đủ" và CẢ HAI ghi được ⇒ dư nợ −100tr. Đo
 * thật trên DB test. Serializable một phía cũng không cứu: SSI chỉ bắt khi CẢ HAI
 * phía Serializable, nên `ghiKyTraNo` chạy cùng một dòng "Trả nợ gốc" ghi tay vẫn lọt.
 *
 * `FOR UPDATE` giữ dòng `Loan` tới khi transaction commit, nên lượt thứ hai phải CHỜ rồi mới đọc —
 * và khi đọc thì đã thấy dòng của lượt trước. Khoá theo dòng `Loan` (không phải theo `CashMovement`)
 * vì `Loan` là thứ DUY NHẤT mọi đường ghi đều chạm.
 *
 * Khoá NHIỀU khoản trong một transaction (sửa dòng từ khoản A sang khoản B) thì PHẢI theo thứ tự id
 * tăng dần ở mọi nơi, nếu không hai lượt giữ chéo nhau rồi Postgres huỷ một bên.
 */
export async function khoaKhoanVay(
  tx: Prisma.TransactionClient,
  loanId: string
): Promise<void> {
  // Không có dòng ⇒ 0 hàng, không khoá gì: caller vẫn tự báo "Không tìm thấy khoản vay" ngay sau đó.
  await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${loanId} FOR UPDATE`;
}

/** Khoá nhiều khoản theo THỨ TỰ ID tăng dần — cùng thứ tự ở mọi đường ghi thì không kẹt chéo. */
export async function khoaCacKhoanVay(
  tx: Prisma.TransactionClient,
  loanIds: string[]
): Promise<void> {
  for (const id of [...new Set(loanIds)].sort()) await khoaKhoanVay(tx, id);
}

/** Dư nợ gốc còn lại của khoản vay, tính lại từ chính các dòng tiền (không có cột dư nợ để lệch). */
export async function duNoSauKhiGhi(
  tx: Prisma.TransactionClient,
  loanId: string
): Promise<number> {
  const [loan, nhom] = await Promise.all([
    tx.loan.findUniqueOrThrow({ where: { id: loanId }, select: { duNoMoSo: true } }),
    tx.cashMovement.groupBy({
      by: ["kind"],
      where: { loanId, kind: { in: [...KIND_GOC] } },
      _sum: { amount: true },
    }),
  ]);
  const tong = (k: (typeof KIND_GOC)[number]) =>
    nhom.find((x) => x.kind === k)?._sum.amount ?? 0;
  return loan.duNoMoSo + tong("LOAN_IN") - tong("LOAN_REPAY");
}

/** Ném khi phép ghi vừa rồi làm dư nợ âm. `duNo` là số ÂM — phần thiếu là `-duNo`. */
export class LoiDuNoAm extends Error {
  constructor(public readonly duNo: number) {
    super(`Vượt dư nợ còn lại (thiếu ${formatVnd(-duNo)}) — kiểm lại số tiền hoặc khoản vay`);
    this.name = "LoiDuNoAm";
  }
}

/** Kiểm vị từ; hợp lệ ⇒ trả dư nợ mới (caller hiện lên toast "dư nợ còn Z"). */
export async function chanDuNoAm(
  tx: Prisma.TransactionClient,
  loanId: string
): Promise<number> {
  const duNo = await duNoSauKhiGhi(tx, loanId);
  if (duNo < 0) throw new LoiDuNoAm(duNo);
  return duNo;
}

/**
 * Sổ tiết kiệm bắt buộc ngân hàng ĐANG GIỮ của khoản vay = Σ DEPOSIT_OUT − Σ DEPOSIT_IN, toàn thời
 * gian. Dùng lúc tất toán để ghi đúng số hoàn lại, và để hiện "ngân hàng đang giữ X" ở bảng khoản vay.
 *
 * KHÔNG lọc theo ngày, cùng lý do với `duNoSauKhiGhi`: một dòng đề ngày cũ vẫn là tiền đã ra/vào.
 * Số này KHÔNG BAO GIỜ đụng dư nợ gốc vay và KHÔNG BAO GIỜ vào P&L (tiền của chủ shop, NH giữ hộ).
 */
export async function tienGuiDangGiu(
  tx: Prisma.TransactionClient,
  loanId: string
): Promise<number> {
  const nhom = await tx.cashMovement.groupBy({
    by: ["kind"],
    where: { loanId, kind: { in: [...KIND_TIEN_GUI] } },
    _sum: { amount: true },
  });
  const tong = (k: (typeof KIND_TIEN_GUI)[number]) =>
    nhom.find((x) => x.kind === k)?._sum.amount ?? 0;
  return tong("DEPOSIT_OUT") - tong("DEPOSIT_IN");
}

/** Ném khi phép ghi vừa rồi làm số tiền gửi ngân hàng đang giữ âm. `tienGui` là số ÂM. */
export class LoiTienGuiAm extends Error {
  constructor(public readonly tienGui: number) {
    super(
      `Vượt tiền gửi ngân hàng đang giữ (thiếu ${formatVnd(-tienGui)}) — kiểm lại số tiền hoặc khoản vay`
    );
    this.name = "LoiTienGuiAm";
  }
}

/**
 * VỊ TỪ TIỀN GỬI — song song `chanDuNoAm`, cùng luật gọi: TRONG transaction đã khoá dòng `Loan`, và
 * SAU câu ghi.
 *
 * Vì sao phải có riêng: `chanDuNoAm` chỉ đếm `KIND_GOC`, còn `kiemKhoanVay` (`cash-movements.ts`)
 * thoát sớm với mọi loại khác `LOAN_IN` — nên một dòng ghi tay "Nhận lại tiền gửi" (`DEPOSIT_IN`)
 * lớn hơn Σ ngân hàng đang giữ đi lọt qua CẢ HAI cổng: quỹ phồng lên bằng tiền không có thật, và số
 * âm đó còn bị GIẤU vì mọi chỗ hiển thị đều canh `> 0`. Hai lượt bấm song song cũng đều lọt nếu chỉ
 * kiểm trước khi ghi (check-then-act).
 */
export async function chanTienGuiAm(
  tx: Prisma.TransactionClient,
  loanId: string
): Promise<number> {
  const tienGui = await tienGuiDangGiu(tx, loanId);
  if (tienGui < 0) throw new LoiTienGuiAm(tienGui);
  return tienGui;
}
