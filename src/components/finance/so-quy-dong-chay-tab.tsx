import Link from "next/link";
import { format } from "date-fns";

import { formatVnd } from "@/lib/format";
import { nhanCuoiKySoQuy } from "@/lib/so-quy/cong-thuc-so-quy";
import type { DuBaoQuy } from "@/lib/so-quy/du-bao-quy-types";
import type { SoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-types";
import { cn } from "@/lib/utils";

import { SoQuyBieuDoDuBao } from "./so-quy-bieu-do-du-bao";
import { SoQuyCanhBao } from "./so-quy-canh-bao";
import { SoQuyDongChayTable } from "./so-quy-dong-chay-table";
import { SoQuyXuatExcelButton } from "./so-quy-xuat-excel-button";
import { SoQuyDuBaoCanhBao } from "./so-quy-du-bao-canh-bao";
import { SoQuyQuyToiThieuForm } from "./so-quy-quy-toi-thieu-form";

/**
 * Tab "Sổ quỹ" của hub Tài chính — CHI TIẾT từng dòng của đúng con số thẻ "Quỹ còn lại" (tab Dòng
 * tiền). Ba trạng thái tách bạch theo hợp đồng `SoQuyDongChay` (`dong-chay-so-quy-types.ts`): chưa mở
 * sổ · kỳ nằm trọn trước ngày mở sổ · có sổ. Server component thuần hiển thị — không tự tính lại số
 * nào, `lechDoiChieu` hiện đỏ chứ không tự nắn.
 */

/** Hộp số nhỏ cho hàng tóm tắt — cùng khuôn `ONho` của `so-quy-card.tsx`, khai riêng ở đây vì file đó
 * không export helper để dùng chung (thêm `testId` mà `ONho` không cần). */
function OSo({
  nhan,
  tien,
  tone,
  dau,
  testId,
}: {
  nhan: string;
  tien: number;
  tone?: "success" | "error";
  dau?: "−";
  testId?: string;
}) {
  return (
    <div className="rounded-xl bg-surface-card p-3">
      <p className="text-xs text-muted-foreground">{nhan}</p>
      <p
        className={cn(
          "mt-1 font-serif text-xl",
          tone === "success" && "text-success",
          tone === "error" && "text-error",
          !tone && "text-ink"
        )}
        data-testid={testId}
      >
        {dau ? `${dau} ` : ""}
        {formatVnd(tien)}
      </p>
    </div>
  );
}

export function SoQuyDongChayTab({
  dongChay,
  /** Dự báo quỹ 30 ngày + lịch sử 90 ngày (`docDuBaoQuy`) — ĐỘC LẬP kỳ đang xem của `dongChay` (luôn
   * neo "hôm nay", không đổi theo tháng chọn). `CHUA_MO_SO` ⇒ khối không hiện. `null` = `docDuBaoQuy()`
   * NÉM LỖI ở lượt đọc này (page.tsx đã `.catch` để không sập cả tab) — hiện hộp nhẹ mời tải lại,
   * KHÔNG kéo sổ tháng bên dưới theo (hai hợp đồng độc lập). */
  duBaoQuy,
  /** Href sang tab Dòng tiền GIỮ range đang xem — page.tsx tính sẵn qua `tabHref("dong-tien")`. */
  hrefDongTien,
  /** Kỳ đang xem có phải tháng hiện tại — quyết định nhãn "Cuối kỳ (dự kiến hết tháng)" và có hiện ô
   * "Quỹ tới hôm nay" hay không, cùng luật với thẻ Quỹ (`so-quy-card.tsx`). */
  isCurrentMonth,
  /** Số khoản vay còn hiệu lực đang có kỳ trả nợ chờ duyệt — page tính từ `listKhoanVay()` qua
   * `demKhoanVayCoKyCho()`, cùng phép đếm với thẻ Quỹ ở tab Dòng tiền. */
  soKhoanVayCoKyCho,
}: {
  dongChay: SoQuyDongChay;
  duBaoQuy: DuBaoQuy | null;
  hrefDongTien: string;
  isCurrentMonth: boolean;
  soKhoanVayCoKyCho: number;
}) {
  // Khối MỚI ở đầu tab: biểu đồ 90+30 ngày + cảnh báo sắp cạn + ô ngưỡng. Đặt TRƯỚC nhánh trạng thái
  // của `dongChay` vì hai hợp đồng độc lập — có thể đang xem một tháng TRUOC_MO_SO trong khi sổ đã mở
  // (dự báo CO_SO) ở hiện tại.
  const khoiDuBao =
    duBaoQuy === null ? (
      <div className="rounded-xl border border-hairline p-4 text-sm text-muted-foreground" data-testid="so-quy-du-bao-loi">
        Không dựng được dự báo quỹ — tải lại trang; nếu vẫn lỗi báo lại để kiểm.
      </div>
    ) : duBaoQuy.trangThai === "CO_SO" ? (
      <div className="flex flex-col gap-4 rounded-xl border border-hairline p-4" data-testid="so-quy-du-bao">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-serif text-lg text-ink">Dự báo quỹ 30 ngày</h3>
          <SoQuyQuyToiThieuForm nguong={duBaoQuy.nguong} nguongDaDat={duBaoQuy.nguongDaDat} />
        </div>
        <SoQuyDuBaoCanhBao
          homNay={duBaoQuy.homNay}
          quyHomNay={duBaoQuy.quyHomNay}
          nguong={duBaoQuy.nguong}
          nguongDaDat={duBaoQuy.nguongDaDat}
          cham={duBaoQuy.cham}
          thapNhat={duBaoQuy.thapNhat}
        />
        <SoQuyBieuDoDuBao
          lichSu={duBaoQuy.lichSu}
          duBao={duBaoQuy.duBao}
          nguong={duBaoQuy.nguong}
          nguongDaDat={duBaoQuy.nguongDaDat}
        />
      </div>
    ) : null;

  if (dongChay.trangThai === "CHUA_MO_SO") {
    return (
      <div className="flex flex-col gap-4">
        {khoiDuBao}
        <div className="rounded-xl border border-hairline p-4">
          <p className="text-sm text-muted-foreground">Sổ quỹ</p>
          <p className="mt-2 text-sm text-ink">
            Chưa mở sổ quỹ. Sang tab{" "}
            <Link href={hrefDongTien} className="underline underline-offset-2">
              Dòng tiền
            </Link>{" "}
            ghi dòng tiền đầu tiên (góp vốn hoặc khoản vay) — sổ quỹ sẽ tính từ ngày đó.
          </p>
        </div>
      </div>
    );
  }

  if (dongChay.trangThai === "TRUOC_MO_SO") {
    return (
      <div className="flex flex-col gap-4">
        {khoiDuBao}
        <div className="rounded-xl border border-hairline p-4">
          <p className="text-sm text-muted-foreground">Sổ quỹ</p>
          <p className="mt-2 text-sm text-ink">
            Tháng này trước ngày mở sổ ({format(dongChay.d0, "dd/MM/yyyy")}) — chưa có sổ.
          </p>
        </div>
      </div>
    );
  }

  const { dauKy, cuoiKy, tongThu, tongChi, dong, lechDoiChieu, the } = dongChay;
  // Cùng một luật nhãn với thẻ "Quỹ còn lại" (`nhanCuoiKySoQuy`) — không tự viết lại điều kiện.
  const { duKien: cuoiKyDuKien, nhan: nhanCuoiKy, ghiChu: ghiChuCuoiKy } = nhanCuoiKySoQuy(the, isCurrentMonth);

  return (
    <div className="flex flex-col gap-4">
      {khoiDuBao}
      {lechDoiChieu && (
        <div
          className="rounded-lg border border-error/40 bg-error/5 p-3 text-sm text-error"
          data-testid="so-quy-dong-chay-lech"
        >
          Dòng chạy lệch thẻ Quỹ: cuối kỳ theo thẻ {formatVnd(lechDoiChieu.cuoiKyThe)}, cộng từ các
          dòng {formatVnd(lechDoiChieu.cuoiKyTuDong)}. Thẻ và các dòng đọc ở hai lượt riêng nên một
          khoản vừa ghi xen giữa có thể làm lệch THOÁNG QUA — tải lại trang; nếu vẫn lệch thì báo lại
          để kiểm.
        </div>
      )}

      {/* Đúng khối cảnh báo của thẻ Quỹ (tab Dòng tiền) — bỏ rơi ở đây thì sổ quỹ trông đầy đủ trong
          khi thẻ đang kêu quỹ thiếu một khoản (vd lệnh TikTok thiếu ngày, ví Shopee chưa nhập kịp). */}
      <SoQuyCanhBao
        soQuy={the}
        soKhoanVayCoKyCho={soKhoanVayCoKyCho}
        // Khối Khoản vay nằm ở tab Dòng tiền — neo `#khoan-vay` trần ở tab này là ngõ cụt.
        hrefKhoanVay={`${hrefDongTien}#khoan-vay`}
      />

      {/* Xuất đúng bảng đang xem (tháng này, dòng chạy + Đầu/Cuối kỳ). Khoá kỳ lấy ở SERVER (giờ VN). */}
      <div className="flex justify-end">
        <SoQuyXuatExcelButton
          dongChay={dongChay}
          ky={format(dongChay.den, "yyyy-MM")}
          laThangHienTai={isCurrentMonth}
        />
      </div>

      <div className={cn("grid grid-cols-2 gap-3", cuoiKyDuKien ? "sm:grid-cols-5" : "sm:grid-cols-4")}>
        <OSo nhan="Đầu kỳ" tien={dauKy} />
        <OSo nhan="Tổng thu" tien={tongThu} tone="success" />
        <OSo nhan="Tổng chi" tien={tongChi} tone="error" dau="−" />
        {cuoiKyDuKien && <OSo nhan="Quỹ tới hôm nay" tien={the.quyHomNay} />}
        <OSo nhan={nhanCuoiKy} tien={cuoiKy} testId="so-quy-dong-chay-cuoi-ky" />
      </div>

      <SoQuyDongChayTable
        dong={dong}
        dauKy={dauKy}
        cuoiKy={cuoiKy}
        nhanCuoiKy={nhanCuoiKy}
        ghiChuCuoiKy={ghiChuCuoiKy}
      />

      <p className="text-xs text-muted-foreground">
        Tổng thu/chi có thể khác thẻ Quỹ ở tab Dòng tiền vì thẻ bù trừ theo TỪNG NGUỒN, còn ở đây tách
        theo từng dòng — cuối kỳ thì LUÔN khớp thẻ.
      </p>
    </div>
  );
}
