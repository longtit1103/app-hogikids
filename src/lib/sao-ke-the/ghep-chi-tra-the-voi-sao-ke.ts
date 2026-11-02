/**
 * Ghép giao dịch thẻ phía app NGOÀI hoá đơn TikTok — chi ghi tay "trừ vào thẻ" (`Expense.cardId`), nạp ví ads bằng thẻ
 * (`ADS_TOPUP`), trả thẻ (`CARD_PAY`) — với dòng sao kê. THUẦN, không DB. Gọi từ `doiChieuSaoKeThe`.
 *
 * Vì sao cần: neo `KySaoKeThe.soDu` = dư nợ ngân hàng cuối ngày chốt D theo NGÀY GIAO DỊCH, còn lõi `ky-sao-ke.ts` chỉ
 * đếm giao dịch app ngày > D. Sao kê lại lấy giao dịch theo NGÀY GHI SỔ ≤ D ⇒
 *  - giao dịch app ngày ≤ D mà ngân hàng ghi sổ sau D (chưa lên sao kê) phải BÙ vào neo: chi ⇒ cộng, trả ⇒ trừ;
 *  - giao dịch app ghi ngày > D mà sao kê ĐÃ có (ngày GD ≤ D) ⇒ lõi sẽ đếm lần hai ⇒ KHÔNG cho chốt, bảo sửa ngày.
 *
 * Luật ghép (multiset, tất định):
 *  - chi: dòng ghi nợ không TikTok, không thanh toán ↔ chi app CÙNG ngày GD, CÙNG số tiền; còn dư thì thử chi app ngày
 *    ∈ (D, D+3] cùng số tiền lệch ≤ 3 ngày ⇒ "sai ngày".
 *  - trả (`ghepTra`): lượt 1 ghép ĐÚNG ngày GD + đúng tiền. Phần dư mới ghép có dung sai ±3 ngày, và CHỈ khi cặp là
 *    duy nhất: dòng sao kê có đúng MỘT `CARD_PAY` ứng viên và `CARD_PAY` đó chỉ ứng với dòng ấy. Ứng viên của một dòng
 *    là các `CARD_PAY` ngày ≤ D trong ±3; KHÔNG có cái nào mới tới `CARD_PAY` ngày > D (trả ngày > D không được "lấp"
 *    dòng ≤ D khi còn lần trả trong kỳ) — ghép trúng ngày > D ⇒ "sai ngày". Cụm ứng viên đan nhau (≥ 3 nút: nhiều lần
 *    trả cùng số tiền cách nhau vài ngày) ⇒ MƠ HỒ ⇒ CHẶN chốt: mỗi cách ghép cho một P (trả chưa lên sao kê) và một
 *    câu nhắc "chưa ghi" khác nhau, chọn im lặng một cách là đòi trả sai đúng một lần trả (đo 28/10). Sửa ngày Trả
 *    thẻ về đúng ngày GD ngân hàng thì lượt 1 ghép thẳng — rẻ hơn ghép đoán.
 *  - chỉ xét dòng sao kê ngày GD ≥ M (trước M app không có giao dịch thẻ nào; tiền đó nằm trong neo mở sổ).
 *  - giao dịch app ≤ neo trước chỉ bỏ khi CŨNG ≤ mốc trễ (D − 5): neo mới THAY hẳn neo cũ, nên giao dịch trong cửa sổ
 *    ghi sổ trễ phải xét lại dù nằm trước neo trước.
 *  - giao dịch app ngày ≤ D không ghép được: trong cửa sổ trễ (mocTre, D] ⇒ chưa lên sao kê (bù vào neo); sớm hơn ⇒ chỉ
 *    báo "không thấy trên sao kê" (ngân hàng ghi sổ trễ tối đa vài ngày — lâu hơn là app ghi sai số/ngày/thẻ, bù vào
 *    neo là sai thêm).
 *  - dòng thanh toán ngày GD > neo trước không ghép được ⇒ nhắc ghi "Trả thẻ" (không chặn: neo đã tính theo sao kê).
 */

import type { DongSaoKe } from "./techcombank-sao-ke-parser";

/** Chi app trừ vào thẻ (không gồm hoá đơn TikTok — đi luật riêng). `ngay` = `yyyy-MM-dd` giờ VN. */
export type GiaoDichAppGhiNo = { id: string; ngay: string; soTien: number; loai: "CHI_TAY" | "NAP_VI" };
/** `CARD_PAY` của thẻ. */
export type GiaoDichAppGhiCo = { id: string; ngay: string; soTien: number };
export type GiaoDichAppThe = { ghiNo: GiaoDichAppGhiNo[]; ghiCo: GiaoDichAppGhiCo[] };

export type CapSaiNgay<G> = { giaoDich: G; dong: DongSaoKe };

export type KetQuaGhepChiTra = {
  /** Chi app ngày ∈ (mocTre, D] chưa lên sao kê ⇒ CỘNG vào số đề xuất. */
  chiTayChuaLenSaoKe: GiaoDichAppGhiNo[];
  /** Chi app ngày ≤ mocTre không thấy trên sao kê ⇒ chỉ báo. */
  chiTayKhongThayTrenSaoKe: GiaoDichAppGhiNo[];
  /** Chi app ghi ngày > D nhưng sao kê đã có ⇒ chặn chốt. */
  chiSaiNgay: CapSaiNgay<GiaoDichAppGhiNo>[];
  /** Dòng ghi nợ không TikTok đã có chi app tương ứng. */
  dongChiDaCoTrongApp: DongSaoKe[];
  /** `CARD_PAY` ngày ∈ (mocTre, D] chưa lên sao kê ⇒ TRỪ khỏi số đề xuất. */
  traChuaLenSaoKe: GiaoDichAppGhiCo[];
  /** `CARD_PAY` ngày ≤ mocTre không thấy trên sao kê ⇒ chỉ báo. */
  traKhongThayTrenSaoKe: GiaoDichAppGhiCo[];
  /** `CARD_PAY` ghi ngày > D nhưng sao kê đã có ⇒ chặn chốt. */
  traSaiNgay: CapSaiNgay<GiaoDichAppGhiCo>[];
  /** Dòng thanh toán ngày GD ≥ M, > neo trước, app chưa có `CARD_PAY` ⇒ nhắc ghi. */
  thanhToanChuaGhi: DongSaoKe[];
  /**
   * Cụm trả thẻ ghép MƠ HỒ (dòng sao kê ↔ `CARD_PAY` cùng tiền đan nhau trong ±3 ngày) ⇒ CHẶN chốt. Các phần tử của cụm
   * KHÔNG vào `traChuaLenSaoKe` / `thanhToanChuaGhi` / `traSaiNgay` (chưa biết cách hiểu nào đúng).
   */
  traMoHo: TraMoHo[];
};

export type TraMoHo = { dong: DongSaoKe[]; giaoDich: GiaoDichAppGhiCo[] };

/** Lệch ngày tối đa giữa giao dịch app và ngày GD trên sao kê khi ghép trả thẻ / soi sai ngày. */
export const LECH_NGAY_GHEP_THE = 3;

const MOT_NGAY_MS = 24 * 3600 * 1000;

function lechNgay(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MOT_NGAY_MS);
}

type CoNgayTien = { id: string; ngay: string; soTien: number };

const theoNgay = (a: CoNgayTien, b: CoNgayTien) => a.ngay.localeCompare(b.ngay) || a.id.localeCompare(b.id);

/**
 * Ghép một-một dòng sao kê ↔ giao dịch app cùng số tiền, ngày lệch ≤ `lech`. Xếp mọi cặp ứng viên theo (lệch ít trước,
 * ngày dòng, ngày app, id) rồi nhận tham lam — kết quả không phụ thuộc thứ tự đầu vào. Dùng cho lượt ĐÚNG ngày
 * (`lech = 0`, mọi cách ghép như nhau) và lượt soi chi app ghi sau ngày sao kê (cặp nào cũng CHẶN chốt). Trả thẻ có
 * dung sai KHÔNG đi đường tham lam này — xem `ghepTra`.
 */
function ghep<G extends CoNgayTien>(
  dongs: readonly DongSaoKe[],
  tien: (d: DongSaoKe) => number,
  gds: readonly G[],
  lech: number
): { cap: Array<{ dong: DongSaoKe; gd: G }>; dongCon: DongSaoKe[]; gdCon: G[] } {
  const ungVien: Array<{ i: number; j: number; l: number }> = [];
  dongs.forEach((d, i) => {
    gds.forEach((g, j) => {
      if (g.soTien !== tien(d)) return;
      const l = lechNgay(d.ngayGiaoDich, g.ngay);
      if (l <= lech) ungVien.push({ i, j, l });
    });
  });
  ungVien.sort(
    (a, b) =>
      a.l - b.l ||
      dongs[a.i].ngayGiaoDich.localeCompare(dongs[b.i].ngayGiaoDich) ||
      theoNgay(gds[a.j], gds[b.j]) ||
      a.i - b.i
  );
  const dongDung = new Set<number>();
  const gdDung = new Set<number>();
  const cap: Array<{ dong: DongSaoKe; gd: G }> = [];
  for (const u of ungVien) {
    if (dongDung.has(u.i) || gdDung.has(u.j)) continue;
    dongDung.add(u.i);
    gdDung.add(u.j);
    cap.push({ dong: dongs[u.i], gd: gds[u.j] });
  }
  return {
    cap,
    dongCon: dongs.filter((_, i) => !dongDung.has(i)),
    gdCon: gds.filter((_, j) => !gdDung.has(j)),
  };
}

/**
 * Ghép trả thẻ (xem luật ở đầu file). Trả về cặp đúng ngày + cặp dung sai DUY NHẤT, phần dư hai phía, và các cụm mơ hồ.
 * Cụm = thành phần liên thông của đồ thị "dòng ↔ `CARD_PAY` ứng viên" trên phần dư sau lượt đúng ngày.
 */
function ghepTra(
  dongs: readonly DongSaoKe[],
  gds: readonly GiaoDichAppGhiCo[],
  D: string
): { cap: Array<{ dong: DongSaoKe; gd: GiaoDichAppGhiCo }>; dongCon: DongSaoKe[]; gdCon: GiaoDichAppGhiCo[]; moHo: TraMoHo[] } {
  const dung = ghep(dongs, (d) => d.ghiCo, gds, 0);
  const L = [...dung.dongCon].sort((a, b) => a.ngayGiaoDich.localeCompare(b.ngayGiaoDich));
  const G = [...dung.gdCon].sort(theoNgay);

  const ungVien = L.map((d) => {
    const trong = (sauD: boolean) =>
      G.flatMap((g, j) =>
        g.soTien === d.ghiCo && (g.ngay > D) === sauD && lechNgay(d.ngayGiaoDich, g.ngay) <= LECH_NGAY_GHEP_THE ? [j] : []
      );
    const trongKy = trong(false);
    return trongKy.length > 0 ? trongKy : trong(true);
  });

  // Hợp-tìm trên L.length + G.length nút: dòng i ↔ nút i, CARD_PAY j ↔ nút L.length + j.
  const cha = Array.from({ length: L.length + G.length }, (_, i) => i);
  const goc = (x: number): number => (cha[x] === x ? x : (cha[x] = goc(cha[x])));
  ungVien.forEach((js, i) => js.forEach((j) => (cha[goc(i)] = goc(L.length + j))));
  const cum = new Map<number, { d: number[]; g: number[] }>();
  const vao = (x: number) => {
    let c = cum.get(goc(x));
    if (!c) cum.set(goc(x), (c = { d: [], g: [] }));
    return c;
  };
  L.forEach((_, i) => vao(i).d.push(i));
  G.forEach((_, j) => vao(L.length + j).g.push(j));

  const cap = [...dung.cap];
  const dongCon: DongSaoKe[] = [];
  const gdCon: GiaoDichAppGhiCo[] = [];
  const moHo: TraMoHo[] = [];
  for (const { d, g } of cum.values()) {
    if (d.length === 1 && g.length === 1) cap.push({ dong: L[d[0]], gd: G[g[0]] });
    else if (d.length + g.length === 1) {
      if (d.length === 1) dongCon.push(L[d[0]]);
      else gdCon.push(G[g[0]]);
    } else moHo.push({ dong: d.map((i) => L[i]), giaoDich: g.map((j) => G[j]) });
  }
  moHo.sort((a, b) => (a.dong[0]?.ngayGiaoDich ?? "").localeCompare(b.dong[0]?.ngayGiaoDich ?? ""));
  return { cap, dongCon, gdCon, moHo };
}

export function ghepChiTraVoiSaoKe(
  dong: readonly DongSaoKe[],
  gd: GiaoDichAppThe,
  o: { ngaySaoKe: string; mocTre: string; ngayChotTruoc: string | null; mocM: string | null }
): KetQuaGhepChiTra {
  const D = o.ngaySaoKe;
  const sauM = (d: DongSaoKe) => o.mocM === null || d.ngayGiaoDich >= o.mocM;
  const xet = <G extends CoNgayTien>(g: G) =>
    !(o.ngayChotTruoc !== null && g.ngay <= o.ngayChotTruoc && g.ngay <= o.mocTre);

  // Chi: khớp đúng ngày trước, phần dư soi "sai ngày" với chi app ghi sau ngày sao kê.
  const dongChi = dong.filter((d) => !d.laTiktok && !d.laThanhToan && d.ghiNo > 0 && sauM(d));
  const chi1 = ghep(dongChi, (d) => d.ghiNo, gd.ghiNo.filter(xet), 0);
  const chi2 = ghep(chi1.dongCon, (d) => d.ghiNo, chi1.gdCon.filter((g) => g.ngay > D), LECH_NGAY_GHEP_THE);
  const chiConTrongKy = chi1.gdCon.filter((g) => g.ngay <= D).sort(theoNgay);

  // Trả: đúng ngày trước; dung sai chỉ cho cặp duy nhất; cụm đan nhau ⇒ mơ hồ (chặn).
  const dongTra = dong.filter((d) => d.laThanhToan && sauM(d));
  const tra = ghepTra(dongTra, gd.ghiCo.filter(xet), D);
  const traConTrongKy = tra.gdCon.filter((g) => g.ngay <= D).sort(theoNgay);

  return {
    chiTayChuaLenSaoKe: chiConTrongKy.filter((g) => g.ngay > o.mocTre),
    chiTayKhongThayTrenSaoKe: chiConTrongKy.filter((g) => g.ngay <= o.mocTre),
    chiSaiNgay: chi2.cap.map((c) => ({ giaoDich: c.gd, dong: c.dong })),
    dongChiDaCoTrongApp: chi1.cap.map((c) => c.dong),
    traChuaLenSaoKe: traConTrongKy.filter((g) => g.ngay > o.mocTre),
    traKhongThayTrenSaoKe: traConTrongKy.filter((g) => g.ngay <= o.mocTre),
    traSaiNgay: tra.cap.filter((c) => c.gd.ngay > D).map((c) => ({ giaoDich: c.gd, dong: c.dong })),
    thanhToanChuaGhi: tra.dongCon
      .filter((d) => o.ngayChotTruoc === null || d.ngayGiaoDich > o.ngayChotTruoc)
      .sort((a, b) => a.ngayGiaoDich.localeCompare(b.ngayGiaoDich)),
    traMoHo: tra.moHo,
  };
}
