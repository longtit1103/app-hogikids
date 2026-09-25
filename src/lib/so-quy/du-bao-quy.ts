import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import type { DongSoQuy } from "@/lib/so-quy/dong-chay-so-quy-types";
import type {
  DiemSoDu,
  KhoaNgay,
  KhoanDuKien,
  LoaiKhoanDuKien,
} from "@/lib/so-quy/du-bao-quy-types";
import type { KyDuKien } from "@/lib/so-quy/lich-tra-no";

/**
 * Lõi THUẦN (không DB, không đọc đồng hồ — nhận `homNay`) của biểu đồ quỹ + dự báo "quỹ sắp cạn".
 * Phần đọc DB ở `du-bao-quy-queries.ts`, hợp đồng kiểu ở `du-bao-quy-types.ts`.
 *
 * MỌI phép tính ngày ở đây làm trên KHOÁ `yyyy-MM-dd` giờ VN (không trên `Date` + TZ máy chạy): khoá
 * ngày của một mốc DB suy DUY NHẤT qua `khoaNgayVn` — cùng hàm dòng chạy dùng — còn cộng/trừ ngày
 * làm trên lịch dương thuần (neo 00:00 UTC chỉ để mượn bộ đếm ngày của `Date`, không mang nghĩa giờ).
 * Lấy nhầm phần ngày UTC của một mốc là khoản 00:30 sáng mai (giờ VN) bị kéo về HÔM NAY: nó lọt khỏi
 * cửa sổ dự báo, còn quỹ hôm nay thì không có nó ⇒ biến mất khỏi cả hai phía.
 */

export const SO_NGAY_LICH_SU = 90;
export const SO_NGAY_DU_BAO = 30;
/** Trần quỹ tối thiểu — cùng trần 2 tỷ của mọi ô tiền (Prisma `Int` = int32). */
export const TRAN_QUY_TOI_THIEU = 2_000_000_000;

const KHOA_NGAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_NGAY = 24 * 3600 * 1000;

function mocUtc(k: KhoaNgay): number {
  if (!KHOA_NGAY_RE.test(k)) throw new Error(`Khoá ngày không hợp lệ: "${k}"`);
  const t = Date.parse(`${k}T00:00:00Z`);
  // `Date.parse` chấp nhận "2026-02-31" rồi lặng lẽ trôi sang tháng 3 — so ngược lại để bắt.
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== k) {
    throw new Error(`Khoá ngày không tồn tại: "${k}"`);
  }
  return t;
}

/** Cộng `n` ngày lịch vào khoá ngày (n âm = lùi). */
export function congNgay(k: KhoaNgay, n: number): KhoaNgay {
  return new Date(mocUtc(k) + n * MS_NGAY).toISOString().slice(0, 10);
}

/** Số ngày trong tháng (`thang` 1–12). */
function soNgayTrongThang(nam: number, thang: number): number {
  return new Date(Date.UTC(nam, thang, 0)).getUTCDate();
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `dd/MM/yyyy` từ khoá ngày — cho diễn giải khoản, không phụ thuộc locale máy chạy. */
function nhanNgay(k: KhoaNgay): string {
  return `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)}`;
}

/** Một biến động CÓ DẤU đã quy về khoá ngày. */
type BienDong = { ngay: KhoaNgay; soTien: number };

/**
 * Chuỗi số dư CUỐI NGÀY, mỗi ngày trong [tu, den] đúng MỘT điểm — ngày không phát sinh mang số dư
 * ngày trước (biểu đồ liền mạch, không đứt quãng, không nhảy ngày). Biến động ngoài [tu, den] là lỗi
 * ghép dữ liệu của caller ⇒ ném, KHÔNG lặng lẽ bỏ (bỏ là số dư cuối chuỗi lệch thẻ mà không ai biết).
 */
function chuoiSoDu(
  dauKy: number,
  bienDong: readonly BienDong[],
  tu: KhoaNgay,
  den: KhoaNgay,
  duBao: boolean
): DiemSoDu[] {
  const batDau = mocUtc(tu);
  const soNgay = Math.round((mocUtc(den) - batDau) / MS_NGAY) + 1;
  if (soNgay <= 0) {
    if (bienDong.length > 0) throw new Error(`Cửa sổ rỗng ${tu}..${den} mà vẫn có biến động`);
    return [];
  }
  const theoNgay = new Map<KhoaNgay, number>();
  for (const b of bienDong) {
    if (b.ngay < tu || b.ngay > den) {
      throw new Error(`Biến động ngày ${b.ngay} nằm ngoài cửa sổ ${tu}..${den}`);
    }
    theoNgay.set(b.ngay, (theoNgay.get(b.ngay) ?? 0) + b.soTien);
  }
  const ra: DiemSoDu[] = [];
  let soDu = dauKy;
  for (let i = 0; i < soNgay; i++) {
    const ngay = new Date(batDau + i * MS_NGAY).toISOString().slice(0, 10);
    soDu += theoNgay.get(ngay) ?? 0;
    ra.push({ ngay, soDu, duBao });
  }
  return ra;
}

/**
 * Số dư CUỐI NGÀY của dòng chạy Sổ quỹ trong [tu, den] (khoá ngày VN). `dauKy` = số đầu kỳ CỦA THẺ
 * (`docSoQuyDongChay().dauKy`), không tự tính — điểm cuối chuỗi vì thế bằng đúng `dauKy + Σthu − Σchi`
 * của chính dòng chạy, tức con số thẻ "Quỹ còn lại" đang hiện.
 */
export function soDuCuoiNgay(
  dauKy: number,
  dong: readonly Pick<DongSoQuy, "ngay" | "thu" | "chi">[],
  tu: KhoaNgay,
  den: KhoaNgay,
  duBao = false
): DiemSoDu[] {
  return chuoiSoDu(
    dauKy,
    dong.map((d) => ({ ngay: khoaNgayVn(d.ngay), soTien: d.thu - d.chi })),
    tu,
    den,
    duBao
  );
}

/**
 * Khoản ĐÃ GHI ngày sau hôm nay — lấy nguyên các dòng chạy của cửa sổ tương lai (vd kỳ trả nợ duyệt
 * trước hạn, khoản chi ghi hẹn ngày). Đóng góp có dấu = `thu − chi` của chính dòng (dấu đã do công thức
 * thẻ quyết), KHÔNG tự suy lại theo nguồn.
 */
export function khoanDaGhi(dong: readonly DongSoQuy[]): KhoanDuKien[] {
  return dong
    .map((d): KhoanDuKien => ({
      ngay: khoaNgayVn(d.ngay),
      soTien: d.thu - d.chi,
      moTa: d.dienGiai,
      loai: "DA_GHI",
    }))
    .filter((k) => k.soTien !== 0);
}

/**
 * Kỳ trả nợ DỰ KIẾN chưa ghi của một khoản vay (đầu ra `duKienNKy`) ⇒ khoản dự báo trong (…, den].
 *
 * Tiền = `−tongChuyen` — đúng số thật chuyển ngân hàng (đã cấn sổ tiết kiệm bắt buộc ở kỳ cuối),
 * KHÔNG tự cộng lãi + gốc + tiền gửi. Kỳ QUÁ HẠN (đã tới hạn mà chưa đóng dấu) tính vào HÔM NAY:
 * tiền đó chắc chắn phải ra, chỉ là chưa ghi — đẩy nó về ngày đến hạn cũ là nó rơi vào quá khứ và
 * biến mất khỏi dự báo.
 *
 * Kỳ đã đóng dấu (kể cả duyệt TRƯỚC hạn) không bao giờ có ở đây — `duKienNKy` bỏ qua theo con dấu —
 * mà nằm trong phần `DA_GHI`. Đó là lý do hai phần cộng chung không đếm đôi.
 */
export function khoanKyTraNo(
  tenKhoan: string,
  ky: readonly KyDuKien[],
  homNay: KhoaNgay,
  den: KhoaNgay
): KhoanDuKien[] {
  const ra: KhoanDuKien[] = [];
  for (const k of ky) {
    const ngayHan = khoaNgayVn(k.denNgay);
    // `quaHan` do `duKienNKy` tính theo cùng "hôm nay"; so thêm khoá ngày để một kỳ đến hạn đúng hôm
    // nay (hoặc lỡ lệch vài giây giữa hai lần đọc đồng hồ) không bao giờ rơi về quá khứ.
    const quaHan = k.quaHan || ngayHan <= homNay;
    const ngay = quaHan ? homNay : ngayHan;
    if (ngay > den) continue;
    if (k.tongChuyen === 0) continue; // không đổi số dư ⇒ không phải "khoản làm đổi số dư"
    const duoi = quaHan ? " (đã tới hạn, chưa ghi)" : "";
    ra.push({
      ngay,
      soTien: -k.tongChuyen,
      // `tongChuyen` ÂM chỉ có ở kỳ cuối khoản có tiền gửi bắt buộc: tiền gửi cấn vượt phần phải nộp
      // (vd sau khi trả gốc sớm) ⇒ ngân hàng TRẢ về, quỹ TĂNG. Nhãn "Trả nợ" cho một khoản dương là nói
      // ngược chiều tiền với chủ shop.
      moTa:
        k.tongChuyen < 0
          ? `${tenKhoan} — kỳ ${nhanNgay(ngayHan)} — ngân hàng hoàn tiền gửi${duoi}`
          : `Trả nợ ${tenKhoan} — kỳ ${nhanNgay(ngayHan)}${duoi}`,
      loai: "KY_TRA_NO",
    });
  }
  return ra;
}

/**
 * Mẫu chi phí định kỳ (bảng `RecurringExpense`, chỉ các cột cần cho dự báo). `activeFrom` = khoá ngày VN
 * của mốc bắt đầu sinh (NULL = không cận dưới) — BẮT BUỘC khai để nơi đọc không lỡ quên cột.
 */
export type MauDinhKy = {
  id: string;
  amount: number;
  dayOfMonth: number;
  description: string;
  activeFrom: KhoaNgay | null;
};

/** Khoá "mẫu đã sinh dòng trong tháng" — `recurringId|yyyy-MM` (tháng theo giờ VN). */
export function khoaDaSinh(recurringId: string, ngay: KhoaNgay): string {
  return `${recurringId}|${ngay.slice(0, 7)}`;
}

/**
 * Các lần phát sinh của chi phí định kỳ ĐANG BẬT từ tháng hiện tại tới hết cửa sổ, ngày ≤ `den`.
 *
 * Lần phát sinh của THÁNG HIỆN TẠI đã tới hạn (ngày ≤ hôm nay) mà CHƯA sinh dòng ⇒ tính vào HÔM NAY
 * (cùng cách kỳ trả nợ quá hạn): bộ sinh `ensureRecurringExpenses` chỉ chạy ở vài trang và chỉ cho
 * tháng đang xem, nên banner ở trang khác hoàn toàn có thể đọc lúc dòng chưa sinh — khi đó quỹ hôm nay
 * chưa trừ khoản này; bỏ nó khỏi dự báo là nó biến mất khỏi CẢ HAI phía và dự báo "thận trọng" báo dư
 * đúng số tiền đó. Tháng TRƯỚC tháng hiện tại không xét: dự báo không phải chỗ đòi bù chi phí quá khứ.
 *
 * Ngày phát sinh theo ĐÚNG luật của `ensureRecurringExpenses`: `dayOfMonth` 29–31 gặp tháng thiếu ngày
 * thì kẹp về ngày cuối tháng (31 ⇒ 28/02 hay 29/02 năm nhuận), không tràn sang tháng sau.
 *
 * `daSinh` (khoá `khoaDaSinh`) = mẫu đã có dòng `Expense` trong tháng đó — cổng chống trùng của chính
 * bộ sinh là "mỗi mẫu tối đa 1 dòng/tháng", nên tháng đã có dòng thì bộ sinh sẽ KHÔNG đẻ thêm; dòng
 * đó đã nằm trong quỹ hôm nay (ngày ≤ hôm nay) hoặc phần `DA_GHI` (ngày sau). Bỏ cổng này là đếm đôi.
 */
export function khoanDinhKy(
  mau: readonly MauDinhKy[],
  homNay: KhoaNgay,
  den: KhoaNgay,
  daSinh: ReadonlySet<string>
): KhoanDuKien[] {
  const ra: KhoanDuKien[] = [];
  let nam = Number(homNay.slice(0, 4));
  let thang = Number(homNay.slice(5, 7));
  const thangCuoi = den.slice(0, 7);
  for (;;) {
    const tienTo = `${nam}-${pad2(thang)}`;
    if (tienTo > thangCuoi) break;
    const soNgay = soNgayTrongThang(nam, thang);
    for (const m of mau) {
      if (m.amount === 0) continue;
      // Cổng mốc — CÙNG luật `mauDinhKySinhChoThang` của bộ sinh (so theo THÁNG), viết trên khoá chuỗi
      // vì lõi này không dùng `Date`. Tháng trước mốc bộ sinh không sinh ⇒ dự báo không được trừ.
      if (m.activeFrom !== null && tienTo < m.activeFrom.slice(0, 7)) continue;
      const ngayPhatSinh = `${tienTo}-${pad2(Math.min(m.dayOfMonth, soNgay))}`;
      if (ngayPhatSinh > den) continue;
      if (daSinh.has(khoaDaSinh(m.id, ngayPhatSinh))) continue;
      // Vòng lặp bắt đầu từ tháng hiện tại ⇒ `ngayPhatSinh ≤ homNay` chỉ có thể là tháng hiện tại.
      const denHan = ngayPhatSinh <= homNay;
      const moTa = m.description.trim();
      const nhan = moTa === "" ? "Chi phí định kỳ" : `Chi phí định kỳ — ${moTa}`;
      ra.push({
        ngay: denHan ? homNay : ngayPhatSinh,
        soTien: -m.amount,
        moTa: denHan ? `${nhan} — ngày ${nhanNgay(ngayPhatSinh)} (đến hạn, chưa ghi sổ)` : nhan,
        loai: "DINH_KY",
      });
    }
    thang += 1;
    if (thang > 12) {
      thang = 1;
      nam += 1;
    }
  }
  return ra;
}

/** Thứ tự loại khi cùng ngày — cố định để danh sách tất định giữa các lần tải. */
const THU_TU_LOAI: Record<LoaiKhoanDuKien, number> = { DA_GHI: 0, KY_TRA_NO: 1, DINH_KY: 2 };

export type KetQuaDuBao = {
  duBao: DiemSoDu[];
  khoanDuKien: KhoanDuKien[];
  cham: null | { ngay: KhoaNgay; soDu: number; khoan: KhoanDuKien[] };
  thapNhat: { ngay: KhoaNgay; soDu: number };
};

/**
 * Ghép dự báo 30 ngày SAU hôm nay từ quỹ hôm nay + các khoản dự kiến.
 *
 * Khoản mang ngày HÔM NAY (kỳ trả nợ quá hạn, chi phí định kỳ đến hạn chưa sinh dòng) dồn vào điểm ĐẦU
 * TIÊN của dự báo: quỹ hôm nay là số THẬT đã xảy ra, không được đổi; khoản đó sẽ ra ngay khi ghi sổ. Vì thế khi ngày chạm ngưỡng là
 * điểm đầu tiên, `cham.khoan` kèm cả các khoản quá hạn — chính chúng kéo quỹ xuống.
 *
 * `cham` = ngày dự báo ĐẦU TIÊN số dư < ngưỡng (nhỏ hơn hẳn: bằng ngưỡng chưa phải cạn).
 */
export function ghepDuBao(args: {
  homNay: KhoaNgay;
  quyHomNay: number;
  nguong: number;
  khoan: readonly KhoanDuKien[];
}): KetQuaDuBao {
  const { homNay, quyHomNay, nguong } = args;
  const ngayMai = congNgay(homNay, 1);
  const den = congNgay(homNay, SO_NGAY_DU_BAO);

  for (const k of args.khoan) {
    if (k.ngay < homNay || k.ngay > den) {
      throw new Error(`Khoản dự kiến "${k.moTa}" ngày ${k.ngay} nằm ngoài ${homNay}..${den}`);
    }
  }
  const khoanDuKien = args.khoan
    .map((k, i) => ({ k, i }))
    .sort(
      (a, b) =>
        (a.k.ngay < b.k.ngay ? -1 : a.k.ngay > b.k.ngay ? 1 : 0) ||
        THU_TU_LOAI[a.k.loai] - THU_TU_LOAI[b.k.loai] ||
        a.i - b.i
    )
    .map(({ k }) => k);

  const quaHan = khoanDuKien.filter((k) => k.ngay === homNay);
  const batDau = quaHan.reduce((s, k) => s + k.soTien, quyHomNay);
  const duBao = chuoiSoDu(
    batDau,
    khoanDuKien.filter((k) => k.ngay > homNay),
    ngayMai,
    den,
    true
  );

  const diemCham = duBao.find((d) => d.soDu < nguong);
  const cham =
    diemCham === undefined
      ? null
      : {
          ngay: diemCham.ngay,
          soDu: diemCham.soDu,
          khoan: khoanDuKien.filter(
            (k) => k.ngay === diemCham.ngay || (diemCham.ngay === ngayMai && k.ngay === homNay)
          ),
        };

  // `duBao` luôn đủ 30 điểm (SO_NGAY_DU_BAO ≥ 1) nên phần tử đầu tồn tại.
  let thap = duBao[0];
  for (const d of duBao) if (d.soDu < thap.soDu) thap = d;

  return { duBao, khoanDuKien, cham, thapNhat: { ngay: thap.ngay, soDu: thap.soDu } };
}

/**
 * Đọc giá trị ô `Setting` quỹ tối thiểu. Chỉ nhận chuỗi chữ số thuần trong [0, trần]; thiếu hoặc hỏng
 * (sửa tay bằng SQL/Studio) ⇒ coi như CHƯA ĐẶT (0) — ngưỡng hỏng không được làm sập banner toàn app,
 * và `nguongDaDat=false` để màn hình mời đặt lại thay vì hiện một số bịa.
 */
export function docNguongTuGiaTri(value: string | null | undefined): {
  nguong: number;
  nguongDaDat: boolean;
} {
  if (value == null || !/^\d{1,10}$/.test(value.trim())) return { nguong: 0, nguongDaDat: false };
  const n = Number(value.trim());
  if (n > TRAN_QUY_TOI_THIEU) return { nguong: 0, nguongDaDat: false };
  return { nguong: n, nguongDaDat: true };
}
