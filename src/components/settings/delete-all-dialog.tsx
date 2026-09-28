"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  deleteAllData,
  type AdsMoCoi,
  type ChiPhiKhongDungLai,
  type DonMoCoi,
} from "@/lib/actions/data-admin";
import { formatVnd } from "@/lib/format";
import { BackupButton } from "./backup-button";

/**
 * Câu định lượng khoản NHẬP TAY sắp mất. Chỉ nêu vế thực sự có phát sinh: shop chưa nhập chi phí nào
 * mà câu vẫn mở bằng "Đang có 0 khoản chi phí nhập tay (0 ₫)" thì đọc như lỗi số liệu. Nối các vế bằng
 * ", " và " và " trước vế cuối. Hàm THUẦN để test được bằng chuỗi chính xác.
 */
export function moTaKhoanMatTrang(chiPhi: ChiPhiKhongDungLai): string {
  const ve = [
    chiPhi.soChiPhi > 0 && `${chiPhi.soChiPhi} khoản chi phí nhập tay (${formatVnd(chiPhi.tongChiPhi)})`,
    chiPhi.soDinhKy > 0 && `${chiPhi.soDinhKy} chi phí định kỳ`,
    chiPhi.soKhoanTienKhac > 0 &&
      `${chiPhi.soKhoanTienKhac} khoản tiền khác ghi tay (${formatVnd(chiPhi.tongKhoanTienKhac)})`,
    chiPhi.soKhoanVay > 0 && `${chiPhi.soKhoanVay} khoản vay (hồ sơ + dư nợ)`,
    chiPhi.soSoTietKiem > 0 &&
      `${chiPhi.soSoTietKiem} sổ tiết kiệm (hồ sơ + ${formatVnd(chiPhi.tongThuNhap)} lãi đã ghi)`,
  ].filter((v): v is string => typeof v === "string");

  if (ve.length === 0) return "Hiện chưa có khoản chi phí hay khoản tiền khác nhập tay nào.";
  const cuoi = ve[ve.length - 1];
  const dau = ve.slice(0, -1);
  return `Đang có ${dau.length > 0 ? `${dau.join(", ")} và ${cuoi}` : cuoi}.`;
}

/**
 * "Xóa dữ liệu giao dịch" — confirm 2 bước.
 *
 * - App rỗng (`hasData=false`): chỉ hiện "Không có dữ liệu để xóa" + "Đóng".
 * - Bước 1: liệt kê hậu quả + gợi ý sao lưu (nút phụ "Sao lưu ngay") + "Tiếp tục".
 *   Hai cảnh báo đỏ nằm NGAY dưới danh sách xoá và TRƯỚC câu hướng dẫn dựng
 *   lại, vì chúng là phần dựng lại KHÔNG lấy lại được:
 *     · chi phí NHẬP TAY, khoản tiền khác ghi tay (`CashMovement`) và hồ sơ
 *       khoản vay (`Loan`) — LUÔN hiện
 *       (không có bản gốc nào trong kho thô để dựng lại), kèm số dòng và số tiền
 *       để thấy độ lớn. Chi tiêu quảng cáo KHÔNG còn nằm ở đây: kho thô giữ bản
 *       gốc báo cáo Meta/TikTok nên dựng lại được;
 *     · đơn mồ côi (`donMoCoi.soDon > 0`) — đơn cũ hơn cửa sổ kho thô;
 *     · chi tiêu quảng cáo mồ côi (`adsMoCoi.soDong > 0`) — dòng chi phí mà kho thô
 *       không có bản gốc báo cáo (đêm nào land Bronze hỏng riêng). Đo THẬT chứ
 *       không suy đoán, vì dialog đang khẳng định ads dựng lại được.
 * - Bước 2: gõ đúng tên shop hiện tại (case-sensitive) → "Xóa vĩnh viễn" (nền
 *   error) chỉ enabled khi khớp.
 * - Esc / click ngoài (base-ui Dialog) = hủy; đóng reset về bước 1 + xoá ô nhập.
 * - Thành công → `router.push("/")` + toast.
 */
export function DeleteAllDialog({
  hasData,
  shopName,
  donMoCoi,
  chiPhi,
  adsMoCoi,
}: {
  hasData: boolean;
  shopName: string;
  donMoCoi: DonMoCoi;
  chiPhi: ChiPhiKhongDungLai;
  adsMoCoi: AdsMoCoi;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setStep(1);
      setConfirmText("");
    }
  }

  const matches = confirmText === shopName;

  // Định lượng khoản chi phí NHẬP TAY sắp mất (chi tiêu quảng cáo không tính — dựng lại được từ kho
  // thô). Cảnh báo bên dưới là CỐ ĐỊNH (không phụ thuộc số này) vì chi phí nhập tay không bao giờ
  // dựng lại được, nhưng câu chữ phải đọc trơn cả khi shop chưa nhập gì.
  const moTaChiPhi = moTaKhoanMatTrang(chiPhi);

  async function handleDelete() {
    if (!matches) return;
    setDeleting(true);
    try {
      const res = await deleteAllData(confirmText);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã xóa dữ liệu giao dịch");
      setOpen(false);
      router.push("/");
    } catch {
      toast.error("Xóa thất bại — kiểm tra kết nối");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Button type="button" variant="destructive" className="w-full sm:w-auto" onClick={() => handleOpenChange(true)}>
        Xóa dữ liệu giao dịch
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
          {!hasData ? (
            <>
              <DialogHeader>
                <DialogTitle>Xóa dữ liệu giao dịch</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">Không có dữ liệu để xóa.</p>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Đóng
                </Button>
              </DialogFooter>
            </>
          ) : step === 1 ? (
            <>
              <DialogHeader>
                <DialogTitle>Xóa dữ liệu giao dịch</DialogTitle>
                <DialogDescription>Hành động xóa vĩnh viễn, không hoàn tác được.</DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3 text-sm text-ink">
                <p>Sẽ bị xóa vĩnh viễn:</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  <li>Toàn bộ đơn hàng và dòng hàng trong đơn</li>
                  <li>Toàn bộ chi phí (thường và định kỳ)</li>
                  <li>Toàn bộ khoản tiền khác ghi tay (vay/góp/rút vốn, trả nợ gốc, bán trực tiếp, thu khác)</li>
                  <li>Toàn bộ hồ sơ khoản vay (lãi suất, kỳ hạn, dư nợ, lịch trả nợ đã duyệt)</li>
                  <li>
                    Toàn bộ sổ tiết kiệm sinh lãi (hồ sơ + lãi đã ghi vào{" "}
                    <strong className="text-ink">Thu nhập tài chính</strong> của bảng Lãi/Lỗ)
                  </li>
                  <li>
                    Toàn bộ số liệu <strong className="text-ink">Tiền đã về</strong> (TikTok và
                    Shopee)
                  </li>
                  <li>Toàn bộ log đồng bộ (GIỮ lại nhật ký sao lưu)</li>
                </ul>
                <p className="text-error">
                  Chi phí và khoản tiền khác nhập tay KHÔNG dựng lại được từ kho thô — chỉ phục hồi
                  bản sao lưu mới cứu. {moTaChiPhi}
                </p>
                {donMoCoi.soDon > 0 && (
                  <p className="text-error">
                    {donMoCoi.soDon} đơn (giá trị hàng {formatVnd(donMoCoi.tongTien)}) không có bản
                    gốc trong kho thô — dựng lại KHÔNG lấy lại được, chỉ phục hồi bản sao lưu mới
                    cứu.
                  </p>
                )}
                {adsMoCoi.soDong > 0 && (
                  <p className="text-error">
                    {adsMoCoi.soDong} khoản chi tiêu quảng cáo ({formatVnd(adsMoCoi.tongTien)}) không
                    có bản gốc báo cáo trong kho thô — phần này dựng lại KHÔNG lấy lại được, chỉ phục
                    hồi bản sao lưu mới cứu.
                  </p>
                )}
                <p className="text-muted-foreground">
                  Giữ nguyên kho thô (bản gốc Pancake, sao kê TikTok Shop và file ví Shopee đã
                  import), sản phẩm / tồn kho và{" "}
                  <strong className="text-ink">giá vốn nhập tay</strong>, cùng tài khoản đăng nhập,
                  cấu hình kênh, danh mục chi phí, cài đặt và mốc sao lưu gần nhất.
                </p>
                <p className="text-muted-foreground">
                  Muốn lấy lại đơn và số liệu Tiền đã về: bấm{" "}
                  <strong className="text-ink">&quot;Dựng lại từ kho thô&quot;</strong> ở khu Dữ
                  liệu trong Cài đặt. Lượt đó cũng chỉ dựng lại được phần kho thô còn giữ, và chỉ
                  phát hiện được đơn kẹt do luật lọc thay đổi khi thực sự chạy.
                </p>
                <p className="text-warning">Nên bấm &quot;Sao lưu ngay&quot; trước khi xóa.</p>
              </div>

              <DialogFooter className="sm:justify-between">
                <BackupButton variant="outline" />
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                    Hủy
                  </Button>
                  <Button type="button" onClick={() => setStep(2)}>
                    Tiếp tục
                  </Button>
                </div>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Xác nhận xóa</DialogTitle>
                <DialogDescription>
                  Gõ đúng tên shop{" "}
                  <strong className="text-ink">{shopName}</strong> để xác nhận xóa vĩnh viễn.
                </DialogDescription>
              </DialogHeader>

              <Input
                autoFocus
                value={confirmText}
                placeholder={shopName}
                aria-label="Tên shop xác nhận"
                onChange={(e) => setConfirmText(e.target.value)}
              />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setStep(1)}>
                  Quay lại
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!matches || deleting}
                  onClick={handleDelete}
                >
                  {deleting ? "Đang xóa…" : "Xóa vĩnh viễn"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
