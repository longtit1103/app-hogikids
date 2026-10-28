import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import type { DongSaoKeGhi } from "@/lib/no-phai-tra/ghi-ky-sao-ke";
import { docGiaoDichTheChiTiet, type DbDocThe } from "@/lib/no-phai-tra/du-no-the";
import { theCuaNenTang, type NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { docTextPdf } from "@/lib/sao-ke-the/doc-text-pdf";
import {
  doiChieuSaoKeThe,
  type BillApp,
  type KetQuaDoiChieu,
} from "@/lib/sao-ke-the/doi-chieu-sao-ke-the";
import { LECH_NGAY_GHEP_THE, type GiaoDichAppThe } from "@/lib/sao-ke-the/ghep-chi-tra-the-voi-sao-ke";
import {
  parseSaoKeTechcombank,
  type DongSaoKe,
  type SaoKeThe,
} from "@/lib/sao-ke-the/techcombank-sao-ke-parser";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Phần DB + file của "Nhập sao kê thẻ (PDF)" — dùng chung cho bước xem trước và bước chốt (`actions/sao-ke-the.ts`).
 * Bước chốt CHẠY LẠI toàn bộ (đọc file → tách → đối chiếu TRONG tx sau khoá thẻ): server không tin số client gửi.
 *
 * KHÔNG đụng quỹ, P&L hay công thức dư nợ: chỉ ĐỌC hoá đơn TikTok / ví TikTok / chi thẻ / nạp ví / trả thẻ để ghép
 * với sao kê, ra số đề xuất cho kỳ sao kê mới (ghi qua lõi `ghi-ky-sao-ke.ts`).
 */

/** Đọc thêm dòng sao kê đã lưu của kỳ PDF trước (loại bill đã ghép ở kỳ đó). */
type DbDoiChieu = DbDocThe & Pick<Prisma.TransactionClient, "dongSaoKeThe">;

/**
 * Trần dung lượng file sao kê phía server (Next đã nới body Server Action lên 3 MB — app tự từ chối rõ câu trước khi
 * đọc). Modal chặn sớm hơn ở 2,5 MB: body multipart còn mang các trường khác, file sát 3 MB sẽ bị chính Next chặn với
 * lỗi chung.
 */
export const TRAN_FILE_SAO_KE = 3 * 1024 * 1024;

/** Cùng bộ lọc "tiền rời phương thức thanh toán" với `docGiaoDichThe` (`du-no-the.ts`) — hoá đơn trả bằng TIỀN. */
const LOAI_HOA_DON_CHI_THE = ["BILL_PAYMENT", "ADD_BALANCE"];
const HOA_DON_TRA_TIEN = "CASH";

/** Ví TikTok Shop trừ và hoá đơn tương ứng cách nhau ±2 phút (đo 112/112) — nới 10 phút cho chắc. */
const LECH_VI_HOA_DON_MS = 10 * 60 * 1000;

const MOT_NGAY_MS = 24 * 3600 * 1000;
const PDF_MAGIC = "%PDF-";

const dauNgayVnTuKhoa = (khoa: string): Date => new Date(`${khoa}T00:00:00+07:00`);
const congNgay = (khoa: string, n: number): string => khoaNgayVn(new Date(dauNgayVnTuKhoa(khoa).getTime() + n * MOT_NGAY_MS));

export type FileSaoKe = { buf: Uint8Array; hash: string };

/**
 * Lấy file `file` từ FormData + cổng rẻ trước khi đọc: có file, ≤ 3 MB, kiểu PDF (trình duyệt gửi `application/pdf`;
 * rỗng thì để magic quyết), 5 byte đầu `%PDF-`. `hash` = sha256 nội dung — khoá "một file một lần" cho mỗi thẻ.
 */
export async function docFileSaoKe(formData: FormData): Promise<{ ok: true; file: FileSaoKe } | { ok: false; error: string }> {
  const f = formData.get("file");
  if (!(f instanceof Blob) || f.size === 0) return { ok: false, error: "Chưa chọn file sao kê" };
  if (f.size > TRAN_FILE_SAO_KE) return { ok: false, error: "File quá lớn (tối đa 3 MB)" };
  if (f.type !== "" && f.type !== "application/pdf") return { ok: false, error: "Cần file PDF sao kê" };
  const buf = new Uint8Array(await f.arrayBuffer());
  if (String.fromCharCode(...buf.subarray(0, PDF_MAGIC.length)) !== PDF_MAGIC) {
    return { ok: false, error: "File không phải PDF" };
  }
  return { ok: true, file: { buf, hash: createHash("sha256").update(buf).digest("hex") } };
}

/** Đọc lớp chữ PDF + tách sao kê Techcombank. Mọi lỗi ⇒ câu tiếng Việt (không ném ra UI). */
export async function tachSaoKe(buf: Uint8Array): Promise<{ ok: true; saoKe: SaoKeThe } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await docTextPdf(buf);
  } catch (e) {
    // `docTextPdf` ném câu tiếng Việt cho các ca biết trước (scan, quá trang…); lỗi lạ của thư viện đi kèm tiền tố.
    const msg = e instanceof Error && e.message ? e.message : "file hỏng";
    return { ok: false, error: `Không đọc được PDF: ${msg}` };
  }
  try {
    const kq = parseSaoKeTechcombank(text);
    if (!kq.ok) return { ok: false, error: `Không tách được sao kê: ${kq.loi}` };
    return { ok: true, saoKe: kq.saoKe };
  } catch (e) {
    console.error("Lỗi tách sao kê thẻ:", e);
    return { ok: false, error: "Không tách được sao kê — chỉ hỗ trợ sao kê thẻ Techcombank" };
  }
}

/**
 * Thẻ gánh một hoá đơn TikTok để GHÉP với sao kê. Từ M: đúng luật thẻ (`theCuaNenTang`, như dư nợ). Trước M chưa có
 * luật thẻ (dư nợ không đọc hoá đơn trước M) mà sao kê vẫn in các lần trừ đó ⇒ coi thẻ của mốc gắn TIKTOK_ADS SỚM
 * NHẤT là thẻ đã trả. Chỉ để ghép dòng sao kê ≤ neo trước — bill ≤ neo trước không đổi số đề xuất.
 */
function theGanhHoaDonTiktok(ctx: NguCanhLoc, d: Date): string | null {
  if (ctx.mocM === null) return null;
  if (khoaNgayVn(d) >= khoaNgayVn(ctx.mocM)) return theCuaNenTang(ctx, "TIKTOK_ADS", d);
  let somNhat: { cardId: string; tuNgay: Date } | null = null;
  for (const g of ctx.gan) {
    if (g.nenTang !== "TIKTOK_ADS") continue;
    if (somNhat === null || g.tuNgay.getTime() < somNhat.tuNgay.getTime()) somNhat = g;
  }
  return somNhat?.cardId ?? null;
}

export type ViTraDaBo = { soLan: number; tong: number };

/**
 * Hoá đơn TikTok của thẻ `cardId` (`BILL_PAYMENT`/`ADD_BALANCE`, CASH) tạo trong `[tu, cuối ngày den]` VN — CÙNG bộ lọc
 * + luật thẻ với dư nợ (`docGiaoDichTheChiTiet`):
 *  - `bills` = POSITIVE (TikTok trừ thẻ). BỎ hoá đơn ví TikTok Shop trả: mỗi lần ví trừ cũng ra một hoá đơn
 *    `BILL_PAYMENT|CASH` cùng số (±2 phút) nhưng KHÔNG BAO GIỜ lên sao kê ngân hàng — để lại thì nó thành "bill ghi sổ
 *    trễ" và CỘNG thừa vào số đề xuất. Ghép một-một (cùng số tiền, lệch ≤ 10 phút) với `TiktokAdsSettlement` âm.
 *  - `hoan` = NEGATIVE (TikTok hoàn về thẻ, `amount` dương). Dư nợ trừ nó như `VI_TRU`; neo PDF phải trừ phần hoàn
 *    ngân hàng chưa ghi sổ, không thì sau chốt lõi chỉ đếm > ngày chốt và khoản hoàn mất hẳn.
 */
export async function docBillTiktokChoSaoKe(
  db: DbDocThe,
  cardId: string,
  tu: string,
  den: string,
  ctx: NguCanhLoc
): Promise<{ bills: BillApp[]; hoan: BillApp[]; viTraDaBo: ViTraDaBo }> {
  const tuMoc = dauNgayVnTuKhoa(tu);
  const sauMoc = dauNgayVnTuKhoa(congNgay(den, 1));
  const [rows, vi] = await Promise.all([
    db.tiktokAdsHoaDon.findMany({
      where: {
        createTime: { gte: tuMoc, lt: sauMoc },
        transactionType: { in: LOAI_HOA_DON_CHI_THE },
        billingType: HOA_DON_TRA_TIEN,
        amountType: { in: ["POSITIVE", "NEGATIVE"] },
      },
      select: { id: true, createTime: true, amount: true, amountType: true },
      orderBy: [{ createTime: "asc" }, { id: "asc" }],
    }),
    db.tiktokAdsSettlement.findMany({
      where: {
        orderCreateTime: { gte: new Date(tuMoc.getTime() - LECH_VI_HOA_DON_MS), lt: new Date(sauMoc.getTime() + LECH_VI_HOA_DON_MS) },
        settlementAmount: { lt: 0 },
      },
      select: { orderCreateTime: true, settlementAmount: true },
      orderBy: { orderCreateTime: "asc" },
    }),
  ]);
  const viConLai = vi.map((v) => ({ t: v.orderCreateTime.getTime(), soTien: -v.settlementAmount, daDung: false }));
  const bills: BillApp[] = [];
  const hoan: BillApp[] = [];
  const viTraDaBo: ViTraDaBo = { soLan: 0, tong: 0 };
  for (const h of rows) {
    if (theGanhHoaDonTiktok(ctx, h.createTime) !== cardId) continue;
    if (h.amountType === "NEGATIVE") {
      hoan.push({ id: h.id, ngay: khoaNgayVn(h.createTime), soTien: h.amount });
      continue;
    }
    const t = h.createTime.getTime();
    const cap = viConLai.find((v) => !v.daDung && v.soTien === h.amount && Math.abs(v.t - t) <= LECH_VI_HOA_DON_MS);
    if (cap) {
      cap.daDung = true;
      viTraDaBo.soLan += 1;
      viTraDaBo.tong += h.amount;
      continue;
    }
    bills.push({ id: h.id, ngay: khoaNgayVn(h.createTime), soTien: h.amount });
  }
  return { bills, hoan, viTraDaBo };
}

/**
 * Giao dịch thẻ khác của app (ngoài hoá đơn TikTok) tới hết ngày `den` (VN) — đọc qua `docGiaoDichTheChiTiet`, CÙNG luật
 * thẻ với dư nợ: chi ghi tay "trừ vào thẻ" (`Expense.cardId`), nạp ví ads bằng thẻ (`ADS_TOPUP`), trả thẻ (`CARD_PAY`).
 * Ads nền tảng theo mốc gắn (`Expense` không `cardId`) KHÔNG ghép: chi tiêu ngày không phải lần ngân hàng trừ (nền tảng
 * gom theo ngưỡng); hoá đơn TikTok đi `docBillTiktokChoSaoKe`.
 */
export async function docGiaoDichAppChoSaoKe(
  db: DbDocThe,
  cardId: string,
  den: string,
  ctx: NguCanhLoc
): Promise<GiaoDichAppThe> {
  const gd = await docGiaoDichTheChiTiet(cardId, dauNgayVnTuKhoa(den), db, ctx);
  const kq: GiaoDichAppThe = { ghiNo: [], ghiCo: [] };
  for (const g of gd) {
    const ngay = khoaNgayVn(g.ngay);
    if (g.nguon === "CHI_PHI_THE") kq.ghiNo.push({ id: g.id, ngay, soTien: g.soTien, loai: "CHI_TAY" });
    else if (g.nguon === "NAP_VI") kq.ghiNo.push({ id: g.id, ngay, soTien: g.soTien, loai: "NAP_VI" });
    else if (g.nguon === "TRA_THE") kq.ghiCo.push({ id: g.id, ngay, soTien: g.soTien });
  }
  return kq;
}

/**
 * Hoá đơn (id — bill hay hoàn) đã ghép với một dòng sao kê của kỳ PDF TRƯỚC ngày sao kê này — nó nằm trên sao kê
 * trước, xét lại ở kỳ này là cộng / trừ hai lần (hoá đơn trong cửa sổ ghi sổ trễ được xét lại dù ≤ neo trước).
 */
async function docBillDaGhepKyTruoc(db: DbDoiChieu, cardId: string, ngaySaoKe: string, billIds: string[]): Promise<Set<string>> {
  if (billIds.length === 0) return new Set();
  const rows = await db.dongSaoKeThe.findMany({
    where: { hoaDonId: { in: billIds }, ky: { cardId, ngayChot: { lt: dauNgayVnTuKhoa(ngaySaoKe) } } },
    select: { hoaDonId: true },
  });
  return new Set(rows.flatMap((r) => (r.hoaDonId === null ? [] : [r.hoaDonId])));
}

/** Khoá ngày VN của lượt hoá đơn TikTok mới nhất về app (`max(syncedAt)`); null = chưa có hoá đơn nào. */
export async function docLanKeoHoaDonMoiNhat(db: DbDocThe): Promise<string | null> {
  const r = await db.tiktokAdsHoaDon.aggregate({ _max: { syncedAt: true } });
  return r._max.syncedAt === null ? null : khoaNgayVn(r._max.syncedAt);
}

/** Thẻ `cardId` có gánh TikTok Ads cuối ngày sao kê không (không gánh thì độ tươi hoá đơn TikTok không liên quan). */
export function theGanhTiktokNgay(ctx: NguCanhLoc, cardId: string, ngay: string): boolean {
  return theCuaNenTang(ctx, "TIKTOK_ADS", new Date(`${ngay}T23:59:59+07:00`)) === cardId;
}

/**
 * Từ ngày các kỳ/neo của thẻ: ngày kỳ/neo gần nhất TRƯỚC ngày sao kê (null = chưa có) + thẻ đã có kỳ đúng ngày đó chưa.
 * Dùng chung cho đối chiếu lúc nhập và lúc tính lại một kỳ đã chốt.
 */
export function ngayChotTruocCua(
  ngayChots: readonly Date[],
  ngaySaoKe: string
): { ngayChotTruoc: string | null; coKyNgaySaoKe: boolean } {
  let ngayChotTruoc: string | null = null;
  let coKyNgaySaoKe = false;
  for (const d of ngayChots) {
    const khoa = khoaNgayVn(d);
    if (khoa === ngaySaoKe) coKyNgaySaoKe = true;
    else if (khoa < ngaySaoKe && (ngayChotTruoc === null || khoa > ngayChotTruoc)) ngayChotTruoc = khoa;
  }
  return { ngayChotTruoc, coKyNgaySaoKe };
}

export type DoiChieuVoiApp = {
  ketQua: KetQuaDoiChieu;
  /** Ngày kỳ/neo gần nhất của thẻ TRƯỚC ngày sao kê (`yyyy-MM-dd`), null = chưa có. */
  ngayChotTruoc: string | null;
  /** Thẻ đã có kỳ/neo đúng ngày sao kê (unique `(cardId, ngayChot)` sẽ chặn chốt). */
  coKyNgaySaoKe: boolean;
  viTraDaBo: ViTraDaBo;
  /** = `ketQua.thanhToanChuaGhi` (giữ ở cấp trên cho caller cũ). */
  thanhToanChuaGhi: DongSaoKe[];
};

/**
 * Đối chiếu sao kê với dữ liệu app của thẻ: tìm neo trước, đọc hoá đơn TikTok (đã bỏ phần ví trả, bỏ bill đã ghép ở
 * kỳ PDF trước) từ đầu kỳ sao kê tới hết ngày sao kê + giao dịch thẻ khác tới D+3 (soi trả/chi ghi sai ngày), ghép
 * (`doiChieuSaoKeThe`). `db` = prisma (xem trước) hoặc `tx` sau khoá thẻ (chốt).
 */
export async function doiChieuSaoKeVoiApp(
  db: DbDoiChieu,
  cardId: string,
  saoKe: SaoKeThe,
  ctx: NguCanhLoc
): Promise<DoiChieuVoiApp> {
  const ngaySaoKe = saoKe.ngaySaoKe;
  const kys = await db.kySaoKeThe.findMany({ where: { cardId }, select: { ngayChot: true } });
  const { ngayChotTruoc, coKyNgaySaoKe } = ngayChotTruocCua(
    kys.map((k) => k.ngayChot),
    ngaySaoKe
  );

  // Từ đầu kỳ sao kê (dòng sớm nhất) — và không muộn hơn ngày sau neo trước, để bill trong khe vẫn được soi.
  let tu = saoKe.dong.reduce<string | null>((m, d) => (m === null || d.ngayGiaoDich < m ? d.ngayGiaoDich : m), null);
  const sauNeo = ngayChotTruoc === null ? null : congNgay(ngayChotTruoc, 1);
  if (tu === null) tu = sauNeo ?? congNgay(ngaySaoKe, -45);
  else if (sauNeo !== null && sauNeo < tu) tu = sauNeo;

  const [{ bills: tatCaBill, hoan: tatCaHoan, viTraDaBo }, giaoDichApp] = await Promise.all([
    docBillTiktokChoSaoKe(db, cardId, tu, ngaySaoKe, ctx),
    docGiaoDichAppChoSaoKe(db, cardId, congNgay(ngaySaoKe, LECH_NGAY_GHEP_THE), ctx),
  ]);
  const daGhep = await docBillDaGhepKyTruoc(
    db,
    cardId,
    ngaySaoKe,
    [...tatCaBill, ...tatCaHoan].map((b) => b.id)
  );
  const bills = tatCaBill.filter((b) => !daGhep.has(b.id));
  const hoan = tatCaHoan.filter((b) => !daGhep.has(b.id));
  const ketQua = doiChieuSaoKeThe(saoKe, bills, {
    ngayChotTruoc,
    mocM: ctx.mocM === null ? null : khoaNgayVn(ctx.mocM),
    giaoDichApp,
    hoan,
  });
  return { ketQua, ngayChotTruoc, coKyNgaySaoKe, viTraDaBo, thanhToanChuaGhi: ketQua.thanhToanChuaGhi };
}

const khoaDong = (d: DongSaoKe): string => [d.ngayGiaoDich, d.ngayGhiSo, d.ghiNo, d.ghiCo, d.dienGiai].join("|");

/**
 * Dòng sao kê ⇒ dòng ghi `DongSaoKeThe` (ngày 00:00 VN) kèm `hoaDonId` ghép được (bill cho dòng ghi nợ, hoá đơn hoàn
 * cho dòng ghi có — kỳ PDF sau loại chúng theo id). Ghép theo NỘI DUNG dòng (multiset), không theo tham chiếu object —
 * lõi đối chiếu có thể trả bản sao.
 */
export function dongSaoKeDeGhi(saoKe: SaoKeThe, ketQua: KetQuaDoiChieu): DongSaoKeGhi[] {
  const hoaDonTheoDong = new Map<string, string[]>();
  for (const k of [...ketQua.khop, ...ketQua.khopHoan]) {
    const khoa = khoaDong(k.dong);
    const ds = hoaDonTheoDong.get(khoa) ?? [];
    ds.push(k.billId);
    hoaDonTheoDong.set(khoa, ds);
  }
  return saoKe.dong.map((d) => ({
    ngayGiaoDich: dauNgayVnTuKhoa(d.ngayGiaoDich),
    ngayGhiSo: dauNgayVnTuKhoa(d.ngayGhiSo),
    ghiNo: d.ghiNo,
    ghiCo: d.ghiCo,
    dienGiai: d.dienGiai,
    laTiktok: d.laTiktok,
    hoaDonId: hoaDonTheoDong.get(khoaDong(d))?.shift() ?? null,
  }));
}
