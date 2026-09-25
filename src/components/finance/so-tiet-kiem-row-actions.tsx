"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format, startOfDay } from "date-fns";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { xoaSoTietKiem } from "@/lib/actions/so-tiet-kiem";
import { moLaiSoTietKiem, tatToanSoTietKiem } from "@/lib/actions/tat-toan-so-tiet-kiem";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import { lyDoKhongXoaSoTietKiem, type TrangThaiKhoaXoa } from "@/lib/tiet-kiem/ly-do-khong-xoa-so-tiet-kiem";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { NGAY, O } from "./khoan-vay-form-fields";
import { SoTietKiemFormModal } from "./so-tiet-kiem-form-modal";

/**
 * Menu ⋯ của một dòng sổ tiết kiệm: Sửa · Xoá · Tất toán · Rút trước hạn — hoặc CHỈ Mở lại nếu đã
 * tất toán (spec §7.3: sổ đã tất toán KHÔNG sửa được, chỉ mở lại).
 *
 * ⚠️ "Sửa" LUÔN HIỆN kể cả khi sổ đã tất toán (chốt sau rà chéo, ĐÈ lên bản gốc của phase doc — xem
 * đầu `phase-07-ui.md`) — đồng bộ 100% với `khoan-vay-row-actions.tsx` đang chạy prod: mục biến mất
 * làm chủ shop tưởng app hỏng, còn hộp thoại thì DẠY được. Bấm "Sửa" khi đã tất toán mở hộp
 * `khongSuaDuoc` (đọc-only, không gọi action nào) nói lý do + chỉ đường "Mở lại" thay vì mở thẳng
 * `SoTietKiemFormModal` — mở form rồi để `suaSoTietKiem` tự ném lỗi "Sổ đã tất toán — mở lại trước
 * khi sửa" là để chủ shop điền cả form xong mới biết không lưu được.
 *
 * "Xoá" cũng LUÔN hiện kể cả khi không xoá được (khuôn cũ, giữ nguyên): bấm vào mở hộp nói THẬT lý
 * do, dùng CHUNG vị từ với server (`lyDoKhongXoaSoTietKiem`) nên câu ở hộp và câu server ném ra không
 * thể lệch.
 *
 * "Tất toán" và "Rút trước hạn" CÙNG gọi `tatToanSoTietKiem` — chỉ khác NGÀY/LÃI mặc định và câu dẫn:
 * tất toán mặc định lãi = `laiDuKien` (đúng hạn, có đề xuất); rút trước hạn mặc định lãi = 0 (app
 * KHÔNG đoán lãi rút sớm, spec §6.2 — chủ shop tự gõ theo giấy báo ngân hàng).
 */

/** Map dữ liệu hiển thị → đầu vào của `lyDoKhongXoaSoTietKiem` (Phase 02) — export để kiểm riêng. */
/**
 * Sổ đã tới ngày đáo hạn chưa — quyết định mục "Tất toán" có hiện trong menu ⋯ hay không.
 * Cắt về đầu ngày cả hai vế: đáo hạn ĐÚNG hôm nay là ĐÃ tới hạn, không phải "còn vài tiếng nữa".
 */
export function soDaDenHan(maturityDate: Date, homNay: Date): boolean {
  return startOfDay(maturityDate) <= startOfDay(homNay);
}

export function trangThaiKhoaXoaTuRow(
  so: Pick<SoTietKiemRow, "closedAt" | "laiThucNhan" | "coDongGhiTay">
): TrangThaiKhoaXoa {
  return {
    daTatToan: so.closedAt !== null,
    coThuNhap: (so.laiThucNhan ?? 0) > 0,
    coDongGhiTay: so.coDongGhiTay,
  };
}

/** Câu cho hộp "Sửa" khi sổ đã tất toán — khuôn văn của `lyDoKhongXoaSoTietKiem` (nhánh `daTatToan`)
 *  nhưng cho hành động "sửa", không phải "xoá": cùng lý do (gốc đã về quỹ, lãi đã vào Lãi/Lỗ), cùng
 *  đường gỡ ("Mở lại sổ trước"), khác động từ. Không tách vào `src/lib/**` vì đây thuần câu chữ UI,
 *  không phải vị từ server dùng lại (server tự ném câu riêng ở `suaSoTietKiem`). */
const LY_DO_KHONG_SUA_DUOC =
  "Sổ này đã tất toán — gốc đã về quỹ và lãi (nếu có) đã vào Lãi/Lỗ, sửa thẳng sẽ làm hồ sơ lệch với " +
  "hai dòng đó. Mở lại sổ trước (menu ⋯ → Mở lại, app tự gỡ dòng nhận lại gốc và dòng lãi nó đã " +
  "sinh), rồi mới sửa được.";

type HopThoai = null | "xoa" | "khongXoaDuoc" | "khongSuaDuoc" | "tatToan" | "rutTruocHan" | "moLai";

const TIEU_DE: Record<Exclude<HopThoai, null>, string> = {
  khongXoaDuoc: "Không xoá được sổ tiết kiệm",
  khongSuaDuoc: "Không sửa được sổ tiết kiệm",
  xoa: "Xoá sổ tiết kiệm",
  tatToan: "Tất toán sổ tiết kiệm",
  rutTruocHan: "Rút trước hạn",
  moLai: "Mở lại sổ tiết kiệm",
};
const NUT: Record<Exclude<HopThoai, null>, string> = {
  khongXoaDuoc: "Đã hiểu",
  khongSuaDuoc: "Đã hiểu",
  xoa: "Xoá",
  tatToan: "Tất toán",
  rutTruocHan: "Rút trước hạn",
  moLai: "Mở lại",
};
/** Hai hộp CHỈ ĐỂ ĐỌC — không nút nào trong chúng gọi action, chỉ giải thích + chỉ đường. */
const HOP_CHI_DOC = new Set<HopThoai>(["khongXoaDuoc", "khongSuaDuoc"]);

export function SoTietKiemRowActions({
  so,
  loans,
  d0,
}: {
  so: SoTietKiemRow;
  loans: KhoanVayRow[];
  /** Ngày mở sổ quỹ; null = chưa mở sổ. Modal Sửa cần để hỏi lại khi ghi ngày gửi trước D0. */
  d0: Date | null;
}) {
  const router = useRouter();
  const [moSua, setMoSua] = useState(false);
  const [hopThoai, setHopThoai] = useState<HopThoai>(null);
  const [dangChay, setDangChay] = useState(false);
  const [ngayTatToan, setNgayTatToan] = useState(() => format(new Date(), NGAY));
  const [lai, setLai] = useState(0);

  const daTatToan = so.closedAt !== null;
  const lyDoKhongXoa = lyDoKhongXoaSoTietKiem(trangThaiKhoaXoaTuRow(so));

  function moSuaHoacGiaiThich() {
    if (daTatToan) setHopThoai("khongSuaDuoc");
    else setMoSua(true);
  }
  /**
   * "Tất toán" CHỈ có nghĩa khi sổ đã tới ngày đáo hạn — lúc đó `laiDuKien` (lãi TRỌN KỲ) mới là
   * con số ngân hàng thật sự trả. Sổ chưa tới hạn mà bấm nhầm mục này (nó đứng TRƯỚC "Rút trước
   * hạn") là ghi lãi trọn kỳ vào một ngày chưa đáo hạn: dòng "Thu nhập tài chính" phồng lên bằng
   * tiền chưa hề nhận, và thẻ Quỹ cũng cộng theo. Không cổng nào đỏ vì `ThuNhap` chỉ cần > 0.
   * Vì vậy mục này ẨN khi chưa tới hạn — đường duy nhất lúc đó là "Rút trước hạn" (lãi để chủ shop
   * gõ, app KHÔNG đoán), đúng luật spec §6.2.
   */
  const daDenHan = soDaDenHan(so.maturityDate, new Date());

  function moTatToan() {
    setNgayTatToan(format(new Date(), NGAY));
    setLai(so.laiDuKien);
    setHopThoai("tatToan");
  }
  function moRutTruocHan() {
    setNgayTatToan(format(new Date(), NGAY));
    setLai(0);
    setHopThoai("rutTruocHan");
  }

  async function chay() {
    if (hopThoai === null || HOP_CHI_DOC.has(hopThoai)) return;
    setDangChay(true);
    try {
      const res =
        hopThoai === "xoa"
          ? await xoaSoTietKiem({ id: so.id })
          : hopThoai === "moLai"
            ? await moLaiSoTietKiem({ id: so.id })
            : await tatToanSoTietKiem({ id: so.id, ngayTatToan, lai });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã ${NUT[hopThoai].toLowerCase()} ${so.name}`);
      setHopThoai(null);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="sm" aria-label={`Thao tác ${so.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={moSuaHoacGiaiThich}>Sửa</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setHopThoai(lyDoKhongXoa === null ? "xoa" : "khongXoaDuoc")}>
            Xoá
          </DropdownMenuItem>
          {daTatToan ? (
            <DropdownMenuItem onClick={() => setHopThoai("moLai")}>Mở lại</DropdownMenuItem>
          ) : (
            <>
              {daDenHan && <DropdownMenuItem onClick={moTatToan}>Tất toán</DropdownMenuItem>}
              <DropdownMenuItem onClick={moRutTruocHan}>Rút trước hạn</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <SoTietKiemFormModal open={moSua} onOpenChange={setMoSua} so={so} loans={loans} d0={d0} />

      <Dialog open={hopThoai !== null} onOpenChange={(o) => !o && setHopThoai(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{hopThoai ? TIEU_DE[hopThoai] : ""}</DialogTitle>
          </DialogHeader>
          {hopThoai === "khongXoaDuoc" && <p className="text-sm text-ink">{lyDoKhongXoa}</p>}
          {hopThoai === "khongSuaDuoc" && <p className="text-sm text-ink">{LY_DO_KHONG_SUA_DUOC}</p>}
          {hopThoai === "xoa" && (
            <p className="text-sm text-ink">
              Xoá {so.name}? Dòng gửi của sổ này cũng bị xoá — chuyển vào Thùng rác, khôi phục lại
              được.
            </p>
          )}
          {hopThoai === "moLai" && (
            <p className="text-sm text-ink">
              Mở lại {so.name}? App sẽ gỡ dòng nhận gốc và bản ghi lãi vừa tất toán để ghi lại từ đầu.
            </p>
          )}
          {(hopThoai === "tatToan" || hopThoai === "rutTruocHan") && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink">
                {hopThoai === "tatToan"
                  ? `Tất toán ${so.name} — nhận lại gốc ${formatVnd(so.principal)}, lãi app điền sẵn theo dự kiến, sửa theo giấy báo ngân hàng nếu khác.`
                  : `Rút trước hạn ${so.name} — nhận lại gốc ${formatVnd(so.principal)}, app KHÔNG đoán lãi (để 0 nếu ngân hàng không trả lãi).`}
              </p>
              <O label="Ngày tất toán">
                <Input
                  type="date"
                  value={ngayTatToan}
                  max={format(new Date(), NGAY)}
                  onChange={(e) => setNgayTatToan(e.target.value)}
                />
              </O>
              <O label="Lãi thực nhận">
                <Input
                  inputMode="numeric"
                  value={formatAmountInput(lai)}
                  onChange={(e) => setLai(parseAmountInput(e.target.value))}
                  className="text-right"
                />
              </O>
              <p className="text-xs text-muted-foreground">Tổng nhận về: {formatVnd(so.principal + lai)}</p>
            </div>
          )}
          <DialogFooter>
            {hopThoai !== null && HOP_CHI_DOC.has(hopThoai) ? (
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
                  {dangChay ? "Đang chạy…" : hopThoai ? NUT[hopThoai] : ""}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
