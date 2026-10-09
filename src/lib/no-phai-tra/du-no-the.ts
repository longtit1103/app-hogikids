import type { Prisma } from "@/generated/prisma/client";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import {
  duNo,
  phaiTra,
  type GiaoDichThe,
  type KyNeo,
  type PhaiTra,
} from "@/lib/no-phai-tra/ky-sao-ke";
import { theCuaDongChi, theCuaNenTang, type NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Gom giao dịch thẻ tín dụng từ DB rồi giao cho lõi THUẦN `ky-sao-ke.ts` (spec `design.md` §5.5).
 *
 * DƯ NỢ LÀ SỐ ƯỚC TÍNH (nghĩa vụ ngoài quỹ) — Sổ quỹ TUYỆT ĐỐI không import file này (lưới P2
 * `khong-dung-tien-du-kien`): quỹ chỉ đổi khi tiền thật rời tài khoản (`CARD_PAY`).
 *
 * Ba nguồn, gán về thẻ theo LUẬT THẺ DUY NHẤT (`theCuaDongChi` — cardId thắng, không thì ads theo nền
 * tảng, không bao giờ cả hai):
 *  - CHI   = `Expense` có thẻ gánh là thẻ này  +  `ADS_TOPUP` nạp ví ads BẰNG thẻ này (§5.9: nạp bằng
 *            thẻ không chạm quỹ, cộng vào nợ thẻ đúng ngày nạp; `soTien = amount`).
 *  - VI_TRU = `TiktokAdsSettlement` có thẻ của TIKTOK_ADS tại `orderCreateTime` là thẻ này —
 *            `soTien = −settlementAmount` CÓ DẤU (dòng ví âm = ví tự trừ ⇒ giảm nợ; dòng dương = hoàn
 *            ⇒ nợ tăng lại). KHÔNG `abs` từng dòng (review lõi thuần N5).
 *  - TRA   = `CARD_PAY` gắn `cardId`.
 *
 * Mọi biên ngày theo khoá ngày VN: `den` = CUỐI NGÀY `den` giờ VN.
 */

/** Client đọc được các bảng cần — prisma gốc hoặc `tx` của transaction đang chạy. */
export type DbDocThe = Pick<
  Prisma.TransactionClient,
  "setting" | "ganNenTangThe" | "viAdsTraTruoc" | "expense" | "cashMovement" | "tiktokAdsSettlement" | "kySaoKeThe" | "theTinDung"
>;

const MOT_NGAY_MS = 24 * 3600 * 1000;

/**
 * 00:00 giờ VN của NGÀY (VN) chứa `d` — chuẩn hoá trước khi ghi `KySaoKeThe.ngayChot`/`hanTra`,
 * `GanNenTangThe.tuNgay`: unique khoá theo TIMESTAMP, cùng ngày khác giờ là lách unique (review P1 (a)).
 * Không phụ thuộc TZ của process.
 */
export function dauNgayVn(d: Date): Date {
  return new Date(`${khoaNgayVn(d)}T00:00:00+07:00`);
}

/** Biên TRÊN loại trừ cho "≤ cuối ngày `den` giờ VN" = 00:00 VN hôm sau (VN không có giờ mùa hè). */
function sauCuoiNgayVn(den: Date): Date {
  return new Date(dauNgayVn(den).getTime() + MOT_NGAY_MS);
}

/**
 * Mọi giao dịch đã gán về thẻ `cardId` có ngày ≤ cuối ngày `den` (VN). Không chặn biên dưới theo neo:
 * lõi thuần tự bỏ giao dịch không sau neo. Biên dưới M cho Expense/ví vì trước M không có thẻ nào gánh.
 */
export async function docGiaoDichThe(
  cardId: string,
  den: Date,
  db: DbDocThe = prisma,
  ctx?: NguCanhLoc
): Promise<GiaoDichThe[]> {
  const c = ctx ?? (await docNguCanhLoc(db));
  const truoc = sauCuoiNgayVn(den);
  // Nền tảng TỪNG gắn vào thẻ này (mọi mốc) — dòng ads của nền tảng khác không bao giờ về thẻ này.
  const nenTang = [...new Set(c.gan.filter((g) => g.cardId === cardId).map((g) => g.nenTang))];

  const [chiPhi, viTiktok, dongTien] = await Promise.all([
    c.mocM === null
      ? Promise.resolve([])
      : db.expense.findMany({
          where: {
            date: { gte: c.mocM, lt: truoc },
            OR: [
              { cardId },
              ...(nenTang.length > 0 ? [{ cardId: null, categoryId: "ads", adsSource: { in: nenTang } }] : []),
            ],
          },
          select: { date: true, amount: true, cardId: true, categoryId: true, adsSource: true },
        }),
    c.mocM === null || !nenTang.includes("TIKTOK_ADS")
      ? Promise.resolve([])
      : db.tiktokAdsSettlement.findMany({
          where: { orderCreateTime: { gte: c.mocM, lt: truoc } },
          select: { orderCreateTime: true, settlementAmount: true },
        }),
    db.cashMovement.findMany({
      where: { cardId, kind: { in: ["CARD_PAY", "ADS_TOPUP"] }, date: { lt: truoc } },
      select: { date: true, amount: true, kind: true },
    }),
  ]);

  const gd: GiaoDichThe[] = [];
  for (const e of chiPhi) {
    // Lọc lại bằng ĐÚNG luật thẻ duy nhất: câu Prisma chỉ thu hẹp, luật (mốc tuNgay theo ngày, đổi thẻ
    // giữa kỳ, cardId < M) nằm ở `theCuaDongChi`.
    if (theCuaDongChi(c, e) === cardId) gd.push({ ngay: e.date, soTien: e.amount, loai: "CHI" });
  }
  for (const v of viTiktok) {
    if (theCuaNenTang(c, "TIKTOK_ADS", v.orderCreateTime) === cardId) {
      gd.push({ ngay: v.orderCreateTime, soTien: -v.settlementAmount, loai: "VI_TRU" });
    }
  }
  for (const m of dongTien) {
    gd.push({ ngay: m.date, soTien: m.amount, loai: m.kind === "CARD_PAY" ? "TRA" : "CHI" });
  }
  return gd;
}

/** Lịch sử neo/kỳ sao kê của thẻ, dạng lõi thuần. */
export async function docKyNeoThe(cardId: string, db: DbDocThe = prisma): Promise<KyNeo[]> {
  const rows = await db.kySaoKeThe.findMany({
    where: { cardId },
    select: { ngayChot: true, soDu: true, hanTra: true, daTraTruocMoSo: true, laNeoMoSo: true },
    orderBy: { ngayChot: "asc" },
  });
  return rows;
}

export type DuNoThe = { cardId: string; duNo: number | null; phaiTra: PhaiTra | null };

/**
 * Dư nợ ước tính + số phải trả của TỪNG thẻ (kể cả thẻ đã đóng) tại cuối ngày `t` (VN).
 * `duNo` null = thẻ chưa có neo ≤ t (UI "chưa có neo"); `phaiTra` null = chưa có kỳ sao kê có hạn.
 */
export async function docDuNoCacThe(t: Date, db: DbDocThe = prisma, ctx?: NguCanhLoc): Promise<DuNoThe[]> {
  const c = ctx ?? (await docNguCanhLoc(db));
  const the = await db.theTinDung.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  return Promise.all(
    the.map(async ({ id }) => {
      const [kys, gd] = await Promise.all([docKyNeoThe(id, db), docGiaoDichThe(id, t, db, c)]);
      return { cardId: id, duNo: duNo(kys, gd, t), phaiTra: phaiTra(kys, gd, t) };
    })
  );
}
