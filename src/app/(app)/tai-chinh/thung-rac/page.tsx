import Link from "next/link";

import { ThungRacTable } from "@/components/thung-rac/thung-rac-table";
import { docSoTrang, veTrangCuoiNeuVuot } from "@/lib/pagination";
import { requireUser } from "@/lib/session";
import { listThungRac } from "@/lib/thung-rac/thung-rac-queries";

type SearchParams = { trang?: string };

/**
 * `/tai-chinh/thung-rac` — mọi mục đã xoá ở Sổ chi phí / Dòng tiền / Khoản vay / Sổ tiết kiệm
 * (bảng `BanGhiDaXoa`, chụp trong CHÍNH transaction xoá — xem `src/lib/thung-rac/ghi-thung-rac.ts`).
 * Đọc-only ngoài 2 nút thao tác mỗi dòng; 2 server action thật nằm ở `src/lib/actions/thung-rac.ts`.
 */
export default async function ThungRacPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser("/tai-chinh/thung-rac");

  const sp = await searchParams;
  const page = docSoTrang(sp.trang);
  const { rows, total } = await listThungRac(page);

  veTrangCuoiNeuVuot({
    duongDan: "/tai-chinh/thung-rac",
    sp,
    trang: page,
    tong: total,
    soDongMoiTrang: 20,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href="/tai-chinh" className="w-fit text-sm text-muted-foreground hover:underline">
          ‹ Tài chính
        </Link>
        <h1 className="font-serif text-2xl text-ink">Thùng rác</h1>
        <p className="text-sm text-muted-foreground">{total} mục đã xoá</p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-hairline p-8 text-center">
          <p className="text-sm text-ink">Thùng rác trống — chưa xoá mục nào.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Mọi mục xoá ở Sổ chi phí, Dòng tiền, Khoản vay, Sổ tiết kiệm đều vào đây, giữ đến khi bạn
            xoá vĩnh viễn.
          </p>
        </div>
      ) : (
        <ThungRacTable rows={rows} total={total} page={page} sp={sp} />
      )}
    </div>
  );
}
