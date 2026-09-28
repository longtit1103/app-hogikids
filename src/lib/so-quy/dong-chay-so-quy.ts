import { adsSourceLabel } from "@/lib/ads-source-label";
import { TONG_RONG, tinhQuyTuTong, type TongNguon } from "@/lib/so-quy/cong-thuc-so-quy";
import type { DongSoQuy, NguonDongQuy } from "@/lib/so-quy/dong-chay-so-quy-types";

/**
 * Lõi THUẦN (không Prisma) của Sổ quỹ dạng dòng chạy: nhận các khoản tiền đã đọc sẵn ⇒ xếp cũ → mới,
 * suy thu/chi từng dòng, cộng dồn số dư từ đầu kỳ. Phần đọc DB ở `dong-chay-so-quy-queries.ts`.
 *
 * DẤU mỗi dòng KHÔNG tự viết ở đây: dựng một `TongNguon` rỗng chỉ mang đúng giá trị của dòng rồi hỏi
 * `tinhQuyTuTong` — cùng một định nghĩa dấu với thẻ "Quỹ còn lại". Tự viết lại luật dấu là hai nơi
 * định nghĩa, sớm muộn lệch nhau (vd rút ví Shopee lưu ÂM, ads TikTok trừ ví lưu ÂM: quên đảo một chỗ
 * là dòng chạy chạy ngược chiều thẻ mà thẻ vẫn đúng).
 */

/**
 * Một khoản tiền chưa xếp: mang giá trị THÔ đúng như cột DB (có dấu nếu cột có dấu) cùng tên trường
 * `TongNguon` mà `docTongNguon` cộng nó vào. Kiểu hợp buộc mỗi nguồn chỉ đi đúng trường của nó —
 * ghi tay là nguồn duy nhất có hai trường (chiều suy từ `kind`).
 */
export type SuKienQuy = {
  key: string;
  ngay: Date;
  dienGiai: string;
  /** Giá trị THÔ theo đúng nghĩa của `truong` (vd `shopeeRutViCoDau` rút = âm). */
  giaTri: number;
} & (
  | { nguon: "GHI_TAY"; truong: "ghiTayVao" | "ghiTayRa" }
  | { nguon: "TIKTOK_VE_BANK"; truong: "tiktokVeBank" }
  | { nguon: "SHOPEE_RUT_VI"; truong: "shopeeRutViCoDau" }
  | { nguon: "CHI_PHI" | "CHI_PHI_ADS_GOP"; truong: "chiPhi" }
  | { nguon: "ADS_TIKTOK_TRU_VI"; truong: "adsTiktokViCoDau" }
  | { nguon: "THU_NHAP"; truong: "thuNhap" }
  | { nguon: "BAN_TRUC_TIEP"; truong: "banTrucTiep" }
);

/**
 * Thứ tự nguồn khi hai dòng CÙNG thời điểm — cố định để bảng tất định giữa các lần tải (không thì
 * số dư chạy ở hai dòng cùng giờ đổi chỗ qua lại, trông như app tính sai). `Record` theo đủ các nguồn:
 * thêm nguồn mới mà quên xếp chỗ là lỗi biên dịch, không phải dòng lặng lẽ nhảy lên đầu ngày.
 */
const THU_TU_NGUON: Record<NguonDongQuy, number> = {
  GHI_TAY: 0,
  TIKTOK_VE_BANK: 1,
  SHOPEE_RUT_VI: 2,
  BAN_TRUC_TIEP: 3,
  THU_NHAP: 4,
  ADS_TIKTOK_TRU_VI: 5,
  CHI_PHI_ADS_GOP: 6,
  CHI_PHI: 7,
};

function soSanhSuKien(a: SuKienQuy, b: SuKienQuy): number {
  const t = a.ngay.getTime() - b.ngay.getTime();
  if (t !== 0) return t;
  const n = THU_TU_NGUON[a.nguon] - THU_TU_NGUON[b.nguon];
  if (n !== 0) return n;
  // So mã đơn vị (không `localeCompare`): locale của máy chạy không được làm đổi thứ tự.
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Đóng góp CÓ DẤU của một khoản vào quỹ — hỏi đúng công thức của thẻ, không tự suy. */
export function dongGopCuaSuKien(s: SuKienQuy): number {
  const t: TongNguon = { ...TONG_RONG, [s.truong]: s.giaTri };
  return tinhQuyTuTong(t);
}

export type KetQuaDongChay = { dong: DongSoQuy[]; tongThu: number; tongChi: number };

/** Xếp cũ → mới (ngày · thứ tự nguồn · key) và cộng dồn số dư từ `dauKy`. Không đổi mảng đầu vào. */
export function dungDongChay(dauKy: number, suKien: readonly SuKienQuy[]): KetQuaDongChay {
  let soDu = dauKy;
  let tongThu = 0;
  let tongChi = 0;
  const dong = [...suKien].sort(soSanhSuKien).map((s): DongSoQuy => {
    const v = dongGopCuaSuKien(s);
    const thu = v > 0 ? v : 0;
    const chi = v < 0 ? -v : 0;
    soDu += v;
    tongThu += thu;
    tongChi += chi;
    return { key: s.key, ngay: s.ngay, nguon: s.nguon, dienGiai: s.dienGiai, thu, chi, soDu };
  });
  return { dong, tongThu, tongChi };
}

/**
 * Khoá ngày `yyyy-MM-dd` theo giờ VN, KHÔNG lệ thuộc TZ máy chạy: VN = UTC+7 cố định (không DST) nên
 * cộng 7 giờ rồi lấy phần ngày của ISO là đúng biên ngày VN (cùng cách `khoaNgayVnHomNay`).
 */
export function khoaNgayVn(d: Date): string {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Một dòng chi tiêu ads tự động (mỗi chiến dịch mỗi ngày một dòng) — đầu vào của phép gộp. */
export type ChiPhiAdsTuDong = { date: Date; adsSource: string | null; amount: number };

/**
 * Gộp chi tiêu ads TỰ ĐỘNG thành một dòng / ngày VN / nền tảng (chủ shop chốt 24/09: một tháng có cả
 * trăm dòng chiến dịch, liệt kê từng dòng là che mất các khoản chi khác). Tổng tiền GIỮ NGUYÊN — chỉ
 * gộp cách trình bày. `ngay` của dòng gộp = mốc sớm nhất trong nhóm (ingest neo 00:00 VN nên mọi dòng
 * cùng nhóm vốn cùng mốc). Nguồn rỗng gom về "KHAC" chứ không bỏ: bỏ là quỹ lệch thẻ.
 */
export function gopChiPhiAdsTheoNgay(ds: readonly ChiPhiAdsTuDong[]): SuKienQuy[] {
  const nhom = new Map<string, { ngay: Date; nguonAds: string; tong: number; soDong: number }>();
  for (const e of ds) {
    const nguonAds = e.adsSource ?? "KHAC";
    const key = `CHI_PHI_ADS_GOP:${khoaNgayVn(e.date)}:${nguonAds}`;
    const g = nhom.get(key);
    if (g === undefined) {
      nhom.set(key, { ngay: e.date, nguonAds, tong: e.amount, soDong: 1 });
    } else {
      g.tong += e.amount;
      g.soDong += 1;
      if (e.date < g.ngay) g.ngay = e.date;
    }
  }
  return [...nhom].map(([key, g]): SuKienQuy => ({
    key,
    ngay: g.ngay,
    nguon: "CHI_PHI_ADS_GOP",
    truong: "chiPhi",
    giaTri: g.tong,
    dienGiai: `Quảng cáo ${adsSourceLabel(g.nguonAds)} — ${g.soDong} chiến dịch`,
  }));
}
