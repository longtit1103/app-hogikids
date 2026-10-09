import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import type { KhoaNgay } from "@/lib/so-quy/du-bao-quy-types";

/**
 * Lõi THUẦN kỳ sao kê thẻ tín dụng (spec `design.md` §2 + §5.5): không DB, không đọc đồng hồ — nhận `t`.
 * Phần gom giao dịch từ DB ở `du-no-the.ts`.
 *
 * HỢP ĐỒNG NEO: một dòng `KySaoKeThe` = "dư nợ tổng của thẻ CUỐI NGÀY `ngayChot` là `soDu`". Tại ngày t
 * dùng neo có `ngayChot` lớn nhất ≤ t rồi CHỈ cộng/trừ giao dịch `ngayChot < ngày ≤ t` — giao dịch đúng ngày
 * chốt đã nằm trong số sao kê, đếm nữa là hai lần. Mọi so sánh ngày làm trên khoá `yyyy-MM-dd` giờ VN
 * (`khoaNgayVn`), "cuối ngày" = so `>` trên khoá: 23:59 VN ngày chốt thuộc neo, 00:01 VN hôm sau thì không.
 *
 * FIFO: tiền trả sau kỳ mới nhất ăn phần còn treo của kỳ TRƯỚC (hạn cũ, có thể đã quá) trước, phần dư mới
 * sang kỳ mới — phần kỳ cũ KHÔNG được dời hạn chỉ vì đã gộp vào sao kê mới.
 *
 * KẸP: sao kê mới ĐÃ gồm phần chưa trả của kỳ cũ, nên trần nghĩa vụ là `nghiaVuKy` của kỳ mới nhất; phần
 * kỳ cũ lấy `min(nghiaVuKy, …)` để hai phần cộng lại không bao giờ vượt trần — kể cả khi chủ shop gõ số
 * sao kê mới NHỎ HƠN phần kỳ cũ còn treo (cũ còn 4, mới gõ 2 ⇒ 2 + 0, không phải 4). Không cộng hai sao kê.
 */

export type KyNeo = {
  ngayChot: Date;
  soDu: number;
  /** NULL = neo thuần (vd neo mở sổ cuối M − 1), không phải kỳ có hạn trả. */
  hanTra: Date | null;
  /** Phần của kỳ đã trả TRƯỚC mốc mở sổ (không có `CARD_PAY` tương ứng). */
  daTraTruocMoSo: number;
  laNeoMoSo: boolean;
};

/**
 * Một giao dịch đã gán về thẻ. `soTien` là ĐÓNG GÓP CÓ DẤU theo `loai`, công thức
 * `duNo = neo + Σ CHI − Σ VI_TRU − Σ TRA` cộng thẳng, KHÔNG `abs` từng dòng:
 * - CHI (≥ 0) = `Expense` gán thẻ (ads theo nền tảng HOẶC `cardId`) — cộng vào dư nợ.
 * - TRA (≥ 0) = `CARD_PAY` — trừ dư nợ.
 * - VI_TRU (CÓ DẤU) = `−settlementAmount` của `TiktokAdsSettlement` (ví nền tảng tự trừ thẻ): dòng ví ÂM
 *   ⇒ VI_TRU DƯƠNG ⇒ trừ dư nợ; dòng ví DƯƠNG (hoàn ads) ⇒ VI_TRU ÂM ⇒ cộng lại. Lấy `abs` từng dòng là
 *   trừ cả phần hoàn — sai đúng gấp đôi số hoàn.
 * CHI/TRA âm là caller quy dấu sai ⇒ `kiemDauGiaoDich` ném.
 */
export type GiaoDichThe = { ngay: Date; soTien: number; loai: "CHI" | "VI_TRU" | "TRA" };

/** Chặn CHI/TRA âm (VI_TRU được âm — xem hợp đồng dấu ở `GiaoDichThe`). */
function kiemDauGiaoDich(gd: readonly GiaoDichThe[]): void {
  for (const g of gd) {
    if (g.loai !== "VI_TRU" && g.soTien < 0) {
      throw new Error(`Giao dịch thẻ ${g.loai} phải ≥ 0, nhận ${g.soTien}`);
    }
  }
}

export type PhanPhaiTra = { soTien: number; hanTra: Date; quaHan: boolean; denHanHomNay: boolean };
export type PhaiTra = { nghiaVuKy: number; phanTruoc: PhanPhaiTra | null; phanMoi: PhanPhaiTra | null };

/** Dòng có khoá `ngayChot` lớn nhất thoả `dieuKien` (null nếu không có). */
function chotLonNhat(kys: readonly KyNeo[], dieuKien: (k: KyNeo, khoaChot: KhoaNgay) => boolean): KyNeo | null {
  let tot: KyNeo | null = null;
  let khoaTot = "";
  for (const k of kys) {
    const kc = khoaNgayVn(k.ngayChot);
    if (dieuKien(k, kc) && (tot === null || kc > khoaTot)) {
      tot = k;
      khoaTot = kc;
    }
  }
  return tot;
}

/** Neo dùng tại ngày t: `ngayChot` lớn nhất ≤ t (có hạn hay không). */
export function neoTai(kys: readonly KyNeo[], t: Date): KyNeo | null {
  const kt = khoaNgayVn(t);
  return chotLonNhat(kys, (_, kc) => kc <= kt);
}

/** Kỳ phải trả tại t: kỳ CÓ hạn, `ngayChot` lớn nhất ≤ t. */
export function kyPhaiTraTai(kys: readonly KyNeo[], t: Date): KyNeo | null {
  const kt = khoaNgayVn(t);
  return chotLonNhat(kys, (k, kc) => k.hanTra !== null && kc <= kt);
}

/** Kỳ có hạn liền trước `ky` (một bậc là đủ: soDu của nó đã gồm mọi kỳ cũ hơn). */
export function kyTruoc(kys: readonly KyNeo[], ky: KyNeo): KyNeo | null {
  const kKy = khoaNgayVn(ky.ngayChot);
  return chotLonNhat(kys, (k, kc) => k.hanTra !== null && kc < kKy);
}

/** Σ `soTien` của giao dịch loại `loai` có khoá ngày trong (sau, den] — "sau" là cuối ngày, nên so `>`. */
function tongTrongKhoang(gd: readonly GiaoDichThe[], loai: GiaoDichThe["loai"], sau: KhoaNgay, den: KhoaNgay): number {
  let s = 0;
  for (const g of gd) {
    if (g.loai !== loai) continue;
    const kg = khoaNgayVn(g.ngay);
    if (kg > sau && kg <= den) s += g.soTien;
  }
  return s;
}

/**
 * Dư nợ ƯỚC TÍNH cuối ngày t = neo.soDu + Σ CHI − Σ VI_TRU − Σ TRA trong (neo.ngayChot, t].
 * null khi chưa có neo ≤ t (UI "chưa có neo" — không đoán số).
 */
export function duNo(kys: readonly KyNeo[], gd: readonly GiaoDichThe[], t: Date): number | null {
  kiemDauGiaoDich(gd);
  const neo = neoTai(kys, t);
  if (!neo) return null;
  const sau = khoaNgayVn(neo.ngayChot);
  const den = khoaNgayVn(t);
  return (
    neo.soDu +
    tongTrongKhoang(gd, "CHI", sau, den) -
    tongTrongKhoang(gd, "VI_TRU", sau, den) -
    tongTrongKhoang(gd, "TRA", sau, den)
  );
}

function phan(soTien: number, hanTra: Date, kt: KhoaNgay): PhanPhaiTra | null {
  if (soTien <= 0) return null;
  const kh = khoaNgayVn(hanTra);
  return { soTien, hanTra, quaHan: kh < kt, denHanHomNay: kh === kt };
}

/**
 * Số phải trả tại t, tách hai phần theo HẠN THẬT. `tra` có thể chứa mọi loại giao dịch — chỉ TRA được đọc.
 *
 * Trả null khi chưa có kỳ nào CÓ HẠN với `ngayChot` ≤ t (vd chỉ có neo mở sổ): chưa có sao kê thì không có
 * gì để nhắc trả. Khác `nghiaVuKy` 0 = có kỳ nhưng đã trả hết.
 */
export function phaiTra(kys: readonly KyNeo[], tra: readonly GiaoDichThe[], t: Date): PhaiTra | null {
  kiemDauGiaoDich(tra);
  const ky = kyPhaiTraTai(kys, t);
  if (!ky || !ky.hanTra) return null;
  const kt = khoaNgayVn(t);
  const kChot = khoaNgayVn(ky.ngayChot);

  const pSau = tongTrongKhoang(tra, "TRA", kChot, kt);
  const nghiaVuKy = Math.max(0, ky.soDu - ky.daTraTruocMoSo - pSau);

  const truoc = kyTruoc(kys, ky);
  let soTruoc = 0;
  if (truoc?.hanTra) {
    const traGiuaHaiChot = tongTrongKhoang(tra, "TRA", khoaNgayVn(truoc.ngayChot), kChot);
    const quaHanTruocChot = Math.max(0, truoc.soDu - truoc.daTraTruocMoSo - traGiuaHaiChot);
    soTruoc = Math.min(nghiaVuKy, Math.max(0, quaHanTruocChot - pSau));
  }

  return {
    nghiaVuKy,
    phanTruoc: truoc?.hanTra ? phan(soTruoc, truoc.hanTra, kt) : null,
    phanMoi: phan(nghiaVuKy - soTruoc, ky.hanTra, kt),
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Khoá ngày `ngay` của tháng (`thang` 1–12); ngày vượt số ngày tháng ⇒ ngày cuối tháng (31 ở T2 ⇒ 28/29).
 * Dùng cho nhắc chốt sao kê + gợi ý ngày trong form (chủ shop sửa được).
 */
export function ngayTrongThang(nam: number, thang: number, ngay: number): KhoaNgay {
  if (!Number.isInteger(nam) || !Number.isInteger(thang) || !Number.isInteger(ngay) || thang < 1 || thang > 12 || ngay < 1) {
    throw new Error(`Ngày không hợp lệ: ${nam}-${thang}-${ngay}`);
  }
  const cuoiThang = new Date(Date.UTC(nam, thang, 0)).getUTCDate();
  return `${nam}-${pad2(thang)}-${pad2(Math.min(ngay, cuoiThang))}`;
}
