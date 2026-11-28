import { DauTrangDonHang } from "@/components/don-hang/dau-trang-don-hang";
import { KhungDanhSachDonHang } from "@/components/don-hang/khung-danh-sach-don-hang";
import { locSauKhiBatTat } from "@/components/don-hang/lua-chon-loc-don-hang";
import { TheSoDonHang } from "@/components/don-hang/the-so-don-hang";
import type { DieuHuongDon } from "@/components/orders/drawer-dau-don";
import { OrderDetailDrawer } from "@/components/orders/order-detail-drawer";
import { chuanHoaSearchParams, type SearchParamsTho } from "@/lib/chuan-hoa-search-params";
import { docThamSoDonHang, hrefDonHang, nhanKyDonHang, queryXuatDonHang } from "@/lib/orders/doc-tham-so-don-hang";
import type { DonKeBen } from "@/lib/orders/don-hang-kieu-du-lieu";
import { khopBangLaiLo } from "@/lib/orders/khop-bang-lai-lo";
import { veTrangCuoiNeuVuot } from "@/lib/pagination";
import { prisma } from "@/lib/prisma";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { getLastPancakeSyncAt, getOrderDetail, ORDER_PAGE_SIZE } from "@/lib/queries/orders";
import { getDonKeBen } from "@/lib/queries/orders-don-ke-ben";
import { getTrangDonHang } from "@/lib/queries/orders-trang-don-hang";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { coQuyen } from "@/lib/quyen/nguoi-dung-phien";

/**
 * Trang Đơn hàng (spec `docs/design-spec/don-hang-redesign-261127/spec-don-hang-moi.md`): chỉ xem.
 *
 * Mọi con số đến từ hàm truy vấn (lãi từng đơn tính ở database, cùng công thức `order-profit.ts`) — trang
 * chỉ ráp props, không cộng/trừ tiền. Bộ lọc đọc MỘT lần bằng `docThamSoDonHang` (đã bỏ chip/sắp xếp cần
 * giá vốn khi người xem thiếu quyền); hàm truy vấn kẹp lại lần nữa.
 */
export default async function DonHangPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsTho<Record<string, string>>>;
}) {
  // Cổng NGAY TẠI TRANG, không chỉ dựa vào `(app)/layout.tsx`: một request RSC dựng tay có
  // thể xin riêng segment trang mà không chạy lại layout ⇒ dữ liệu đơn hàng lọt ra ngoài phiên,
  // và mốc thu hồi phiên (đổi mật khẩu) cũng không được soi.
  const nd = await yeuCauQuyenTrang("/don-hang", "don-hang:xem");
  const quyen = quyenGiaVonCua(nd);

  // Tham số lặp (?kenh=a&kenh=b) Next trả MẢNG — chuẩn hoá trước khi đọc. Giữ cả khoá lạ để link dựng
  // lại không làm rơi tham số người khác thêm vào.
  const sp: Record<string, string | undefined> = chuanHoaSearchParams(await searchParams);
  const now = new Date();
  const boLoc = docThamSoDonHang(sp, quyen, now);

  const [trang, lastSyncAt, orderDetail, keBen, kenh] = await Promise.all([
    getTrangDonHang(boLoc, quyen, now),
    getLastPancakeSyncAt(),
    boLoc.don ? getOrderDetail(boLoc.don, quyen) : Promise.resolve(null),
    boLoc.don ? getDonKeBen(boLoc, boLoc.don, quyen, now) : Promise.resolve(null),
    prisma.channel.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true, color: true } }),
  ]);

  // `redirect()` ném lỗi điều khiển — gọi SAU khi có tổng và ngoài mọi try/catch.
  veTrangCuoiNeuVuot({ duongDan: "/don-hang", sp, trang: boLoc.trang, tong: trang.tong.soDon, soDongMoiTrang: ORDER_PAGE_SIZE });

  const qXuat = queryXuatDonHang(sp);
  const coLoc = boLoc.q !== "" || boLoc.channels.length > 0 || boLoc.loc.length > 0 || boLoc.statuses.length > 0;
  // Cảnh báo "N đơn thiếu giá vốn" dưới thẻ Lãi bấm sang chính tập đó; chip đã bật thì không còn gì để bật.
  const hrefThieuGiaVon = boLoc.loc.includes("thieu_gv") ? null : hrefDonHang(sp, { loc: locSauKhiBatTat(boLoc.loc, "thieu_gv"), don: null });

  return (
    // Nền xám phủ kín vùng nội dung của <main> như trang chủ (bù đúng padding của shell). Chữ Inter đến từ
    // luật `html { font-sans }` của toàn app; lớp `font-sans` ở đây chỉ nói rõ ý đồ, không còn là thứ quyết định.
    <div className="font-sans -mx-4 -mt-6 -mb-16 flex flex-col gap-4 bg-tq-nen px-4 pt-6 pb-16 md:-mx-6 md:-mb-6 md:px-6 md:pb-6">
      <DauTrangDonHang
        nhanKy={nhanKyDonHang(boLoc.ky)}
        nhanKySoSanh={trang.kyTruoc?.nhan ?? null}
        lastSyncAt={lastSyncAt}
        hrefXemTatCa={boLoc.ky.loai === "khoang" ? hrefDonHang(sp, { ky: "tat_ca" }) : null}
        hrefVeThangNay={boLoc.ky.loai === "tat_ca" ? hrefDonHang(sp, { ky: null }) : null}
        hrefXuatExcel={coQuyen(nd, "xuat-du-lieu") ? `/api/export/don-hang${qXuat ? `?${qXuat}` : ""}` : null}
      />
      <TheSoDonHang trang={trang} dangTim={boLoc.q !== ""} khop={khopBangLaiLo(boLoc)} hrefThieuGiaVon={hrefThieuGiaVon} />
      <KhungDanhSachDonHang trang={trang} boLoc={boLoc} sp={sp} kenh={kenh} coLoc={coLoc} now={now} />
      <OrderDetailDrawer order={orderDetail} dieuHuong={keBen ? dieuHuongTu(keBen, sp) : null} now={now} />
    </div>
  );
}

/** Cụm ‹ i / N › của drawer: href đổi `don` + `trang` (đơn kề bên có thể nằm ở trang khác). */
function dieuHuongTu(keBen: DonKeBen, sp: Record<string, string | undefined>): DieuHuongDon {
  const href = (d: { id: string; trang: number } | null) =>
    d ? hrefDonHang(sp, { don: d.id, trang: String(d.trang) }) : null;
  return { viTri: keBen.viTri, tong: keBen.tong, hrefTruoc: href(keBen.truoc), hrefSau: href(keBen.sau) };
}
