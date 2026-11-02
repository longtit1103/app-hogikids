"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  dangKyHost,
  dangKyNguoiNghe,
  traLoiXacNhan,
  yeuCauHienTai,
  type TuyChonXacNhan,
} from "@/lib/xac-nhan-hang-doi";

/**
 * Hộp xác nhận ĐIỀU KHIỂN BẰNG `open` — dùng khi nó nằm LỒNG trong một `Dialog` khác (form bấm đóng khi
 * còn dữ liệu chưa lưu). Phải render NGAY TRONG cây React của `DialogContent` cha: Base UI nhận ra
 * dialog con theo cây, nên bấm vào hộp này không bị cha coi là "bấm ra ngoài" và tự đóng.
 */
export function XacNhanHopThoai({
  open,
  onOpenChange,
  onDongY,
  noiDung,
  tieuDe = "Xác nhận",
  nhanDongY = "Đồng ý",
  nhanHuy = "Ở lại",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDongY: () => void;
} & TuyChonXacNhan) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="xac-nhan-hop-thoai">
        <AlertDialogHeader>
          <AlertDialogTitle>{tieuDe}</AlertDialogTitle>
          <AlertDialogDescription>{noiDung}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="xac-nhan-huy">{nhanHuy}</AlertDialogCancel>
          <AlertDialogAction data-testid="xac-nhan-dong-y" onClick={onDongY}>
            {nhanDongY}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Host của `xacNhan()` (`src/lib/xac-nhan-hang-doi.ts`) — gắn MỘT lần ở layout gốc. Vẽ yêu cầu đầu
 * hàng; đóng bằng bất kỳ cách nào ngoài nút "Đồng ý" (nút Huỷ, Esc) đều tính là `false`.
 */
export function XacNhanHost() {
  const yeuCau = useSyncExternalStore(dangKyNguoiNghe, yeuCauHienTai, () => null);
  useEffect(() => dangKyHost(), []);
  // Giữ nội dung của yêu cầu vừa đóng để hộp không nháy chữ rỗng trong lúc chạy hiệu ứng đóng.
  // State (không phải ref): ghi ref lúc render là tác dụng phụ trong render, sai dưới StrictMode/concurrent.
  // Cập nhật state NGAY trong render khi có yêu cầu mới là khuôn React chỉ định cho "giữ giá trị trước".
  const [ganNhat, setGanNhat] = useState<TuyChonXacNhan | null>(null);
  if (yeuCau !== null && yeuCau !== ganNhat) setGanNhat(yeuCau);
  const hienThi = yeuCau ?? ganNhat;

  return (
    <XacNhanHopThoai
      open={yeuCau !== null}
      // Đóng không qua nút Đồng ý (nút Huỷ, Esc) ⇒ huỷ. Nút Đồng ý trả lời `true` trước, rồi sự kiện
      // đóng mới đến — truyền `yeuCau` đang hiển thị để lần trả lời `false` muộn đó không đụng yêu cầu kế.
      onOpenChange={(mo) => {
        if (!mo) traLoiXacNhan(false, yeuCau);
      }}
      onDongY={() => traLoiXacNhan(true, yeuCau)}
      noiDung={hienThi?.noiDung ?? ""}
      tieuDe={hienThi?.tieuDe}
      nhanDongY={hienThi?.nhanDongY}
      nhanHuy={hienThi?.nhanHuy}
    />
  );
}
