import { chuanHoaSearchParams, type SearchParamsTho } from "@/lib/chuan-hoa-search-params";

import { ChuaSyncEmptyState } from "@/components/dashboard/chua-sync-empty-state";
import { hrefDuocPhep } from "@/components/shell/nav-config";
import { BanChay } from "@/components/trang-chu/ban-chay";
import { ChiSoProvider, HangTheSo, KhoiBieuDoTheoNgay } from "@/components/trang-chu/chi-so-dang-chon";
import { LaiNhieuNenDay } from "@/components/trang-chu/lai-nhieu-nen-day";
import { SapHetHang } from "@/components/trang-chu/sap-het-hang";
import { TheoKenh } from "@/components/trang-chu/theo-kenh";
import { TienDiDau } from "@/components/trang-chu/tien-di-dau";
import { TinhTrangDon } from "@/components/trang-chu/tinh-trang-don";
import { resolveRangeFromParams } from "@/lib/date-range";
import { docLuaChonDaLuu } from "@/lib/date-range-cookie-server";
import { prisma } from "@/lib/prisma";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { coQuyen } from "@/lib/quyen/nguoi-dung-phien";
import { taiDuLieuTrangChu } from "@/lib/trang-chu/tai-du-lieu-trang-chu";

type SearchParams = { tu?: string; den?: string; range?: string };

/**
 * Trang chủ "Tổng quan" (spec trang-chu-redesign-261031): MỘT kỳ của bộ chọn toàn cục điều khiển MỌI số.
 * Số liệu do `taiDuLieuTrangChu` dựng theo quyền (thiếu `gia-von-loi-nhuan:xem` ⇒ nhánh DTO che, không
 * mang giá vốn / chi phí / lãi); khối thuộc module khác null khi thiếu quyền ⇒ không dựng.
 */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParamsTho<SearchParams>> }) {
  const nd = await yeuCauQuyenTrang("/", "tong-quan:xem");
  // Link trên trang chỉ dựng khi người xem vào được trang đích (cùng nguồn với menu).
  const hrefs = hrefDuocPhep(nd);

  const [pancakeSyncCount, orderCount] = await Promise.all([
    prisma.syncLog.count({ where: { kind: "PANCAKE" } }),
    prisma.order.count(),
  ]);
  if (pancakeSyncCount === 0 && orderCount === 0) {
    return <ChuaSyncEmptyState choPhepDongBo={coQuyen(nd, "cai-dat:sua")} hrefDuocPhep={hrefs} />;
  }

  const sp = chuanHoaSearchParams(await searchParams);
  // Kỳ chung: ?tu=&den= (Tùy chọn) → ?range=<preset> → cookie đã lưu → this_month.
  const range = resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range }, new Date(), await docLuaChonDaLuu());
  const du = await taiDuLieuTrangChu(nd, range, new Date());

  // Link sang Lãi/Lỗ trong "Tiền bán hàng đi đâu" chỉ khi có khối này (đã qua quyền giá vốn) ∧ vào được tab.
  const choPhepXemLoiLo = du.tienDiDau !== null && coQuyen(nd, "tai-chinh-loi-lo:xem");

  const khoiDuoi = [
    du.banChay && <BanChay key="ban-chay" rows={du.banChay} hrefDuocPhep={hrefs} />,
    du.laiNenDay && <LaiNhieuNenDay key="lai-nen-day" du={du.laiNenDay} hrefDuocPhep={hrefs} />,
    du.sapHet && <SapHetHang key="sap-het" rows={du.sapHet.rows} total={du.sapHet.total} hrefDuocPhep={hrefs} />,
  ].filter(Boolean);
  // Các khối còn lại chia đều hàng (3 khối → mỗi khối 4/12).
  const cotKhoiDuoi = khoiDuoi.length === 3 ? "lg:grid-cols-3" : khoiDuoi.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-1";

  return (
    // Nền xám phủ kín vùng nội dung của <main> (bù đúng padding px-4/md:px-6, pt-6, pb-16/md:pb-6 của shell).
    <div
      className="-mx-4 -mt-6 -mb-16 flex flex-col gap-4 bg-tq-nen px-4 pt-6 pb-16 md:-mx-6 md:-mb-6 md:px-6 md:pb-6"
      data-khoang-server={du.khoangServer}
    >
      {/*
        Tiêu đề tự dựng, KHÔNG dùng `PageTitle` của shell: nó cứng `font-serif`, còn spec trang chủ §6 đòi tiêu đề
        chữ không chân. Giữ `data-slot="page-title"` + `hidden md:flex print:flex` (cùng quy tắc ẩn dưới md vì
        Topbar đã ghi tên; dòng "so với …" nằm NGOÀI khối này nên không bị ẩn) để các e2e PageTitle/mobile vẫn
        nhận ra. `font-sans` thắng luật h1–h6 serif của globals.css vì luật đó nằm trong `@layer base`, còn
        utility nằm ở layer cao hơn.
      */}
      <div data-slot="page-title" className="hidden flex-col md:flex print:flex">
        <h1 className="font-sans text-2xl font-semibold tracking-tight text-tq-chu-dam">Tổng quan</h1>
      </div>
      {/*
        Mốc của mọi huy hiệu "↗ 18%" bên dưới — hiện ở MỌI khổ (điện thoại không có h1 trong nội dung nhưng vẫn cần
        biết đang so với gì). Từ md kéo sát h1 (-mt-3 bù `gap-4` của khung) để vẫn đọc như dòng phụ của tiêu đề.
      */}
      <p data-testid="nhan-ky-so-sanh" className="text-[13px] text-tq-chu-phu md:-mt-3 md:text-sm">
        so với {du.theVaBieuDo.nhanKySoSanh}
      </p>

      <ChiSoProvider coQuyenGiaVon={du.theVaBieuDo.coQuyenGiaVon}>
        <HangTheSo du={du.theVaBieuDo} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-8">
            <KhoiBieuDoTheoNgay du={du.theVaBieuDo} />
          </div>
          <div className="min-w-0 lg:col-span-4">
            <TinhTrangDon du={du.tinhTrangDon} ky={du.kyDangXem} hrefDuocPhep={hrefs} />
          </div>
        </div>
      </ChiSoProvider>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {du.tienDiDau && (
          <div className="min-w-0 lg:col-span-6">
            <TienDiDau du={du.tienDiDau} choPhepXemLoiLo={choPhepXemLoiLo} />
          </div>
        )}
        <div className={du.tienDiDau ? "min-w-0 lg:col-span-6" : "min-w-0 lg:col-span-12"}>
          <TheoKenh du={du.theoKenh} hrefDuocPhep={hrefs} />
        </div>
      </div>

      {khoiDuoi.length > 0 && <div className={`grid grid-cols-1 gap-4 ${cotKhoiDuoi}`}>{khoiDuoi}</div>}
    </div>
  );
}
