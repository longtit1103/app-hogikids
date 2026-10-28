/**
 * Đối chiếu sao kê thẻ (đã tách) với hoá đơn TikTok Ads phía app — THUẦN, không DB.
 *
 * Đo thật 26/10: hoá đơn TikTok trong app = dòng "9PAY*TikTok Ads" trên sao kê từng dòng từng đồng,
 * cùng NGÀY GIAO DỊCH. Ngân hàng ghi sổ trễ 1–3 ngày ⇒ bill mấy ngày cuối kỳ chưa lên sao kê, nhưng
 * Techcombank đếm "đã chi tiêu" theo ngày giao dịch ⇒ số chốt đúng = dư nợ sao kê + bill ghi sổ trễ.
 *
 * Ghép MULTISET theo (ngày giao dịch, số tiền), chỉ dòng `laTiktok`. Ghép với MỌI bill ≤ ngày sao kê
 * (kể cả bill ≤ `ngayChotTruoc` — dòng sao kê đầu kỳ vẫn phải tìm được bill của nó); bill > ngày sao kê
 * bỏ qua (kỳ sau). Bill không ghép được mà ≤ `ngayChotTruoc` VÀ ≤ mốc trễ (D − `soNgayGhiSoTre`) thì BỎ QUA
 * (thuộc kỳ trước, đã nằm trong neo); bill trong cửa sổ trễ thì vẫn xét dù ≤ neo trước — neo mới THAY hẳn neo
 * cũ, bỏ chúng là đề xuất thiếu đúng phần đó (bill đã ghép ở một kỳ PDF trước thì caller loại sẵn theo
 * `DongSaoKeThe.hoaDonId`). Bill còn lại chia hai: trong cửa sổ trễ ⇒ ghi sổ trễ (CỘNG vào số chốt); sớm hơn ⇒
 * cảnh báo "không thấy trên sao kê" (ngân hàng không charge?).
 *
 * Giao dịch thẻ khác của app (chi ghi tay, nạp ví bằng thẻ, trả thẻ) ghép ở `ghep-chi-tra-the-voi-sao-ke.ts`.
 *
 * HOÀN TIỀN TikTok về thẻ (hoá đơn `amountType = NEGATIVE`, `opts.hoan`): lõi dư nợ trừ nó như `VI_TRU`, nhưng chỉ khi
 * ngày hoàn > neo ⇒ hoàn ngày ≤ ngày sao kê mà ngân hàng CHƯA ghi sổ phải trừ ngay vào số đề xuất, không thì sau chốt nó
 * mất hẳn. Ghép MULTISET theo (ngày giao dịch, số tiền) với dòng GHI CÓ `laTiktok`; phần dư chia theo ĐÚNG luật cửa
 * sổ trễ của bill (thuộc kỳ trước ⇒ bỏ; trong cửa sổ trễ ⇒ TRỪ; sớm hơn ⇒ chỉ cảnh báo). Số dư in trên sao kê không đổi.
 *
 * Số đề xuất = dư nợ sao kê + bill ghi sổ trễ + chi thẻ chưa lên sao kê − trả thẻ chưa lên sao kê − hoàn TikTok chưa
 * lên sao kê.
 */

import { formatVnd } from "@/lib/format";

import {
  ghepChiTraVoiSaoKe,
  type GiaoDichAppThe,
  type KetQuaGhepChiTra,
} from "./ghep-chi-tra-the-voi-sao-ke";
import type { DongSaoKe, SaoKeThe } from "./techcombank-sao-ke-parser";

export type BillApp = { id: string; /** yyyy-MM-dd giờ VN */ ngay: string; soTien: number };

export type KetQuaDoiChieu = KetQuaGhepChiTra & {
  khop: Array<{ dong: DongSaoKe; billId: string }>;
  /** Dòng TikTok GHI NỢ trên sao kê không ghép được bill. */
  saoKeKhongCoTrongApp: DongSaoKe[];
  /** Dòng TikTok GHI CÓ (hoàn về thẻ) ↔ hoá đơn hoàn của app. */
  khopHoan: Array<{ dong: DongSaoKe; billId: string }>;
  /** Dòng TikTok ghi có trên sao kê không ghép được hoá đơn hoàn ⇒ chỉ báo. */
  saoKeHoanKhongCoTrongApp: DongSaoKe[];
  /** Hoá đơn hoàn ngày ∈ (ngaySaoKe − soNgayGhiSoTre, ngaySaoKe], chưa lên sao kê ⇒ TRỪ khỏi số chốt. */
  hoanGhiSoTre: BillApp[];
  /** Hoá đơn hoàn ∈ (ngayChotTruoc, ngaySaoKe − soNgayGhiSoTre] không có trên sao kê ⇒ cảnh báo. */
  hoanKhongThayTrenSaoKe: BillApp[];
  /** Bill app, ngày GD ∈ (ngaySaoKe − soNgayGhiSoTre, ngaySaoKe], chưa lên sao kê ⇒ CỘNG vào số chốt. */
  billGhiSoTre: BillApp[];
  /** Bill app ∈ (ngayChotTruoc, ngaySaoKe − soNgayGhiSoTre] không có trên sao kê ⇒ cảnh báo. */
  billKhongThayTrenSaoKe: BillApp[];
  /** Không TikTok, không phải thanh toán: phí, mua khác, hoàn phí. */
  dongKhac: { ghiNo: DongSaoKe[]; ghiCo: DongSaoKe[] };
  thanhToan: DongSaoKe[];
  tongBillGhiSoTre: number;
  tongChiTayChuaLenSaoKe: number;
  tongTraChuaLenSaoKe: number;
  tongHoanGhiSoTre: number;
  /** = duNoCuoiKy + tongBillGhiSoTre + tongChiTayChuaLenSaoKe − tongTraChuaLenSaoKe − tongHoanGhiSoTre. */
  soDeXuat: number;
  /** Câu tiếng Việt cho UI. */
  giaiThich: string[];
};

export const SO_NGAY_GHI_SO_TRE_MAC_DINH = 5;

/** yyyy-MM-dd − n ngày (lịch thuần, không múi giờ). */
function truNgay(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/** yyyy-MM-dd → dd/MM. */
function ngayNgan(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function tong(xs: Array<{ soTien: number }>): number {
  return xs.reduce((s, x) => s + x.soTien, 0);
}

/** Danh sách ngày gọn: "17/10 ×2 · 19/10 ×5". */
function lietKeNgay(bills: ReadonlyArray<{ ngay: string }>): string {
  const dem = new Map<string, number>();
  for (const b of [...bills].sort((a, c) => a.ngay.localeCompare(c.ngay))) {
    dem.set(b.ngay, (dem.get(b.ngay) ?? 0) + 1);
  }
  return [...dem].map(([ngay, n]) => (n > 1 ? `${ngayNgan(ngay)} ×${n}` : ngayNgan(ngay))).join(" · ");
}

/** Rút diễn giải ngân hàng về phần đọc được: bỏ "Giao dịch thanh toán/Purchase - Số Thẻ/Card No: …". */
export function tomTatDienGiai(dienGiai: string): string {
  const s = dienGiai
    .replace(/Giao dịch thanh toán\/Purchase\s*-\s*/gi, "")
    .replace(/(?:Số\s*)?Thẻ\/Card No:?\s*\d+\s*\.{2,}\s*\d+/gi, "")
    .replace(/\s*-\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function moTaDong(d: DongSaoKe): string {
  return `${tomTatDienGiai(d.dienGiai)} ${formatVnd(d.ghiNo || d.ghiCo)} (${ngayNgan(d.ngayGiaoDich)})`;
}

const theoNgayBill = (a: BillApp, b: BillApp) => a.ngay.localeCompare(b.ngay) || a.id.localeCompare(b.id);

/**
 * Ghép MULTISET dòng sao kê ↔ hoá đơn app theo (ngày giao dịch, số tiền `tien(dong)`), rồi chia hoá đơn còn dư theo
 * cửa sổ ghi sổ trễ. Hoá đơn > ngày sao kê bỏ (kỳ sau). Hoá đơn dư ≤ `ngayChotTruoc` VÀ ≤ `mocTre` bỏ (thuộc kỳ trước,
 * đã nằm trong neo); > `mocTre` ⇒ ghi sổ trễ; còn lại ⇒ không thấy trên sao kê. Dùng chung cho bill (dòng ghi nợ) và
 * hoá đơn hoàn (dòng ghi có) — một luật cửa sổ, hai chiều tiền.
 */
function ghepHoaDonVoiDong(
  dongs: readonly DongSaoKe[],
  tien: (d: DongSaoKe) => number,
  hoaDon: readonly BillApp[],
  o: { ngaySaoKe: string; ngayChotTruoc: string | null; mocTre: string },
): { khop: Array<{ dong: DongSaoKe; billId: string }>; dongKhongCo: DongSaoKe[]; ghiSoTre: BillApp[]; khongThay: BillApp[] } {
  // Kho theo khoá (ngày, số tiền), giữ thứ tự (ngày, id) để ghép tất định.
  const kho = new Map<string, BillApp[]>();
  for (const b of hoaDon.filter((x) => x.ngay <= o.ngaySaoKe).sort(theoNgayBill)) {
    const k = `${b.ngay}|${b.soTien}`;
    const ds = kho.get(k);
    if (ds) ds.push(b);
    else kho.set(k, [b]);
  }

  const khop: Array<{ dong: DongSaoKe; billId: string }> = [];
  const dongKhongCo: DongSaoKe[] = [];
  for (const dong of dongs) {
    const b = kho.get(`${dong.ngayGiaoDich}|${tien(dong)}`)?.shift();
    if (b) khop.push({ dong, billId: b.id });
    else dongKhongCo.push(dong);
  }

  const ghiSoTre: BillApp[] = [];
  const khongThay: BillApp[] = [];
  for (const ds of kho.values()) {
    for (const b of ds) {
      if (o.ngayChotTruoc !== null && b.ngay <= o.ngayChotTruoc && b.ngay <= o.mocTre) continue;
      if (b.ngay > o.mocTre) ghiSoTre.push(b);
      else khongThay.push(b);
    }
  }
  ghiSoTre.sort(theoNgayBill);
  khongThay.sort(theoNgayBill);
  return { khop, dongKhongCo, ghiSoTre, khongThay };
}

/**
 * `bills` = hoá đơn TikTok trừ thẻ (đã bỏ phần ví TikTok Shop trả). `opts.hoan` = hoá đơn TikTok hoàn về thẻ (thiếu ⇒
 * không có). `opts.giaoDichApp` = giao dịch thẻ khác của app (thiếu ⇒ coi như app không có). `opts.mocM` = khoá ngày
 * bật theo dõi nợ (dòng thanh toán trước M không xét).
 */
export function doiChieuSaoKeThe(
  saoKe: SaoKeThe,
  bills: BillApp[],
  opts: {
    ngayChotTruoc: string | null;
    soNgayGhiSoTre?: number;
    mocM?: string | null;
    giaoDichApp?: GiaoDichAppThe;
    hoan?: BillApp[];
  },
): KetQuaDoiChieu {
  const soNgay = opts.soNgayGhiSoTre ?? SO_NGAY_GHI_SO_TRE_MAC_DINH;
  const mocTre = truNgay(saoKe.ngaySaoKe, soNgay);
  const cuaSo = { ngaySaoKe: saoKe.ngaySaoKe, ngayChotTruoc: opts.ngayChotTruoc, mocTre };

  const dongTiktok = saoKe.dong.filter((d) => d.laTiktok && d.ghiNo > 0);
  const gBill = ghepHoaDonVoiDong(dongTiktok, (d) => d.ghiNo, bills, cuaSo);
  const { khop, ghiSoTre: billGhiSoTre, khongThay: billKhongThayTrenSaoKe } = gBill;
  const saoKeKhongCoTrongApp = gBill.dongKhongCo;

  const gHoan = ghepHoaDonVoiDong(
    saoKe.dong.filter((d) => d.laTiktok && d.ghiCo > 0),
    (d) => d.ghiCo,
    opts.hoan ?? [],
    cuaSo,
  );

  const dongKhac = {
    ghiNo: saoKe.dong.filter((d) => !d.laTiktok && !d.laThanhToan && d.ghiNo > 0),
    ghiCo: saoKe.dong.filter((d) => !d.laTiktok && !d.laThanhToan && d.ghiCo > 0),
  };
  const thanhToan = saoKe.dong.filter((d) => d.laThanhToan);

  const chiTra = ghepChiTraVoiSaoKe(saoKe.dong, opts.giaoDichApp ?? { ghiNo: [], ghiCo: [] }, {
    ngaySaoKe: saoKe.ngaySaoKe,
    mocTre,
    ngayChotTruoc: opts.ngayChotTruoc,
    mocM: opts.mocM ?? null,
  });

  const tongBillGhiSoTre = tong(billGhiSoTre);
  const tongChiTayChuaLenSaoKe = tong(chiTra.chiTayChuaLenSaoKe);
  const tongTraChuaLenSaoKe = tong(chiTra.traChuaLenSaoKe);
  const tongHoanGhiSoTre = tong(gHoan.ghiSoTre);
  const soDeXuat =
    saoKe.duNoCuoiKy + tongBillGhiSoTre + tongChiTayChuaLenSaoKe - tongTraChuaLenSaoKe - tongHoanGhiSoTre;

  const giaiThich: string[] = [];
  const phepTinh: string[] = [];
  if (billGhiSoTre.length > 0) {
    phepTinh.push(`+ ${billGhiSoTre.length} bill TikTok ngày ${lietKeNgay(billGhiSoTre)} ghi sổ sau ngày sao kê ${formatVnd(tongBillGhiSoTre)}`);
  }
  if (chiTra.chiTayChuaLenSaoKe.length > 0) {
    phepTinh.push(
      `+ ${chiTra.chiTayChuaLenSaoKe.length} khoản chi trừ vào thẻ ngày ${lietKeNgay(chiTra.chiTayChuaLenSaoKe)} chưa lên sao kê ${formatVnd(tongChiTayChuaLenSaoKe)}`,
    );
  }
  if (chiTra.traChuaLenSaoKe.length > 0) {
    phepTinh.push(
      `− ${chiTra.traChuaLenSaoKe.length} lần trả thẻ ngày ${lietKeNgay(chiTra.traChuaLenSaoKe)} chưa lên sao kê ${formatVnd(tongTraChuaLenSaoKe)}`,
    );
  }
  if (gHoan.ghiSoTre.length > 0) {
    phepTinh.push(
      `− ${gHoan.ghiSoTre.length} lần TikTok hoàn ngày ${lietKeNgay(gHoan.ghiSoTre)} chưa lên sao kê ${formatVnd(tongHoanGhiSoTre)}`,
    );
  }
  giaiThich.push(
    phepTinh.length > 0
      ? `Sao kê ${formatVnd(saoKe.duNoCuoiKy)} ${phepTinh.join(" ")} = ${formatVnd(soDeXuat)}`
      : `Không có bill TikTok ghi sổ trễ — số đề xuất = dư nợ sao kê ${formatVnd(soDeXuat)}`,
  );
  giaiThich.push(`${khop.length}/${dongTiktok.length} dòng TikTok trên sao kê khớp bill trong app (cùng ngày giao dịch, cùng số tiền)`);
  if (saoKeKhongCoTrongApp.length > 0) {
    const t = saoKeKhongCoTrongApp.reduce((s, d) => s + d.ghiNo, 0);
    giaiThich.push(
      `${saoKeKhongCoTrongApp.length} dòng TikTok trên sao kê (${formatVnd(t)}) KHÔNG có hoá đơn tương ứng trong app — kiểm lại đồng bộ hoá đơn TikTok`,
    );
  }
  if (billKhongThayTrenSaoKe.length > 0) {
    giaiThich.push(
      `${billKhongThayTrenSaoKe.length} bill ${lietKeNgay(billKhongThayTrenSaoKe)} (${formatVnd(tong(billKhongThayTrenSaoKe))}) không thấy trên sao kê — ngân hàng có thể không charge, kiểm Lịch sử giao dịch`,
    );
  }
  if (gHoan.dongKhongCo.length > 0) {
    const t = gHoan.dongKhongCo.reduce((s, d) => s + d.ghiCo, 0);
    giaiThich.push(
      `${gHoan.dongKhongCo.length} dòng TikTok hoàn trên sao kê (${formatVnd(t)}) KHÔNG có hoá đơn hoàn tương ứng trong app — kiểm lại đồng bộ hoá đơn TikTok (sao kê đã trừ vào dư nợ, không cần ghi)`,
    );
  }
  if (gHoan.khongThay.length > 0) {
    giaiThich.push(
      `${gHoan.khongThay.length} lần TikTok hoàn ${lietKeNgay(gHoan.khongThay)} (${formatVnd(tong(gHoan.khongThay))}) không thấy trên sao kê — kiểm Lịch sử giao dịch (không trừ khỏi số đề xuất)`,
    );
  }
  const lyDoSai = lyDoGiaoDichSaiNgay(chiTra);
  if (lyDoSai !== null) giaiThich.push(lyDoSai);
  if (chiTra.chiTayKhongThayTrenSaoKe.length > 0) {
    const ds = chiTra.chiTayKhongThayTrenSaoKe;
    giaiThich.push(
      `${ds.length} khoản chi trừ vào thẻ trong app ngày ${lietKeNgay(ds)} (${formatVnd(tong(ds))}) không thấy trên sao kê — kiểm lại số tiền, ngày, thẻ (không cộng vào số đề xuất)`,
    );
  }
  if (chiTra.traKhongThayTrenSaoKe.length > 0) {
    const ds = chiTra.traKhongThayTrenSaoKe;
    giaiThich.push(
      `${ds.length} lần trả thẻ trong app ngày ${lietKeNgay(ds)} (${formatVnd(tong(ds))}) không thấy trên sao kê — kiểm lại số tiền, ngày (không trừ khỏi số đề xuất)`,
    );
  }
  const daCo = new Set(chiTra.dongChiDaCoTrongApp);
  const chiChuaGhi = dongKhac.ghiNo.filter((d) => !daCo.has(d));
  if (chiChuaGhi.length > 0) {
    giaiThich.push(
      `${chiChuaGhi.length} khoản không phải TikTok: ${chiChuaGhi.map(moTaDong).join("; ")} — nếu là chi phí shop, ghi Sổ chi phí "trừ vào thẻ" ĐÚNG ngày giao dịch trên sao kê (≤ ngày sao kê); ghi ngày sau ngày sao kê sẽ đếm hai lần`,
    );
  }
  if (dongKhac.ghiCo.length > 0) {
    giaiThich.push(
      `${dongKhac.ghiCo.length} khoản ghi có khác: ${dongKhac.ghiCo.map(moTaDong).join("; ")} — sao kê đã trừ vào dư nợ, không cần ghi`,
    );
  }
  if (thanhToan.length > 0) {
    giaiThich.push(
      `${thanhToan.length} lần thanh toán thẻ trong kỳ, tổng ${formatVnd(thanhToan.reduce((s, d) => s + d.ghiCo, 0))}`,
    );
  }

  return {
    ...chiTra,
    khop,
    saoKeKhongCoTrongApp,
    khopHoan: gHoan.khop,
    saoKeHoanKhongCoTrongApp: gHoan.dongKhongCo,
    hoanGhiSoTre: gHoan.ghiSoTre,
    hoanKhongThayTrenSaoKe: gHoan.khongThay,
    billGhiSoTre,
    billKhongThayTrenSaoKe,
    dongKhac,
    thanhToan,
    tongBillGhiSoTre,
    tongChiTayChuaLenSaoKe,
    tongTraChuaLenSaoKe,
    tongHoanGhiSoTre,
    soDeXuat,
    giaiThich,
  };
}

/**
 * Lý do KHÔNG cho chốt vì giao dịch app ghi ngày SAU ngày sao kê trong khi ngân hàng đã ghi nó trước đó (sao kê có):
 * neo đã gồm nó, lõi `ky-sao-ke.ts` lại đếm giao dịch ngày > ngày chốt ⇒ trừ/cộng hai lần. null = không có.
 */
export function lyDoGiaoDichSaiNgay(k: Pick<KetQuaGhepChiTra, "traSaiNgay" | "chiSaiNgay">): string | null {
  const ds = [
    ...k.traSaiNgay.map(
      (c) => `Trả thẻ ${formatVnd(c.giaoDich.soTien)} ghi ngày ${ngayNgan(c.giaoDich.ngay)} — ngân hàng ghi ngày ${ngayNgan(c.dong.ngayGiaoDich)}`,
    ),
    ...k.chiSaiNgay.map(
      (c) => `Khoản chi thẻ ${formatVnd(c.giaoDich.soTien)} ghi ngày ${ngayNgan(c.giaoDich.ngay)} — ngân hàng ghi ngày ${ngayNgan(c.dong.ngayGiaoDich)}`,
    ),
  ];
  if (ds.length === 0) return null;
  const loai = k.traSaiNgay.length > 0 ? (k.chiSaiNgay.length > 0 ? "Trả thẻ / khoản chi" : "Trả thẻ") : "khoản chi";
  return `${ds.join("; ")}. Sửa ngày ${loai} về đúng ngày ngân hàng rồi nhập lại — để nguyên thì sau khi chốt app tính hai lần`;
}
