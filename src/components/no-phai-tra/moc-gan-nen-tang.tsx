"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";

import { xoaGanNenTang } from "@/lib/actions/the-tin-dung";
import type { MocGanThe } from "@/lib/no-phai-tra/the-tin-dung-queries";

import { nhanNenTang } from "./nen-tang-gan-the";

/**
 * Các mốc "nền tảng ads → thẻ" của một thẻ. Mốc chưa có hiệu lực (từ ngày mai) xoá được; mốc đã hiệu
 * lực là lịch sử gánh ads — chỉ đổi thẻ bằng cách thêm mốc mới.
 */
export function MocGanNenTang({ gan, choPhepSua, homNay = new Date() }: { gan: readonly MocGanThe[]; choPhepSua: boolean; homNay?: Date }) {
  const router = useRouter();
  const [dangXoa, setDangXoa] = useState<string | null>(null);
  const khoaHomNay = format(homNay, "yyyy-MM-dd");
  const khoa = (g: MocGanThe) => format(g.tuNgay, "yyyy-MM-dd");
  // Chỉ mốc ĐANG hiệu lực (tuNgay lớn nhất ≤ hôm nay của từng nền tảng) và mốc sắp áp dụng.
  const hienThi = gan
    .filter((g) => {
      if (khoa(g) > khoaHomNay) return true;
      return !gan.some((h) => h.nenTang === g.nenTang && khoa(h) <= khoaHomNay && khoa(h) > khoa(g));
    })
    .sort((a, b) => a.tuNgay.getTime() - b.tuNgay.getTime());
  if (hienThi.length === 0) return <span className="text-muted-foreground">—</span>;

  async function xoa(id: string) {
    setDangXoa(id);
    try {
      const res = await xoaGanNenTang(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã xoá mốc gắn");
      router.refresh();
    } catch {
      toast.error("Thao tác thất bại — kiểm tra kết nối");
    } finally {
      setDangXoa(null);
    }
  }

  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {hienThi.map((g) => (
        <li key={g.id} className="flex items-center gap-1.5">
          <span className="text-ink">
            {nhanNenTang(g.nenTang)} từ {format(g.tuNgay, "dd/MM/yyyy")}
          </span>
          {khoa(g) > khoaHomNay && <span className="text-muted-foreground">(sắp áp dụng)</span>}
          {choPhepSua && g.xoaDuoc && (
            <button
              type="button"
              disabled={dangXoa === g.id}
              onClick={() => xoa(g.id)}
              className="text-muted-foreground underline underline-offset-2"
            >
              xoá
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
