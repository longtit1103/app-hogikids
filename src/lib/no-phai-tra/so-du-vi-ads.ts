import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Số dư ví ads TRẢ TRƯỚC (S1 — ví Shopee Ads nạp trước, spec §5.9). Ví là "túi" ngoài quỹ:
 *   ví(t) = soDuNeo + Σ nạp `ADS_TOPUP` của ví − Σ Expense[adsSource = nền tảng, cardId null]
 * trên giao dịch có ngày VN trong (ngayNeo, t]. Neo = số dư CUỐI NGÀY `ngayNeo` (= M − 1) ⇒ giao dịch đúng
 * ngày neo đã nằm trong neo, giao dịch trong ngày t (tới 23:59 VN) có đếm. So theo khoá ngày VN, không
 * theo giờ, để biên 00:00 VN không lệch UTC.
 *
 * Ví KHÔNG phân biệt nguồn nạp (ngân hàng hay thẻ — cả hai đều làm ví tăng); nguồn chỉ quyết QUỸ (nạp
 * ngân hàng trừ quỹ qua `napViTuBank`) và NỢ THẺ (nạp bằng thẻ). Đây là số ƯỚC TÍNH, KHÔNG phải tiền quỹ:
 * lưới `tests/unit/so-quy/khong-dung-tien-du-kien.test.ts` cấm các file tính quỹ import module này.
 */

export type GiaoDichVi = { date: Date; amount: number };
export type NeoVi = { soDuNeo: number; ngayNeo: Date };

/** THUẦN — số dư ví cuối ngày VN chứa `t`. */
export function tinhSoDuViAds(
  neo: NeoVi,
  nap: readonly GiaoDichVi[],
  chi: readonly GiaoDichVi[],
  t: Date
): number {
  const khoaNeo = khoaNgayVn(neo.ngayNeo);
  const khoaT = khoaNgayVn(t);
  const trongCuaSo = (g: GiaoDichVi) => {
    const k = khoaNgayVn(g.date);
    return k > khoaNeo && k <= khoaT;
  };
  const tong = (ds: readonly GiaoDichVi[]) => ds.filter(trongCuaSo).reduce((s, g) => s + g.amount, 0);
  return neo.soDuNeo + tong(nap) - tong(chi);
}

type DbDocVi = Pick<Prisma.TransactionClient, "viAdsTraTruoc" | "cashMovement" | "expense">;

const MOT_NGAY_MS = 24 * 3600 * 1000;

/** Số dư ví của nền tảng cuối ngày VN chứa `t`; `null` khi nền tảng chưa có hồ sơ ví trả trước. */
export async function soDuViAds(nenTang: string, t: Date, db: DbDocVi = prisma): Promise<number | null> {
  const vi = await db.viAdsTraTruoc.findUnique({
    where: { nenTang },
    select: { id: true, soDuNeo: true, ngayNeo: true },
  });
  if (vi === null) return null;
  // Biên thô ở DB (đầu ngày neo → hết ngày t, giờ VN — VN không có giờ mùa hè), phần thuần cắt đúng khoá ngày.
  const tu = new Date(`${khoaNgayVn(vi.ngayNeo)}T00:00:00+07:00`);
  const den = new Date(new Date(`${khoaNgayVn(t)}T00:00:00+07:00`).getTime() + MOT_NGAY_MS);
  const date = { gte: tu, lt: den };
  const [nap, chi] = await Promise.all([
    db.cashMovement.findMany({
      where: { kind: "ADS_TOPUP", viAdsId: vi.id, date },
      select: { date: true, amount: true },
    }),
    db.expense.findMany({
      where: { adsSource: nenTang, cardId: null, date },
      select: { date: true, amount: true },
    }),
  ]);
  return tinhSoDuViAds(vi, nap, chi, t);
}
