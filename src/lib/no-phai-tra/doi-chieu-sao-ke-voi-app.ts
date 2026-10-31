import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { formatVnd } from "@/lib/format";
import {
  hienPhamVi,
  MODE_DAU_BAT_DAU,
  MODE_DAU_KET_THUC,
  phamViCuaLuot,
  phamViPhuNgayVn,
  STREAM_HOA_DON_TIKTOK,
  timLuotPhuNgay,
  xetLuotCoDau,
  type KetQuaLuotCoDau,
  type PhamViHoaDon,
} from "@/lib/no-phai-tra/dau-luot-hoa-don-tiktok";
import {
  docHoaDonTinhNoTheCuaBc,
  docTrangThaiBcBen,
  NOI_DANH_DAU_BC_KHONG_DUNG,
} from "@/lib/no-phai-tra/bc-tiktok-hoa-don";
import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import type { DongSaoKeGhi } from "@/lib/no-phai-tra/ghi-ky-sao-ke";
import { dieuKienHoaDonTiktokTinhNoThe, docGiaoDichTheChiTiet, type DbDocThe } from "@/lib/no-phai-tra/du-no-the";
import { theCuaNenTang, type NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { lyDoHoaDonTiktokChuaVe, ngayHoaDonTiktokDuVe } from "@/lib/sao-ke-the/cong-chot-sao-ke";
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
export function theGanhHoaDonTiktok(ctx: NguCanhLoc, d: Date): string | null {
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
      // Cùng tập "hoá đơn tính vào dư nợ thẻ" với `docGiaoDichThe` (`du-no-the.ts`).
      where: { ...dieuKienHoaDonTiktokTinhNoThe(tuMoc, sauMoc), amountType: { in: ["POSITIVE", "NEGATIVE"] } },
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

/** `SyncLog.stats.mode` của trang đã land VÀ dựng Silver (route `/api/ingest/raw`); `bronze-only` chưa có Silver. */
const CHE_DO_DA_DUNG_SILVER = "land+transform";
/** Cửa sổ soi `SyncLog` (lượt kéo) và kho thô (BC "đang dùng") trước ngày sao kê. */
const SO_NGAY_XET_BC_HOA_DON = 30;

type DbDoTuoiHoaDon = Pick<
  Prisma.TransactionClient,
  "syncLog" | "rawTiktokBusinessInvoice" | "tiktokBcHoaDon" | "tiktokAdsHoaDon" | "setting"
>;

/** Kết quả lượt mới nhất của một BC + ca BC cần xét mà không còn lượt nào trong cửa sổ (biến mất). */
type TrangThaiLuotBc = KetQuaLuotCoDau | { loai: "chua-co-luot" };

const ngayNganKhoa = (k: string): string => `${k.slice(8, 10)}/${k.slice(5, 7)}`;

/** Khoá Setting n8n đọc để KÉO BÙ hoá đơn TikTok từ một ngày cũ (khối dấu lượt của `tiktok-business-nightly`). */
const KHOA_KEO_BU_HOA_DON_TIKTOK = "tiktokBusinessHoaDonTuNgay";
/** Mục hướng dẫn kéo bù — câu lý do của cổng trỏ về đây. */
const HUONG_DAN_KEO_BU_HOA_DON_TIKTOK = 'n8n/huong-dan-cai-dat-workflows.md, mục "Kéo bù hoá đơn TikTok"';

/**
 * Trần lùi của khoá kéo bù — PHẢI bằng `KEO_BU_HOA_DON_TRAN_NGAY` trong khối dấu lượt của `tiktok-business-nightly`
 * (test workflow ghim hai bên). n8n từ chối khoá khi `hôm nay − ngày khoá > trần`.
 */
export const TRAN_NGAY_KEO_BU_HOA_DON_TIKTOK = 60;

/**
 * Cách KÉO BÙ một lượt phủ ngày sao kê D: lùi mốc đầu cửa sổ hoá đơn về D − 1 (phủ D cả khi TikTok hiểu chuỗi theo UTC).
 * Mốc cuối n8n luôn giữ 00:00 hôm nay — đã sau D+1 vì cổng chỉ chạy từ D+2. D − 1 đã quá trần lùi ⇒ n8n chắc chắn
 * từ chối khoá ⇒ KHÔNG khuyên kéo bù, nói thẳng chốt bằng form tay.
 */
function huongDanKeoBu(ngaySaoKe: string, homNay: string): string {
  const tuNgay = congNgay(ngaySaoKe, -1);
  const soNgayLui = Math.round((dauNgayVnTuKhoa(homNay).getTime() - dauNgayVnTuKhoa(tuNgay).getTime()) / MOT_NGAY_MS);
  if (soNgayLui > TRAN_NGAY_KEO_BU_HOA_DON_TIKTOK) {
    return (
      `Ngày cần kéo bù (${ngayNganKhoa(tuNgay)}) đã cách hôm nay ${soNgayLui} ngày, quá trần kéo bù ` +
      `${TRAN_NGAY_KEO_BU_HOA_DON_TIKTOK} ngày — KHÔNG kéo bù được, chốt kỳ này bằng form chốt tay`
    );
  }
  return (
    `KÉO BÙ: đặt khoá \`${KHOA_KEO_BU_HOA_DON_TIKTOK}\` = "${tuNgay}" trong bảng Setting, bấm "Chạy tay" workflow ` +
    `tiktok-business-nightly trên n8n, đợi chạy xong (không đỏ) rồi XOÁ khoá đó và nhập lại (hướng dẫn: ` +
    `${HUONG_DAN_KEO_BU_HOA_DON_TIKTOK})`
  );
}

/**
 * Hai trang hoá đơn của cùng BC cách nhau DƯỚI ngần này thì thuộc cùng một lượt kéo (khi trang không mang `luotId`).
 * n8n kéo mọi trang của một lượt liền một mạch trong vài phút; lùi khi TikTok trả 429/5xx tối đa 3s + 8s + 20s mỗi
 * request, cộng nhiều request lùi liên tiếp vẫn chỉ vài phút. Lượt đêm kế tiếp cách ~24h, "Chạy tay" chủ shop bấm lại
 * sau khi thấy lỗi thường cách ≥ vài chục phút. 30' tách được hai ca đó; ca bấm chạy tay ngay trong 30' bị gộp vào lượt
 * lỗi ⇒ vẫn CHẶN (hướng an toàn) tới lượt sau.
 */
const KHOANG_TACH_LUOT_HOA_DON_MS = 30 * 60 * 1000;

/**
 * Một dòng `SyncLog` stream hoá đơn: trang ingest (`/api/ingest/raw`) hoặc DẤU LƯỢT (`/api/ingest/luot-hoa-don-tiktok`,
 * `mode` = `luot-bat-dau` | `luot-ket-thuc`; `stats` mang số liệu kết thúc).
 */
type TrangHoaDon = {
  status: string;
  startedAt: Date;
  bcId: string | null;
  mode: string | null;
  luotId: string | null;
  stats: Prisma.JsonValue | null;
};

const laDauLuot = (t: TrangHoaDon): boolean => t.mode === MODE_DAU_BAT_DAU || t.mode === MODE_DAU_KET_THUC;

/** `stats` của một trang ingest ⇒ BC (`shopId` = bc_id), chế độ, mã lượt kéo; thiếu/sai kiểu ⇒ null. */
function docDauTrang(stats: Prisma.JsonValue | null): Pick<TrangHoaDon, "bcId" | "mode" | "luotId"> {
  const st = stats !== null && typeof stats === "object" && !Array.isArray(stats) ? stats : {};
  return {
    bcId: typeof st.shopId === "string" ? st.shopId : null,
    mode: typeof st.mode === "string" ? st.mode : null,
    luotId: typeof st.luotId === "string" && st.luotId !== "" ? st.luotId : null,
  };
}

/** Một lượt kéo: các trang (theo `startedAt` tăng) + mốc bắt đầu (trang đầu). */
type LuotHoaDon = { batDau: Date; trang: TrangHoaDon[] };

/**
 * Gom trang (đã sắp `startedAt` tăng) thành lượt kéo, trả lượt theo `batDau` tăng.
 *  - Trang có `stats.luotId` (n8n gửi mã lượt — hợp đồng mới): gom theo đúng mã, BẤT KỂ khoảng cách. Hai lượt chồng nhau
 *    xen kẽ trang vẫn tách đúng; hai lượt cách 5' vẫn là hai lượt.
 *  - Trang không có mã: trang liền trước (trong nhóm không mã) cách < `KHOANG_TACH_LUOT_HOA_DON_MS` ⇒ cùng lượt.
 */
function gomLuotHoaDon(ds: readonly TrangHoaDon[]): LuotHoaDon[] {
  const theoMa = new Map<string, LuotHoaDon>();
  const khongMa: LuotHoaDon[] = [];
  for (const t of ds) {
    if (t.luotId !== null) {
      const l = theoMa.get(t.luotId);
      if (l) l.trang.push(t);
      else theoMa.set(t.luotId, { batDau: t.startedAt, trang: [t] });
      continue;
    }
    const cuoi = khongMa.at(-1);
    const truoc = cuoi?.trang.at(-1);
    if (cuoi && truoc && t.startedAt.getTime() - truoc.startedAt.getTime() < KHOANG_TACH_LUOT_HOA_DON_MS) cuoi.trang.push(t);
    else khongMa.push({ batDau: t.startedAt, trang: [t] });
  }
  return [...theoMa.values(), ...khongMa].sort((a, b) => a.batDau.getTime() - b.batDau.getTime());
}

const laLuotSach = (l: LuotHoaDon): boolean =>
  l.trang.every((t) => t.status === "OK") && l.trang.some((t) => t.mode === CHE_DO_DA_DUNG_SILVER);

/**
 * Lý do CHƯA chốt được vì hoá đơn TikTok tạo tới hết ngày sao kê D có thể chưa về app (null = đủ). Fail-closed:
 *  1. hôm nay ≥ D + 2 (`lyDoHoaDonTiktokChuaVe`, cùng câu với form chốt tay);
 *  2. kho thô KHÔNG còn backlog chưa dựng Silver — trang OK vẫn có thể nằm trên backlog cũ;
 *  3. THEO TỪNG BC, THEO LƯỢT KÉO. Dòng `SyncLog` stream hoá đơn từ D − 30 (trang + dấu lượt) được gom thành lượt
 *     (`gomLuotHoaDon`: theo `stats.luotId` nếu có, không thì các trang cách nhau < 30'), rồi xét LƯỢT MỚI NHẤT của
 *     từng BC trong TẬP XÉT.
 *     CHẾ ĐỘ NGHIÊM = app đã từng nhận một dấu lượt (bảng bền `TiktokBcHoaDon` có `lanDauCoDau`, hoặc còn dấu trong
 *     cửa sổ). Bền: KHÔNG tắt vì 30 ngày không có dấu hay vì `SyncLog` cũ bị dọn — workflow ngừng gửi dấu mà cổng tự
 *     quay về luật mù là đúng lỗ cần vá. Trước dấu đầu tiên (app lên trước, workflow gửi dấu import sau) mới dùng luật
 *     cũ.
 *     TẬP XÉT = BC land hoá đơn từ D − 30 ∪ BC có dấu lượt từ D − 30 ∪ (khi nghiêm) BC có trang từ D − 30 ∪ BC ĐÃ TỪNG
 *     đọc được hoá đơn ở MỌI thời điểm (`lanCuoiDocDuoc` bền, hoặc có hoá đơn trong kho thô — kho thô không bị dọn)
 *     ∪ MỌI BC app đã từng nhận dấu (`lanDauCoDau` — BC chưa từng đọc được rồi im > 30 ngày vẫn CHẶN), TRỪ BC chủ shop
 *     đã xác nhận "không dùng thẻ" (`khongDungTu`, khối Business Center TikTok ở Nợ phải trả). Nghiêm mà tập xét rỗng ⇒
 *     CHẶN (không rơi về luật cũ).
 *     BC đã xác nhận "không dùng thẻ" mà có hoá đơn TÍNH VÀO DƯ NỢ THẺ (`dieuKienHoaDonTiktokTinhNoThe`, từ mốc M) tạo
 *     từ `khongDungTu` tới hết ngày D ⇒ CHẶN — dữ liệu nói ngược cờ, hoá đơn của BC đang vào nghĩa vụ thẻ (kể cả khi ví
 *     TikTok Shop trả, `VI_TRU` bù) nên thiếu hoá đơn của nó làm số chốt lệch; gỡ bằng bỏ đánh dấu (cổng xét lại BC).
 *     a. LUẬT DẤU LƯỢT (chế độ nghiêm — MỌI BC): lượt mới nhất phải ĐỦ theo `xetLuotCoDau` (dấu bắt đầu + dấu kết
 *        thúc, kết thúc báo 0 lỗi và GET ≥ total_page, số trang OK app ghi nhận = số trang n8n khai land, không
 *        trang/dấu ERROR/RUNNING). BẰNG CHỨNG cho ngày D (`timLuotPhuNgay`) = lượt ĐỦ mà PHẠM VI THỜI GIAN n8n đã gửi
 *        TikTok (`phamVi` trên dấu = đúng `filtering{start_time, end_time}` của GET) PHỦ TRỌN D — [D 00:00, D+1 00:00)
 *        giờ VN theo MỌI cách hiểu múi của nguồn (TikTok không nói rõ: múi ad account = giờ VN, hoặc UTC ⇒ bảo thủ:
 *        start ≤ "D−1 17:00:00", end ≥ "D+1 00:00:00", `phamViPhuNgayVn`) — VÀ bắt đầu ≥ D+2 00:00 VN. "Lượt phủ D"
 *        dùng vị từ LỎNG (`phamViCoThePhuNgayVn`: phủ D theo ÍT NHẤT một cách hiểu, vd start "D 00:00:00"), cùng lượt
 *        KHÔNG RÕ phạm vi (dấu bản cũ không mang `phamVi`, thiếu dấu bắt đầu — fail-closed coi như có thể phủ D): lượt
 *        phủ D sau cùng hỏng ⇒ CHẶN, lượt phủ D cũ hơn KHÔNG che; lượt đủ chỉ phủ lỏng thì xét tiếp lượt cũ hơn. Câu
 *        lý do: D − 1 quá trần kéo bù (`TRAN_NGAY_KEO_BU_HOA_DON_TIKTOK`) ⇒ chỉ khuyên form tay; lượt phủ D hỏng vì
 *        thiếu quyền finance ⇒ cấp quyền TRƯỚC (hoặc đánh dấu "không dùng thẻ"). Không có lượt đủ nào phủ D (lượt đêm chỉ kéo N ngày gần nhất nên chạy thành công hôm nay vẫn có thể
 *        không còn phủ D) ⇒ CHẶN, câu lý do nói BC, D, phạm vi lượt gần nhất và cách KÉO BÙ (khoá Setting
 *        `tiktokBusinessHoaDonTuNgay` + Chạy tay — `n8n/huong-dan-cai-dat-workflows.md`). KHÔNG dựa ngày chạy thành
 *        công hay số ngày cố định. Lượt mới nhất chỉ có trang (mã lượt lạ / không mã) mà
 *        không có dấu bắt đầu ⇒ CHẶN: dấu không tới app / workflow n8n bị lùi về bản không gửi dấu. Lượt đủ mà 0 hoá
 *        đơn (nguồn `total_page 0`) ⇒ hợp lệ. n8n gửi dấu bắt đầu TRƯỚC lần GET đầu tiên ⇒ lượt hỏng ngay trang 1 (dấu
 *        kết thúc `ketQua` `loi`) hay n8n chết giữa chừng (không dấu kết thúc) vẫn là lượt mới nhất ⇒ CHẶN, lượt sạch
 *        cũ không che. Dấu bắt đầu không tới app ⇒ app không thấy lượt mới (giới hạn còn lại — n8n báo đỏ execution).
 *        BC trong tập xét mà không còn lượt nào từ D − 30 (BC từng đọc được nay biến mất khỏi token) ⇒ CHẶN "chưa có
 *        lượt kéo sau ngày chốt".
 *        Lượt mới nhất `ketQua` `khong-quyen-finance` (TikTok báo BC thiếu quyền finance ngay trang 1) ⇒ CHẶN:
 *         - BC ĐÃ TỪNG đọc được (bất kể bao lâu) ⇒ "MẤT QUYỀN finance" — hoá đơn của BC sau lúc mất quyền không kiểm
 *           được;
 *         - BC CHƯA TỪNG đọc được ⇒ "CHƯA XÁC NHẬN" — không biết BC có trả quảng cáo bằng thẻ không.
 *        Cả hai gỡ bằng cấp quyền finance rồi kéo lại, HOẶC chủ shop đánh dấu BC "không dùng thẻ" (hoặc form chốt tay).
 *     b. LUẬT CŨ — chỉ khi CHƯA nghiêm (app chưa từng nhận dấu lượt nào). KHÔNG xét phạm vi thời gian (trang không
 *        mang phạm vi — mù với việc lượt có phủ D không; giữ nguyên như trước, chỉ để chạy trước khi workflow gửi dấu).
 *        Lượt SẠCH = mọi trang OK và có ≥ 1 trang đã dựng Silver (`land+transform`).
 *         - Lượt MỚI NHẤT có trang ERROR (kể cả 500) hoặc RUNNING ⇒ CHẶN, kể cả khi có trang OK SAU trang lỗi.
 *         - Mốc "đã về" = lượt sạch mới nhất; phải bắt đầu ≥ D+2 00:00 VN.
 *        Luật này MÙ với trang hỏng TRƯỚC khi có SyncLog (400/413/502/timeout) và với lượt đang chạy dở — lý do luật a.
 *     Vì sao theo BC: BC thiếu quyền finance chỉ để lại dấu (không trang nào) — n8n bỏ qua nó rồi đi tiếp BC kia ⇒ lượt
 *     của BC này không nói gì về BC kia. Tập xét rỗng ⇒ gom mọi trang chung theo luật b; tập xét chỉ còn BC đã đánh dấu
 *     "không dùng thẻ" ⇒ CHẶN (thẻ đang gánh TikTok Ads mà không BC nào được kiểm).
 *  4. Trang ERROR/RUNNING stream hoá đơn KHÔNG quy được BC (`stats.shopId` thiếu) có thể là trang của BC nào cũng được
 *     ⇒ tính cho MỌI BC (fail-closed): chặn tới khi mọi BC có lượt sạch BẮT ĐẦU sau trang đó, câu lý do nói rõ "không
 *     xác định được BC". Route `/api/ingest/raw` gắn `stream`/`shopId`/`mode` vào mọi dòng SyncLog (cả nhánh 500), nên
 *     ca này chỉ còn ở dòng ghi tay/dòng lạ — vẫn phải chặn, không đoán.
 *
 * Không dùng `max(TiktokAdsHoaDon.syncedAt)` (chỉ đặt lúc TẠO hoá đơn ⇒ ngừng ads là mốc đứng yên). Trang kéo lại hoá
 * đơn cũ (`landed 0`, trùng hash) vẫn ghi SyncLog OK ⇒ mốc tiến khi ngừng ads. Luật b: cả cửa sổ kéo trống ⇒ không có
 * SyncLog ⇒ chặn (chủ shop dùng form chốt tay); luật a: dấu lượt vẫn tới ⇒ lượt 0 hoá đơn đủ ⇒ mở. Mốc lượt = dòng
 * đầu (dấu bắt đầu, gửi TRƯỚC lần GET đầu tiên) ⇒ mọi trang của lượt được API trả SAU mốc đó — đòi mốc ≥ D+2 là bảo
 * thủ.
 */
export async function lyDoHoaDonTiktokChuaDu(db: DbDoTuoiHoaDon, ngaySaoKe: string, homNay: string): Promise<string | null> {
  const tu = ngayHoaDonTiktokDuVe(ngaySaoKe);
  // Truyền `tu` làm "lượt kéo" chỉ để lấy đúng điều kiện NGÀY của hàm dùng chung; điều kiện lượt kéo xét ở dưới theo BC.
  const lyDoNgay = lyDoHoaDonTiktokChuaVe(ngaySaoKe, homNay, tu);
  if (lyDoNgay !== null) return lyDoNgay;
  if (await hasBronzeBacklog()) {
    return 'Kho thô còn dữ liệu chưa dựng sang bảng nghiệp vụ — hoá đơn TikTok có thể thiếu; chạy "Dựng lại từ kho thô" (Cài đặt) rồi nhập lại';
  }

  const tuXet = dauNgayVnTuKhoa(congNgay(ngaySaoKe, -SO_NGAY_XET_BC_HOA_DON));
  const [ben, mocM, trang] = await Promise.all([
    docTrangThaiBcBen(db, tuXet),
    docMocM(db),
    db.syncLog.findMany({
      where: {
        kind: "TIKTOK_ADS",
        status: { in: ["OK", "ERROR", "RUNNING"] },
        startedAt: { gte: tuXet },
        stats: { path: ["stream"], equals: STREAM_HOA_DON_TIKTOK },
      },
      select: { status: true, startedAt: true, stats: true },
      orderBy: { startedAt: "asc" },
    }),
  ]);
  const ds: TrangHoaDon[] = trang.map((t) => ({ status: t.status, startedAt: t.startedAt, stats: t.stats, ...docDauTrang(t.stats) }));
  const khongRoBc = ds.filter((t) => t.bcId === null && t.status !== "OK");
  const bcCoDau = new Set(ds.flatMap((t) => (laDauLuot(t) && t.bcId !== null ? [t.bcId] : [])));
  const nghiem = ben.daCoDau || bcCoDau.size > 0;

  /**
   * Trạng thái một BC (`null` = gộp mọi trang, luật cũ): ngày bắt đầu lượt sạch mới nhất (null = chưa có), trạng thái
   * lượt mới nhất, BC đã từng đọc được hoá đơn chưa, và còn trang lỗi KHÔNG rõ BC chưa có lượt sạch nào của BC này bắt
   * đầu sau nó (điều kiện 4).
   */
  const xet = (bcId: string | null) => {
    const luot = gomLuotHoaDon(ds.filter((t) => bcId === null || t.bcId === bcId));
    const moiNhat = luot.at(-1);
    let sach: LuotHoaDon | null;
    let luotMoiNhat: TrangThaiLuotBc;
    /** Luật dấu lượt: lượt phủ D sau cùng hỏng (`chiTiet` + ngày lượt) — null khi không có ca đó. */
    let phuHong: { chiTiet: string; ngay: string; khongQuyen: boolean } | null = null;
    /** Luật dấu lượt: lượt mới nhất (đủ) có phạm vi KHÔNG phủ D ⇒ đợi lượt đêm vô ích, phải kéo bù. */
    let moiNhatKhongPhu: PhamViHoaDon | null = null;
    if (bcId !== null && nghiem) {
      // Luật dấu lượt: lượt MỚI NHẤT phải đủ — lượt cũ đủ không che lượt mới hỏng. Bằng chứng = lượt ĐỦ có phạm vi
      // PHỦ ngày sao kê, và lượt mới nhất trong số các lượt (có thể) phủ D phải là nó (`timLuotPhuNgay`).
      luotMoiNhat = moiNhat === undefined ? { loai: "chua-co-luot" } : xetLuotCoDau(moiNhat.trang);
      sach = null;
      if (luotMoiNhat.loai === "du" && moiNhat !== undefined) {
        const phu = timLuotPhuNgay(luot.map((l) => l.trang), ngaySaoKe);
        if (phu.loai === "co") sach = luot[phu.chiSo];
        else if (phu.loai === "phu-hong") phuHong = {
          chiTiet: phu.chiTiet,
          ngay: khoaNgayVn(luot[phu.chiSo].batDau),
          khongQuyen: phu.loaiLuot === "khong-quyen-finance",
        };
        const pv = phamViCuaLuot(moiNhat.trang);
        if (pv !== null && !phamViPhuNgayVn(pv, ngaySaoKe)) moiNhatKhongPhu = pv;
      }
    } else {
      sach = luot.filter(laLuotSach).at(-1) ?? null;
      luotMoiNhat = moiNhat?.trang.some((t) => t.status === "ERROR")
        ? { loai: "trang-loi" }
        : moiNhat?.trang.some((t) => t.status === "RUNNING")
          ? { loai: "dang-chay" }
          : { loai: "du" };
    }
    // Từng đọc được: nhớ bền (dấu kết thúc đã GET ≥ 1 trang, hoặc hoá đơn trong kho thô — MỌI thời điểm), hoặc lượt
    // đủ / lượt sạch còn trong cửa sổ.
    const tungDocDuoc =
      bcId !== null &&
      (ben.tungDocDuoc.has(bcId) || luot.some((l) => laLuotSach(l) || xetLuotCoDau(l.trang).loai === "du"));
    return {
      bcId,
      lanCuoi: sach === null ? null : khoaNgayVn(sach.batDau),
      luotMoiNhat,
      phuHong,
      moiNhatKhongPhu,
      tungDocDuoc,
      khongRoBcSau: bcId !== null && khongRoBc.some((t) => sach === null || sach.batDau <= t.startedAt),
    };
  };
  // Khi nghiêm: mọi BC có trang trong cửa sổ, mọi BC từng đọc được, và mọi BC app đã từng nhận dấu (`lanDauCoDau` —
  // BC chưa từng đọc được rồi im lặng > 30 ngày vẫn CHẶN tới khi cấp quyền hoặc đánh dấu "không dùng thẻ").
  const ungVien = new Set([
    ...ben.coHoaDonTrongCuaSo,
    ...bcCoDau,
    ...(nghiem ? [...ds.flatMap((t) => (t.bcId !== null ? [t.bcId] : [])), ...ben.tungDocDuoc, ...ben.coDau] : []),
  ]);

  // BC đã đánh dấu "không dùng thẻ" mà có hoá đơn TÍNH VÀO DƯ NỢ THẺ tạo từ mốc đánh dấu tới hết ngày chốt ⇒ dữ liệu
  // nói ngược cờ (hoá đơn của BC đó đang vào dư nợ) ⇒ CHẶN, không bỏ BC đó khỏi tập xét một cách im lặng.
  if (mocM !== null && ben.khongDung.size > 0) {
    const tuTien = mocM > tuXet ? mocM : tuXet;
    const hoaDon = await docHoaDonTinhNoTheCuaBc(db, [...ben.khongDung.keys()], tuTien, dauNgayVnTuKhoa(congNgay(ngaySaoKe, 1)));
    const nguoc = [...ben.khongDung]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([bcId, tuNgay]) => {
        const cua = hoaDon.filter((h) => h.bcId === bcId && h.createTime >= tuNgay);
        return cua.length === 0 ? [] : [{ bcId, tuNgay, soLan: cua.length, tong: cua.reduce((s, h) => s + h.amount, 0) }];
      });
    if (nguoc.length > 0) {
      const chiTietNguoc = nguoc
        .map((n) => `BC ${n.bcId}: ${n.soLan} hoá đơn, ${formatVnd(n.tong)} từ ${ngayNganKhoa(khoaNgayVn(n.tuNgay))}`)
        .join(" · ");
      return (
        `Business Center đã đánh dấu "không dùng thẻ" nhưng có hoá đơn TikTok trừ tiền tính vào dư nợ thẻ sau mốc đánh ` +
        `dấu (${chiTietNguoc}) — cổng phải kiểm lượt kéo của BC này; bỏ đánh dấu ở ${NOI_DANH_DAU_BC_KHONG_DUNG} để cổng ` +
        `xét lại BC (hoặc chốt bằng form tay)`
      );
    }
  }

  const bcs = [...ungVien].filter((b) => !ben.khongDung.has(b)).sort();
  if (bcs.length === 0 && (ungVien.size > 0 || nghiem)) {
    // Nghiêm thì KHÔNG rơi về `xet(null)` (luật cũ, mù với trang hỏng trước SyncLog).
    return ungVien.size > 0
      ? `Mọi Business Center TikTok (BC ${[...ungVien].sort().join(", ")}) đều được đánh dấu "không dùng thẻ" trong ` +
          `khi thẻ đang gánh TikTok Ads — không BC nào được kiểm hoá đơn trừ thẻ; bỏ đánh dấu BC đang trả quảng cáo bằng ` +
          `thẻ ở ${NOI_DANH_DAU_BC_KHONG_DUNG}, hoặc chốt bằng form tay`
      : "Chưa có Business Center TikTok nào để kiểm hoá đơn trừ thẻ (chế độ dấu lượt đã bật) — đợi lượt kéo đêm rồi " +
          "nhập lại, hoặc chốt bằng form tay";
  }
  const ketQua = bcs.length > 0 ? bcs.map(xet) : [xet(null)];

  const tenBc = (cac: readonly { bcId: string | null }[]) =>
    cac.some((k) => k.bcId !== null) ? ` (BC ${cac.map((k) => k.bcId).join(", ")})` : "";
  const theoLoai = (loai: TrangThaiLuotBc["loai"]) => ketQua.filter((k) => k.luotMoiNhat.loai === loai);
  const chiTiet = (cac: typeof ketQua) =>
    cac
      .map((k) => ("chiTiet" in k.luotMoiNhat ? `BC ${k.bcId}: ${k.luotMoiNhat.chiTiet.slice(0, 300)}` : null))
      .filter((x) => x !== null)
      .join(" · ");

  const loi = theoLoai("trang-loi");
  if (loi.length > 0) {
    return (
      `Lượt kéo hoá đơn TikTok mới nhất có trang LỖI${tenBc(loi)} — hoá đơn có thể thiếu (trang lỗi chưa được kéo lại); ` +
      `xem lỗi đồng bộ ở Cài đặt, kéo lại cho tới khi một lượt chạy hết không lỗi rồi nhập lại`
    );
  }
  const baoLoi = theoLoai("bao-loi");
  if (baoLoi.length > 0) {
    return (
      `Lượt kéo hoá đơn TikTok mới nhất kết thúc với LỖI (${chiTiet(baoLoi)}) — hoá đơn có thể thiếu; xem lỗi đồng bộ ` +
      `ở Cài đặt, kéo lại cho tới khi một lượt chạy hết không lỗi rồi nhập lại`
    );
  }
  const dangChay = theoLoai("dang-chay");
  if (dangChay.length > 0) {
    return (
      `Lượt kéo hoá đơn TikTok mới nhất có trang CHƯA XONG${tenBc(dangChay)} — đang đồng bộ hoặc bị ngắt giữa ` +
      `chừng; đợi lượt kéo chạy xong (hoặc kéo lại) rồi nhập lại`
    );
  }
  const chuaKetThuc = theoLoai("chua-ket-thuc");
  if (chuaKetThuc.length > 0) {
    return (
      `Lượt kéo hoá đơn TikTok mới nhất CHƯA HOÀN TẤT${tenBc(chuaKetThuc)} — chưa có dấu kết thúc lượt (đang chạy hoặc ` +
      `bị ngắt giữa chừng); đợi lượt kéo chạy xong (hoặc kéo lại) rồi nhập lại`
    );
  }
  const thieuBatDau = theoLoai("thieu-bat-dau");
  if (thieuBatDau.length > 0) {
    return (
      `Lượt kéo hoá đơn TikTok mới nhất KHÔNG có dấu bắt đầu lượt${tenBc(thieuBatDau)} — dấu không tới app hoặc ` +
      `workflow n8n không phải bản gửi dấu, nên không kiểm được lượt có đủ trang; kéo lại bằng workflow hiện hành rồi ` +
      `nhập lại`
    );
  }
  const khongKhop = theoLoai("khong-khop");
  if (khongKhop.length > 0) {
    return (
      `Lượt kéo hoá đơn TikTok mới nhất THIẾU TRANG (${chiTiet(khongKhop)}) — trang mất trước khi app ghi nhận, hoá ` +
      `đơn có thể thiếu; kéo lại rồi nhập lại`
    );
  }
  const khongQuyen = theoLoai("khong-quyen-finance");
  const matQuyen = khongQuyen.filter((k) => k.tungDocDuoc);
  if (matQuyen.length > 0) {
    return (
      `Business Center MẤT QUYỀN finance${tenBc(matQuyen)} — lượt kéo hoá đơn TikTok mới nhất bị TikTok từ chối ` +
      `(${chiTiet(matQuyen)}) trong khi app đã từng đọc được hoá đơn của BC này, nên hoá đơn trừ thẻ của BC không ` +
      `kiểm được; cấp lại vai trò finance cho token TikTok Business, kéo lại rồi nhập lại — hoặc nếu BC không còn trả ` +
      `quảng cáo bằng thẻ, đánh dấu "không dùng thẻ" ở ${NOI_DANH_DAU_BC_KHONG_DUNG} (hoặc chốt bằng form tay)`
    );
  }
  const chuaXacNhan = khongQuyen.filter((k) => !k.tungDocDuoc);
  if (chuaXacNhan.length > 0) {
    return (
      `Business Center CHƯA XÁC NHẬN${tenBc(chuaXacNhan)} — TikTok báo thiếu quyền finance (${chiTiet(chuaXacNhan)}) ` +
      `và app chưa từng đọc được hoá đơn của BC này, nên không biết BC có trả quảng cáo bằng thẻ không; cấp vai trò ` +
      `finance cho token TikTok Business rồi kéo lại, HOẶC đánh dấu BC "không dùng thẻ" ở ` +
      `${NOI_DANH_DAU_BC_KHONG_DUNG} (hoặc chốt bằng form tay)`
    );
  }
  const moTaPhuHong = (k: (typeof ketQua)[number]) =>
    k.phuHong === null ? [] : [`BC ${k.bcId}: lượt ngày ${ngayNganKhoa(k.phuHong.ngay)} — ${k.phuHong.chiTiet.slice(0, 300)}`];
  // Lượt phủ D sau cùng bị TikTok từ chối vì thiếu quyền finance: kéo bù khi còn thiếu quyền chỉ lặp lại lượt bị từ
  // chối ⇒ hướng dẫn cấp quyền TRƯỚC (hoặc đánh dấu "không dùng thẻ").
  const phuHongKhongQuyen = ketQua.filter((k) => k.phuHong?.khongQuyen === true).flatMap(moTaPhuHong);
  if (phuHongKhongQuyen.length > 0) {
    return (
      `Lượt kéo hoá đơn TikTok gần nhất PHỦ ngày sao kê ${ngayNganKhoa(ngaySaoKe)} bị TikTok từ chối vì THIẾU QUYỀN ` +
      `finance (${phuHongKhongQuyen.join(" · ")}) — hoá đơn ngày sao kê của BC chưa kiểm được. TRƯỚC HẾT cấp (hoặc kiểm ` +
      `lại) vai trò finance của token TikTok Business với BC này — kéo lại khi còn thiếu quyền chỉ bị từ chối lần nữa; ` +
      `có quyền rồi mới kéo lại. ${huongDanKeoBu(ngaySaoKe, homNay)}. Nếu BC không trả quảng cáo bằng thẻ: đánh dấu ` +
      `"không dùng thẻ" ở ${NOI_DANH_DAU_BC_KHONG_DUNG} (hoặc chốt bằng form tay)`
    );
  }
  const phuHong = ketQua.flatMap(moTaPhuHong);
  if (phuHong.length > 0) {
    return (
      `Lượt kéo hoá đơn TikTok gần nhất PHỦ ngày sao kê ${ngayNganKhoa(ngaySaoKe)} không đủ (${phuHong.join(" · ")}) — lượt ` +
      `phủ ngày đó cũ hơn không che được lượt hỏng, hoá đơn ngày sao kê có thể thiếu. ${huongDanKeoBu(ngaySaoKe, homNay)}`
    );
  }
  // Lượt mới nhất đủ nhưng phạm vi đã trôi qua D, và không còn bằng chứng đạt mốc D+2 ⇒ đợi lượt đêm không bao giờ đủ.
  const canKeoBu = ketQua.flatMap((k) =>
    k.moiNhatKhongPhu !== null && (k.lanCuoi === null || k.lanCuoi < tu)
      ? [`BC ${k.bcId}: lượt gần nhất chỉ phủ ${hienPhamVi(k.moiNhatKhongPhu)}`]
      : [],
  );
  if (canKeoBu.length > 0) {
    return (
      `Chưa có lượt kéo hoá đơn TikTok ĐỦ nào phủ trọn ngày sao kê ${ngayNganKhoa(ngaySaoKe)} và bắt đầu từ ` +
      `${ngayNganKhoa(tu)} (${canKeoBu.join(" · ")}) — lượt đêm chỉ kéo vài ngày gần nhất nên đợi thêm cũng không phủ lại ` +
      `ngày đó. ${huongDanKeoBu(ngaySaoKe, homNay)}`
    );
  }
  const chuaKeo = ketQua.filter((k) => k.lanCuoi === null || k.lanCuoi < tu);
  if (chuaKeo.length > 0) {
    const laBienMat = (k: (typeof ketQua)[number]) => k.luotMoiNhat.loai === "chua-co-luot";
    const lan = (k: (typeof ketQua)[number]) =>
      k.lanCuoi !== null
        ? `lượt mới nhất ngày ${ngayNganKhoa(k.lanCuoi)}`
        : laBienMat(k) && !k.tungDocDuoc
          ? "chưa có lượt nào — CHƯA XÁC NHẬN: chưa từng đọc được hoá đơn"
          : "chưa có lượt nào";
    const chiTietNgay = chuaKeo.map((k) => (k.bcId === null ? `(${lan(k)})` : `BC ${k.bcId} (${lan(k)})`)).join(", ");
    const bienMatTungDoc = chuaKeo.some((k) => laBienMat(k) && k.tungDocDuoc);
    const bienMatChuaDoc = chuaKeo.some((k) => laBienMat(k) && !k.tungDocDuoc);
    return (
      `Chưa có lượt kéo hoá đơn TikTok sau ngày chốt ${chiTietNgay} — đợi lượt kéo đêm từ ${ngayNganKhoa(tu)} rồi nhập ` +
      `lại` +
      (bienMatTungDoc
        ? `; BC không còn lượt kéo nào trong ${SO_NGAY_XET_BC_HOA_DON} ngày mà app đã từng đọc được hoá đơn của nó — ` +
          `kiểm token TikTok Business còn quyền với BC, hoặc nếu BC không còn trả quảng cáo bằng thẻ, đánh dấu "không ` +
          `dùng thẻ" ở ${NOI_DANH_DAU_BC_KHONG_DUNG}`
        : "") +
      (bienMatChuaDoc
        ? `; BC app đã nhận dấu lượt nhưng chưa từng đọc được hoá đơn và nay không còn lượt kéo nào — cấp vai trò ` +
          `finance cho token TikTok Business rồi kéo lại, HOẶC đánh dấu BC "không dùng thẻ" ở ${NOI_DANH_DAU_BC_KHONG_DUNG}`
        : "")
    );
  }
  if (ketQua.some((k) => k.khongRoBcSau)) {
    return (
      "Lượt kéo hoá đơn TikTok có trang LỖI không xác định được BC (thiếu bc_id trong nhật ký đồng bộ) sau lượt thành " +
      "công cuối — không biết hoá đơn của BC nào có thể thiếu nên chặn mọi thẻ; xem lỗi đồng bộ ở Cài đặt, kéo lại cho " +
      "tới khi mọi BC có lượt thành công sau trang lỗi rồi nhập lại"
    );
  }
  return null;
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
