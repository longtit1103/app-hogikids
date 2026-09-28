"use client";

import { format } from "date-fns";

import type { AdsMoCoi, ChiPhiKhongDungLai, DonMoCoi } from "@/lib/actions/data-admin";
import type { TrangThaiSaoLuu } from "@/lib/backup/trang-thai-sao-luu";
import { BackupButton } from "./backup-button";
import { DeleteAllDialog } from "./delete-all-dialog";
import { RebuildFromRawButton } from "./rebuild-from-raw-button";
import { RestoreDialog } from "./restore-dialog";

/**
 * Dung lượng file dạng "21,89 MB" — chỉ dùng ở đây, không cần helper `formatVnd` (không phải tiền).
 * Chia 1024×1024 (MiB, đơn vị `ls -lh`/`du -h` trên minipc hay in) chứ không phải 1e6: bản dump
 * 22.958.125 byte hiện "21,89 MB", không phải "22,96 MB".
 */
function formatDungLuong(bytes: number | null): string | null {
  if (bytes === null) return null;
  return `${(bytes / (1024 * 1024)).toFixed(2).replace(".", ",")} MB`;
}

/**
 * Dòng trạng thái "Sao lưu" — 1 trong 4 mức từ `tinhTrangSaoLuu` (`lib/backup/trang-thai-sao-luu.ts`):
 * chưa từng backup / còn tươi (không cảnh báo) / quá hạn (không lượt mới nhưng lượt cuối không lỗi)
 * / lỗi (lượt gần nhất thất bại) — 2 mức sau đều là cảnh báo nhưng nói RÕ nguyên nhân khác nhau,
 * không gộp chung một câu mơ hồ.
 */
function TrangThaiSaoLuuText({ trangThai }: { trangThai: TrangThaiSaoLuu }) {
  if (trangThai.muc === "chua-co") {
    return <p className="text-sm text-warning">Chưa sao lưu lần nào</p>;
  }

  const moc = trangThai.finishedAt ? format(trangThai.finishedAt, "dd/MM/yyyy HH:mm") : null;

  if (trangThai.muc === "loi") {
    return (
      <p className="text-sm text-error">
        Bản sao lưu gần nhất lỗi{moc ? ` (lúc ${moc})` : ""}
        {trangThai.error ? `: ${trangThai.error}` : ""}
      </p>
    );
  }

  if (trangThai.muc === "qua-han") {
    const soGio = trangThai.gioTruoc !== null ? Math.floor(trangThai.gioTruoc) : null;
    return (
      <p className="text-sm text-warning">
        Đã {soGio ?? "?"} giờ chưa có bản sao lưu mới{moc ? ` (gần nhất: ${moc})` : ""} — kiểm cron
        backup đêm trên host.
      </p>
    );
  }

  const dungLuong = formatDungLuong(trangThai.fileSizeBytes);
  return (
    <p className="text-sm text-muted-foreground">
      Sao lưu gần nhất: {moc}
      {dungLuong ? ` (${dungLuong})` : ""}
    </p>
  );
}

/**
 * Cài đặt › Dữ liệu (Section 6). Bốn khối theo thứ tự:
 *  1. Sao lưu — dòng trạng thái (`TrangThaiSaoLuuText`) + nút "Sao lưu ngay" + caption backup đêm.
 *  2. Phục hồi từ file — nạp lại nguyên trạng từ một bản backup.
 *  3. Dựng lại từ kho thô — đường phục hồi sau khi xóa dữ liệu giao dịch (đơn + Tiền đã về; KHÔNG
 *     dựng lại sản phẩm/tồn kho).
 *  4. Xóa dữ liệu giao dịch — vùng nguy hiểm, dialog confirm 2 bước.
 *
 * Đặt "Dựng lại" NGAY TRƯỚC "Xóa" để chủ shop thấy đường quay lại trước khi thấy nút xóa.
 *
 * `trangThaiSaoLuu` tính từ SyncLog kind BACKUP mới nhất — MỘT nguồn sự thật duy nhất cho CẢ nút
 * "Sao lưu ngay" lẫn cron đêm (không còn `Setting.lastBackupAt` — 2 nguồn trôi nhau từng khiến
 * cron chạy OK 21 lần liền mà màn hình vẫn báo "Chưa sao lưu lần nào", đo prod 01/08).
 */
export function DataSection({
  trangThaiSaoLuu,
  hasData,
  shopName,
  donMoCoi,
  chiPhi,
  adsMoCoi,
}: {
  trangThaiSaoLuu: TrangThaiSaoLuu;
  hasData: boolean;
  shopName: string;
  donMoCoi: DonMoCoi;
  chiPhi: ChiPhiKhongDungLai;
  adsMoCoi: AdsMoCoi;
}) {
  return (
    <div className="flex flex-col gap-6">
      {/* 1. Sao lưu */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-ink">Sao lưu</h3>
        <TrangThaiSaoLuuText trangThai={trangThaiSaoLuu} />
        <div>
          <BackupButton />
        </div>
        <p className="text-xs text-muted-foreground">
          Backup tự động mỗi đêm qua host cron <code>full-backup.sh</code> (4am): bản{" "}
          <code>hogikids-*.dump</code> (<code>pg_dump -Fc</code>, schema <code>app</code> của DB{" "}
          <code>postgres</code>) → <code>cloud:backups/</code> giữ 30 bản — tách khỏi
          tarball toàn-server 7 ngày ở <code>cloud:full-backups</code>.
        </p>
      </div>

      {/* 2. Phục hồi từ file */}
      <div className="flex flex-col gap-3 border-t border-hairline pt-6">
        <h3 className="text-sm font-medium text-ink">Phục hồi từ file</h3>
        <p className="text-sm text-muted-foreground">
          Thay sạch toàn bộ dữ liệu hiện tại bằng nội dung một bản backup — kể cả tài khoản đăng
          nhập và cài đặt. DB hiện tại được tự sao lưu (bản lùi) trước khi phục hồi.
        </p>
        <div>
          <RestoreDialog shopName={shopName} />
        </div>
        <p className="text-xs text-muted-foreground">
          Nhận bản <code>hogikids-*.dump</code> (nút Sao lưu ngay, hoặc tải từ{" "}
          <code>cloud:backups/</code>). KHÔNG nhận <code>.tar.gz</code>{" "}
          backup-toàn-server. File &gt;~100MB hoặc minipc hỏng/DB trống → dùng{" "}
          <code>deploy/restore.sh</code> (Tailscale/CLI, không qua trang public), xem hướng dẫn
          deploy.
        </p>
      </div>

      {/* 3. Dựng lại từ kho thô */}
      <div className="flex flex-col gap-3 border-t border-hairline pt-6">
        <h3 className="text-sm font-medium text-ink">Dựng lại từ kho thô</h3>
        <p className="text-sm text-muted-foreground">
          Đọc lại kho thô (bản gốc Pancake, sao kê TikTok Shop, file ví Shopee đã import và báo cáo
          quảng cáo Meta / TikTok) để dựng lại đơn hàng, số liệu Tiền đã về và chi tiêu quảng cáo.
          Dùng khi số liệu thiếu, hoặc sau khi xóa dữ liệu giao dịch. Chỉ ghi thêm/ghi đè, không xóa
          gì — bấm lại nhiều lần vẫn an toàn.
        </p>
        <div>
          <RebuildFromRawButton />
        </div>
        <p className="text-xs text-muted-foreground">
          Không dựng lại sản phẩm và tồn kho (tồn kho do đồng bộ và webhook Pancake giữ cho khớp),
          cũng không dựng lại chi phí nhập tay. Nếu app đang được đặt ở chế độ chỉ lưu kho thô thì
          đây chính là bước dựng lại tay bắt buộc sau khi tắt chế độ đó.
        </p>
      </div>

      {/* 4. Xóa dữ liệu giao dịch */}
      <div className="flex flex-col gap-3 border-t border-hairline pt-6">
        <h3 className="text-sm font-medium text-error">Xóa dữ liệu giao dịch</h3>
        <p className="text-sm text-muted-foreground">
          Xóa vĩnh viễn toàn bộ đơn hàng, chi phí, số liệu Tiền đã về và log đồng bộ (giữ lại nhật
          ký sao lưu). Giữ nguyên kho thô, sản phẩm / tồn kho và giá vốn nhập tay, tài khoản, cấu
          hình kênh, danh mục và cài đặt. Không hoàn tác được. Chi phí nhập tay không dựng lại được từ kho thô — sao lưu
          trước khi xóa.
        </p>
        <div>
          <DeleteAllDialog
            hasData={hasData}
            shopName={shopName}
            donMoCoi={donMoCoi}
            chiPhi={chiPhi}
            adsMoCoi={adsMoCoi}
          />
        </div>
      </div>
    </div>
  );
}
