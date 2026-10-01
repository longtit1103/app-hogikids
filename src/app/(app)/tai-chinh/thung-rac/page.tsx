import Link from "next/link";

import { ThungRacTable } from "@/components/thung-rac/thung-rac-table";
import { docSoTrang, veTrangCuoiNeuVuot } from "@/lib/pagination";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { listThungRac, phamViThungRac, QUYEN_VAO_THUNG_RAC } from "@/lib/thung-rac/thung-rac-queries";

type SearchParams = { trang?: string };

/**
 * `/tai-chinh/thung-rac` — mọi mục đã xoá ở Sổ chi phí / Dòng tiền / Khoản vay / Sổ tiết kiệm
 * (bảng `BanGhiDaXoa`, chụp trong CHÍNH transaction xoá — xem `src/lib/thung-rac/ghi-thung-rac.ts`).
 * Đọc-only ngoài 2 nút thao tác mỗi dòng; 2 server action thật nằm ở `src/lib/actions/thung-rac.ts`.
 *
 * Vào trang cần ÍT NHẤT MỘT quyền sửa trong ba nhóm; danh sách CHỈ liệt kê loại bản ghi người xem có
 * quyền (`phamViThungRac`) — người chỉ quản chi phí không thấy khoản vay/sổ tiết kiệm đã xoá, người chỉ
 * có Dòng tiền không thấy dòng tiền gắn khoản vay/sổ tiết kiệm. Action khôi phục/xoá vĩnh viễn vẫn tự
 * kiểm lại theo loại + ảnh chụp đọc từ DB.
 */
export default async function ThungRacPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const nd = await yeuCauQuyenTrang("/tai-chinh/thung-rac", QUYEN_VAO_THUNG_RAC);

  const sp = await searchParams;
  const page = docSoTrang(sp.trang);
  const { rows, total } = await listThungRac({ ...phamViThungRac(nd), page });

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
