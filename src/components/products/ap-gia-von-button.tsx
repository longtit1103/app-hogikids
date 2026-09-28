"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apGiaVonTheoPancake } from "@/lib/actions/dong-bo-gia-von-pancake";
import type { CheDoDoiChieu } from "@/lib/gia-von/doi-chieu-gia-von";

/**
 * Nút duyệt — bản bấm-trong-app của `--ghi` bên CLI.
 *
 * Có hộp xác nhận CỐ Ý, không bấm-một-phát-là-ghi: đây là chế độ ĐÈ được giá chủ shop tự nhập, và
 * nó làm lãi các tháng đã đóng tính lại. Bên CLI, chỗ dựa để nói "không phá bất biến #5" chính là
 * cú bấm `y` của con người — bỏ nó ở đây là mất luôn chỗ dựa đó.
 *
 * KHÔNG gửi danh sách dòng lên server: action tự đọc lại. Trang có thể mở từ sáng.
 */
export function ApGiaVonButton({
  cheDo,
  vanTay,
  soDong,
  soDongDeLen,
  soThangAnhHuong,
}: {
  cheDo: CheDoDoiChieu;
  /** Vân tay danh sách lúc trang render — lượt ghi từ chối nếu danh sách đã đổi. */
  vanTay: string;
  soDong: number;
  /** Số dòng app ĐANG CÓ số và sẽ bị đè — phần đáng cân nhắc nhất. */
  soDongDeLen: number;
  soThangAnhHuong: number;
}) {
  const router = useRouter();
  const [dangChay, setDangChay] = useState(false);
  const [mo, setMo] = useState(false);

  async function ap() {
    setDangChay(true);
    try {
      const kq = await apGiaVonTheoPancake(cheDo, vanTay);
      if (!kq.ok) {
        toast.error(kq.error);
        // Danh sách đã đổi ⇒ tải lại để chủ shop nhìn con số mới, đừng để họ bấm lại trên bảng cũ.
        if (kq.code === "DANH_SACH_DA_DOI") {
          setMo(false);
          router.refresh();
        }
        return;
      }
      setMo(false);
      const { daGhi, boQua } = kq.data;
      toast.success(
        boQua > 0
          ? `Đã áp ${daGhi} mã. ${boQua} mã bỏ qua vì giá vừa đổi — mở lại trang để xem phần còn lại.`
          : `Đã áp giá vốn cho ${daGhi} mã.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(`Không áp được: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDangChay(false);
    }
  }

  return (
    <Dialog open={mo} onOpenChange={setMo}>
      <DialogTrigger
        render={
          <Button className="self-start">
            Áp giá vốn Pancake cho {soDong.toLocaleString("vi-VN")} mã
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Xác nhận áp giá vốn</DialogTitle>
          <DialogDescription>
            Xem kỹ trước khi bấm — thao tác này ghi đè giá vốn.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
              <p>
                Sẽ ghi giá vốn Pancake cho <strong>{soDong.toLocaleString("vi-VN")}</strong> mã
                {soDongDeLen > 0 && (
                  <>
                    , trong đó <strong>{soDongDeLen.toLocaleString("vi-VN")}</strong> mã đang có số và
                    sẽ bị <strong>ghi đè</strong>
                  </>
                )}
                .
              </p>
              {soThangAnhHuong > 0 && (
                <p>
                  Lãi của <strong>{soThangAnhHuong}</strong> tháng đã qua sẽ được tính lại theo giá
                  mới — xem bảng phía trên trước khi bấm.
                </p>
              )}
              <p className="text-muted-foreground">
                Giá cũ được lưu lại tự động trước khi ghi, nên vẫn có đường lùi.
              </p>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Huỷ</Button>} />
          <Button onClick={ap} disabled={dangChay}>
            {dangChay ? "Đang ghi…" : "Áp giá vốn"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
