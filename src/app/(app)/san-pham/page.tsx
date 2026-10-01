import Link from "next/link";

import { CostImportModal } from "@/components/products/cost-import-modal";
import { ProductGroupTable } from "@/components/products/product-group-table";
import { ProductKpiCards } from "@/components/products/product-kpi-cards";
import { ProductToolbar } from "@/components/products/product-toolbar";
import { docSoTrang, veTrangCuoiNeuVuot } from "@/lib/pagination";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { getProductListPage, PRODUCT_PAGE_SIZE } from "@/lib/queries/products";
import { getDefaultThreshold } from "@/lib/queries/variants";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { coQuyen } from "@/lib/quyen/nguoi-dung-phien";
import { PageTitle } from "@/components/shell/page-title";

export default async function SanPhamPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; loc?: string; trang?: string }>;
}) {
  // Cổng ngay tại trang, không chỉ dựa vào layout — xem ghi chú ở `/don-hang`.
  const nd = await yeuCauQuyenTrang("/san-pham", "san-pham:xem");
  const quyen = quyenGiaVonCua(nd);
  const suaNguong = coQuyen(nd, "san-pham:sua");
  // Sửa/nhập/đồng bộ giá vốn cần CẢ quyền sửa module lẫn quyền thấy giá vốn (spec phân quyền §1.1).
  const suaGiaVon = suaNguong && quyen.coQuyenGiaVon;

  const sp = await searchParams;
  const page = docSoTrang(sp.trang);
  // Hai bộ lọc theo giá vốn vô nghĩa với người không thấy giá vốn (query cũng tự bỏ qua).
  const missingCost = quyen.coQuyenGiaVon && sp.loc === "thieu_gia_von";
  // Tập HÀNH ĐỘNG ĐƯỢC (đã bán mà giá vốn còn 0) — xem `ProductListParams.soldMissingCost`.
  const soldMissingCost = quyen.coQuyenGiaVon && sp.loc === "da_ban_thieu_gia_von";
  const lowOnly = sp.loc === "sap_het";

  const [du, defaultThreshold] = await Promise.all([
    getProductListPage({ q: sp.q, missingCost, soldMissingCost, lowOnly, page }, quyen),
    getDefaultThreshold(),
  ]);
  const { total, kpi } = du;
  const bang = du.coQuyenGiaVon
    ? { coQuyenGiaVon: true as const, products: du.products, suaGiaVon }
    : { coQuyenGiaVon: false as const, products: du.products };

  veTrangCuoiNeuVuot({ duongDan: "/san-pham", sp, trang: page, tong: total, soDongMoiTrang: PRODUCT_PAGE_SIZE });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle title="Sản phẩm">
          <p className="text-sm text-muted-foreground">
            {kpi.totalProducts.toLocaleString("vi-VN")} sản phẩm · {kpi.totalVariants.toLocaleString("vi-VN")} SKU
          </p>
        </PageTitle>
        {suaGiaVon && (
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Đường vào CỐ ĐỊNH cho màn đồng bộ giá vốn. Không dựa vào dải cảnh báo: dải đó im khi
            "đang khớp" (đúng ý) NHƯNG cũng im ở mức `chua-kiem` — nếu đó là link duy nhất thì màn
            duyệt bị cô lập, chỉ vào được bằng gõ tay URL.
          */}
          <Link
            href="/san-pham/dong-bo-gia-von"
            className="rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-surface-soft hover:text-ink"
          >
            Đồng bộ giá vốn từ Pancake
          </Link>
          <CostImportModal choPhepTaiMau={coQuyen(nd, "xuat-du-lieu")} />
        </div>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Dữ liệu sản phẩm/giá bán/tồn đồng bộ từ Pancake — chỉnh sửa tại Pancake.
        {suaGiaVon &&
          " App chỉ quản lý giá vốn và ngưỡng cảnh báo. Nhập giá vốn ở cấp sản phẩm để áp cho tất cả biến thể, hoặc mở rộng để sửa riêng từng biến thể."}
      </p>

      <ProductKpiCards du={du} />
      <ProductToolbar coQuyenGiaVon={quyen.coQuyenGiaVon} />

      {bang.products.length > 0 ? (
        <ProductGroupTable bang={bang} suaNguong={suaNguong} total={total} page={page} defaultThreshold={defaultThreshold} />
      ) : (
        <EmptyState missingCost={missingCost} soldMissingCost={soldMissingCost} lowOnly={lowOnly} q={sp.q} />
      )}
    </div>
  );
}

function EmptyState({
  missingCost,
  soldMissingCost,
  lowOnly,
  q,
}: {
  missingCost: boolean;
  soldMissingCost: boolean;
  lowOnly: boolean;
  q?: string;
}) {
  if (q) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Không tìm thấy sản phẩm khớp «{q}»</p>;
  }
  // ĐỨNG TRƯỚC nhánh `missingCost`: rỗng ở bộ lọc này là ĐÍCH CẦN ĐẠT (nhập xong giá vốn cho mọi
  // SKU đã bán), không phải sự cố. Thiếu nhánh riêng thì nó rơi xuống câu chốt "Chưa có sản phẩm —
  // chờ đồng bộ Pancake" — vừa sai (kho vẫn đủ SKU, ngay dòng tiêu đề còn in tổng) vừa xui chủ shop
  // đi đồng bộ đúng lúc họ vừa làm xong việc cần làm.
  if (soldMissingCost) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
        <p>🎉 Mọi SKU đã bán đều đã có giá vốn — số lãi không còn bị thổi lên vì thiếu giá vốn</p>
        <p className="text-xs">
          Biến thể chưa bán ngày nào có thể vẫn thiếu giá vốn, nhưng chúng không ảnh hưởng con số lãi/lỗ.
        </p>
        <div className="flex gap-3">
          <a href="?loc=thieu_gia_von" className="text-primary hover:underline">
            Xem cả kho
          </a>
          <a href="?" className="text-primary hover:underline">
            Xóa bộ lọc
          </a>
        </div>
      </div>
    );
  }
  if (missingCost) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
        <p>🎉 Mọi sản phẩm đều đã có giá vốn</p>
        <a href="?" className="text-primary hover:underline">
          Xóa bộ lọc
        </a>
      </div>
    );
  }
  if (lowOnly) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
        <p>🎉 Không có sản phẩm nào dưới ngưỡng cảnh báo</p>
        <a href="?" className="text-primary hover:underline">
          Xóa bộ lọc
        </a>
      </div>
    );
  }
  return (
    <p className="py-12 text-center text-sm text-muted-foreground">
      Chưa có sản phẩm — chờ đồng bộ Pancake, hoặc bấm «Đồng bộ ngay»
    </p>
  );
}
