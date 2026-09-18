"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { differenceInCalendarDays, format } from "date-fns";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ghiKyTraNo } from "@/lib/actions/khoan-vay";
import { formatVnd } from "@/lib/format";
import type { DeXuatKy } from "@/lib/so-quy/lich-tra-no";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import { gocDeXuatKep, tienGuiSeNhanLai } from "@/lib/so-quy/tien-ky-tra-no";

import { KyTraNoInputs } from "./ky-tra-no-inputs";

/**
 * Thẻ "Kỳ trả nợ chờ duyệt" (spec §5.3). Lãi/gốc chỉ là ĐỀ XUẤT — chủ shop sửa được trước khi bấm,
 * vì ngân hàng thu tổng cố định mỗi tháng chứ không theo công thức của app.
 *
 * Cả hai nút đều có hộp xác nhận: một cú bấm ở đây ghi tiền vào Sổ chi phí + dòng trả gốc, còn nút
 * "không thu kỳ này" thì đóng dấu kỳ VĨNH VIỄN (con dấu `lastDueHandled` không lùi).
 *
 * Hai ô Lãi/Gốc là state khởi tạo từ đề xuất, nên thẻ PHẢI remount khi đổi sang kỳ khác — key của
 * thẻ ở `khoan-vay-section.tsx` gồm cả ngày đến hạn, đừng rút gọn về `loan.id`: duyệt xong kỳ 1 là
 * kỳ 2 hiện ra ngay, giữ nguyên state cũ thì chủ shop bấm tiếp và ghi đúng số tiền của kỳ TRƯỚC.
 *
 * `format()` chạy ở client tức theo múi giờ TRÌNH DUYỆT — giả định máy chủ shop ở VN (bất biến #3).
 * Máy lệch múi giờ chỉ làm ngày HIỂN THỊ lệch: `ghiKyTraNo` tính lại kỳ từ server và từ chối nếu
 * `dueDate` không khớp ("Kỳ không hợp lệ — tải lại trang"), tức fail-closed chứ không ghi sai tiền.
 */

const NGAY_COI_LA_TRE = 7;

export function KyTraNoCard({ loan }: { loan: KhoanVayRow & { kyCho: DeXuatKy } }) {
  const router = useRouter();
  const ky = loan.kyCho;
  const [lai, setLai] = useState(ky.lai);
  // KẸP về dư nợ HIỆN TẠI: `deXuatKy` tính gốc từ dư nợ ĐẦU kỳ, nên một lượt trả bớt gốc bằng tay
  // giữa kỳ (dòng nằm sau mốc đầu kỳ) làm ô này hiện số lớn hơn số thật còn nợ — trong khi dòng tổng
  // và hộp xác nhận ngay bên dưới đọc `loan.duNo`. Xem `gocDeXuatKep`.
  const [goc, setGoc] = useState(() => gocDeXuatKep({ gocDeXuat: ky.goc, duNoHienTai: loan.duNo }));
  const [tienGui, setTienGui] = useState(ky.tienGui);
  const [dangGhi, setDangGhi] = useState(false);
  const [moGhi, setMoGhi] = useState(false);
  const [moBoQua, setMoBoQua] = useState(false);

  const thauChi = loan.kind === "OVERDRAFT";
  const nhanKy = thauChi ? "kỳ lãi" : "kỳ";
  const tre = differenceInCalendarDays(new Date(), ky.denNgay) > NGAY_COI_LA_TRE;
  // Trừ trên dư nợ HIỆN TẠI, không phải dư nợ đầu kỳ: giữa kỳ có thể đã trả bớt gốc bằng tay, lúc
  // đó hai số lệch nhau và hộp xác nhận sẽ hứa một con số dư nợ không bao giờ xảy ra.
  const duNoSau = loan.duNo - goc;
  // Kỳ CUỐI của khoản có sổ tiết kiệm: sau khi ghi kỳ này, Σ tiền gửi đang giữ sẽ là số dưới đây —
  // nói trước để chủ shop biết bấm Tất toán ngay sau đó là nhận lại đúng số nào. Cùng con số này là
  // phần ngân hàng CẤN vào số phải nộp kỳ cuối, nên nó đi thẳng xuống dòng tổng ở `KyTraNoInputs`.
  const hoanTienGui = tienGuiSeNhanLai({
    termMonths: loan.termMonths,
    tienGuiDangGiu: loan.tienGuiDangGiu,
    kyThuMay: ky.ky,
    tienGuiKyNay: tienGui,
  });
  // Ô "Tiền gửi" chỉ có nghĩa với khoản trả gốc cuối kỳ — server từ chối THẲNG mọi `tienGui > 0` ở
  // loại khác (`superRefine` trong khoan-vay.ts), không có ngoại lệ nào cho khoản "lỡ đang giữ" một
  // số > 0. Hiện ô cho khoản TERM/OVERDRAFT chỉ tạo ngõ cụt fail-closed: chủ shop gõ vào là
  // `chayGhiKy` ném lỗi và rollback trọn kỳ (lãi cũng không vào Sổ chi phí), không có đường ghi lại
  // ngoài tự đoán phải xoá số trong ô. Số "đang giữ" của khoản lạc như vậy vẫn hiện ở bảng Khoản vay
  // (`khoan-vay-table.tsx`) nên không mất dấu, chỉ không có ô nhập ở đây nữa.
  const coTienGui = loan.kind === "BULLET";

  async function ghi(boQua: boolean) {
    setDangGhi(true);
    try {
      const res = await ghiKyTraNo({
        loanId: loan.id,
        dueDate: format(ky.denNgay, "yyyy-MM-dd"),
        lai: boQua ? 0 : lai,
        goc: boQua ? 0 : goc,
        tienGui: boQua ? 0 : tienGui,
        boQua,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setMoGhi(false);
      setMoBoQua(false);
      const veTienGui = !boQua && tienGui > 0 ? ` + tiền gửi ${formatVnd(tienGui)}` : "";
      toast.success(
        boQua
          ? `Đã đánh dấu kỳ ${format(ky.denNgay, "dd/MM/yyyy")} không thu`
          : `Đã ghi lãi ${formatVnd(lai)} + gốc ${formatVnd(goc)}${veTienGui} — dư nợ còn ${formatVnd(res.data.duNoConLai)}`
      );
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangGhi(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border-l-4 border-warning bg-surface-card p-4">
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
        <span>
          {loan.name} — {nhanKy} {format(ky.tuNgay, "dd/MM")} → {format(ky.denNgay, "dd/MM")} (
          {ky.soNgay} ngày) · dư nợ đầu kỳ {formatVnd(ky.duNoDauKy)}
        </span>
        {tre && <Badge variant="outline">trễ</Badge>}
      </p>

      <KyTraNoInputs
        lai={lai}
        setLai={setLai}
        goc={goc}
        setGoc={setGoc}
        tienGui={tienGui}
        setTienGui={setTienGui}
        thauChi={thauChi}
        coTienGui={coTienGui}
        tienGuiSeNhanLai={hoanTienGui}
      />

      <p className="mt-2 text-xs text-muted-foreground">
        Lãi, gốc và tiền gửi được ghi theo ngày đến hạn {format(ky.denNgay, "dd/MM/yyyy")} — duyệt trễ
        thì số của tháng đó cập nhật lại.
      </p>
      {/* Kỳ cuối của khoản có sổ tiết kiệm: server ĐÒI dư nợ về 0 mới cho tất toán (chanDuNoAm), mà
          tiền gửi không cấn vào Gốc trong sổ — nó về bằng một dòng DEPOSIT_IN RIÊNG lúc bấm Tất
          toán. Nói sai câu này (như bản cũ "cấn trừ") ⇒ chủ shop gõ Gốc thiếu đúng phần tiền gửi,
          dư nợ còn treo, con dấu kỳ cuối đã đóng nên KẸT CỨNG không ghi lại được.

          `loan.duNo` chứ KHÔNG phải `ky.duNoDauKy` — cùng lý do với `duNoSau` ở trên: giữa kỳ có
          thể đã trả bớt gốc bằng tay, lúc đó dư nợ đầu kỳ LỚN HƠN dư nợ thật và câu này bảo chủ
          shop gõ trả thừa. Số "phải chuyển bao nhiêu" nay CHỈ in ở dòng tổng của `KyTraNoInputs`. */}
      {hoanTienGui > 0 && (
        <p className="mt-1 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-ink">
          Kỳ cuối — gõ <strong>Gốc = toàn bộ dư nợ {formatVnd(loan.duNo)}</strong>, kể cả phần ngân
          hàng cấn bằng sổ tiết kiệm. Ghi xong bấm <strong>Tất toán</strong> để app ghi nhận lại{" "}
          {formatVnd(hoanTienGui)} sổ tiết kiệm.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Dialog open={moGhi} onOpenChange={setMoGhi}>
          <DialogTrigger render={<Button type="button">Đã chuyển tiền — ghi vào sổ</Button>} />
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Xác nhận ghi kỳ trả nợ</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-ink">
              Ghi lãi {formatVnd(lai)} vào Sổ chi phí và trả gốc {formatVnd(goc)}
              {tienGui > 0 && <> + gửi tiết kiệm {formatVnd(tienGui)}</>} — dư nợ còn{" "}
              {formatVnd(duNoSau)}. Chỉ bấm khi đã chuyển tiền cho ngân hàng.
            </p>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Huỷ</Button>} />
              <Button type="button" disabled={dangGhi} onClick={() => ghi(false)}>
                {dangGhi ? "Đang ghi…" : "Ghi vào sổ"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={moBoQua} onOpenChange={setMoBoQua}>
          <DialogTrigger
            render={
              <Button type="button" variant="outline">
                Ngân hàng không thu kỳ này
              </Button>
            }
          />
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Bỏ qua kỳ này</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-ink">
              Kỳ này sẽ KHÔNG ghi lãi/gốc và KHÔNG mở lại được — muốn ghi sau thì nhập tay ở Sổ chi
              phí / Nhập quỹ.
            </p>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Huỷ</Button>} />
              <Button type="button" disabled={dangGhi} onClick={() => ghi(true)}>
                {dangGhi ? "Đang ghi…" : "Bỏ qua kỳ"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Câu này phải ở NGAY DƯỚI nút (design §5.5), không chỉ nằm trong hộp xác nhận: app không
          chuyển tiền hộ, bấm nút chỉ là GHI LẠI việc chủ shop đã chuyển. */}
      <p className="mt-2 text-xs text-muted-foreground">Chỉ bấm khi đã chuyển tiền cho ngân hàng.</p>
    </div>
  );
}
