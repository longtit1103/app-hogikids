import type { ChuThichDoTuoi } from "@/lib/reports/marketing/cau-do-tuoi-du-lieu";

/**
 * Chú thích ĐỘ TƯƠI dữ liệu — DÙNG CHUNG cho mọi khối/bảng đọc từ `src/lib/reports/marketing/*`
 * (mỗi reader tự trả `soNgayChuaSanSang`/`soNgayThieu`/`mocSanSang` riêng, xem `moc-du-lieu-san-sang.ts`).
 * Tách khỏi từng section để BA khối (`pheu-tiktok-section.tsx` — client vì có biểu đồ recharts,
 * `noi-dung-section.tsx`, `san-pham-nguon-section.tsx` — server) đều import được cùng MỘT bản, không
 * chép luật 3 lần rồi trôi khác nhau, và không phải kéo file client vào module server (hay ngược lại).
 *
 * CHỈ RENDER — nhận SẴN `cau1`/`cau2` đã tính ở `page.tsx` (`tinhChuThichDoTuoi`, gói `quyetDinhCauDoTuoi`
 * + `cauThieuDuLieu` của `@/lib/reports/marketing/cau-do-tuoi-du-lieu`). TUYỆT ĐỐI KHÔNG tự gọi hai
 * hàm đó ở đây (ruling P2-R38): component này bị `pheu-tiktok-section.tsx` — "use client" — import,
 * nên nếu quyết định câu chữ chạy Ở ĐÂY thì nó chạy LẠI trên trình duyệt lúc hydrate; `quyetDinhCauDoTuoi`
 * dùng `date-fns` `format`/`subDays` đọc lịch LOCAL của môi trường thực thi (không nhận `timeZone`) ⇒
 * server (giờ VN) và trình duyệt (TZ bất kỳ) có thể ra hai câu KHÁC NHAU — hydration mismatch + câu
 * đổ lỗi lật ngược (bất biến #3). Vì vậy import ở trên chỉ lấy TYPE (`import type`, bị xoá lúc build) —
 * không kéo theo hàm JS thật nào của `cau-do-tuoi-du-lieu.ts` vào bundle client.
 */
export function ChuThichDoTuoiVaThieu({ cau1, cau2 }: ChuThichDoTuoi) {
  if (cau1 === null && cau2 === null) return null;
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
      {cau1 && <p>{cau1}</p>}
      {cau2 && <p>{cau2}</p>}
    </div>
  );
}
