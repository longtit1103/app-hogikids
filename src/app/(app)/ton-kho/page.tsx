import { InventoryKpiCards } from "@/components/inventory/inventory-kpi-cards";
import { InventoryTable } from "@/components/inventory/inventory-table";
import { InventoryToolbar } from "@/components/inventory/inventory-toolbar";
import { docSoTrang, veTrangCuoiNeuVuot } from "@/lib/pagination";
import { getVariantListPage, VARIANT_PAGE_SIZE } from "@/lib/queries/variants";
import { requireUser } from "@/lib/session";

export default async function TonKhoPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; loc?: string; sap_xep?: string; chieu?: string; trang?: string }>;
}) {
  // Canh phiên ngay tại trang, không chỉ dựa vào layout — xem ghi chú ở `/don-hang`.
  await requireUser("/ton-kho");

  const sp = await searchParams;
  const page = docSoTrang(sp.trang);
  const lowOnly = sp.loc === "sap_het";
  const sort = sp.sap_xep === "ton" ? "ton" : "von";
  const dir = sp.chieu === "asc" ? "asc" : "desc";

  const { rows, total, kpi } = await getVariantListPage({ q: sp.q, lowOnly, sort, dir, page });

  veTrangCuoiNeuVuot({ duongDan: "/ton-kho", sp, trang: page, tong: total, soDongMoiTrang: VARIANT_PAGE_SIZE });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl text-ink">Tồn kho</h1>
        <p className="text-sm text-muted-foreground">Tồn realtime từ Pancake — điều chỉnh tồn tại Pancake</p>
      </div>

      <InventoryKpiCards kpi={kpi} />
      <InventoryToolbar />

      {rows.length > 0 ? (
        <InventoryTable rows={rows} total={total} page={page} sort={sort} dir={dir} sp={sp} />
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
