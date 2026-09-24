import type { ThuNhapKind } from "@prisma/client";
import { startOfDay } from "date-fns";

import { CASH_MOVEMENT_KIND_META, isInflow } from "@/lib/cash-movements/cash-movement-kinds";
import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";
import {
  dungDongChay,
  gopChiPhiAdsTheoNgay,
  type ChiPhiAdsTuDong,
  type SuKienQuy,
} from "@/lib/so-quy/dong-chay-so-quy";
import type { SoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-types";
import { bien, boLocNguonQuy, tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { lietKeTienBanTrucTiep } from "@/lib/so-quy/tien-ban-truc-tiep";

/**
 * Đọc Sổ quỹ dạng DÒNG CHẠY cho kỳ đang xem — chi tiết của đúng con số thẻ "Quỹ còn lại".
 *
 * Mỗi lượt đọc dưới đây trùng khít `docTongNguon` (`so-quy-queries.ts`) theo CẤU TRÚC: cùng hàm biên
 * `bien()` và cùng `where` lấy từ `boLocNguonQuy` / bộ lọc chung bán trực tiếp — không lượt nào tự
 * viết điều kiện. Sửa bộ lọc một nguồn là thẻ và bảng đổi CÙNG lúc; chỉ `select` là riêng của bảng. Không nắn: tự kiểm
 * `dauKy + Σthu − Σchi = cuoiKy` của thẻ, lệch thì trả `lechDoiChieu` để màn hình kêu đỏ.
 *
 * Tiền DỰ KIẾN / net sàn chốt còn nằm trong ví KHÔNG bao giờ vào đây (lưới
 * `tests/unit/so-quy/khong-dung-tien-du-kien.test.ts` soi cả file này).
 */

/** Nhãn loại thu nhập tài chính — `Record` theo enum để thêm loại mới là lỗi biên dịch, không rơi rỗng. */
const NHAN_THU_NHAP: Record<ThuNhapKind, string> = { LAI_TIET_KIEM: "Lãi tiết kiệm" };

/** "Nhãn — mô tả", bỏ gạch nối khi mô tả rỗng. */
function noi(nhan: string, moTa: string): string {
  const m = moTa.trim();
  return m === "" ? nhan : `${nhan} — ${m}`;
}

/** 7 lượt đọc song song (cùng bộ lọc với `docTongNguon`) ⇒ danh sách khoản tiền chưa xếp của [tu, den]. */
async function docSuKien(tu: Date, den: Date): Promise<SuKienQuy[]> {
  const khoang = bien(tu, den);
  const loc = boLocNguonQuy(khoang);
  const [ghiTay, tiktok, shopee, chiPhi, adsVi, thuNhap, banTrucTiep] = await Promise.all([
    prisma.cashMovement.findMany({
      where: loc.ghiTay,
      select: { id: true, date: true, kind: true, amount: true, description: true },
    }),
    prisma.tiktokPayment.findMany({
      where: loc.tiktokVeBank,
      select: { id: true, paymentId: true, paidTime: true, settlementValue: true },
    }),
    prisma.shopeeSettlement.findMany({
      where: loc.shopeeRutVi,
      select: { id: true, txnTime: true, amount: true },
    }),
    prisma.expense.findMany({
      where: loc.chiPhi,
      select: {
        id: true,
        date: true,
        amount: true,
        description: true,
        source: true,
        adsSource: true,
        category: { select: { name: true } },
      },
    }),
    prisma.tiktokAdsSettlement.findMany({
      where: loc.adsTiktokTruVi,
      select: { id: true, orderCreateTime: true, settlementAmount: true },
    }),
    prisma.thuNhap.findMany({
      where: loc.thuNhap,
      select: { id: true, date: true, kind: true, amount: true, description: true },
    }),
    lietKeTienBanTrucTiep(khoang),
  ]);

  const suKien: SuKienQuy[] = [];

  // Chiều vào/ra SUY từ `kind` (một định nghĩa duy nhất ở cash-movement-kinds) — y như tổng của thẻ.
  for (const m of ghiTay) {
    suKien.push({
      key: `GHI_TAY:${m.id}`,
      ngay: m.date,
      nguon: "GHI_TAY",
      truong: isInflow(m.kind) ? "ghiTayVao" : "ghiTayRa",
      giaTri: m.amount,
      dienGiai: noi(CASH_MOVEMENT_KIND_META[m.kind].label, m.description),
    });
  }

  for (const p of tiktok) {
    // Bộ lọc khoảng ngày đã loại `paidTime` rỗng; gặp rỗng ở đây là Prisma đổi nghĩa — nổ, đừng đoán ngày.
    if (p.paidTime === null) throw new Error(`TikTokPayment ${p.id} PAID trong kỳ mà thiếu paidTime`);
    suKien.push({
      key: `TIKTOK_VE_BANK:${p.id}`,
      ngay: p.paidTime,
      nguon: "TIKTOK_VE_BANK",
      truong: "tiktokVeBank",
      giaTri: p.settlementValue,
      dienGiai: `TikTok chuyển về tài khoản — lệnh ${p.paymentId}`,
    });
  }

  for (const s of shopee) {
    suKien.push({
      key: `SHOPEE_RUT_VI:${s.id}`,
      ngay: s.txnTime,
      nguon: "SHOPEE_RUT_VI",
      truong: "shopeeRutViCoDau",
      giaTri: s.amount, // CÓ DẤU nguyên như cột — dấu thu/chi do công thức quỹ quyết, không tự đảo
      dienGiai: s.amount < 0 ? "Rút ví Shopee về tài khoản" : "Shopee đảo lệnh rút ví (tiền quay lại ví)",
    });
  }

  const adsTuDong: ChiPhiAdsTuDong[] = [];
  for (const e of chiPhi) {
    if (e.source === "ADS_API") {
      adsTuDong.push({ date: e.date, adsSource: e.adsSource, amount: e.amount });
      continue;
    }
    suKien.push({
      key: `CHI_PHI:${e.id}`,
      ngay: e.date,
      nguon: "CHI_PHI",
      truong: "chiPhi",
      giaTri: e.amount,
      dienGiai: noi(e.category.name, e.description),
    });
  }
  suKien.push(...gopChiPhiAdsTheoNgay(adsTuDong));

  for (const a of adsVi) {
    suKien.push({
      key: `ADS_TIKTOK_TRU_VI:${a.id}`,
      ngay: a.orderCreateTime,
      nguon: "ADS_TIKTOK_TRU_VI",
      truong: "adsTiktokViCoDau",
      giaTri: a.settlementAmount, // lưu ÂM (sàn trừ ví) — công thức quỹ tự cộng lại
      dienGiai: "Ads TikTok sàn trừ thẳng vào ví — bù lại khoản đã ghi ở Sổ chi phí",
    });
  }

  for (const t of thuNhap) {
    suKien.push({
      key: `THU_NHAP:${t.id}`,
      ngay: t.date,
      nguon: "THU_NHAP",
      truong: "thuNhap",
      giaTri: t.amount,
      dienGiai: noi(NHAN_THU_NHAP[t.kind], t.description),
    });
  }

  for (const d of banTrucTiep) {
    suKien.push({
      key: `BAN_TRUC_TIEP:${d.id}`,
      ngay: d.orderedAt,
      nguon: "BAN_TRUC_TIEP",
      truong: "banTrucTiep",
      giaTri: d.paidAtShop,
      dienGiai: `Bán trực tiếp — đơn ${d.code}`,
    });
  }

  return suKien;
}

/**
 * Sổ quỹ dòng chạy của kỳ `range`. Số đầu/cuối kỳ LẤY TỪ THẺ (`tinhSoQuyThang`), các dòng đọc riêng
 * rồi đối chiếu — không bao giờ dùng số tự cộng thay số thẻ.
 */
export async function docSoQuyDongChay(range: DateRange): Promise<SoQuyDongChay> {
  const the = await tinhSoQuyThang(range);
  if (the.d0 === null) return { trangThai: "CHUA_MO_SO" };
  const d0 = the.d0;
  if (the.truocMoSo) return { trangThai: "TRUOC_MO_SO", d0 };

  // CÙNG cách `tinhSoQuyThang` tính `batDau` — lệch mốc là dòng ngày mở sổ bị đếm hai lần hoặc mất.
  const tu = startOfDay(range.from) > d0 ? startOfDay(range.from) : d0;
  const den = range.to;
  const { dong, tongThu, tongChi } = dungDongChay(the.dauKy, await docSuKien(tu, den));

  const cuoiKyTuDong = the.dauKy + tongThu - tongChi;
  return {
    trangThai: "CO_SO",
    d0,
    tu,
    den,
    dauKy: the.dauKy,
    cuoiKy: the.cuoiKy,
    tongThu,
    tongChi,
    dong,
    lechDoiChieu:
      cuoiKyTuDong === the.cuoiKy ? null : { cuoiKyThe: the.cuoiKy, cuoiKyTuDong },
    the,
  };
}
