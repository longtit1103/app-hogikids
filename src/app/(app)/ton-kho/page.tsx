import { InventoryKpiCards } from "@/components/inventory/inventory-kpi-cards";
import { InventoryTable } from "@/components/inventory/inventory-table";
import { InventoryToolbar } from "@/components/inventory/inventory-toolbar";
import { docSoTrang, veTrangCuoiNeuVuot } from "@/lib/pagination";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { getVariantListPage, VARIANT_PAGE_SIZE } from "@/lib/queries/variants";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { coQuyen } from "@/lib/quyen/nguoi-dung-phien";
import { PageTitle } from "@/components/shell/page-title";

export default async function TonKhoPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; loc?: string; sap_xep?: string; chieu?: string; trang?: string }>;
}) {
  // Cổng ngay tại trang, không chỉ dựa vào layout — xem ghi chú ở `/don-hang`.
  const nd = await yeuCauQuyenTrang("/ton-kho", "ton-kho:xem");
  const quyen = quyenGiaVonCua(nd);

  const sp = await searchParams;
  const page = docSoTrang(sp.trang);
  const lowOnly = sp.loc === "sap_het";
  // Thiếu quyền giá vốn: không có cột "Giá trị vốn" để sort ⇒ sort theo tồn (query cũng tự ép vậy).
  const sort = sp.sap_xep === "ton" || !quyen.coQuyenGiaVon ? "ton" : "von";
  const dir = sp.chieu === "asc" ? "asc" : "desc";

  const bang = await getVariantListPage({ q: sp.q, lowOnly, sort, dir, page }, quyen);
  const { total } = bang;

  veTrangCuoiNeuVuot({ duongDan: "/ton-kho", sp, trang: page, tong: total, soDongMoiTrang: VARIANT_PAGE_SIZE });

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Tồn kho">
        <p className="text-sm text-muted-foreground">Tồn realtime từ Pancake — điều chỉnh tồn tại Pancake</p>
      </PageTitle>

      <InventoryKpiCards du={bang} />
      <InventoryToolbar choPhepXuat={coQuyen(nd, "xuat-du-lieu")} />

      {bang.rows.length > 0 ? (
        <InventoryTable bang={bang} total={total} page={page} sort={sort} dir={dir} sp={sp} />
      ) : (
        <EmptyState lowOnly={lowOnly} q={sp.q} />
      )}
    </div>
  );
}

function EmptyState({ lowOnly, q }: { lowOnly: boolean; q?: string }) {
  if (q) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Không tìm thấy SKU khớp «{q}»</p>;
  }
  if (lowOnly) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">🎉 Không có SKU nào dưới ngưỡng cảnh báo</p>
    );
  }
  return (
    <p className="py-12 text-center text-sm text-muted-foreground">
      Chưa có sản phẩm — chờ đồng bộ Pancake, hoặc bấm «Đồng bộ ngay»
    </p>
  );
}
