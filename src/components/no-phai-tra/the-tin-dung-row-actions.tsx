"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { dongThe, xoaThe } from "@/lib/actions/the-tin-dung";
import type { TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";

import { ChotSaoKeFormModal } from "./chot-sao-ke-form-modal";
import { GanNenTangForm } from "./gan-nen-tang-form";
import { TheTinDungFormModal } from "./the-tin-dung-form-modal";

type HopThoai = null | "dong" | "xoa" | "khongDong" | "khongXoa";

/**
 * Menu ⋯ của một thẻ: Sửa · Gắn nền tảng · Chốt sao kê (chủ shop, sau khi bật) · Đóng · Xoá. "Đóng" và
 * "Xoá" luôn hiện: khi thẻ chưa đóng/xoá được, bấm mở hộp NÓI lý do thật (`lyDoKhong*` do server tính,
 * cùng câu action ném) thay vì ẩn mục đi — cùng khuôn `KhoanVayRowActions`. Hộp nằm NGOÀI menu vì menu
 * đóng ngay khi bấm item.
 */
export function TheTinDungRowActions({
  the,
  mocM,
  laChuShop,
  ngayChotMacDinh,
  hanTraGoiY,
}: {
  the: TheKemTrangThai;
  mocM: string | null;
  laChuShop: boolean;
  ngayChotMacDinh: string;
  hanTraGoiY: string;
}) {
  const router = useRouter();
  const [moSua, setMoSua] = useState(false);
  const [moGan, setMoGan] = useState(false);
  const [moChot, setMoChot] = useState(false);
  const [hop, setHop] = useState<HopThoai>(null);
  const [dangChay, setDangChay] = useState(false);

  const daDong = the.closedAt !== null;
  const coTheChot = laChuShop && mocM !== null && !daDong;

  const CAU: Record<Exclude<HopThoai, null>, { tieuDe: string; noiDung: string; nut: string }> = {
    khongDong: { tieuDe: "Chưa đóng được thẻ", noiDung: the.lyDoKhongDong ?? "", nut: "Đã hiểu" },
    khongXoa: { tieuDe: "Không xoá được thẻ", noiDung: the.lyDoKhongXoa ?? "", nut: "Đã hiểu" },
    dong: { tieuDe: "Đóng thẻ", noiDung: `Đóng thẻ ${the.ten}? Thẻ đóng không nhận thêm giao dịch.`, nut: "Đóng thẻ" },
    xoa: { tieuDe: "Xoá thẻ", noiDung: `Xoá thẻ ${the.ten}? Hồ sơ trắng — xoá hẳn.`, nut: "Xoá" },
  };

  async function chay() {
    if (hop !== "dong" && hop !== "xoa") return;
    setDangChay(true);
    try {
      const res = hop === "dong" ? await dongThe(the.id) : await xoaThe(the.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(hop === "dong" ? `Đã đóng thẻ ${the.ten}` : `Đã xoá thẻ ${the.ten}`);
      setHop(null);
      router.refresh();
    } catch {
      toast.error("Thao tác thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  const cau = hop === null ? null : CAU[hop];
  const chiDoc = hop === "khongDong" || hop === "khongXoa";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="sm" aria-label={`Thao tác thẻ ${the.ten}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setMoSua(true)}>Sửa</DropdownMenuItem>
          {!daDong && <DropdownMenuItem onClick={() => setMoGan(true)}>Gắn nền tảng</DropdownMenuItem>}
          {coTheChot && <DropdownMenuItem onClick={() => setMoChot(true)}>Chốt sao kê</DropdownMenuItem>}
          {!daDong && (
            <DropdownMenuItem onClick={() => setHop(the.lyDoKhongDong === null ? "dong" : "khongDong")}>
              Đóng
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setHop(the.lyDoKhongXoa === null ? "xoa" : "khongXoa")}>Xoá</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <TheTinDungFormModal open={moSua} onOpenChange={setMoSua} the={the} mocM={mocM} />
      <GanNenTangForm open={moGan} onOpenChange={setMoGan} the={the} daBat={mocM !== null} />
      {mocM !== null && (
        <ChotSaoKeFormModal
          open={moChot}
          onOpenChange={setMoChot}
          the={the}
          mocM={mocM}
          ngayChotMacDinh={ngayChotMacDinh}
          hanTraGoiY={hanTraGoiY}
        />
      )}

      <Dialog open={cau !== null} onOpenChange={(o) => !o && setHop(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{cau?.tieuDe ?? ""}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ink">{cau?.noiDung ?? ""}</p>
          <DialogFooter>
            {chiDoc ? (
              <Button type="button" onClick={() => setHop(null)}>
                Đã hiểu
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setHop(null)}>
                  Huỷ
                </Button>
                <Button type="button" variant={hop === "xoa" ? "destructive" : "default"} disabled={dangChay} onClick={chay}>
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
