import { formatVnd } from "@/lib/format";

/**
 * Chênh lệch quỹ app ↔ tiền thật TẠI MỐC BẬT nợ phải trả (spec §5.4 bước 2) — THUẦN, không DB.
 *
 * Cùng hợp đồng với đối chiếu số dư chốt (`doi-chieu-so-du-chot.ts`), chỉ khác thời điểm (cuối ngày M − 1):
 *   chenh = (bank + tiền mặt) − quỹ app(M − 1) + dư nợ thấu chi(M − 1)
 * Dương = tiền thật NHIỀU hơn sổ. Trước khi bật, sổ trừ ngay mọi thứ cà thẻ và mọi phiếu nhập đã duyệt,
 * nên tiền thật thường nhiều hơn sổ đúng bằng phần CHƯA trả. Phần giải thích được:
 *  - thẻ: dư nợ cuối M − 1 của từng thẻ (chủ shop gõ) — chi đã trừ sổ mà tiền chưa rời ngân hàng;
 *  - phiếu Y: phiếu nhập đã duyệt (Sổ chi phí) nhiều hơn số thật đã trả trước M (`daTraTruoc`) và chủ shop
 *    đã xác nhận lệch đó — sổ trừ thừa đúng phần chênh;
 *  - ví ads trả trước: số dư ví cuối M − 1 — tiền đã RỜI ngân hàng (nạp từ ngân hàng) hoặc đã nằm trong dư
 *    nợ thẻ (nạp bằng thẻ) mà sổ CHƯA trừ (sổ chỉ trừ lúc ads chạy) ⇒ giải thích ÂM.
 * Phần còn lại là CHƯA giải thích — app không đoán, chủ shop tự quyết (gợi ý chốt số dư tháng M − 1).
 */

export type MucGiaiThich = {
  /** Khoá ổn định của mục (thẻ / phiếu / ví) — để UI dựng danh sách điều chỉnh. */
  khoa: string;
  nhan: string;
  /** CÓ DẤU: dương = tiền thật nhiều hơn sổ vì mục này. */
  soTien: number;
};

export type DauVaoChenhLechTaiM = {
  quyApp: number;
  soDuBank: number;
  tienMat: number;
  duNoThauChi: number;
  the: readonly MucGiaiThich[];
  phieuY: readonly MucGiaiThich[];
  viAds: readonly MucGiaiThich[];
};

export type ChenhLechTaiM = {
  quyApp: number;
  soThat: number;
  duNoThauChi: number;
  chenh: number;
  giaiThichDuoc: { the: number; phieuY: number; viAds: number };
  tongGiaiThich: number;
  chuaGiaiThich: number;
  muc: MucGiaiThich[];
};

const tong = (ds: readonly MucGiaiThich[]) => ds.reduce((s, m) => s + m.soTien, 0);

export function tinhChenhLechTaiM(d: DauVaoChenhLechTaiM): ChenhLechTaiM {
  const soThat = d.soDuBank + d.tienMat;
  const chenh = soThat - d.quyApp + d.duNoThauChi;
  const giaiThichDuoc = { the: tong(d.the), phieuY: tong(d.phieuY), viAds: tong(d.viAds) };
  const tongGiaiThich = giaiThichDuoc.the + giaiThichDuoc.phieuY + giaiThichDuoc.viAds;
  return {
    quyApp: d.quyApp,
    soThat,
    duNoThauChi: d.duNoThauChi,
    chenh,
    giaiThichDuoc,
    tongGiaiThich,
    chuaGiaiThich: chenh - tongGiaiThich,
    muc: [...d.the, ...d.phieuY, ...d.viAds].filter((m) => m.soTien !== 0),
  };
}

/** Một dòng điều chỉnh quỹ ngày M (`CUTOVER_ADJ_IN` / `CUTOVER_ADJ_OUT`). */
export type DongDieuChinh = { chieu: "IN" | "OUT"; soTien: number; moTa: string };

export type LuaChonDieuChinh = "toan-bo" | "giai-thich-duoc";

/** Mục CÓ DẤU ⇒ dòng điều chỉnh (dương = VÀO quỹ, âm = RA); 0 ⇒ bỏ. */
function sangDong(soTien: number, moTa: string): DongDieuChinh | null {
  if (soTien === 0) return null;
  return { chieu: soTien > 0 ? "IN" : "OUT", soTien: Math.abs(soTien), moTa };
}

/**
 * Danh sách điều chỉnh gợi ý theo lựa chọn: "giải thích được" = mỗi mục một dòng (mô tả điền sẵn);
 * "toàn bộ" = thêm một dòng cho phần chưa giải thích để quỹ khớp đúng tiền thật. Lựa chọn "tự gõ" của
 * màn hình bắt đầu từ một trong hai danh sách này rồi sửa tay.
 */
export function goiYDieuChinh(kq: ChenhLechTaiM, luaChon: LuaChonDieuChinh, nhanM: string): DongDieuChinh[] {
  const dong = kq.muc.map((m) => sangDong(m.soTien, `Mở sổ nợ phải trả ${nhanM}: ${m.nhan}`));
  if (luaChon === "toan-bo") {
    dong.push(
      sangDong(
        kq.chuaGiaiThich,
        `Mở sổ nợ phải trả ${nhanM}: chênh lệch chưa giải thích với số dư thật (${formatVnd(kq.soThat)})`
      )
    );
  }
  return dong.filter((x): x is DongDieuChinh => x !== null);
}

/** Tác động CÓ DẤU của danh sách điều chỉnh lên quỹ (để màn xác nhận nói "quỹ sau bật"). */
export function tacDongDieuChinh(ds: readonly DongDieuChinh[]): number {
  return ds.reduce((s, d) => s + (d.chieu === "IN" ? d.soTien : -d.soTien), 0);
}
