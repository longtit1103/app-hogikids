import { formatVnd } from "@/lib/format";
import { nhanCuoiKySoQuy } from "@/lib/so-quy/cong-thuc-so-quy";
import type { SoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-types";
import { NGUON_LABEL } from "@/lib/so-quy/nhan-nguon-dong-quy";

/**
 * Builder THUẦN cho sheet Excel tab "Sổ quỹ" (dòng chạy) — dùng ở nút "Xuất Excel", khuôn
 * `exportTabToExcel` (`@/lib/reports/export-excel.ts`, client). Cột: Ngày · Nguồn · Diễn giải · Thu ·
 * Chi · Số dư — cùng thứ tự bảng trên màn (`so-quy-dong-chay-table.tsx`). Tiền LUÔN là số nguyên
 * (không format chuỗi qua `formatVnd`) để cộng được ngay trong Excel; ô không áp dụng (vd Thu/Chi của
 * dòng Đầu/Cuối kỳ, Số dư của dòng Tổng) để trống `""` thay vì 0 — 0 dễ hiểu nhầm thành "phát sinh bằng
 * 0". Dòng đầu "Đầu kỳ" neo ĐÚNG `dauKy` của thẻ Quỹ (không tự cộng lại từ các dòng — cùng bất biến với
 * bảng trên màn). Dòng cuối dùng ĐÚNG nhãn màn hình qua `nhanCuoiKySoQuy` (`the`, `laThangHienTai`) —
 * tháng hiện tại còn khoản ghi ngày sau hôm nay thì cả màn lẫn file cùng in "Cuối kỳ (dự kiến hết
 * tháng)", không lệch nhãn giữa hai nơi. Có `lechDoiChieu` ⇒ thêm một dòng cảnh báo ở cuối sheet để
 * người đọc file ngoài app cũng thấy lệch.
 */

type SoQuySheetRow = Record<string, string | number>;

/**
 * "dd/MM/yyyy" (+ " HH:mm" khi giờ VN ≠ 00:00) theo giờ VN CỐ ĐỊNH, không theo máy chạy.
 *
 * Hàm này chạy TRONG TRÌNH DUYỆT (nút xuất là client component): `date-fns/format` sẽ dùng múi giờ của
 * máy người bấm ⇒ máy đặt múi giờ khác ra ngày/giờ lệch với bảng trên màn hình (bảng render ở server
 * giờ VN). VN = UTC+7 không DST ⇒ dời 7 giờ rồi đọc bằng getter UTC là đúng giờ VN ở mọi máy.
 */
function formatNgayExcel(d: Date): string {
  const vn = new Date(d.getTime() + 7 * 3600 * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const ngay = `${p2(vn.getUTCDate())}/${p2(vn.getUTCMonth() + 1)}/${vn.getUTCFullYear()}`;
  const gio = `${p2(vn.getUTCHours())}:${p2(vn.getUTCMinutes())}`;
  return gio === "00:00" ? ngay : `${ngay} ${gio}`;
}

export function buildSoQuySheetRows(
  d: Extract<SoQuyDongChay, { trangThai: "CO_SO" }>,
  /** Kỳ đang xuất có phải tháng hiện tại — cùng cờ `isCurrentMonth` tab truyền cho
   * `nhanCuoiKySoQuy`/bảng trên màn, KHÔNG tự suy lại ở đây (builder thuần, không đọc đồng hồ). */
  laThangHienTai: boolean
): SoQuySheetRow[] {
  const { nhan: nhanCuoiKy } = nhanCuoiKySoQuy(d.the, laThangHienTai);
  const rows: SoQuySheetRow[] = [
    { Ngày: "", Nguồn: "", "Diễn giải": "Đầu kỳ", Thu: "", Chi: "", "Số dư": d.dauKy },
    ...d.dong.map(
      (dong): SoQuySheetRow => ({
        Ngày: formatNgayExcel(dong.ngay),
        Nguồn: NGUON_LABEL[dong.nguon],
        "Diễn giải": dong.dienGiai,
        // `dong.thu`/`dong.chi` đã là số nguyên VÀ tối đa một vế khác 0 (bất biến `DongSoQuy`) — dùng
        // thẳng, không cần điều kiện rỗng như hai cột trên.
        Thu: dong.thu,
        Chi: dong.chi,
        "Số dư": dong.soDu,
      })
    ),
    { Ngày: "", Nguồn: "", "Diễn giải": "Tổng", Thu: d.tongThu, Chi: d.tongChi, "Số dư": "" },
    { Ngày: "", Nguồn: "", "Diễn giải": nhanCuoiKy, Thu: "", Chi: "", "Số dư": d.cuoiKy },
  ];

  if (d.lechDoiChieu) {
    const { cuoiKyThe, cuoiKyTuDong } = d.lechDoiChieu;
    rows.push({
      Ngày: "",
      Nguồn: "",
      "Diễn giải":
        `CẢNH BÁO: dòng chạy lệch thẻ Quỹ — cuối kỳ theo thẻ ${formatVnd(cuoiKyThe)}, ` +
        `cộng từ các dòng ${formatVnd(cuoiKyTuDong)}. Tải lại trang; nếu vẫn lệch thì ` +
        `báo lại để kiểm.`,
      Thu: "",
      Chi: "",
      "Số dư": "",
    });
  }

  return rows;
}
