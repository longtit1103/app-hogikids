import type { Prisma } from "@prisma/client";

import { formatVnd } from "@/lib/format";

/**
 * VỊ TỪ SỔ TIẾT KIỆM — dùng chung cho MỌI đường ghi chạm dòng `SAVINGS_*`: `taoSoTietKiem` ·
 * `tatToanSoTietKiem` · `moLaiSoTietKiem` · `createCashMovement` / `updateCashMovement` /
 * `deleteCashMovement` (cửa 6, spec §8.1).
 *
 * Khuôn nguyên bản: `src/lib/so-quy/vi-tu-du-no.ts` — đã chạy prod 3 đợt. Luật gọi giống hệt:
 * khoá dòng TRƯỚC câu ghi, kiểm vị từ SAU câu ghi (kiểm trước là check-then-act — hai lượt bấm song
 * song đều thấy "còn đủ" rồi cùng ghi). Ném ⇒ Prisma rollback trọn transaction, đúng ý; caller PHẢI
 * bắt và trả câu tiếng Việt thay vì để nó thành 500.
 */

export type Tx = Prisma.TransactionClient;

/** Hai loại dòng tiền của sổ tiết kiệm SINH LÃI. CỐ Ý tách hẳn `DEPOSIT_OUT`/`DEPOSIT_IN` (tiền gửi
 * BẮT BUỘC theo hợp đồng vay, gắn `loanId`, không sinh lãi) — trộn hai cặp là nhập nhằng hai loại
 * tiền khác hẳn nhau. CHECK `CashMovement_loan_savings_loai_tru` dưới DB chặn ở tầng thứ hai. */
const KIND_TIET_KIEM = ["SAVINGS_OUT", "SAVINGS_IN"] as const;

/**
 * KHOÁ DÒNG `SoTietKiem` — gọi ĐẦU TIÊN trong MỌI transaction chạm sổ, TRƯỚC cả câu ghi.
 *
 * Vì sao bắt buộc: `chanSoDuTietKiemAm` cộng lại tổng từ bảng `CashMovement`, mà ReadCommitted KHÔNG
 * thấy dòng chưa commit của lượt song song ⇒ hai lượt tất toán cùng lúc đều thấy "còn đủ" và CẢ HAI
 * ghi được. `FOR UPDATE` giữ dòng tới khi commit nên lượt thứ hai phải CHỜ rồi mới đọc.
 *
 * Isolation phải là **ReadCommitted** (mặc định), KHÔNG Serializable: Serializable đóng băng snapshot
 * nên sau khi giành khoá vẫn đọc thiếu dòng ghi tay vừa commit — đo thật ở đường khoản vay.
 *
 * Không có dòng ⇒ 0 hàng, không khoá gì: caller vẫn tự báo "Không tìm thấy sổ" ngay sau đó.
 */
export async function khoaSoTietKiem(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "SoTietKiem" WHERE id = ${id} FOR UPDATE`;
}

/**
 * Khoá nhiều sổ theo THỨ TỰ ID tăng dần (sửa dòng từ sổ A sang sổ B) — cùng thứ tự ở mọi đường ghi
 * thì không kẹt chéo. Mảng rỗng ⇒ vòng lặp không chạy câu nào, đúng ý: gọi vô điều kiện ở đầu
 * transaction mà không phải rắc `if` khắp nơi.
 */
export async function khoaCacSoTietKiem(tx: Tx, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await khoaSoTietKiem(tx, id);
}

/**
 * Số tiền sổ ĐANG GỬI = Σ SAVINGS_OUT − Σ SAVINGS_IN, TOÀN THỜI GIAN (spec §5.1: không lưu cột, lưu
 * 2 chỗ là lệch 2 chỗ). KHÔNG lọc theo ngày — một dòng đề ngày cũ vẫn là tiền đã ra/vào.
 */
export async function soDuDangGui(tx: Tx, id: string): Promise<number> {
  const nhom = await tx.cashMovement.groupBy({
    by: ["kind"],
    where: { savingsId: id, kind: { in: [...KIND_TIET_KIEM] } },
    _sum: { amount: true },
  });
  const tong = (k: (typeof KIND_TIET_KIEM)[number]) =>
    nhom.find((x) => x.kind === k)?._sum.amount ?? 0;
  return tong("SAVINGS_OUT") - tong("SAVINGS_IN");
}

/** Ném khi phép ghi vừa rồi làm số đang gửi âm. `soDu` là số ÂM — phần thiếu là `-soDu`. */
export class LoiSoDuTietKiemAm extends Error {
  constructor(public readonly soDu: number) {
    super(
      `Vượt số tiền đang gửi ở sổ tiết kiệm (thiếu ${formatVnd(-soDu)}) — kiểm lại số tiền hoặc sổ`
    );
    this.name = "LoiSoDuTietKiemAm";
  }
}

/**
 * Kiểm vị từ SAU câu ghi. Không có nó thì một dòng "Nhận lại gốc tiết kiệm" lớn hơn số đang gửi đi
 * lọt: quỹ phồng lên bằng tiền không có thật, và số âm đó còn bị GIẤU vì mọi chỗ hiển thị canh `> 0`.
 */
export async function chanSoDuTietKiemAm(tx: Tx, id: string): Promise<void> {
  const soDu = await soDuDangGui(tx, id);
  if (soDu < 0) throw new LoiSoDuTietKiemAm(soDu);
}

/** Lỗi hợp đồng của sổ tiết kiệm; `field` để action map thẳng về ô trên form (mặc định `savingsId`). */
export class LoiSoTietKiemKhongHopLe extends Error {
  constructor(
    message: string,
    public readonly field: string = "savingsId"
  ) {
    super(message);
    this.name = "LoiSoTietKiemKhongHopLe";
  }
}

/**
 * CỔNG CỬA 6 (spec §8.1): form "Khoản tiền khác" không được trỏ dòng `SAVINGS_*` vào sổ đã tất toán.
 * Thiếu cổng này thì thứ tự §7.2 (ghi hết dòng tiền TRƯỚC, đóng `closedAt` SAU CÙNG) mất nghĩa: chủ
 * shop ghi tay thêm một dòng vào sổ đã đóng, sổ báo 0 mà quỹ đã đổi.
 */
export async function kiemSoTietKiemConHieuLuc(tx: Tx, id: string): Promise<void> {
  const so = await tx.soTietKiem.findUnique({ where: { id }, select: { closedAt: true } });
  if (!so) throw new LoiSoTietKiemKhongHopLe("Không tìm thấy sổ tiết kiệm");
  if (so.closedAt !== null) {
    throw new LoiSoTietKiemKhongHopLe(
      "Sổ tiết kiệm đã tất toán — mở lại sổ trước khi ghi thêm dòng tiền vào sổ này"
    );
  }
}
