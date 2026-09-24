import type { Prisma } from "@prisma/client";
import { endOfDay, startOfDay, subDays } from "date-fns";

import { isInflow } from "@/lib/cash-movements/cash-movement-kinds";
import { type DateRange } from "@/lib/date-range";
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

export type CanhBaoQuy = {
  /** Lệnh TikTok đã trả nhưng thiếu ngày ⇒ chưa vào quỹ. */
  tiktokPaidThieuNgay: number;
  shopeeViTuNgay: Date | null;
  shopeeViToiNgay: Date | null;
  /** Ví Shopee chỉ có dữ liệu SAU ngày mở sổ ⇒ thiếu tiền rút trước đó. */
  shopeeThieuTruocD0: boolean;
  shopeeChuaPhanLoai: number;
  /** Có chi phí định kỳ đang bật ⇒ tháng chưa ai mở xem thì quỹ còn thiếu khoản đó. */
  coDinhKyActive: boolean;
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
  ads: { soChiPhi: number; sanTruVi: number }
): Promise<CanhBaoQuy> {
  const [tiktokPaidThieuNgay, viBien, shopeeChuaPhanLoai, soDinhKy] = await Promise.all([
    prisma.tiktokPayment.count({ where: { status: "PAID", paidTime: null } }),
    prisma.shopeeSettlement.aggregate({ _min: { txnTime: true }, _max: { txnTime: true } }),
    prisma.shopeeSettlement.count({ where: { type: "OTHER" } }),
    prisma.recurringExpense.count({ where: { active: true } }),
  ]);
  const tuNgay = viBien._min.txnTime ?? null;
  return {
    tiktokPaidThieuNgay,
    shopeeViTuNgay: tuNgay,
    shopeeViToiNgay: viBien._max.txnTime ?? null,
    shopeeThieuTruocD0: d0 !== null && tuNgay !== null && startOfDay(tuNgay) > d0,
    shopeeChuaPhanLoai,
    coDinhKyActive: soDinhKy > 0,
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
  const d0 = await ngayMoSo();
  if (d0 === null) {
    const canhBao = await docCanhBao(null, ADS_RONG);
    return {
      ...ghepSoQuyThang(null, TONG_RONG, TONG_RONG, TONG_RONG, false),
      adsTiktok: ADS_RONG,
      canhBao,
    };
  }

  // Kỳ nằm TRỌN trước ngày mở sổ ⇒ chưa có sổ; 4 số 0 ở đây là "chưa có", không phải "bằng 0".
  if (endOfDay(range.to) < d0) {
    const [canhBao, toiHomNay] = await Promise.all([
      docCanhBao(d0, ADS_RONG),
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
  const canhBao = await docCanhBao(d0, adsTiktok);

  return { ...ghepSoQuyThang(d0, truocThang, trongThang, toiHomNay, false), adsTiktok, canhBao };
}
