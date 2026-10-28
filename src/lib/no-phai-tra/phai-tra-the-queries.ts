import type { Prisma } from "@/generated/prisma/client";

import { COT_KY_NEO, kyNeoTuDong, phaiTra, type GiaoDichThe, type PhaiTra } from "@/lib/no-phai-tra/ky-sao-ke";
import { prisma } from "@/lib/prisma";

/**
 * Số PHẢI TRẢ theo SAO KÊ của từng thẻ đang mở tại ngày `t` (spec §5.5) — đầu vào khoản dự kiến
 * `TRA_THE` của dự báo quỹ. Chỉ đọc kỳ sao kê (số ngân hàng in) + `CARD_PAY` (tiền đã trả thật): KHÔNG
 * dùng dư nợ ước tính (`du-no-the.ts`, lưới `khong-dung-tien-du-kien` cấm Sổ quỹ import) — dự báo nhắc
 * khoản ngân hàng sẽ đòi, không phải số app tự cộng.
 *
 * Thẻ đã đóng bỏ qua: đóng được chỉ khi kỳ mới nhất còn phải trả = 0. `phaiTra` null = chưa có kỳ nào có hạn.
 */
export type PhaiTraThe = { cardId: string; ten: string; phaiTra: PhaiTra | null };

type DbDoc = Pick<Prisma.TransactionClient, "theTinDung" | "kySaoKeThe" | "cashMovement">;

export async function docPhaiTraCacThe(t: Date, db: DbDoc = prisma): Promise<PhaiTraThe[]> {
  const cacThe = await db.theTinDung.findMany({
    where: { closedAt: null },
    select: { id: true, ten: true },
    orderBy: { createdAt: "asc" },
  });
  if (cacThe.length === 0) return [];
  const ids = cacThe.map((x) => x.id);
  const [kys, tra] = await Promise.all([
    db.kySaoKeThe.findMany({
      where: { cardId: { in: ids } },
      select: { cardId: true, ...COT_KY_NEO },
      orderBy: { ngayChot: "asc" },
    }),
    db.cashMovement.findMany({
      where: { kind: "CARD_PAY", cardId: { in: ids } },
      select: { cardId: true, date: true, amount: true },
    }),
  ]);
  return cacThe.map(({ id, ten }) => {
    const gd: GiaoDichThe[] = tra
      .filter((m) => m.cardId === id)
      .map((m) => ({ ngay: m.date, soTien: m.amount, loai: "TRA" as const }));
    // Nghĩa vụ kỳ = số in trên sao kê (`saoKeSoDu`) trừ phần đã trả mà sao kê chưa in (`saoKeTraChuaLen`), không
    // phải neo dư nợ `soDu` (gồm bill ghi sổ trễ) — CÙNG bộ cột + bộ đổi với `docKyNeoThe`.
    const kyCuaThe = kys.filter((k) => k.cardId === id).map(kyNeoTuDong);
    return { cardId: id, ten, phaiTra: phaiTra(kyCuaThe, gd, t) };
  });
}
