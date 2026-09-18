"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { suaKhoanVay, tatToanKhoanVay, xoaKhoanVay } from "@/lib/actions/khoan-vay";
import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import { lyDoKhongXoaKhoanVay } from "@/lib/so-quy/ly-do-khong-xoa-khoan-vay";

import { KhoanVayFormModal } from "./khoan-vay-form-modal";
import { ThauChiTatToanDialog } from "./thau-chi-tat-toan-dialog";

/**
 * Menu ⋯ của một dòng khoản vay: Sửa · Xoá · Tất toán — hoặc **Mở lại** nếu khoản đã tất toán. Tách
 * khỏi `khoan-vay-table.tsx` để bảng dưới 200 dòng.
 *
 * "Xoá" LUÔN hiện, kể cả khi khoản không xoá được: bản cũ ẩn hẳn mục đó và chủ shop khai nhầm một
 * khoản trả gốc cuối kỳ (duyệt kỳ 1 chỉ ghi lãi, không sinh dòng trả gốc) không thấy đường nào, cũng
 * không biết vì sao. Bấm vào giờ mở hộp nói THẬT lý do + đường gỡ (`lyDoKhongXoaKhoanVay`, dùng
 * chung với `xoaKhoanVay` nên câu ở hộp và câu server ném ra không thể lệch). Hộp đó không có nút
 * ghi — luật chặn xoá giữ nguyên từng chữ, đây chỉ là chỗ giải thích.
 *
 * Hộp xác nhận nằm NGOÀI `DropdownMenu`: menu đóng lại ngay khi bấm item, để dialog bên trong nó là
 * dialog bị gỡ khỏi cây trước khi kịp mở.
 */

type HopThoai = null | "xoa" | "khongXoaDuoc" | "tatToan" | "moLai";

/**
 * Dựng lại nguyên payload hiện có của khoản vay — `suaKhoanVay` nhận cả hồ sơ, nên nút "Mở lại"
 * phải gửi đúng những gì đang có rồi chỉ thêm cờ `moLai`, nếu không nó âm thầm sửa mất dữ liệu.
 */
function payloadGiuNguyen(loan: KhoanVayRow) {
  const laMoi = loan.duNoMoSo === 0;
  return {
    name: loan.name,
    lender: loan.lender,
    annualRateBp: loan.annualRateBp,
    // BẮT BUỘC gửi lại `kind`: server khoá loại khoản vay vĩnh viễn sau khi tạo, thiếu trường này
    // thì zod điền mặc định "TERM" và mọi lượt "Mở lại" một khoản thấu chi bị từ chối.
    kind: loan.kind,
    coLich:
      loan.kind === "OVERDRAFT"
        ? loan.firstDueDate !== null
        : loan.firstDueDate !== null && loan.termMonths !== null,
    termMonths: loan.termMonths,
    firstDueDate: loan.firstDueDate,
    // BẮT BUỘC gửi lại cả hai — cùng bẫy với `kind`: thiếu thì zod coi như "không khai" và một khoản
    // gốc-cuối-kỳ (BULLET) bị "Mở lại" sẽ mất lãi cố định + sổ tiết kiệm về 0 một cách im lặng.
    //
    // Cả hai PHẢI kẹp đối xứng cùng một điều kiện `kind === "BULLET"`: `superRefine` ở khoan-vay.ts
    // từ chối THẲNG `laiCoDinhMoiKy !== null` lẫn `tienGuiBatBuocMoiKy > 0` ở mọi loại khác BULLET.
    // Khoản lạc lỡ mang `laiCoDinhMoiKy` khác null (bản ghi cũ) mà kẹp thiếu ở đây thì "Sửa"/"Mở lại"
    // của chính khoản đó tự ăn lỗi do payload nó vừa gửi đi.
    laiCoDinhMoiKy: loan.kind === "BULLET" ? loan.laiCoDinhMoiKy : null,
    // Chỉ BULLET mang được số tiền gửi: server từ chối nó ở loại khác và hộp "Mở lại" không có ô nào
    // để sáng lên câu lỗi đó.
    tienGuiBatBuocMoiKy: loan.kind === "BULLET" ? loan.tienGuiBatBuocMoiKy : 0,
    note: loan.note,
    cheDo: laMoi ? "moi" : "mang-sang",
    ...(laMoi
      ? { soTienGiaiNgan: loan.giaiNgan, ngayGiaiNgan: loan.startDate }
      : { duNoMoSo: loan.duNoMoSo, startDate: loan.startDate }),
  };
}

export function KhoanVayRowActions({ loan }: { loan: KhoanVayRow }) {
  const router = useRouter();
  const [moSua, setMoSua] = useState(false);
  const [hopThoai, setHopThoai] = useState<HopThoai>(null);
  const [dangChay, setDangChay] = useState(false);
  const [moTatToanThauChi, setMoTatToanThauChi] = useState(false);
  // Ngày tất toán — CHỈ hỏi khi khoản đang giữ tiền gửi, vì đúng ca đó lượt bấm mới GHI TIỀN THẬT
  // (dòng hoàn `DEPOSIT_IN`): kỳ cuối đến hạn 10/05 mà bấm 03/06 thì cả số tiền gửi rơi sang tháng 6.
  const [ngayTatToan, setNgayTatToan] = useState(() => format(new Date(), "yyyy-MM-dd"));

  const daTatToan = loan.closedAt !== null;
  const coTienGui = loan.tienGuiDangGiu > 0;
  // CÙNG vị từ với `xoaKhoanVay` ở server (`null` = xoá được) — client không tự dựng lại điều kiện.
  const lyDoKhongXoa = lyDoKhongXoaKhoanVay({
    coTraGoc: loan.coTraGoc,
    daDuyetKy: loan.lastDueHandled !== null,
    mangSang: loan.duNoMoSo > 0,
    coTienGui: loan.coDongTienGui,
  });
  // Thấu chi còn hiệu lực tất toán bằng hộp riêng (ghi lãi + trả TOÀN BỘ gốc trong một lượt) —
  // KHÔNG dùng `tatToanKhoanVay` (đòi dư nợ đã về 0 sẵn, không ghi đồng nào).
  const tatToanBangHopThauChi = loan.kind === "OVERDRAFT" && !daTatToan;

  const CAU: Record<Exclude<HopThoai, null>, { tieuDe: string; noiDung: string; nut: string }> = {
    khongXoaDuoc: {
      tieuDe: "Không xoá được khoản vay",
      noiDung: lyDoKhongXoa ?? "",
      nut: "Đã hiểu",
    },
    xoa: {
      tieuDe: "Xoá khoản vay",
      noiDung: `Xoá ${loan.name}? Dòng giải ngân của khoản này cũng bị xoá — chuyển vào Thùng rác, khôi phục lại được.`,
      nut: "Xoá",
    },
    tatToan: {
      tieuDe: "Tất toán khoản vay",
      // Câu cũ ("không nhận thêm dòng tiền nào") nay SAI với khoản có sổ tiết kiệm: chính lượt tất
      // toán ghi một dòng hoàn tiền gửi vào quỹ. Nói rõ số sẽ nhận lại, rồi mới nói khoá sổ.
      noiDung: coTienGui
        ? `Tất toán ${loan.name}? Sẽ nhận lại tiền gửi ${formatVnd(loan.tienGuiDangGiu)} vào quỹ theo ngày chọn bên dưới; sau đó khoản không nhận thêm dòng tiền nào (mở lại được nếu cần).`
        : `Tất toán ${loan.name}? Sau khi tất toán, khoản không nhận thêm dòng tiền nào (mở lại được nếu cần).`,
      nut: "Tất toán",
    },
    moLai: {
      tieuDe: "Mở lại khoản vay",
      noiDung: `Mở lại ${loan.name} để ghi tiếp dòng gốc — dư nợ vẫn suy từ chính các dòng tiền đã có.`,
      nut: "Mở lại",
    },
  };

  async function chay() {
    // "khongXoaDuoc" là hộp CHỈ ĐỂ ĐỌC — không có nút nào gọi tới đây, chốt lại cho chắc.
    if (hopThoai === null || hopThoai === "khongXoaDuoc") return;
    setDangChay(true);
    try {
      const res =
        hopThoai === "xoa"
          ? await xoaKhoanVay(loan.id)
          : hopThoai === "tatToan"
            ? // Không tiền gửi ⇒ undefined, action giữ nguyên hợp đồng cũ (mặc định hôm nay).
              await tatToanKhoanVay(
                loan.id,
                coTienGui ? { ngayTatToan: new Date(`${ngayTatToan}T00:00:00+07:00`) } : undefined
              )
            : await suaKhoanVay(loan.id, { ...payloadGiuNguyen(loan), moLai: true });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã ${CAU[hopThoai].nut.toLowerCase()} ${loan.name}`);
      setHopThoai(null);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  const cau = hopThoai === null ? null : CAU[hopThoai];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="sm" aria-label={`Thao tác ${loan.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setMoSua(true)}>Sửa</DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setHopThoai(lyDoKhongXoa === null ? "xoa" : "khongXoaDuoc")}
          >
            Xoá
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (daTatToan) setHopThoai("moLai");
              else if (tatToanBangHopThauChi) setMoTatToanThauChi(true);
              else setHopThoai("tatToan");
            }}
          >
            {daTatToan ? "Mở lại" : "Tất toán"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <KhoanVayFormModal open={moSua} onOpenChange={setMoSua} loan={loan} />
      <ThauChiTatToanDialog loan={loan} open={moTatToanThauChi} onOpenChange={setMoTatToanThauChi} />

      <Dialog open={cau !== null} onOpenChange={(o) => !o && setHopThoai(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{cau?.tieuDe ?? ""}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ink">{cau?.noiDung ?? ""}</p>
          {hopThoai === "tatToan" && coTienGui && (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Ngày tất toán (ngày ngân hàng trả lại tiền gửi)
              {/* `min` cũng BẮT BUỘC như `max`: lượt bấm này ghi một dòng hoàn tiền gửi THẬT, gõ
                  nhầm về trước kỳ cuối là cả Σ tiền gửi rơi vào tháng chưa hề chi ra (Sổ quỹ tháng
                  đó phồng đúng số ấy). `tatToanKhoanVay` chặn lại lần nữa — ô này chỉ để chủ shop
                  thấy trước thay vì bấm rồi ăn câu lỗi. */}
              <Input
                type="date"
                aria-label="Ngày tất toán"
                value={ngayTatToan}
                min={format(loan.ngayTatToanSomNhat, "yyyy-MM-dd")}
                max={format(new Date(), "yyyy-MM-dd")}
                onChange={(e) => setNgayTatToan(e.target.value)}
              />
            </label>
          )}
          <DialogFooter>
            {hopThoai === "khongXoaDuoc" ? (
              <Button type="button" onClick={() => setHopThoai(null)}>
                Đã hiểu
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setHopThoai(null)}>
                  Huỷ
                </Button>
                <Button
                  type="button"
                  variant={hopThoai === "xoa" ? "destructive" : "default"}
                  disabled={dangChay}
                  onClick={chay}
                >
                  {dangChay ? "Đang chạy…" : (cau?.nut ?? "")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
