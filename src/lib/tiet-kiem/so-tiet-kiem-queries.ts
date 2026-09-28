import { prisma } from "@/lib/prisma";
import {
  docDongTheoSo,
  docDuNoGoc,
  docThuNhapTheoSo,
} from "@/lib/tiet-kiem/doc-tong-theo-so-tiet-kiem";
import {
  chenhLechLaiSuat,
  laiDonToiNay,
  laiDuKien,
  soNgayGiua,
  type ChenhLechLai,
} from "@/lib/tiet-kiem/cong-thuc-lai-tiet-kiem";

// Ba số tổng sống ở file riêng (mối quan tâm khác), re-export ở đây để đường import của mọi nơi gọi
// giữ nguyên — hợp đồng interface ở `plan.md` khai chúng thuộc module này.
export {
  demSoDenHan,
  tongDangGui,
  tongLaiDaNhanTrongKy,
  type TongDangGui,
} from "@/lib/tiet-kiem/so-tiet-kiem-so-tong";

/**
 * Đọc bảng sổ tiết kiệm (spec §11). Số tiền đang gửi KHÔNG lưu cột: luôn suy lại từ chính các dòng
 * `CashMovement` gắn `savingsId` — không có chỗ nào để nó lệch với sổ.
 *
 * Trục DÒNG TIỀN + `ThuNhap`; file này KHÔNG import gì từ `src/lib/reports/**` và P&L cũng không
 * import nó — P&L chỉ biết bảng `ThuNhap` (spec §4).
 *
 * Mọi tổng gom 1 LƯỢT ĐỌC cho MỌI sổ (bảng chỉ vài dòng); gọi vị từ trong vòng lặp là N+1 truy vấn.
 */

export type SoTietKiemRow = {
  id: string;
  name: string;
  bank: string;
  principal: number;
  startDate: Date;
  termMonths: number;
  maturityDate: Date;
  annualRateBp: number;
  closedAt: Date | null;
  note: string;
  /** Σ SAVINGS_OUT − Σ SAVINGS_IN (suy từ dòng tiền, không phải cột). */
  dangGui: number;
  laiDuKien: number;
  /** Lãi dồn tới HÔM NAY — THÔNG TIN, không vào P&L, không vào Sổ quỹ (spec §6.4). */
  laiDonToiNay: number;
  /** Σ `ThuNhap` của sổ; `null` khi sổ chưa tất toán — chưa tất toán thì chưa có lãi thật để khoe. */
  laiThucNhan: number | null;
  rutTruocHan: boolean;
  loan: { id: string; name: string } | null;
  chenhLech: ChenhLechLai;
  /**
   * Có dòng `CashMovement` nào NGOÀI đúng một dòng `SAVINGS_OUT` do app sinh. Sổ đã tất toán luôn
   * `true` (có thêm dòng `SAVINGS_IN`) — không sao: cổng `daTatToan` của
   * `lyDoKhongXoaSoTietKiem` đứng TRƯỚC nên câu lý do vẫn đúng.
   */
  coDongGhiTay: boolean;
  /**
   * SỐ DÒNG `SAVINGS_OUT` của sổ. Khác `dangGui` (số TIỀN): ô chọn sổ ở form ghi tay phải lọc theo
   * ĐÚNG vị từ server dùng (`kiemSoTietKiem` đếm dòng gửi), nếu không sổ đã nhận lại hết tiền bằng
   * dòng ghi tay vẫn hiện ra cho chọn rồi bấm Lưu mới ăn lỗi.
   */
  soDongGui: number;
};

/**
 * Sổ còn hiệu lực trước (`closedAt` null), trong mỗi nhóm mới tạo trước. `nulls: "first"` là BẮT
 * BUỘC: Postgres mặc định xếp NULL CUỐI khi ASC, tức sổ đã tất toán sẽ nhảy lên đầu bảng.
 */
export async function listSoTietKiem(): Promise<SoTietKiemRow[]> {
  const so = await prisma.soTietKiem.findMany({
    orderBy: [{ closedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    include: {
      loan: {
        select: { id: true, name: true, kind: true, annualRateBp: true, laiCoDinhMoiKy: true },
      },
    },
  });
  const loanIds = [...new Set(so.map((s) => s.loanId).filter((x): x is string => x !== null))];
  const [dong, thuNhap, duNo] = await Promise.all([
    docDongTheoSo(),
    docThuNhapTheoSo(),
    docDuNoGoc(loanIds),
  ]);
  const homNay = new Date();

  return so.map((s) => {
    const d = dong.get(s.id) ?? { tongDong: 0, soGui: 0, dangGui: 0 };
    return {
      id: s.id,
      name: s.name,
      bank: s.bank,
      principal: s.principal,
      startDate: s.startDate,
      termMonths: s.termMonths,
      maturityDate: s.maturityDate,
      annualRateBp: s.annualRateBp,
      closedAt: s.closedAt,
      note: s.note,
      dangGui: d.dangGui,
      laiDuKien: laiDuKien(s.principal, s.annualRateBp, soNgayGiua(s.startDate, s.maturityDate)),
      laiDonToiNay: laiDonToiNay({
        principal: s.principal,
        annualRateBp: s.annualRateBp,
        startDate: s.startDate,
        maturityDate: s.maturityDate,
        homNay,
      }),
      laiThucNhan: s.closedAt === null ? null : (thuNhap.get(s.id) ?? 0),
      rutTruocHan: s.closedAt !== null && s.closedAt < s.maturityDate,
      loan: s.loan === null ? null : { id: s.loan.id, name: s.loan.name },
      chenhLech: chenhLechLaiSuat(
        { principal: s.principal, annualRateBp: s.annualRateBp },
        s.loan === null
          ? null
          : {
              kind: s.loan.kind,
              annualRateBp: s.loan.annualRateBp,
              laiCoDinhMoiKy: s.loan.laiCoDinhMoiKy,
              duNoGoc: duNo.get(s.loan.id) ?? 0,
            }
      ),
      // 0 dòng ⇒ KHÔNG coi là ghi tay (không có gì để mất khi xoá sổ); đúng 1 dòng và nó là dòng
      // gửi ⇒ dòng do app sinh; mọi hình khác đều là bàn tay chủ shop.
      coDongGhiTay: d.tongDong > 1 || (d.tongDong === 1 && d.soGui === 0),
      soDongGui: d.soGui,
    };
  });
}
