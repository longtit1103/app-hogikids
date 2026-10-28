import type { Prisma } from "@/generated/prisma/client";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import {
  COT_KY_NEO,
  duNo,
  kyNeoTuDong,
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
 * Nguồn, gán về thẻ theo LUẬT THẺ DUY NHẤT (`theCuaDongChi` — cardId thắng, không thì ads theo nền tảng,
 * không bao giờ cả hai):
 *  - CHI   = `Expense` có thẻ gánh là thẻ này (cardId ghi tay; hoặc ads nền tảng KHÔNG thuộc
 *            `NEN_TANG_HOA_DON_THAT` — META, SHOPEE_ADS… — theo mốc gắn)
 *          + HOÁ ĐƠN THẬT của nền tảng thuộc `NEN_TANG_HOA_DON_THAT` (hôm nay chỉ TIKTOK_ADS — `TiktokAdsHoaDon`
 *            loại `BILL_PAYMENT`/`ADD_BALANCE`, `billingType = CASH`, `amountType = POSITIVE`, `createTime ≥ M`,
 *            thẻ = `theCuaNenTang(ctx, "TIKTOK_ADS", createTime)`; `soTien = amount` GỒM VAT)
 *          + `ADS_TOPUP` nạp ví ads BẰNG thẻ này (§5.9: nạp bằng thẻ không chạm quỹ, `soTien = amount`).
 *  - VI_TRU = `TiktokAdsSettlement` có thẻ của TIKTOK_ADS tại `orderCreateTime` là thẻ này —
 *            `soTien = −settlementAmount` CÓ DẤU (dòng ví âm = ví tự trừ ⇒ giảm nợ; dòng dương = hoàn
 *            ⇒ nợ tăng lại). KHÔNG `abs` từng dòng (review lõi thuần N5).
 *          + hoá đơn thật `amountType = NEGATIVE` (TikTok hoàn về phương thức thanh toán) — `soTien = amount` DƯƠNG.
 *  - TRA   = `CARD_PAY` gắn `cardId`.
 *
 * VÌ SAO TIKTOK_ADS ĐỌC HOÁ ĐƠN, KHÔNG ĐỌC `Expense`: TikTok tặng tín dụng ads — phần ads trả bằng tín dụng
 * KHÔNG trừ thẻ, nên Σ`Expense` ads (chi tiêu báo cáo) cao hơn số ngân hàng ghi nợ. Hoá đơn `BILL_PAYMENT|CASH`
 * là đúng số TikTok thu. `Expense` ads TIKTOK_ADS `cardId` null vì thế KHÔNG còn là CHI (đếm cả hai là hai lần);
 * `Expense` TIKTOK_ADS có `cardId` ghi tay vẫn theo luật cardId thắng như cũ.
 *
 * VÌ SAO GIỮ VI_TRU: mỗi lần TikTok thu — dù trừ ví TikTok Shop hay trừ thẻ — đều ra một hoá đơn `BILL_PAYMENT|CASH`
 * (đo 112/112 lần ví trừ có hoá đơn cùng số, ±2 phút; trả tách ví + thẻ ra hai hoá đơn). Σ hoá đơn vì thế GỒM
 * phần ví trả ⇒ nợ thẻ = neo + Σ hoá đơn − Σ|ví trừ| − Σ CARD_PAY.
 *
 * LOẠI BỎ QUA: `ORDER_CREATION_PAYMENT` (trả từ số dư đã nạp — tiền đã rời thẻ ở lần `ADD_BALANCE`), `PROMOTION_ISSUED`
 * và mọi `billingType` ≠ CASH (tín dụng tặng). `ADD_BALANCE|CASH` = nạp số dư bằng phương thức thanh toán ⇒ tiền
 * rời thẻ ⇒ tính như hoá đơn. `paymentPortfolioId` KHÔNG dùng làm khoá thẻ (có cả trên hoá đơn ví trả).
 *
 * ĐỘ TRỄ (biết mà chấp nhận): API hoá đơn TikTok trễ 6–11h (hoá đơn chiều/tối ngày D về ở lượt kéo đêm D+2), còn
 * ngân hàng ghi nhận lần trừ TikTok trễ ~1 ngày ⇒ ước tính lệch ngân hàng ± khoảng một ngày hoá đơn.
 *
 * Mọi biên ngày theo khoá ngày VN: `den` = CUỐI NGÀY `den` giờ VN.
 */

/**
 * Nền tảng ads mà nợ thẻ đọc từ HOÁ ĐƠN THẬT thay vì `Expense`. Thêm nền tảng vào đây thì phải có bảng hoá đơn
 * của nó trong `docGiaoDichThe` — không thì nền tảng đó biến khỏi nợ thẻ.
 */
export const NEN_TANG_HOA_DON_THAT = ["TIKTOK_ADS"] as const;

/** Loại giao dịch hoá đơn TikTok làm tiền rời phương thức thanh toán (xem docblock đầu file). */
const LOAI_HOA_DON_CHI_THE = ["BILL_PAYMENT", "ADD_BALANCE"];

/** Hoá đơn trả bằng TIỀN (thẻ/ví) — loại khác (CREDIT = tín dụng tặng) không chạm thẻ. */
const HOA_DON_TRA_TIEN = "CASH";

const laNenTangHoaDonThat = (nenTang: string): boolean =>
  (NEN_TANG_HOA_DON_THAT as readonly string[]).includes(nenTang);

/** Client đọc được các bảng cần — prisma gốc hoặc `tx` của transaction đang chạy. */
export type DbDocThe = Pick<
  Prisma.TransactionClient,
  | "setting"
  | "ganNenTangThe"
  | "viAdsTraTruoc"
  | "expense"
  | "cashMovement"
  | "tiktokAdsSettlement"
  | "tiktokAdsHoaDon"
  | "kySaoKeThe"
  | "theTinDung"
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
 * Nguồn của một giao dịch thẻ — chỉ cho đối chiếu sao kê (`doi-chieu-sao-ke-voi-app.ts`) phân biệt từng loại; lõi dư
 * nợ chỉ dùng `GiaoDichThe` (`docGiaoDichThe` bỏ hai trường này đi).
 *  - `CHI_PHI_THE`: `Expense` có `cardId` = thẻ này (ghi tay "trừ vào thẻ") · `ADS_NEN_TANG`: `Expense` ads theo mốc gắn
 *  - `HOA_DON` / `HOAN_HOA_DON`: hoá đơn TikTok POSITIVE / NEGATIVE · `VI_TRU`: ví TikTok Shop trừ
 *  - `NAP_VI`: `ADS_TOPUP` bằng thẻ · `TRA_THE`: `CARD_PAY`
 */
export type NguonGiaoDichThe = "CHI_PHI_THE" | "ADS_NEN_TANG" | "HOA_DON" | "HOAN_HOA_DON" | "VI_TRU" | "NAP_VI" | "TRA_THE";
export type GiaoDichTheChiTiet = GiaoDichThe & { id: string; nguon: NguonGiaoDichThe };

/**
 * Mọi giao dịch đã gán về thẻ `cardId` có ngày ≤ cuối ngày `den` (VN). Không chặn biên dưới theo neo:
 * lõi thuần tự bỏ giao dịch không sau neo. Biên dưới M cho Expense/ví/hoá đơn vì trước M không có thẻ nào gánh
 * (hoá đơn trước mốc gắn TIKTOK_ADS cũng không về thẻ — `theCuaNenTang` — nên số neo mở sổ không bị đếm lại).
 */
export async function docGiaoDichThe(
  cardId: string,
  den: Date,
  db: DbDocThe = prisma,
  ctx?: NguCanhLoc
): Promise<GiaoDichThe[]> {
  const gd = await docGiaoDichTheChiTiet(cardId, den, db, ctx);
  return gd.map(({ ngay, soTien, loai }) => ({ ngay, soTien, loai }));
}

/** Như `docGiaoDichThe` nhưng giữ `id` + `nguon` từng dòng — CÙNG một luật thẻ, một bộ câu đọc. */
export async function docGiaoDichTheChiTiet(
  cardId: string,
  den: Date,
  db: DbDocThe = prisma,
  ctx?: NguCanhLoc
): Promise<GiaoDichTheChiTiet[]> {
  const c = ctx ?? (await docNguCanhLoc(db));
  const truoc = sauCuoiNgayVn(den);
  // Nền tảng TỪNG gắn vào thẻ này (mọi mốc) — dòng ads của nền tảng khác không bao giờ về thẻ này.
  const nenTang = [...new Set(c.gan.filter((g) => g.cardId === cardId).map((g) => g.nenTang))];
  // Nền tảng đọc nợ từ `Expense` (ads theo mốc gắn) — nền tảng có hoá đơn thật đọc từ bảng hoá đơn bên dưới.
  const nenTangTheoExpense = nenTang.filter((n) => !laNenTangHoaDonThat(n));
  const coTiktok = nenTang.includes("TIKTOK_ADS");

  const [chiPhi, viTiktok, hoaDonTiktok, dongTien] = await Promise.all([
    c.mocM === null
      ? Promise.resolve([])
      : db.expense.findMany({
          where: {
            date: { gte: c.mocM, lt: truoc },
            OR: [
              { cardId },
              ...(nenTangTheoExpense.length > 0
                ? [{ cardId: null, categoryId: "ads", adsSource: { in: nenTangTheoExpense } }]
                : []),
            ],
          },
          select: { id: true, date: true, amount: true, cardId: true, categoryId: true, adsSource: true },
        }),
    c.mocM === null || !coTiktok
      ? Promise.resolve([])
      : db.tiktokAdsSettlement.findMany({
          where: { orderCreateTime: { gte: c.mocM, lt: truoc } },
          select: { id: true, orderCreateTime: true, settlementAmount: true },
        }),
    c.mocM === null || !coTiktok
      ? Promise.resolve([])
      : db.tiktokAdsHoaDon.findMany({
          where: {
            createTime: { gte: c.mocM, lt: truoc },
            transactionType: { in: LOAI_HOA_DON_CHI_THE },
            billingType: HOA_DON_TRA_TIEN,
          },
          select: { id: true, createTime: true, amount: true, amountType: true },
        }),
    db.cashMovement.findMany({
      where: { cardId, kind: { in: ["CARD_PAY", "ADS_TOPUP"] }, date: { lt: truoc } },
      select: { id: true, date: true, amount: true, kind: true },
    }),
  ]);

  const gd: GiaoDichTheChiTiet[] = [];
  for (const e of chiPhi) {
    // Lọc lại bằng ĐÚNG luật thẻ duy nhất: câu Prisma chỉ thu hẹp, luật (mốc tuNgay theo ngày, đổi thẻ
    // giữa kỳ, cardId < M) nằm ở `theCuaDongChi`. `Expense` có `cardId` ghi tay đi nhánh `{ cardId }` ở trên
    // — kể cả adsSource TIKTOK_ADS (cardId thắng, y cũ).
    if (theCuaDongChi(c, e) === cardId) {
      gd.push({ id: e.id, ngay: e.date, soTien: e.amount, loai: "CHI", nguon: e.cardId === cardId ? "CHI_PHI_THE" : "ADS_NEN_TANG" });
    }
  }
  for (const v of viTiktok) {
    if (theCuaNenTang(c, "TIKTOK_ADS", v.orderCreateTime) === cardId) {
      gd.push({ id: v.id, ngay: v.orderCreateTime, soTien: -v.settlementAmount, loai: "VI_TRU", nguon: "VI_TRU" });
    }
  }
  for (const h of hoaDonTiktok) {
    if (theCuaNenTang(c, "TIKTOK_ADS", h.createTime) !== cardId) continue;
    if (h.amountType === "POSITIVE") {
      gd.push({ id: h.id, ngay: h.createTime, soTien: h.amount, loai: "CHI", nguon: "HOA_DON" });
    } else if (h.amountType === "NEGATIVE") {
      // Hoàn về thẻ ⇒ GIẢM nợ. Ghi `VI_TRU` DƯƠNG chứ không ghi `CHI` âm: lõi thuần `ky-sao-ke.ts` cấm CHI âm
      // (`kiemDauGiaoDich` bắt caller quy dấu sai), còn VI_TRU có dấu và bị TRỪ khỏi dư nợ — đúng nghĩa
      // "tiền về lại thẻ". Không thêm loại mới vào lõi để giữ nguyên công thức + test lõi.
      gd.push({ id: h.id, ngay: h.createTime, soTien: h.amount, loai: "VI_TRU", nguon: "HOAN_HOA_DON" });
    }
    // amountType khác: CHECK ở DB + mapping đã chặn — không có nhánh thứ ba.
  }
  for (const m of dongTien) {
    gd.push(
      m.kind === "CARD_PAY"
        ? { id: m.id, ngay: m.date, soTien: m.amount, loai: "TRA", nguon: "TRA_THE" }
        : { id: m.id, ngay: m.date, soTien: m.amount, loai: "CHI", nguon: "NAP_VI" }
    );
  }
  return gd;
}

/** Các lần TikTok trừ THẺ THẬT tạo đúng một ngày — phần ví TikTok Shop trả đã bỏ ra (xem `docHoaDonTiktokTrongNgay`). */
export type HoaDonTiktokTrongNgay = {
  /** Số lần trừ thẻ thật = số hoá đơn − số lần ví TikTok Shop trừ cùng ngày (mỗi lần ví trừ ra đúng một hoá đơn). */
  soLan: number;
  /** Tổng trừ thẻ thật = Σ hoá đơn − `viTra`, kẹp ≥ 0. */
  tong: number;
  /** Phần ví TikTok Shop trả trong ngày (Σ −`settlementAmount`, có dấu như `VI_TRU`, kẹp ≥ 0) — chỉ để nói rõ. */
  viTra: number;
};

/**
 * Các lần TikTok trừ thẻ (hoá đơn `BILL_PAYMENT`/`ADD_BALANCE`, CASH, POSITIVE) TẠO ĐÚNG ngày `ngay` (khoá VN) mà thẻ
 * gánh TIKTOK_ADS lúc đó là `cardId` — cùng bộ lọc + luật thẻ với `docGiaoDichThe`. Cho form chốt sao kê: ngân hàng
 * thường ghi sổ lần trừ TikTok trễ ~1 ngày, nên sao kê chốt ngày D hay CHƯA gồm các lần trừ tạo ngày D — mà lõi
 * (`ky-sao-ke.ts`) coi mọi giao dịch ≤ ngày chốt là đã nằm trong neo. Chủ shop cần biết N lần / tổng X để quyết có
 * cộng vào số sao kê hay không. Trước M hoặc nền tảng chưa gắn thẻ ⇒ 0.
 *
 * TRỪ PHẦN VÍ TRẢ: mọi lần TikTok thu — kể cả trừ ví TikTok Shop — đều ra một hoá đơn `BILL_PAYMENT|CASH` (đo
 * 112/112). Phần ví trả KHÔNG BAO GIỜ lên sao kê ngân hàng; nhắc chủ shop "cộng X" mà X gồm phần ví là neo thừa đúng
 * phần đó tới kỳ sau. Ví trừ cùng ngày (`TiktokAdsSettlement` theo `orderCreateTime`, CÙNG luật `VI_TRU` của
 * `docGiaoDichThe`: `theCuaNenTang` + dấu −`settlementAmount`) bị trừ ra khỏi cả số lần lẫn tổng.
 */
export async function docHoaDonTiktokTrongNgay(
  cardId: string,
  ngay: string,
  db: DbDocThe = prisma,
  ctx?: NguCanhLoc
): Promise<HoaDonTiktokTrongNgay> {
  const c = ctx ?? (await docNguCanhLoc(db));
  if (c.mocM === null) return { soLan: 0, tong: 0, viTra: 0 };
  const dau = new Date(`${ngay}T00:00:00+07:00`);
  const sau = new Date(dau.getTime() + MOT_NGAY_MS);
  const tu = dau > c.mocM ? dau : c.mocM;
  const [rows, vi] = await Promise.all([
    db.tiktokAdsHoaDon.findMany({
      where: {
        createTime: { gte: tu, lt: sau },
        transactionType: { in: LOAI_HOA_DON_CHI_THE },
        billingType: HOA_DON_TRA_TIEN,
        amountType: "POSITIVE",
      },
      select: { createTime: true, amount: true },
    }),
    db.tiktokAdsSettlement.findMany({
      where: { orderCreateTime: { gte: tu, lt: sau } },
      select: { orderCreateTime: true, settlementAmount: true },
    }),
  ]);
  let soHoaDon = 0;
  let tongHoaDon = 0;
  for (const h of rows) {
    if (theCuaNenTang(c, "TIKTOK_ADS", h.createTime) !== cardId) continue;
    soHoaDon += 1;
    tongHoaDon += h.amount;
  }
  let soLanVi = 0;
  let viCoDau = 0;
  for (const v of vi) {
    if (theCuaNenTang(c, "TIKTOK_ADS", v.orderCreateTime) !== cardId) continue;
    viCoDau += -v.settlementAmount;
    if (v.settlementAmount < 0) soLanVi += 1;
  }
  const viTra = Math.max(0, viCoDau);
  return {
    soLan: Math.max(0, soHoaDon - soLanVi),
    tong: Math.max(0, tongHoaDon - viTra),
    viTra,
  };
}

/** Lịch sử neo/kỳ sao kê của thẻ, dạng lõi thuần. */
export async function docKyNeoThe(cardId: string, db: DbDocThe = prisma): Promise<KyNeo[]> {
  const rows = await db.kySaoKeThe.findMany({ where: { cardId }, select: COT_KY_NEO, orderBy: { ngayChot: "asc" } });
  return rows.map(kyNeoTuDong);
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
