import { cache } from "react";

import { demKyDaToiHan, duKienNKy } from "@/lib/so-quy/lich-tra-no";
import { prisma } from "@/lib/prisma";
import { docSoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-queries";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import {
  congNgay,
  docNguongTuGiaTri,
  ghepDuBao,
  khoaDaSinh,
  khoanDaGhi,
  khoanDinhKy,
  khoanKyTraNo,
  soDuCuoiNgay,
  SO_NGAY_DU_BAO,
  SO_NGAY_LICH_SU,
  type KetQuaDuBao,
} from "@/lib/so-quy/du-bao-quy";
import type {
  CanhBaoSapCan,
  DiemSoDu,
  DuBaoQuy,
  KhoaNgay,
  KhoanDuKien,
} from "@/lib/so-quy/du-bao-quy-types";
import { listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";

/**
 * Đọc biểu đồ quỹ (90 ngày) + dự báo "quỹ sắp cạn" (30 ngày). Lõi tính ở `du-bao-quy.ts` (thuần).
 *
 * Bất biến: lịch sử và phần "đã ghi" của dự báo đều đọc qua `docSoQuyDongChay` — CÙNG bộ lọc, cùng cột
 * ngày với thẻ "Quỹ còn lại", không tự cộng nguồn. Dự báo KHÔNG cộng tiền sàn sẽ về (chưa biết).
 */

/** Key ô `Setting` giữ quỹ tối thiểu chủ shop đặt (số VND nguyên dạng chuỗi). KHÔNG thuộc kho khoá n8n. */
export const KEY_QUY_TOI_THIEU = "soQuyQuyToiThieu";

/** Khoá ngày VN ⇒ mốc 00:00 giờ VN (đầu vào `DateRange` của các hàm đọc Sổ quỹ). */
function dauNgayVn(k: KhoaNgay): Date {
  return new Date(`${k}T00:00:00+07:00`);
}

/** Ngày 1 của tháng KẾ TIẾP tháng chứa `k` (ngày 1 + 31 ngày luôn rơi vào tháng sau). */
function dauThangSau(k: KhoaNgay): KhoaNgay {
  return `${congNgay(`${k.slice(0, 7)}-01`, 31).slice(0, 7)}-01`;
}

export async function docNguongQuy(): Promise<{ nguong: number; nguongDaDat: boolean }> {
  const row = await prisma.setting.findUnique({
    where: { key: KEY_QUY_TOI_THIEU },
    select: { value: true },
  });
  return docNguongTuGiaTri(row?.value);
}

/** Kỳ trả nợ dự kiến chưa ghi của mọi khoản còn hiệu lực, trong (…, den] — kỳ quá hạn về hôm nay. */
async function docKhoanKyTraNo(bayGio: Date, homNay: KhoaNgay, den: KhoaNgay): Promise<KhoanDuKien[]> {
  const loans = await listKhoanVay();
  const moc = dauNgayVn(den);
  const ra: KhoanDuKien[] = [];
  for (const l of loans) {
    if (l.closedAt !== null) continue;
    // Đủ số kỳ để phủ trọn cửa sổ: số kỳ có hạn ≤ hết cửa sổ tính TỪ KỲ 1 là cận trên của số kỳ CHƯA
    // đóng dấu trong cửa sổ (`duKienNKy` bắt đầu từ kỳ chưa đóng dấu đầu tiên). Hằng số cố định (vd 3)
    // sẽ hụt khi khoản khai lùi ngày có vài kỳ quá hạn dồn lại.
    const soKy = demKyDaToiHan(l, moc);
    if (soKy === 0) continue;
    // `KhoanVayRow` mang đủ field của `KhoanVayLich` — truyền thẳng như thẻ lịch trả nợ dự kiến.
    const ky = duKienNKy({
      lich: l,
      traGoc: l.traGoc,
      lastDueHandled: l.lastDueHandled,
      homNay: bayGio,
      soKy,
      duNoHienTai: l.duNo,
      tienGuiDangGiu: l.tienGuiDangGiu,
      closedAt: l.closedAt,
    });
    ra.push(...khoanKyTraNo(l.name, ky, homNay, den));
  }
  return ra;
}

/**
 * Chi phí định kỳ đang bật, lần phát sinh từ tháng hiện tại tới `den` mà tháng đó chưa sinh dòng — lần
 * đã tới hạn trong tháng hiện tại mà chưa sinh dòng tính vào hôm nay (`khoanDinhKy`).
 */
async function docKhoanDinhKy(homNay: KhoaNgay, den: KhoaNgay): Promise<KhoanDuKien[]> {
  const mau = await prisma.recurringExpense.findMany({
    where: { active: true },
    select: { id: true, amount: true, dayOfMonth: true, description: true },
  });
  if (mau.length === 0) return [];
  // Dòng đã sinh trong các tháng mà cửa sổ chạm — cổng "1 dòng/mẫu/tháng" của chính bộ sinh.
  const daSinhDong = await prisma.expense.findMany({
    where: {
      recurringId: { in: mau.map((m) => m.id) },
      date: {
        gte: dauNgayVn(`${homNay.slice(0, 7)}-01`),
        lt: dauNgayVn(dauThangSau(den)),
      },
    },
    select: { recurringId: true, date: true },
  });
  const daSinh = new Set<string>();
  for (const e of daSinhDong) {
    if (e.recurringId !== null) daSinh.add(khoaDaSinh(e.recurringId, khoaNgayVn(e.date)));
  }
  return khoanDinhKy(mau, homNay, den, daSinh);
}

type PhanDuBao =
  | { trangThai: "CHUA_MO_SO" }
  | ({
      trangThai: "CO_SO";
      homNay: KhoaNgay;
      quyHomNay: number;
      nguong: number;
      nguongDaDat: boolean;
    } & KetQuaDuBao);

/**
 * Mốc "bây giờ" cho các phép tính theo giờ (`duKienNKy`) KHỚP khoá ngày `homNay`. Đồng hồ đã sang ngày
 * mới (request chạy vắt nửa đêm) ⇒ kẹp về 23:59:59.999 VN của `homNay`, để kỳ trả nợ đến hạn "hôm sau"
 * không lọt thành quá hạn trong khi cửa sổ vẫn neo hôm qua. CHỈ kẹp phần kỳ trả nợ: `the.quyHomNay` bên
 * trong `tinhSoQuyThang` vẫn đọc đồng hồ thật — vắt nửa đêm thì phép tự kiểm quỹ hôm nay có thể lệch và
 * tab hiện hộp "không dựng được dự báo" (tải lại là hết), không ra số sai.
 */
function bayGioCuaNgay(homNay: KhoaNgay): Date {
  const bayGio = new Date();
  if (khoaNgayVn(bayGio) === homNay) return bayGio;
  return new Date(dauNgayVn(congNgay(homNay, 1)).getTime() - 1);
}

/**
 * Phần DỰ BÁO (không đọc lịch sử) — dùng chung cho tab Sổ quỹ và banner toàn app.
 *
 * Quỹ hôm nay = đầu kỳ của cửa sổ tương lai [ngày mai, +30] — chính là số thẻ tính cho [D0, hết hôm
 * nay]; tự kiểm bằng `the.quyHomNay` (số to của thẻ). Lệch ⇒ ném: dự báo dựng trên một quỹ khác thẻ
 * thì ngày "sắp cạn" là bịa.
 */
async function docPhanDuBao(homNay: KhoaNgay): Promise<PhanDuBao> {
  const bayGio = bayGioCuaNgay(homNay);
  const ngayMai = congNgay(homNay, 1);
  const den = congNgay(homNay, SO_NGAY_DU_BAO);

  const [tuongLai, kyTraNo, dinhKy, nguong] = await Promise.all([
    docSoQuyDongChay({ from: dauNgayVn(ngayMai), to: dauNgayVn(den) }),
    docKhoanKyTraNo(bayGio, homNay, den),
    docKhoanDinhKy(homNay, den),
    docNguongQuy(),
  ]);
  if (tuongLai.trangThai === "CHUA_MO_SO") return { trangThai: "CHUA_MO_SO" };

  let quyHomNay = 0;
  let daGhi: KhoanDuKien[] = [];
  // TRUOC_MO_SO = dòng ghi tay đầu tiên mang ngày SAU cả cửa sổ ⇒ sổ chưa bắt đầu: quỹ 0, chưa có gì ghi.
  if (tuongLai.trangThai === "CO_SO") {
    if (tuongLai.lechDoiChieu !== null) {
      throw new Error(
        `Dự báo quỹ: dòng chạy ${ngayMai}..${den} lệch thẻ (thẻ ${tuongLai.lechDoiChieu.cuoiKyThe}, ` +
          `dòng ${tuongLai.lechDoiChieu.cuoiKyTuDong})`
      );
    }
    if (tuongLai.dauKy !== tuongLai.the.quyHomNay) {
      throw new Error(
        `Dự báo quỹ: đầu kỳ ngày mai ${tuongLai.dauKy} ≠ quỹ hôm nay của thẻ ${tuongLai.the.quyHomNay}`
      );
    }
    quyHomNay = tuongLai.dauKy;
    daGhi = khoanDaGhi(tuongLai.dong);
  }

  const ketQua = ghepDuBao({
    homNay,
    quyHomNay,
    nguong: nguong.nguong,
    khoan: [...daGhi, ...kyTraNo, ...dinhKy],
  });
  return { trangThai: "CO_SO", homNay, quyHomNay, ...nguong, ...ketQua };
}

/**
 * `docPhanDuBao` NHỚ THEO REQUEST (React `cache` — phạm vi một lượt render server). Layout gọi banner
 * (`docCanhBaoSapCan`) ở MỌI trang, tab Sổ quỹ gọi `docDuBaoQuy` — không nhớ thì tab đó đọc phần dự báo
 * HAI lần (vài chục query mỗi lần). Khoá là khoá ngày VN (chuỗi — `cache` so tham số theo danh tính,
 * truyền `Date` thì không bao giờ trúng); hai lời gọi cùng ngày trong một request dùng chung một lượt.
 *
 * Bản nhớ có thể CŨ hơn chính trang: layout có thể đọc trước khi trang chạy `ensureRecurringExpenses`
 * sinh dòng. `docDuBaoQuy` vì thế đối chiếu với lịch sử nó vừa đọc và đọc lại bản mới khi lệch.
 */
const docPhanDuBaoTrongRequest = cache((homNay: KhoaNgay) => docPhanDuBao(homNay));

/** Phần dự báo lệch lịch sử đọc cùng lượt — do hai lượt đọc cách nhau một lần ghi, không phải lỗi số. */
class LechGiuaHaiLuotDoc extends Error {}

type LichSuDong = Awaited<ReturnType<typeof docSoQuyDongChay>>;

/**
 * Ghép lịch sử 90 ngày với phần dự báo + tự kiểm: điểm cuối lịch sử = quỹ hôm nay của thẻ = của dự báo.
 * Lệch GIỮA lịch sử và phần dự báo ném `LechGiuaHaiLuotDoc` (caller được đọc lại); lệch nội tại của
 * lịch sử (dòng chạy ≠ thẻ) ném `Error` thường — đọc lại không chữa được.
 */
function ghepLichSu(
  lichSuDong: LichSuDong,
  phan: PhanDuBao,
  homNay: KhoaNgay,
  dauLichSu: KhoaNgay
): DuBaoQuy {
  if (phan.trangThai === "CHUA_MO_SO" || lichSuDong.trangThai === "CHUA_MO_SO") {
    // Một bên thấy sổ còn bên kia không = dòng mở sổ vừa ghi/xoá giữa hai lượt.
    if (phan.trangThai !== lichSuDong.trangThai) {
      throw new LechGiuaHaiLuotDoc("Dự báo quỹ: trạng thái mở sổ đổi giữa hai lượt đọc — tải lại trang");
    }
    return { trangThai: "CHUA_MO_SO" };
  }

  // TRUOC_MO_SO = ngày mở sổ nằm SAU hôm nay ⇒ chưa có lịch sử, quỹ hôm nay 0.
  let lichSu: DiemSoDu[] = [];
  if (lichSuDong.trangThai === "CO_SO") {
    if (lichSuDong.lechDoiChieu !== null) {
      throw new Error(
        `Biểu đồ quỹ: dòng chạy ${dauLichSu}..${homNay} lệch thẻ (thẻ ` +
          `${lichSuDong.lechDoiChieu.cuoiKyThe}, dòng ${lichSuDong.lechDoiChieu.cuoiKyTuDong})`
      );
    }
    lichSu = soDuCuoiNgay(lichSuDong.dauKy, lichSuDong.dong, khoaNgayVn(lichSuDong.tu), homNay);
    const cuoi = lichSu[lichSu.length - 1]?.soDu ?? lichSuDong.dauKy;
    if (cuoi !== lichSuDong.the.quyHomNay) {
      throw new Error(
        `Biểu đồ quỹ: cuối lịch sử ${cuoi} ≠ quỹ hôm nay của thẻ ${lichSuDong.the.quyHomNay}`
      );
    }
    if (cuoi !== phan.quyHomNay) {
      throw new LechGiuaHaiLuotDoc(
        `Biểu đồ quỹ: cuối lịch sử ${cuoi} ≠ quỹ hôm nay của dự báo ${phan.quyHomNay}`
      );
    }
  } else if (phan.quyHomNay !== 0) {
    throw new LechGiuaHaiLuotDoc(
      `Biểu đồ quỹ: sổ chưa bắt đầu mà dự báo có quỹ hôm nay ${phan.quyHomNay}`
    );
  }

  return { ...phan, lichSu };
}

/**
 * Biểu đồ quỹ đầy đủ cho tab Sổ quỹ: 90 ngày số dư cuối ngày tới hôm nay (từ ngày mở sổ nếu sổ còn
 * non) + dự báo 30 ngày. Tự kiểm: điểm cuối lịch sử = quỹ hôm nay của dự báo = số to của thẻ.
 */
export async function docDuBaoQuy(): Promise<DuBaoQuy> {
  const homNay = khoaNgayVn(new Date());
  const dauLichSu = congNgay(homNay, -(SO_NGAY_LICH_SU - 1));

  const [lichSuDong, phan] = await Promise.all([
    docSoQuyDongChay({ from: dauNgayVn(dauLichSu), to: dauNgayVn(homNay) }),
    docPhanDuBaoTrongRequest(homNay),
  ]);
  try {
    return ghepLichSu(lichSuDong, phan, homNay, dauLichSu);
  } catch (e) {
    if (!(e instanceof LechGiuaHaiLuotDoc)) throw e;
    // Bản nhớ trong request cũ hơn lịch sử vừa đọc (vd layout đọc trước khi trang sinh dòng định kỳ)
    // ⇒ đọc lại phần dự báo KHÔNG qua bản nhớ, đúng một lần. Vẫn lệch thì lỗi thật, để nó nổ.
    return ghepLichSu(lichSuDong, await docPhanDuBao(homNay), homNay, dauLichSu);
  }
}

/**
 * Bản rút gọn cho banner toàn app — gọi ở layout MỖI trang nên CHỈ đọc phần dự báo (không đọc lịch sử
 * 90 ngày). Banner là lời nhắc: lỗi đọc KHÔNG được biến mọi trang thành 500, nên bắt lại + ghi log
 * `console.error` (tab Sổ quỹ dùng `docDuBaoQuy`, nơi đó lỗi vẫn nổ to).
 */
export async function docCanhBaoSapCan(): Promise<CanhBaoSapCan> {
  try {
    const phan = await docPhanDuBaoTrongRequest(khoaNgayVn(new Date()));
    if (phan.trangThai === "CHUA_MO_SO" || phan.cham === null) return null;
    return { ngay: phan.cham.ngay, soDu: phan.cham.soDu, nguong: phan.nguong, nguongDaDat: phan.nguongDaDat };
  } catch (e) {
    console.error("[so-quy] docCanhBaoSapCan lỗi — banner quỹ sắp cạn tạm ẩn", e);
    return null;
  }
}
