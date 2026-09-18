import { format } from "date-fns";

import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoQuyThangDayDu } from "@/lib/so-quy/so-quy-queries";

import { CashMovementAddButton } from "./cash-movement-add-button";
import { SoQuyCanhBao } from "./so-quy-canh-bao";

/**
 * Thẻ "Quỹ còn lại" — số TO DUY NHẤT ở đầu tab Dòng tiền (spec §5.5). Trục dòng tiền THẬT: tiền đã
 * vào/ra tài khoản, khác hẳn "Chênh lệch trong tháng (dự kiến)" bên dưới (theo đơn đã giao).
 *
 * Ba trạng thái, KHÔNG gộp: chưa mở sổ (mời ghi khoản đầu tiên) · kỳ nằm trọn trước ngày mở sổ (nói
 * "chưa có sổ" thay vì in bốn số 0 như thật) · bình thường. Server component thuần hiển thị. Khối
 * cảnh báo dữ liệu tách sang `so-quy-canh-bao.tsx` để file này dưới 200 dòng.
 */

/** Số cho footnote sổ tiết kiệm sinh lãi — page dựng từ `tongDangGui()` + sổ đáo hạn gần nhất. */
export type TietKiemQuy = {
  /** Σ tiền đang gửi ở các sổ CHƯA tất toán (suy từ dòng tiền, không có cột lưu sẵn để lệch). */
  tong: number;
  /** Ngày đáo hạn sớm nhất trong các sổ chưa tất toán; null khi không đọc được sổ nào. */
  daoHanGanNhat: Date | null;
  /** Gốc của CHÍNH sổ đáo hạn gần nhất (không phải tổng). */
  gocDaoHan: number;
  /** Lãi dự kiến của sổ đó — số ĐỀ XUẤT, tiền chưa về: không vào quỹ, không vào Lãi/Lỗ. */
  laiDuKienDaoHan: number;
};

/**
 * Một câu chú thích cho thẻ Quỹ. CỐ Ý khác hẳn câu tiền gửi BẮT BUỘC (`DEPOSIT_*` — gắn khoản vay,
 * không sinh lãi, nhận lại lúc tất toán khoản vay) ngay từ chữ đầu: hai loại tiền gửi cùng nằm trong
 * một thẻ nên đọc nhầm là hiểu sai cả bản chất lẫn ngày nhận lại. Trả `null` ⇒ không in dòng nào.
 */
export function dongTietKiemDangGui(t: TietKiemQuy | null): string | null {
  if (t === null || t.tong <= 0) return null;
  const dau = `đang gửi tiết kiệm sinh lãi ${formatVnd(t.tong)} (đã trừ vào quỹ, không mất)`;
  if (t.daoHanGanNhat === null) return dau;
  return `${dau} — đáo hạn gần nhất ${format(t.daoHanGanNhat, "dd/MM")} nhận lại ${formatVnd(
    t.gocDaoHan
  )} + lãi ≈ ${formatVnd(t.laiDuKienDaoHan)}`;
}

function ONho({
  nhan,
  tien,
  dau,
  ghiChu,
}: {
  nhan: string;
  tien: number;
  dau?: "−";
  ghiChu?: string;
}) {
  return (
    <div className="rounded-xl bg-surface-card p-3">
      <p className="text-xs text-muted-foreground">{nhan}</p>
      <p className="mt-1 font-serif text-xl text-ink">
        {dau ? `${dau} ` : ""}
        {formatVnd(tien)}
      </p>
      {ghiChu && <p className="mt-0.5 text-xs text-muted-foreground">{ghiChu}</p>}
    </div>
  );
}

export function SoQuyCard({
  soQuy,
  isCurrentMonth,
  /** Số KHOẢN VAY còn hiệu lực đang có kỳ chờ duyệt (tối đa 1 kỳ/khoản) — page tính từ `listKhoanVay()`. */
  soKhoanVayCoKyCho,
  loans,
  tietKiem,
}: {
  soQuy: SoQuyThangDayDu;
  isCurrentMonth: boolean;
  soKhoanVayCoKyCho: number;
  /** Cho ô chọn khoản vay trong modal — khoản MANG SANG có thể đã tạo trước cả dòng tiền đầu tiên. */
  loans: KhoanVayRow[];
  /** Tiền đang gửi ở sổ tiết kiệm SINH LÃI (`SAVINGS_*`) — KHÁC tiền gửi bắt buộc theo khoản vay. */
  tietKiem: TietKiemQuy | null;
}) {
  if (soQuy.d0 === null) {
    return (
      <div className="rounded-xl border border-hairline p-4">
        <p className="text-sm text-muted-foreground">Quỹ còn lại</p>
        <p className="mt-2 text-sm text-ink">
          Chưa mở sổ quỹ. Bấm &quot;+ Nhập quỹ&quot; để ghi số tiền đang có (góp vốn) hoặc khoản vay
          — quỹ sẽ tính từ ngày đó.
        </p>
        <div className="mt-3">
          {/* `d0 === null` = chưa có dòng `CashMovement` nào trong sổ. Mà tạo sổ tiết kiệm LUÔN
              sinh một dòng gửi, nên ở nhánh này chắc chắn chưa có sổ nào — mảng rỗng là sự thật,
              không phải chỗ trống điền cho qua. */}
          <CashMovementAddButton loans={loans} soTietKiem={[]} d0={null} />
        </div>
      </div>
    );
  }

  if (soQuy.truocMoSo) {
    return (
      <div className="rounded-xl border border-hairline p-4">
        <p className="text-sm text-muted-foreground">Quỹ còn lại</p>
        <p className="mt-2 text-sm text-ink">
          Sổ quỹ mở từ {format(soQuy.d0, "dd/MM/yyyy")} — tháng này chưa có sổ.
        </p>
        <SoQuyCanhBao soQuy={soQuy} soKhoanVayCoKyCho={soKhoanVayCoKyCho} />
      </div>
    );
  }

  // Thấu chi còn hiệu lực: quỹ đã cộng tiền rút vào (như vay thường), nên số dư app ngân hàng có thể
  // THẤP hơn đúng bằng dư nợ thấu chi — nói trước để chủ shop khỏi tưởng app tính dư.
  const duNoThauChi = loans
    .filter((l) => l.kind === "OVERDRAFT" && l.closedAt === null)
    .reduce((s, l) => s + l.duNo, 0);
  // Tiền gửi tiết kiệm bắt buộc ĐÃ TRỪ vào quỹ (dòng `DEPOSIT_OUT`) nhưng KHÔNG mất — ngân hàng chỉ
  // giữ hộ, trả lại khi tất toán. Không nói ra thì số quỹ tụt xuống trông như một khoản lỗ thật.
  const tongTienGuiDangGiu = loans
    .filter((l) => l.closedAt === null)
    .reduce((s, l) => s + l.tienGuiDangGiu, 0);
  // Sổ tiết kiệm tự nguyện: tiền cũng rời quỹ như tiền gửi bắt buộc nhưng còn SINH LÃI và có NGÀY
  // đáo hạn cụ thể — nói cả hai để chủ shop biết bao giờ tiền quay lại và về bao nhiêu.
  const dongTietKiem = dongTietKiemDangGui(tietKiem);
  const { soChiPhi, sanTruVi } = soQuy.adsTiktok;
  // Tháng hiện tại: số TO là quỹ tới HÔM NAY, còn ô "Cuối kỳ" là quỹ tới CUỐI THÁNG. Hai số lệch
  // nhau khi có khoản ghi ngày sau hôm nay (chi phí định kỳ, kỳ trả nợ duyệt trước) — không nói ra
  // thì chủ shop cộng bốn ô lại thấy khác số to và tưởng app tính sai.
  const cuoiKyDuKien = isCurrentMonth && soQuy.cuoiKy !== soQuy.quyHomNay;

  return (
    <div className="rounded-xl border border-hairline p-4">
      <p className="text-sm text-muted-foreground">
        {isCurrentMonth ? "Quỹ còn lại" : "Quỹ cuối tháng"}
      </p>
      <p className="mt-1 font-serif text-3xl text-ink">
        {formatVnd(isCurrentMonth ? soQuy.quyHomNay : soQuy.cuoiKy)}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ONho nhan="Đầu kỳ" tien={soQuy.dauKy} />
        <ONho nhan="Thu" tien={soQuy.thu} />
        <ONho nhan="Chi" tien={soQuy.chi} dau="−" />
        <ONho
          nhan={cuoiKyDuKien ? "Cuối kỳ (dự kiến hết tháng)" : "Cuối kỳ"}
          tien={soQuy.cuoiKy}
          ghiChu={cuoiKyDuKien ? "đã tính khoản ghi ngày sau hôm nay" : undefined}
        />
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-hairline pt-2 text-xs text-muted-foreground">
        <p>
          tính từ {format(soQuy.d0, "dd/MM/yyyy")} — ngày nhập quỹ đầu tiên · gồm cả tiền mặt: muốn
          khớp app ngân hàng thì cộng thêm tiền mặt đang cầm
        </p>
        <p>
          Tháng nhận vay/góp vốn quỹ tăng nhưng Lãi/Lỗ không đổi; tháng trả gốc quỹ giảm mà Lãi/Lỗ
          chỉ giảm phần lãi — đúng bản chất.
        </p>
        {duNoThauChi > 0 && (
          <p>
            đang thấu chi {formatVnd(duNoThauChi)} — số dư app ngân hàng có thể âm; cộng số này vào
            số dư ngân hàng thì khớp quỹ
          </p>
        )}
        {tongTienGuiDangGiu > 0 && (
          <p>
            đang gửi tiết kiệm ngân hàng {formatVnd(tongTienGuiDangGiu)} (đã trừ vào quỹ, không phải
            mất) — nhận lại khi tất toán khoản vay
          </p>
        )}
        {dongTietKiem && <p>{dongTietKiem}</p>}
        {/* Hiệu ÂM = sàn trừ ví nhiều hơn ads đã ghi sổ (lượt đồng bộ ads còn thiếu, hoặc dòng chi
            phí bị xoá). In "trả thẻ ≈ −500.000 ₫" ở đây làm chủ shop kết luận app tính sai; phải nói
            thẳng là quỹ đang tính dư đúng phần chênh. */}
        {(soChiPhi !== 0 || sanTruVi !== 0) &&
          (sanTruVi > soChiPhi ? (
            <p>
              Ads TikTok: Sổ chi phí {formatVnd(soChiPhi)} · sàn trừ ví {formatVnd(sanTruVi)} — sàn
              trừ ví nhiều hơn ads đã ghi sổ; có thể lượt đồng bộ ads còn thiếu; quỹ đang tính dư{" "}
              {formatVnd(sanTruVi - soChiPhi)}
            </p>
          ) : (
            <p>
              Ads TikTok: Sổ chi phí {formatVnd(soChiPhi)} · sàn trừ ví {formatVnd(sanTruVi)} · trả
              thẻ ≈ {formatVnd(soChiPhi - sanTruVi)}
            </p>
          ))}
      </div>

      <SoQuyCanhBao soQuy={soQuy} soKhoanVayCoKyCho={soKhoanVayCoKyCho} />
    </div>
  );
}
