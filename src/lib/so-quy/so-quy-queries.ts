import { cache } from "react";

import type { Prisma } from "@prisma/client";
import { addMonths, endOfDay, endOfMonth, format, startOfDay, startOfMonth, subDays } from "date-fns";

import { isInflow } from "@/lib/cash-movements/cash-movement-kinds";
import { type DateRange } from "@/lib/date-range";
import { mauDinhKySinhChoThang, ngayDenHanDinhKy } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import {
  ghepSoQuyThang,
  TONG_RONG,
  type SoQuyThang,
  type TongNguon,
} from "@/lib/so-quy/cong-thuc-so-quy";
import { tongTienBanTrucTiep } from "@/lib/so-quy/tien-ban-truc-tiep";

/**
 * Đọc số cho thẻ "Quỹ còn lại". Trục DÒNG TIỀN thuần: chỉ đọc tiền ĐÃ VÀO/RA THẬT —
 * ghi tay, TikTok về bank, Shopee rút ví, Sổ chi phí, ads TikTok sàn trừ ví, sổ thu nhập (lãi tiết
 * kiệm đã nhận), tiền khách trả tại shop (đơn bán trực tiếp).
 *
 * KHÔNG đọc tiền DỰ KIẾN (số thu theo đơn đã giao) và không đọc net sàn chốt còn nằm trong ví — cộng
 * chúng cùng tiền đã về là đếm 2 lần. Ngoại lệ DUY NHẤT chạm bảng đơn là `tien-ban-truc-tiep.ts`
 * (đúng cột tiền khách đã trả, đúng kênh bán trực tiếp). Lưới
 * `tests/unit/so-quy/khong-dung-tien-du-kien.test.ts` đọc chính mã nguồn thư mục này để canh.
 */

/** Khoảng ngày đã chuẩn hoá biên (đầu ngày → cuối ngày giờ VN); thiếu `gte` ⇒ không chặn dưới. */
export type KhoangNgayQuy = { gte?: Date; lte: Date };

/** Biên kỳ: `tu = null` ⇒ không chặn dưới (dùng cho lượt đếm toàn lịch sử). */
export function bien(tu: Date | null, den: Date): KhoangNgayQuy {
  return tu === null ? { lte: endOfDay(den) } : { gte: startOfDay(tu), lte: endOfDay(den) };
}

/**
 * Bộ lọc `where` DUY NHẤT của 6 nguồn tiền đọc từ bảng riêng (nguồn thứ 7 — đơn bán trực tiếp — có
 * bộ lọc chung riêng ở `tien-ban-truc-tiep.ts`). Mọi lượt đọc tiền quỹ — tổng của thẻ "Quỹ còn lại"
 * (`docTongNguon`) lẫn từng dòng của Sổ quỹ dòng chạy — PHẢI lấy `where` từ đây: mỗi bên tự viết là
 * sớm muộn trôi nhau (thêm/bớt một điều kiện ở một bên), và bảng chi tiết cộng ra số khác thẻ.
 *
 * Mỗi nguồn neo đúng CỘT NGÀY tiền thật vào/ra: đổi sang cột khác (vd ngày đồng bộ) là tiền nhảy kỳ.
 */
export function boLocNguonQuy(khoang: KhoangNgayQuy) {
  return {
    /** Ghi tay — mọi loại; chiều vào/ra suy từ `kind` lúc cộng, không lọc ở đây. */
    ghiTay: { date: khoang } satisfies Prisma.CashMovementWhereInput,
    /** TikTok chuyển về bank: CHỈ lệnh đã trả, theo mốc trả. */
    tiktokVeBank: { status: "PAID", paidTime: khoang } satisfies Prisma.TiktokPaymentWhereInput,
    /** Ví Shopee: CHỈ lệnh rút (có dấu — dòng đảo lệnh rút mang dương), theo mốc giao dịch ví. */
    shopeeRutVi: { type: "WITHDRAWAL", txnTime: khoang } satisfies Prisma.ShopeeSettlementWhereInput,
    /** Sổ chi phí — MỌI danh mục (kể cả Nhập hàng: tiền thật ra khỏi quỹ dù không vào Lãi/Lỗ), mọi nguồn. */
    chiPhi: { date: khoang } satisfies Prisma.ExpenseWhereInput,
    /** Ads TikTok sàn trừ thẳng vào ví, theo mốc tạo lệnh. */
    adsTiktokTruVi: { orderCreateTime: khoang } satisfies Prisma.TiktokAdsSettlementWhereInput,
    /** Thu nhập tài chính đã nhận, theo ngày tiền về. */
    thuNhap: { date: khoang } satisfies Prisma.ThuNhapWhereInput,
  };
}

/** 7 lượt đọc song song → 8 con số của `TongNguon`. Kỳ rỗng (tu > den) là hợp lệ: mọi số 0. */
export async function docTongNguon(tu: Date | null, den: Date): Promise<TongNguon> {
  if (tu !== null && startOfDay(tu) > endOfDay(den)) return { ...TONG_RONG };
  const khoang = bien(tu, den);
  const loc = boLocNguonQuy(khoang);

  const [ghiTay, tiktok, shopee, chiPhi, adsVi, thuNhap, banTrucTiep] = await Promise.all([
    prisma.cashMovement.groupBy({ by: ["kind"], where: loc.ghiTay, _sum: { amount: true } }),
    prisma.tiktokPayment.aggregate({ where: loc.tiktokVeBank, _sum: { settlementValue: true } }),
    prisma.shopeeSettlement.aggregate({ where: loc.shopeeRutVi, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: loc.chiPhi, _sum: { amount: true } }),
    prisma.tiktokAdsSettlement.aggregate({
      where: loc.adsTiktokTruVi,
      _sum: { settlementAmount: true },
    }),
    // Thu nhập ngoài bán hàng (hiện chỉ lãi sổ tiết kiệm). Tiền THẬT đã về tài khoản đúng ngày `date`
    // — KHÔNG phải số dự kiến, nên đường đọc này hợp lệ với lưới canh thư mục. Cùng `khoang` với các
    // nguồn trên: sai biên kỳ ở đây là lãi nhảy tháng, ĐẦU KỲ(N+1) lệch CUỐI KỲ(N).
    prisma.thuNhap.aggregate({ where: loc.thuNhap, _sum: { amount: true } }),
    // Cùng `khoang` với các nguồn trên — lệch biên là tiền bán nhảy tháng, ĐẦU KỲ(N+1) ≠ CUỐI KỲ(N).
    tongTienBanTrucTiep(khoang),
  ]);

  // Chiều vào/ra SUY từ `kind` (một định nghĩa duy nhất ở cash-movement-kinds) — không cột riêng.
  let ghiTayVao = 0;
  let ghiTayRa = 0;
  for (const g of ghiTay) {
    const tien = g._sum.amount ?? 0;
    if (isInflow(g.kind)) ghiTayVao += tien;
    else ghiTayRa += tien;
  }

  return {
    ghiTayVao,
    ghiTayRa,
    tiktokVeBank: tiktok._sum.settlementValue ?? 0,
    shopeeRutViCoDau: shopee._sum.amount ?? 0,
    chiPhi: chiPhi._sum.amount ?? 0,
    adsTiktokViCoDau: adsVi._sum.settlementAmount ?? 0,
    thuNhap: thuNhap._sum.amount ?? 0,
    banTrucTiep,
  };
}

/** Ngày mở sổ = ngày dòng ghi tay ĐẦU TIÊN toàn bảng; null = chưa mở sổ (thẻ quỹ chỉ mời nhập quỹ). */
export async function ngayMoSo(): Promise<Date | null> {
  const r = await prisma.cashMovement.aggregate({ _min: { date: true } });
  return r._min.date ? startOfDay(r._min.date) : null;
}

/**
 * `ngayMoSo` NHỚ THEO REQUEST (React `cache` — phạm vi một lượt render server): tab Dòng tiền đọc D0 ở
 * nhiều nơi cùng lượt (thẻ Quỹ, ô ví sàn bên cạnh, banner dự báo ở layout) — mỗi nơi một query
 * `MIN(date)` giống hệt nhau. D0 chỉ đổi khi GHI `CashMovement`, mà lượt render không ghi bảng đó.
 *
 * CHỈ dùng trên đường đọc lúc RENDER. Server action / script vừa ghi rồi đọc PHẢI gọi `ngayMoSo()`
 * trần: ngoài lượt render, `cache` không nhớ gì (đo `react` 19.2.8 bản react-server gọi ngoài
 * render: 2 lời gọi = 2 lần chạy) — nhưng dựa vào chi tiết đó là mong manh, nên danh sách file được
 * dùng bản nhớ bị khoá ở `tests/unit/so-quy/ngay-mo-so-nho-theo-request.test.ts`.
 */
export const ngayMoSoTrongRequest = cache(ngayMoSo);

/**
 * `thang` là nhãn "MM/yyyy", sắp tăng dần theo thời gian; rỗng ⇒ không có khoản nào thiếu.
 * `khoang` = từ đầu tháng thiếu SỚM nhất tới cuối tháng thiếu MUỘN nhất — cảnh báo dẫn thẳng Sổ chi phí
 * của đúng khoảng đó, vì tab ấy gọi `ensureRecurringExpensesForMonths` cho MỌI tháng trong range đang xem
 * ⇒ một lần bấm là app ghi bù đủ (link trần chỉ mở tháng hiện tại, tháng cũ vẫn thiếu).
 */
export type DinhKyChuaGhi = { soKhoan: number; thang: string[]; khoang: DateRange | null };

const DINH_KY_RONG: DinhKyChuaGhi = { soKhoan: 0, thang: [], khoang: null };

/**
 * Đếm cặp (mẫu chi định kỳ active, tháng) có ngày đến hạn ∈ [D0, min(den, cuối ngày hôm nay)] mà
 * CHƯA có Expense nào mang đúng `recurringId` trong tháng đó — nghĩa là `ensureRecurringExpenses`
 * chưa chạy cho tháng này (LAZY, chỉ sinh khi tháng được render). CHỈ ĐỌC: không tự sinh Expense,
 * không đổi số quỹ/P&L nào — chỉ báo cho chủ shop biết cần mở tháng đó để app tự ghi.
 *
 * Đúng 1 query mẫu active + 1 query Expense rồi ghép trong bộ nhớ (không query theo từng tháng×mẫu).
 * D0 null hoặc không có mẫu active ⇒ rỗng ngay, không query thêm.
 */
async function docDinhKyChuaGhi(d0: Date | null, den: Date): Promise<DinhKyChuaGhi> {
  if (d0 === null) return DINH_KY_RONG;

  const homNay = endOfDay(new Date());
  const bienTren = endOfDay(den) < homNay ? endOfDay(den) : homNay;
  if (bienTren < d0) return DINH_KY_RONG;

  const active = await prisma.recurringExpense.findMany({
    where: { active: true },
    select: { id: true, dayOfMonth: true, activeFrom: true },
  });
  if (active.length === 0) return DINH_KY_RONG;

  const tuThang = startOfMonth(d0);
  // Mọi Expense định kỳ đã sinh từ D0 trở đi, của đúng các mẫu active — ghép trong bộ nhớ bên dưới.
  const daSinh = await prisma.expense.findMany({
    where: { recurringId: { in: active.map((r) => r.id) }, date: { gte: tuThang } },
    select: { recurringId: true, date: true },
  });
  const boDaSinh = new Set(daSinh.map((e) => `${e.recurringId}:${format(e.date, "yyyy-MM")}`));

  let soKhoan = 0;
  const thang: string[] = [];
  const thangDaThem = new Set<string>();
  let dauTien: Date | null = null;
  let cuoiCung: Date | null = null;
  for (let m = tuThang; m <= bienTren; m = addMonths(m, 1)) {
    const key = format(m, "yyyy-MM");
    for (const r of active) {
      // Tháng trước mốc `activeFrom`: bộ sinh KHÔNG sinh ⇒ không phải "thiếu" (cùng cổng với bộ sinh).
      if (!mauDinhKySinhChoThang(r.activeFrom, m)) continue;
      const ngayDenHan = ngayDenHanDinhKy(r.dayOfMonth, m);
      if (ngayDenHan < d0 || ngayDenHan > bienTren) continue; // chưa tới hạn hoặc trước ngày mở sổ
      if (boDaSinh.has(`${r.id}:${key}`)) continue; // đã sinh — không thiếu

      soKhoan++;
      if (!thangDaThem.has(key)) {
        thangDaThem.add(key);
        thang.push(format(m, "MM/yyyy"));
        dauTien ??= m;
        cuoiCung = m;
      }
    }
  }
  const khoang = dauTien && cuoiCung ? { from: dauTien, to: endOfMonth(cuoiCung) } : null;
  return { soKhoan, thang, khoang };
}

export type CanhBaoQuy = {
  /** Lệnh TikTok đã trả nhưng thiếu ngày ⇒ chưa vào quỹ. */
  tiktokPaidThieuNgay: number;
  shopeeViTuNgay: Date | null;
  shopeeViToiNgay: Date | null;
  /** Ví Shopee chỉ có dữ liệu SAU ngày mở sổ ⇒ thiếu tiền rút trước đó. */
  shopeeThieuTruocD0: boolean;
  shopeeChuaPhanLoai: number;
  /**
   * Mẫu chi định kỳ ACTIVE có tháng đến hạn trong [D0, hôm nay] mà `ensureRecurringExpenses` CHƯA
   * sinh Expense (tháng đó chưa ai mở xem — cơ chế LAZY) ⇒ Sổ chi phí đang THIẾU đúng khoản chi thật
   * đó, quỹ hiển thị cao hơn thực tế đúng bằng phần thiếu.
   */
  dinhKyChuaGhi: DinhKyChuaGhi;
  /**
   * Ads TikTok sàn ĐÃ trừ ví nhiều hơn phần ads ghi ở Sổ chi phí trong cùng cửa sổ [D0, to]. Quỹ
   * cộng lại NGUYÊN phần sàn trừ ví (không kẹp theo sổ) nên khi Sổ chi phí ads thiếu, quỹ phồng lên
   * đúng bằng phần chênh — phải kêu, đừng để tiền hiện ra từ hư không.
   */
  adsViVuotSo: boolean;
};

export type SoQuyThangDayDu = SoQuyThang & {
  /** Ads TikTok luỹ kế [D0, to]: Sổ chi phí ghi `soChiPhi`, sàn đã trừ ví `sanTruVi` ⇒ trả thẻ ≈ hiệu. */
  adsTiktok: { soChiPhi: number; sanTruVi: number };
  canhBao: CanhBaoQuy;
};

const ADS_RONG = { soChiPhi: 0, sanTruVi: 0 };

async function docCanhBao(
  d0: Date | null,
  den: Date,
  ads: { soChiPhi: number; sanTruVi: number }
): Promise<CanhBaoQuy> {
  const [tiktokPaidThieuNgay, viBien, shopeeChuaPhanLoai, dinhKyChuaGhi] = await Promise.all([
    prisma.tiktokPayment.count({ where: { status: "PAID", paidTime: null } }),
    prisma.shopeeSettlement.aggregate({ _min: { txnTime: true }, _max: { txnTime: true } }),
    prisma.shopeeSettlement.count({ where: { type: "OTHER" } }),
    docDinhKyChuaGhi(d0, den),
  ]);
  const tuNgay = viBien._min.txnTime ?? null;
  return {
    tiktokPaidThieuNgay,
    shopeeViTuNgay: tuNgay,
    shopeeViToiNgay: viBien._max.txnTime ?? null,
    shopeeThieuTruocD0: d0 !== null && tuNgay !== null && startOfDay(tuNgay) > d0,
    shopeeChuaPhanLoai,
    dinhKyChuaGhi,
    adsViVuotSo: ads.sanTruVi > ads.soChiPhi,
  };
}

async function docAdsTiktok(
  d0: Date,
  den: Date
): Promise<{ soChiPhi: number; sanTruVi: number }> {
  const khoang = bien(d0, den);
  const [soSach, vi] = await Promise.all([
    prisma.expense.aggregate({
      where: { categoryId: "ads", adsSource: "TIKTOK_ADS", date: khoang },
      _sum: { amount: true },
    }),
    // Cùng bộ lọc với phần quỹ cộng lại — so hai số ads chỉ có nghĩa khi đọc đúng tập mà quỹ cộng.
    prisma.tiktokAdsSettlement.aggregate({
      where: boLocNguonQuy(khoang).adsTiktokTruVi,
      _sum: { settlementAmount: true },
    }),
  ]);
  // `settlementAmount` lưu ÂM (sàn trừ ví) ⇒ đảo dấu để hiển thị số dương "sàn đã trừ ví".
  return { soChiPhi: soSach._sum.amount ?? 0, sanTruVi: -(vi._sum.settlementAmount ?? 0) };
}

/**
 * 4 số sổ quỹ của kỳ đang xem + quỹ tới hôm nay. ĐẦU KỲ là luỹ kế [D0, trước from] nên
 * `CUỐI KỲ(N) ≡ ĐẦU KỲ(N+1)` tự đúng theo cấu trúc, không cần bảng số dư.
 */
export async function tinhSoQuyThang(range: DateRange): Promise<SoQuyThangDayDu> {
  const d0 = await ngayMoSoTrongRequest();
  if (d0 === null) {
    const canhBao = await docCanhBao(null, new Date(), ADS_RONG);
    return {
      ...ghepSoQuyThang(null, TONG_RONG, TONG_RONG, TONG_RONG, false),
      adsTiktok: ADS_RONG,
      canhBao,
    };
  }

  // Kỳ nằm TRỌN trước ngày mở sổ ⇒ chưa có sổ; 4 số 0 ở đây là "chưa có", không phải "bằng 0".
  if (endOfDay(range.to) < d0) {
    const [canhBao, toiHomNay] = await Promise.all([
      // Cảnh báo luỹ kế TỚI HÔM NAY (giống `toiHomNay` bên dưới) — không phải theo `range` đang xem,
      // vì kỳ này nằm TRỌN trước D0 nên chẳng có "range" nào để neo cửa sổ cảnh báo cả.
      docCanhBao(d0, new Date(), ADS_RONG),
      docTongNguon(d0, new Date()),
    ]);
    return {
      ...ghepSoQuyThang(d0, TONG_RONG, TONG_RONG, toiHomNay, true),
      adsTiktok: ADS_RONG,
      canhBao,
    };
  }

  const batDau = startOfDay(range.from) > d0 ? startOfDay(range.from) : d0;
  const [truocThang, trongThang, toiHomNay, adsTiktok] = await Promise.all([
    // Rỗng khi kỳ bắt đầu ngay tại D0 (không có ngày nào trước đó để cộng).
    batDau <= d0 ? Promise.resolve({ ...TONG_RONG }) : docTongNguon(d0, subDays(batDau, 1)),
    docTongNguon(batDau, range.to),
    docTongNguon(d0, new Date()),
    docAdsTiktok(d0, range.to),
  ]);
  // Cảnh báo chạy SAU: cờ `adsViVuotSo` so hai số ads của chính cửa sổ vừa đọc, không đọc lại DB.
  // `dinhKyChuaGhi` neo TỚI HÔM NAY (giống `toiHomNay` ở trên) — cảnh báo nói về quỹ hiện tại của
  // chủ shop, không đổi theo tháng đang xem trên màn hình.
  const canhBao = await docCanhBao(d0, new Date(), adsTiktok);

  return { ...ghepSoQuyThang(d0, truocThang, trongThang, toiHomNay, false), adsTiktok, canhBao };
}
