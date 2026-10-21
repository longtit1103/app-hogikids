"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Độ trễ giữa lần gõ cuối và lần ghi `?q=` lên URL. */
export const TRE_TIM_KIEM_MS = 300;

/**
 * Dựng chuỗi query mới khi đổi `q` — đi từ `search` HIỆN TẠI của trình duyệt (không phải bản chụp
 * `useSearchParams` lúc effect được tạo): bấm bộ lọc khác trong 300ms chờ gõ xong thì URL đã đổi, dựng
 * từ bản chụp cũ sẽ ghi đè mất bộ lọc vừa bấm. Đổi `q` luôn đưa về trang 1.
 */
export function queryKhiDoiQ(searchHienTai: string, q: string): string {
  const params = new URLSearchParams(searchHienTai);
  if (q) params.set("q", q);
  else params.delete("q");
  params.delete("trang");
  return params.toString();
}

/**
 * Ô tìm kiếm đồng bộ với `?q=` trên URL: gõ → chờ 300ms → `router.replace`. Dùng chung cho các thanh
 * công cụ có ô tìm kiếm (Sản phẩm, Tồn kho, Đơn hàng, Đơn của kênh, Sổ chi phí).
 *
 * - Lúc hết giờ chờ đọc URL từ `window.location` (xem `queryKhiDoiQ`), không từ bản chụp cũ.
 * - URL đổi `q` từ bên ngoài (Back/Forward, "Xóa lọc") ⇒ kéo ô nhập theo. Lần cập nhật do CHÍNH ô này ghi
 *   lên URL bị bỏ qua (nhớ giá trị đẩy GẦN NHẤT trong `daDay`), nếu không URL chạy chậm hơn người gõ sẽ
 *   ghi đè chữ đang gõ. Chỉ nhớ MỘT giá trị (không phải tập): giá trị đẩy trước đó mà URL không bao giờ
 *   hiện ra (bị lần đẩy sau gộp mất) sẽ không nằm lại làm nuốt nhầm một lần Back về đúng giá trị đó.
 */
export function useOTimKiemUrl(tuyChon: { scroll?: boolean } = {}): { q: string; setQ: (q: string) => void } {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qTrenUrl = searchParams.get("q") ?? "";
  const [q, setQ] = useState(qTrenUrl);
  // Giá trị `q` ô này đẩy lên URL GẦN NHẤT mà URL chưa "đuổi kịp" (null = không có gì đang chờ).
  const daDay = useRef<string | null>(null);
  const { scroll } = tuyChon;

  useEffect(() => {
    if (q === (new URLSearchParams(window.location.search).get("q") ?? "")) return;
    const handle = setTimeout(() => {
      const search = window.location.search;
      // Giữa chừng URL đã tự khớp (vd Back) ⇒ không đẩy lại.
      if (q === (new URLSearchParams(search).get("q") ?? "")) return;
      daDay.current = q;
      const qs = queryKhiDoiQ(search, q);
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (scroll === undefined) router.replace(url);
      else router.replace(url, { scroll });
    }, TRE_TIM_KIEM_MS);
    return () => clearTimeout(handle);
  }, [q, pathname, router, scroll]);

  useEffect(() => {
    if (daDay.current === qTrenUrl) {
      daDay.current = null; // URL đuổi kịp lần đẩy của chính ô này
      return;
    }
    daDay.current = null; // URL đã nhảy sang giá trị khác ⇒ lần đẩy cũ không còn chờ nữa
    setQ(qTrenUrl); // đổi từ ngoài (Back/Forward, Xóa lọc)
  }, [qTrenUrl]);

  return { q, setQ };
}
