import { format, startOfDay, startOfMonth, subDays } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";
import { formatVnd } from "@/lib/format";
import { type DongNhapHangSauM, huongDanNhapHangSauM } from "@/lib/no-phai-tra/huong-dan-nhap-hang-sau-m";
import { NEN_TANG_VI_TRA_TRUOC, NHAN_NEN_TANG_VI } from "@/lib/no-phai-tra/vi-ads-queries";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Điều kiện TIÊN QUYẾT của bước xác nhận bật nợ phải trả (spec §5.4, §5.7) — một danh sách, hai nơi dùng:
 * checklist tab Chuẩn bị (đọc ngoài transaction, chỉ để báo) và bước bật (đọc LẠI trong transaction, sau
 * khoá EXCLUSIVE — chặn thật). Mỗi lỗi có mã để test và màn hình phân biệt.
 *
 *  - `CHUA_TOI_NGAY_M`: hôm nay < M — số dư "cuối ngày M − 1" chưa có thật.
 *  - `M_LUI_QUA_XA`: M trước đầu tháng TRƯỚC (giờ VN) — lùi xa thì ads nền tảng gắn thẻ từ M bị chuyển khỏi
 *    quỹ HỒI TỐ và bước 2 đòi số dư ngân hàng/thẻ lịch sử khó kiểm.
 *  - `CHUA_MO_SO` / `M_TRUOC_MO_SO`: quỹ chưa có điểm xuất phát, hoặc M trước ngày mở sổ.
 *  - `M_KHONG_SAU_THANG_DA_CHOT`: M phải thuộc tháng SAU tháng chốt số dư gần nhất — điều chỉnh ngày M
 *    nằm trong tháng đã chốt là bản chốt đó đổi nghĩa (so với một cuối kỳ khác lúc chốt).
 *  - `THIEU_HO_SO_VI`: nền tảng ads trả trước có chi phí 90 ngày gần nhất mà chưa có hồ sơ ví. KHÔNG phải chặn
 *    cứng: bước bật cho qua khi chủ shop xác nhận "ví Shopee chưa theo dõi" (nạp từ ví bán hàng — app chưa
 *    nhận diện tự động dòng nạp — hoặc chưa muốn theo dõi ví); khi đó chi ads Shopee tiếp tục trừ quỹ theo
 *    ngày chạy như trước bật. Lọc mã này là việc của bước bật (`ghiKhoiTaoNoPhaiTra`), hàm này luôn báo.
 *  - `CON_MAU_DINH_KY_NHAP_HANG`: còn mẫu chi định kỳ danh mục Nhập hàng đang chạy — sau M bộ sinh bỏ qua
 *    mẫu này (Nhập hàng đi sổ nợ); bắt chủ shop tắt trước thay vì để mẫu "sống" mà không sinh gì.
 *  - `CON_NHAP_HANG_SAU_M`: còn `Expense` Nhập hàng ngày ≥ M (vd phiếu duyệt trong [M, ngày bật) khi cổng
 *    chặn ghi Nhập hàng sau M chưa có hiệu lực). Sau bật dòng đó VẪN trừ quỹ (bộ lọc chi phí không loại
 *    Nhập hàng) trong khi phiếu thuộc sổ nợ ⇒ quỹ lệch ngân hàng; và phiếu Y của nó bị giải thích nhầm tại
 *    M − 1. Cách xử lý theo THỰC TẾ của từng dòng (`huong-dan-nhap-hang-sau-m.ts`): ngày ghi nhầm (khoản thật
 *    trước M) ⇒ sửa về đúng ngày thật; đã trả thật trong [M, nay] ⇒ xoá dòng, sau khi bật ghi nhận phiếu vào
 *    sổ nợ kèm "Đã trả ngay" đúng ngày trả (quỹ trừ đúng một lần, tại ngày trả); chưa trả ⇒ xoá dòng, sau khi
 *    bật ghi nhận phiếu không kèm trả. KHÔNG đổi ngày chỉ để vượt cổng: dòng về trước M là đổi quỹ tháng
 *    trước và chênh lệch bước bật. Lỗi mang kèm danh sách dòng có cấu trúc (`nhapHangSauM`) cho màn hình.
 * "Mọi thẻ đang có nợ đã khai" KHÔNG kiểm được bằng máy (app không biết thẻ ngoài hồ sơ) — màn hình dặn.
 */

export type MaDieuKienBat =
  | "CHUA_TOI_NGAY_M"
  | "M_LUI_QUA_XA"
  | "CHUA_MO_SO"
  | "M_TRUOC_MO_SO"
  | "M_KHONG_SAU_THANG_DA_CHOT"
  | "THIEU_HO_SO_VI"
  | "CON_MAU_DINH_KY_NHAP_HANG"
  | "CON_NHAP_HANG_SAU_M";

export type LoiDieuKienBat = {
  code: MaDieuKienBat;
  message: string;
  /** Chỉ có ở `CON_NHAP_HANG_SAU_M`: các dòng (tối đa `SO_DONG_NHAP_HANG_LIET_KE`) + số dòng còn lại. */
  nhapHangSauM?: { khoaM: string; khoaHomNay: string; dong: DongNhapHangSauM[]; soDongKhac: number };
};


type DbDieuKien = Pick<
  Prisma.TransactionClient,
  "cashMovement" | "soDuChotThang" | "expense" | "viAdsTraTruoc" | "recurringExpense"
>;

/** Cửa sổ "đang có chi phí" của nền tảng ads trả trước. */
export const SO_NGAY_XET_CHI_ADS_TRA_TRUOC = 90;

/** Số dòng Nhập hàng ≥ M liệt kê trong câu lỗi (còn lại ghi "và N dòng khác"). */
const SO_DONG_NHAP_HANG_LIET_KE = 10;

const nhanNgay = (d: Date) => format(d, "dd/MM/yyyy");
const nhanKhoa = (khoa: string) => khoa.split("-").reverse().join("/");

/** `yyyy-MM-01` của tháng TRƯỚC tháng chứa ngày (khoá ngày VN) — so chuỗi, không phụ thuộc TZ máy. */
function dauThangTruoc(khoaNgay: string): string {
  const [y, m] = khoaNgay.split("-").map(Number);
  const [yy, mm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  return `${yy}-${String(mm).padStart(2, "0")}-01`;
}

export async function kiemDieuKienBat(
  p: { mocM: Date; homNay?: Date },
  db: DbDieuKien = prisma
): Promise<LoiDieuKienBat[]> {
  const homNay = p.homNay ?? new Date();
  const khoaM = khoaNgayVn(p.mocM);
  const tuNgayXet = startOfDay(subDays(homNay, SO_NGAY_XET_CHI_ADS_TRA_TRUOC));
  const dauNgayM = new Date(`${khoaM}T00:00:00+07:00`);

  const [d0Agg, chotGanNhat, chiTraTruoc, vis, mauNhapHang, nhapHangSauM, soNhapHangSauM] = await Promise.all([
    db.cashMovement.aggregate({ _min: { date: true } }),
    db.soDuChotThang.findFirst({ orderBy: { thang: "desc" }, select: { thang: true } }),
    db.expense.groupBy({
      by: ["adsSource"],
      where: { adsSource: { in: [...NEN_TANG_VI_TRA_TRUOC] }, date: { gte: tuNgayXet } },
      _count: { _all: true },
    }),
    db.viAdsTraTruoc.findMany({ select: { nenTang: true } }),
    db.recurringExpense.findMany({
      where: { categoryId: "purchase", active: true },
      select: { description: true },
      orderBy: { description: "asc" },
    }),
    db.expense.findMany({
      where: { categoryId: "purchase", date: { gte: dauNgayM } },
      select: { id: true, date: true, amount: true, description: true },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      take: SO_DONG_NHAP_HANG_LIET_KE,
    }),
    db.expense.count({ where: { categoryId: "purchase", date: { gte: dauNgayM } } }),
  ]);

  const loi: LoiDieuKienBat[] = [];
  if (khoaM > khoaNgayVn(homNay)) {
    loi.push({
      code: "CHUA_TOI_NGAY_M",
      message: `Chưa tới ngày bật ${nhanNgay(p.mocM)} — số dư cuối ngày trước đó chưa có thật`,
    });
  }
  const sanM = dauThangTruoc(khoaNgayVn(homNay));
  if (khoaM < sanM) {
    loi.push({
      code: "M_LUI_QUA_XA",
      message:
        `Ngày bật ${nhanNgay(p.mocM)} lùi quá xa — chọn từ ${nhanKhoa(sanM)} (đầu tháng trước) trở đi: lùi xa thì ` +
        "quảng cáo trả bằng thẻ bị chuyển khỏi quỹ hồi tố và phải khai số dư ngân hàng/thẻ của quá khứ",
    });
  }

  const d0 = d0Agg._min.date;
  if (d0 === null) {
    loi.push({ code: "CHUA_MO_SO", message: "Chưa mở sổ quỹ (chưa có dòng nhập quỹ nào) — mở sổ trước khi bật" });
  } else if (khoaM < khoaNgayVn(d0)) {
    loi.push({
      code: "M_TRUOC_MO_SO",
      message: `Ngày bật ${nhanNgay(p.mocM)} trước ngày mở sổ quỹ ${nhanNgay(d0)}`,
    });
  }

  if (chotGanNhat !== null && startOfMonth(p.mocM) <= chotGanNhat.thang) {
    loi.push({
      code: "M_KHONG_SAU_THANG_DA_CHOT",
      message:
        `Đã chốt số dư tháng ${format(chotGanNhat.thang, "MM/yyyy")} — ngày bật phải thuộc tháng sau đó ` +
        "(điều chỉnh quỹ ngày bật không được rơi vào tháng đã chốt)",
    });
  }

  const coVi = new Set(vis.map((v) => v.nenTang));
  const thieuVi = chiTraTruoc
    .filter((g) => g.adsSource !== null && g._count._all > 0 && !coVi.has(g.adsSource))
    .map((g) => NHAN_NEN_TANG_VI[g.adsSource as string] ?? (g.adsSource as string));
  if (thieuVi.length > 0) {
    loi.push({
      code: "THIEU_HO_SO_VI",
      message:
        `${thieuVi.join(", ")} có chi phí ${SO_NGAY_XET_CHI_ADS_TRA_TRUOC} ngày gần nhất nhưng chưa có hồ sơ ví ` +
        "trả trước — tạo hồ sơ ví ở tab Chuẩn bị, hoặc (nạp từ ví bán hàng / chưa muốn theo dõi ví) đánh dấu " +
        "xác nhận ở bước bật",
    });
  }

  if (mauNhapHang.length > 0) {
    loi.push({
      code: "CON_MAU_DINH_KY_NHAP_HANG",
      message:
        `Còn mẫu chi định kỳ Nhập hàng đang chạy: ${mauNhapHang.map((m) => `"${m.description}"`).join(", ")} — ` +
        "dừng các mẫu này ở Sổ chi phí trước khi bật (sau khi bật, Nhập hàng ghi vào sổ nợ phải trả)",
    });
  }

  if (soNhapHangSauM > 0) {
    const ds = nhapHangSauM.map((e) => `${nhanNgay(e.date)} · ${formatVnd(e.amount)} · ${e.description}`);
    if (soNhapHangSauM > ds.length) ds.push(`và ${soNhapHangSauM - ds.length} dòng khác`);
    const hd = huongDanNhapHangSauM(nhanNgay(p.mocM));
    loi.push({
      code: "CON_NHAP_HANG_SAU_M",
      message:
        `Còn chi phí Nhập hàng ghi từ ngày bật ${nhanNgay(p.mocM)} trở đi: ${ds.join("; ")}. Xử lý từng dòng ở Sổ ` +
        `chi phí: ${hd.truongHop.map((t, i) => `(${i + 1}) ${t}`).join("; ")}. ${hd.canhBao}.`,
      nhapHangSauM: {
        khoaM,
        khoaHomNay: khoaNgayVn(homNay),
        dong: nhapHangSauM.map((e) => ({ id: e.id, khoaNgay: khoaNgayVn(e.date), amount: e.amount, description: e.description })),
        soDongKhac: soNhapHangSauM - nhapHangSauM.length,
      },
    });
  }
  return loi;
}
