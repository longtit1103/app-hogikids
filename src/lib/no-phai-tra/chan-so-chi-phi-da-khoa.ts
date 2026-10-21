import { format } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";

import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * KHOÁ SỔ CHI PHÍ khi đã bật nợ phải trả (M ≠ null) — MỘT cổng cho mọi đường ghi `Expense` qua tay người (tạo/sửa/
 * xoá ở Sổ chi phí, duyệt phiếu nhập, bộ sinh định kỳ, khôi phục thùng rác, bật lại mẫu định kỳ). Hai luật hợp thành:
 *
 *  1. NHẬP HÀNG (`purchase`) khoá MỌI ngày. Ngày ≥ M: tiền hàng đi DUY NHẤT `PhieuNhapNo` + `SUPPLIER_PAY` ngày trả
 *     thật — thêm Expense Nhập hàng là trừ quỹ LẦN HAI cho cùng lô hàng. Ngày < M: luật 2.
 *  2. MỌI danh mục ngày < M (ngày VN) khoá: quỹ cuối M−1 đã được CHỐT theo tiền thật bằng điều chỉnh mở sổ
 *     `CUTOVER_ADJ_*` (bước bật, ghi một lần). Trước M mọi danh mục đều trừ quỹ (`dieuKienChiPhiTruQuy` chỉ cắt từ
 *     ≥ M) ⇒ thêm / xoá / khôi phục một dòng trước M, đổi số tiền / ngày / thẻ của nó, hay dời dòng ≥ M về trước M
 *     đều đổi quỹ app cuối M−1 mà điều chỉnh không biết ⇒ quỹ từ M lệch đúng số đó khỏi tiền thật. Với Nhập hàng
 *     còn đổi "đã trả trước" của phiếu trước M (Expense cùng `refId`, `luat-da-tra-truoc-phieu.ts`) ⇒ nợ phiếu lệch.
 *
 * Luật 2 phải phủ MỌI danh mục chứ không riêng Nhập hàng: chỉ khoá Nhập hàng thì có đường vòng — đổi dòng Nhập hàng
 * sang `fixed` (giữ tiền, hợp lệ), sửa tiền dòng `fixed`, đổi lại Nhập hàng (giữ tiền so với bản đã sửa) ⇒ số tiền
 * Nhập hàng trước M đổi tuỳ ý; hoặc đổi sang `fixed` rồi xoá.
 *
 * NGOẠI LỆ DUY NHẤT (chủ shop chốt 11/10 + 12/10) — SỬA dòng TRƯỚC M mà chỉ đổi danh mục / mô tả / kênh
 * (`laSuaGiuTien`): cùng NGÀY VN, cùng số tiền, cùng `cardId`. Trước M mọi danh mục trừ quỹ như nhau, và "đã trả trước"
 * của phiếu tra theo `refId` không lọc danh mục ⇒ quỹ cuối M−1 và nợ phiếu không đổi, chỉ Lãi/Lỗ đổi (đúng mục đích:
 * sửa khai nhầm danh mục). So ngày theo NGÀY VN, không theo timestamp: dòng sinh từ phiếu mang giờ (10:30) còn form
 * gửi 00:00 cùng ngày — quỹ tính theo ngày nên vô hại.
 *
 * KHÔNG gọi cổng này (ngoại lệ có chủ đích, lưới `tests/khoa-duong-ghi-nhap-hang-da-khoa-so.test.ts` khai lý do):
 *  - cửa máy ads `ADS_API` (chủ shop giữ nguyên: số nền tảng tự báo, chỉ ghi danh mục ads);
 *  - import file ads THỦ CÔNG — không còn là ngoại lệ về tiền: sau khoá chung tự LỌC bỏ dòng ngày < M
 *    (`laNgayTruocMocM`), chỉ ghi/ghi đè dòng ≥ M, chỉ danh mục ads;
 *  - Expense lãi vay sinh cùng `CashMovement` của kỳ vay / tất toán thấu chi — luôn CÙNG ngày với dòng gốc, nên ngày
 *    < M bị chặn ở cổng dòng tiền `chanDongTienTruocM` (khoá chung câu đầu; lưới
 *    `tests/khoa-duong-ghi-dong-tien-truoc-m.test.ts`);
 *  - lối "Sửa số tiền trước mốc" (`actions/sua-tien-truoc-moc.ts`) — đổi số tiền dòng < M nhưng TỰ BÙ `CUTOVER_ADJ_*`
 *    ±Δ ngày M trong cùng transaction nên quỹ từ M không đổi;
 *  - `data-admin` xoá toàn bộ (xoá luôn mốc M và điều chỉnh mở sổ).
 *
 * HỢP ĐỒNG KHOÁ: người gọi PHẢI đã giữ `khoaChiaSeBatNoPhaiTra(tx)` trong CÙNG transaction (câu đầu tiên, trước mọi
 * khoá dòng). Không giữ thì lượt ghi đọc M = null trong lúc bước bật (khoá EXCLUSIVE) chưa commit rồi ghi sau lưng
 * nó; bước bật đã đọc xong quỹ ⇒ vẫn bật ⇒ quỹ lệch điều chỉnh vừa chốt. Lưới
 * `tests/khoa-chung-bat-cho-duong-ghi-nhap-hang.test.ts` + test đua `khe-dua-nhap-hang-va-buoc-bat`.
 */

/** Luật nào chặn: Nhập hàng (mọi ngày) hay "trước M" (mọi danh mục). */
export type LyDoSoChiPhiDaKhoa = "NHAP_HANG" | "TRUOC_M";

/** Câu từ chối theo luật — dùng chung cho action (toast / ô form) và cột trạng thái thùng rác. */
export function cauSoChiPhiDaKhoa(mocM: Date, lyDo: LyDoSoChiPhiDaKhoa): string {
  const ngay = format(mocM, "dd/MM/yyyy");
  return lyDo === "TRUOC_M"
    ? `Chi phí trước ngày bật theo dõi nợ (${ngay}) đã chốt vào số dư mở sổ — chỉ đổi được danh mục, mô tả, kênh; ` +
        `không đổi số tiền, ngày hay thẻ, không thêm, xoá hay khôi phục được nữa.`
    : `Từ ngày bật theo dõi nợ (${ngay}), chi phí "Nhập hàng" đã khoá sổ — không thêm, xoá, khôi phục, lặp hàng ` +
        `tháng hay đổi sang Nhập hàng được nữa: tiền hàng ghi qua sổ nợ (ghi nhận phiếu rồi Trả tiền hàng).`;
}

export class LoiSoChiPhiDaKhoa extends Error {
  readonly code = "DA_BAT_NO_PHAI_TRA" as const;

  constructor(
    readonly mocM: Date,
    readonly lyDo: LyDoSoChiPhiDaKhoa,
  ) {
    super(cauSoChiPhiDaKhoa(mocM, lyDo));
    this.name = "LoiSoChiPhiDaKhoa";
  }
}

/** Client đọc được bảng `Setting` — prisma gốc hoặc `tx` của transaction đang chạy. */
type DbDocSetting = Pick<Prisma.TransactionClient, "setting">;

/** Ngày (theo NGÀY VN) nằm trước mốc M — tức thuộc phần quỹ đã chốt bằng điều chỉnh mở sổ. M null ⇒ false. */
export function laNgayTruocMocM(ngay: Date, mocM: Date | null): boolean {
  return mocM !== null && khoaNgayVn(ngay) < khoaNgayVn(mocM);
}

/**
 * Vị từ THUẦN cho nơi CHỈ ĐỌC đã có sẵn M (khối định kỳ ẩn nút "Bật lại", dự báo quỹ): mẫu/dòng "Nhập hàng" khi
 * đã bật. Phần "trước M" của luật dùng `laNgayTruocMocM`. Đường GHI luôn gọi `chanSoChiPhiDaKhoa`.
 */
export function laNhapHangDaKhoaSo(d: { categoryId: string }, mocM: Date | null): boolean {
  return d.categoryId === "purchase" && mocM !== null;
}

/** Phần "chạm tiền" của một dòng chi phí mà lượt sửa có thể đổi. */
export type PhanTienDongChi = { date: Date; amount: number; cardId: string | null };

/**
 * Lượt sửa GIỮ NGUYÊN tiền của một dòng TRƯỚC M: cùng ngày VN, cùng số tiền, cùng thẻ, và ngày < M (ngày VN).
 * Chỉ khi đó đổi danh mục/mô tả/kênh mới không chạm quỹ cuối M−1 lẫn nợ phiếu — lý do ở đầu file.
 */
export function laSuaGiuTien(cu: PhanTienDongChi, moi: PhanTienDongChi, mocM: Date): boolean {
  const ngayCu = khoaNgayVn(cu.date);
  return (
    ngayCu === khoaNgayVn(moi.date) &&
    ngayCu < khoaNgayVn(mocM) &&
    cu.amount === moi.amount &&
    cu.cardId === moi.cardId
  );
}

/** Dòng chi phí được xét khi tạo / xoá / khôi phục. */
type DongChi = { categoryId: string; date: Date };

/**
 * Thao tác ghi cần xét:
 *  - `TAO`: thêm một dòng (tạo tay, dòng đầu mẫu lặp, duyệt phiếu nhập, bộ sinh định kỳ, khôi phục thùng rác);
 *  - `XOA`: xoá một dòng (cả "Xoá và dừng lặp lại") — `dong` là bản đọc LẠI sau khoá chung;
 *  - `SUA`: `cu` = bản đọc LẠI sau khoá chung, `moi` = dữ liệu sẽ ghi;
 *  - `BAT_MAU`: bật lại một mẫu định kỳ (không ghi Expense; mẫu Nhập hàng thì mọi lần sinh đều bị chặn). Lần phát
 *    sinh trước M của mẫu danh mục khác do bộ sinh tự bỏ (cổng `TAO`), không cần chặn lúc bật lại.
 */
export type ThaoTacChiPhi =
  | { loai: "TAO" | "XOA"; dong: DongChi }
  | { loai: "SUA"; cu: DongChi & PhanTienDongChi; moi: DongChi & PhanTienDongChi }
  | { loai: "BAT_MAU"; categoryId: string };

/**
 * Lõi THUẦN của luật: luật chặn, hoặc `null` = cho qua. M null (chưa bật) ⇒ luôn `null`. "Trước M" xét trước Nhập
 * hàng: dòng Nhập hàng trước M bị chặn vì quỹ đã chốt, và câu "trước M" nói đúng điều còn được phép (đổi danh mục).
 */
export function lyDoSoChiPhiDaKhoa(t: ThaoTacChiPhi, mocM: Date | null): LyDoSoChiPhiDaKhoa | null {
  if (mocM === null) return null;
  switch (t.loai) {
    case "BAT_MAU":
      return t.categoryId === "purchase" ? "NHAP_HANG" : null;
    case "TAO":
    case "XOA":
      if (laNgayTruocMocM(t.dong.date, mocM)) return "TRUOC_M";
      return t.dong.categoryId === "purchase" ? "NHAP_HANG" : null;
    case "SUA":
      if (laSuaGiuTien(t.cu, t.moi, mocM)) return null;
      if (laNgayTruocMocM(t.cu.date, mocM) || laNgayTruocMocM(t.moi.date, mocM)) return "TRUOC_M";
      return t.cu.categoryId === "purchase" || t.moi.categoryId === "purchase" ? "NHAP_HANG" : null;
  }
}

/**
 * Cổng của mọi đường ghi: đọc M (SAU khoá chung của người gọi) rồi ném `LoiSoChiPhiDaKhoa` khi luật chặn. Luôn
 * đọc Setting (một câu) — luật "trước M" áp mọi danh mục.
 */
export async function chanSoChiPhiDaKhoa(db: DbDocSetting, t: ThaoTacChiPhi): Promise<void> {
  const mocM = await docMocM(db);
  if (mocM === null) return;
  const lyDo = lyDoSoChiPhiDaKhoa(t, mocM);
  if (lyDo !== null) throw new LoiSoChiPhiDaKhoa(mocM, lyDo);
}
