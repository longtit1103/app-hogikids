import { ChuThichNguon } from "@/components/marketing/chu-thich-nguon";
import { CreatorDrawer } from "@/components/marketing/creator-drawer";
import { CreatorSection } from "@/components/marketing/creator-section";
import { MarketingTabNav, isMarketingTab, type MarketingTab } from "@/components/marketing/marketing-tab-nav";
import { NoiDungSection } from "@/components/marketing/noi-dung-section";
import { PheuTiktokSection } from "@/components/marketing/pheu-tiktok-section";
import { QuangCaoChienDichSection } from "@/components/marketing/quang-cao-chien-dich-section";
import { SanPhamNguonSection } from "@/components/marketing/san-pham-nguon-section";
import { clampRangeEndToNow, resolveRangeFromParams } from "@/lib/date-range";
import { docSoTrang, veTrangCuoiNeuVuot } from "@/lib/pagination";
import { affiliateTheoKy } from "@/lib/reports/marketing/affiliate-pancake";
import { tinhChuThichDoTuoi } from "@/lib/reports/marketing/cau-do-tuoi-du-lieu";
import { creatorTiktok, donCuaCreator } from "@/lib/reports/marketing/creator-tiktok";
import { gmvMaxTheoSanPham } from "@/lib/reports/marketing/gmv-max-theo-san-pham";
import { hoanHuyTach } from "@/lib/reports/marketing/hoan-huy-tach";
import { khachTheoKy } from "@/lib/reports/marketing/khach-tiktok";
import { liveTiktok } from "@/lib/reports/marketing/live-tiktok";
import { ngayTrongKy } from "@/lib/reports/marketing/cong-so-san";
import { xepNgayTheoMoc } from "@/lib/reports/marketing/moc-du-lieu-san-sang";
import { KHOI_NGUON, type KhoiNguon, nguonDoanhSoTiktok } from "@/lib/reports/marketing/nguon-doanh-so-tiktok";
import { pheuTiktok } from "@/lib/reports/marketing/pheu-tiktok";
import { quangCaoTheoChienDich } from "@/lib/reports/marketing/quang-cao-chien-dich";
import { sanPhamNguonTiktok } from "@/lib/reports/marketing/san-pham-nguon-tiktok";
import { lanChayOkGanNhatAnalyticsTheoStream } from "@/lib/reports/marketing/suc-khoe-dong-bo-analytics";
import { type LoaiTaiKhoanVideo, videoTiktok } from "@/lib/reports/marketing/video-tiktok";
import { computeChannelDailyOrderCount } from "@/lib/reports/daily-series";
import { calcPnl } from "@/lib/reports/pnl";
import { requireUser } from "@/lib/session";
import { KhoiAffiliate, TongQuanP1Section } from "@/components/marketing/tong-quan-p1-section";
import { DONG_MOI_TRANG_MARKETING } from "@/components/marketing/phan-trang-marketing";

type SearchParams = {
  tu?: string;
  den?: string;
  range?: string;
  tab?: string;
  trang?: string;
  /** Trang bảng Video ở tab `noi-dung` — TÁCH khỏi `tranglive` (fix vòng B-2, việc #4). */
  trangvideo?: string;
  /** Trang bảng Phiên live ở tab `noi-dung`. */
  tranglive?: string;
  taikhoan?: string;
  nguon?: string;
  /** Mở drawer đơn cấp SKU của MỘT creator ở tab `creator` — cùng cơ chế `?don=` của /don-hang. */
  creator?: string;
};

/** Kênh Pancake duy nhất mà mục Marketing đọc ở P1/P2 — TikTok (Shopee/Ads Meta ngoài scope, xem design.md). */
const KENH_TIKTOK = "tiktok";

function docLoaiTaiKhoan(v: string | undefined): LoaiTaiKhoanVideo {
  return v === "OFFICIAL_ACCOUNTS" || v === "AFFILIATE_ACCOUNTS" || v === "MARKETING_ACCOUNTS" ? v : "ALL";
}

function docKhoiNguon(v: string | undefined): KhoiNguon {
  return v !== undefined && v in KHOI_NGUON ? (v as KhoiNguon) : "total";
}

/**
 * `/marketing` — mục trả lời CẤP HOẠT ĐỘNG (video · live · KOC · chiến dịch) bằng số DO SÀN BÁO.
 * Khuôn giống `/tai-chinh`: server component, 5 tab qua `?tab=`, kỳ theo date-range toàn cục.
 *
 * RANH GIỚI: mọi thứ ở đây chỉ ĐỌC và HIỂN THỊ. Không reader nào của mục này được lọt vào `pnl.ts`,
 * Dashboard hay `/kenh` — `tests/unit/marketing/khong-ro-ri-vao-pnl.test.ts` canh việc đó. Chiều
 * ngược lại (mục này GỌI `calcPnl`/`computeChannelDailyOrderCount` của `pnl.ts`/`daily-series.ts`)
 * là được PHÉP và có chủ đích — bất biến #1: một nguồn công thức doanh thu duy nhất, Marketing
 * không được tự cộng lại đơn/doanh thu Pancake mà phải MƯỢN hàm đã có.
 */
export default async function MarketingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();

  const sp = await searchParams;
  const now = new Date();
  // Kẹp biên phải về hôm nay như `/kenh`: "Tháng này" không được kéo tới ngày tương lai.
  const range = clampRangeEndToNow(resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range }, now), now);
  const tab: MarketingTab = isMarketingTab(sp.tab) ? sp.tab : "tong-quan";

  let content: React.ReactNode;
  if (tab === "quang-cao") {
    const quangCao = await quangCaoTheoChienDich(range);
    // Bảng con item-level (Step 4): chỉ cần chi GMV Max (GỒM VAT) theo TỪNG chiến dịch — đã có sẵn
    // ở `chiGmvMax` của mỗi dòng, KHÔNG query lại tiền lần hai (đúng lý do reader đã trả field này).
    const chiGmvMaxTheoChienDich: Record<string, number> = {};
    for (const c of quangCao.chienDich) {
      if (c.chiGmvMax !== null) chiGmvMaxTheoChienDich[c.campaignId] = c.chiGmvMax;
    }
    const itemTheoChienDich = await gmvMaxTheoSanPham(range, chiGmvMaxTheoChienDich);
    content = (
      <>
        <QuangCaoChienDichSection dulieu={quangCao} itemTheoChienDich={itemTheoChienDich} />
        <ChuThichNguon nguon={["TIKTOK_ADS"]} />
      </>
    );
  } else if (tab === "creator") {
    // Bảng creator = SỐ SÀN (`RawTiktokShopAffiliateOrder` — TikTok quy công cho creator); khối
    // *Affiliate theo kỳ (Pancake)* của P1 đứng CẠNH với nhãn riêng — hai nguồn đếm hai thứ khác
    // nhau (sàn gồm cả INELIGIBLE/hoàn; Pancake chỉ ghi khi thật sự bị trừ hoa hồng) ⇒ KHÔNG trộn,
    // KHÔNG đối chiếu "lệch".
    const trang = docSoTrang(sp.trang);
    const [creator, affiliate, donDrawer] = await Promise.all([
      creatorTiktok(range),
      affiliateTheoKy(range, { channelId: KENH_TIKTOK }),
      sp.creator !== undefined ? donCuaCreator(range, sp.creator) : Promise.resolve(null),
    ]);
    veTrangCuoiNeuVuot({
      duongDan: "/marketing",
      sp,
      trang,
      tong: creator.dong.length,
      soDongMoiTrang: DONG_MOI_TRANG_MARKETING,
    });
    content = (
      <div className="flex flex-col gap-4">
        <CreatorSection duLieu={creator} sp={sp} trang={trang} />
        <KhoiAffiliate d={affiliate} />
        <ChuThichNguon nguon={["TIKTOK_SHOP_ANALYTICS", "PANCAKE"]} />
        <CreatorDrawer creator={sp.creator ?? null} dong={donDrawer} />
      </div>
    );
  } else if (tab === "tong-quan") {
    // Bắt ĐÍCH DANH `tong-quan`, KHÔNG dùng `else` gom: `noi-dung` và `san-pham` cũng rơi vào đây,
    // và chúng sẽ hiện nguyên khối Pancake (sai nội dung tab) + bắn nhiều truy vấn thừa cho một tab
    // đáng lẽ chỉ đọc analytics.
    //
    // KPI Pancake (đơn · doanh thu gộp · chi quảng cáo) lấy THẲNG từ `calcPnl` — công thức doanh thu
    // DUY NHẤT của app (bất biến #1) — KHÔNG tự cộng lại `itemsTotal`/đếm đơn ở đây.
    //
    // `lanChayOkTheoStream`: bằng chứng ĐỘ TƯƠI (ruling P2-R35), TÁCH THEO TỪNG stream (ruling
    // P2-R40) — `pheu` đọc `tiktok/analytics_shop`, `nguon` đọc `tiktok/analytics_products`; xét
    // nhầm stream của khối kia là đúng lỗi P2-R40 vừa vá. Chốt CHUNG một `now` (đã có ở đầu hàm) cho
    // mọi khối trên trang, để hai khối cùng render trong một lượt không lỡ so hai "bây giờ" khác nhau.
    //
    // Câu chữ ĐỘ TƯƠI tính XONG ở đây (`tinhChuThichDoTuoi`, ruling P2-R38) — `PheuTiktokSection`
    // ("use client" vì chart recharts) chỉ nhận chuỗi/`null` đã tính sẵn, KHÔNG tự gọi lại
    // `quyetDinhCauDoTuoi`/`cauThieuDuLieu` lúc hydrate (bẫy TZ trình duyệt, xem docblock hàm đó).
    const [pheu, nguon, pancake, donTheoNgayPancake, affiliate, khach, hoanHuy, lanChayOkTheoStream] =
      await Promise.all([
        pheuTiktok(range),
        nguonDoanhSoTiktok(range),
        calcPnl(range, { channelId: KENH_TIKTOK }),
        computeChannelDailyOrderCount(range, KENH_TIKTOK),
        affiliateTheoKy(range, { channelId: KENH_TIKTOK }),
        khachTheoKy(range, { channelId: KENH_TIKTOK }),
        hoanHuyTach(range),
        lanChayOkGanNhatAnalyticsTheoStream(),
      ]);
    const chuThichPheu = tinhChuThichDoTuoi({
      mocSanSang: pheu.mocSanSang,
      soNgayChuaSanSang: pheu.soNgayChuaSanSang,
      soNgayThieu: pheu.soNgayThieu,
      lanChayOkGanNhat: lanChayOkTheoStream["tiktok/analytics_shop"],
      bayGio: now,
    });
    const chuThichNguon = tinhChuThichDoTuoi({
      mocSanSang: nguon.mocSanSang,
      soNgayChuaSanSang: nguon.soNgayChuaSanSang,
      soNgayThieu: nguon.soNgayThieu,
      lanChayOkGanNhat: lanChayOkTheoStream["tiktok/analytics_products"],
      bayGio: now,
    });
    content = (
      <div className="flex flex-col gap-4">
        <PheuTiktokSection
          pheu={pheu}
          nguon={nguon}
          donPancake={pancake.orderCount}
          doanhThuGopPancake={pancake.revenue}
          chiQuangCao={pancake.ads}
          donTheoNgayPancake={donTheoNgayPancake}
          chuThichPheu={chuThichPheu}
          chuThichNguon={chuThichNguon}
        />
        <TongQuanP1Section affiliate={affiliate} khach={khach} hoanHuy={hoanHuy} />
        {/* Phễu/Nguồn doanh số đọc TikTok Shop Analytics ⇒ thêm nguồn này cạnh PANCAKE (khối P1 vẫn
            là số Pancake thật). P1 tạm bỏ nguồn này vì lúc đó chưa có dữ liệu — nay P2 đã nối xong.
            Chỉ thêm câu TIKTOK_SHOP_ANALYTICS khi CÓ kết nối (`mocSanSang` khác null ở pheu HOẶC
            nguon — cả hai đọc chung một stream, chỉ khác trường) — fix vòng B-2, việc #7: chưa kết
            nối thì cả hai khối phía trên toàn dấu "—", câu này mô tả một nguồn chưa có số nào. */}
        <ChuThichNguon
          nguon={
            pheu.mocSanSang !== null || nguon.mocSanSang !== null
              ? ["TIKTOK_SHOP_ANALYTICS", "PANCAKE"]
              : ["PANCAKE"]
          }
        />
      </div>
    );
  } else if (tab === "noi-dung") {
    // Video và Phiên live là hai bảng ĐỘ DÀI khác hẳn nhau — tách RIÊNG tham số trang cho từng bảng
    // (fix vòng B-2, việc #4): dùng chung `?trang=` khiến "trang sau" của Video đẩy Live sang trang
    // rỗng rồi tự mâu thuẫn với dòng đếm của chính nó ("Không có phiên live nào" đứng ngay trên
    // "5 phiên live"). Xem docblock đầu `noi-dung-section.tsx`.
    const trangVideo = docSoTrang(sp.trangvideo);
    const trangLive = docSoTrang(sp.tranglive);
    const taiKhoanDangLoc = docLoaiTaiKhoan(sp.taikhoan);
    const [video, live, lanChayOkTheoStream] = await Promise.all([
      videoTiktok(range, { loaiTaiKhoan: taiKhoanDangLoc }),
      liveTiktok(range),
      lanChayOkGanNhatAnalyticsTheoStream(),
    ]);
    veTrangCuoiNeuVuot({
      duongDan: "/marketing",
      sp,
      trang: trangVideo,
      tong: video.video.length,
      soDongMoiTrang: DONG_MOI_TRANG_MARKETING,
      thamSo: "trangvideo",
    });
    veTrangCuoiNeuVuot({
      duongDan: "/marketing",
      sp,
      trang: trangLive,
      tong: live.phien.length,
      soDongMoiTrang: DONG_MOI_TRANG_MARKETING,
      thamSo: "tranglive",
    });
    // Bảng Video đọc `tiktok/analytics_videos` (ruling P2-R40) — KHÔNG dùng chung mốc với products/shop.
    const chuThichVideo = tinhChuThichDoTuoi({
      mocSanSang: video.mocSanSang,
      soNgayChuaSanSang: video.soNgayChuaSanSang,
      soNgayThieu: video.soNgayThieu,
      lanChayOkGanNhat: lanChayOkTheoStream["tiktok/analytics_videos"],
      bayGio: now,
    });
    // Bảng Live — fix vòng B-2, việc #1: `LiveTiktok` cố ý KHÔNG có `soNgayThieu`/`soNgayChuaSanSang`
    // riêng (phiên live là thực thể có id, không phải chuỗi ngày, xem docblock `live-tiktok.ts`), nên
    // suy `soNgayChuaSanSang` ở ĐÂY bằng đúng phép xếp ngày dùng chung (`xepNgayTheoMoc`) với tập
    // "ngày có số" RỖNG — chỉ cần biết ngày nào trong kỳ đã VƯỢT mốc sàn báo, không cần biết ngày nào
    // Bronze có dòng (đó là khái niệm "thiếu" mà Live cố ý không có ⇒ `soNgayThieu: 0` bên dưới).
    const { soNgayChuaSanSang: soNgayChuaSanSangLive } = xepNgayTheoMoc(
      ngayTrongKy(range),
      new Set<string>(),
      live.mocSanSang,
    );
    const chuThichLive = tinhChuThichDoTuoi({
      mocSanSang: live.mocSanSang,
      soNgayChuaSanSang: soNgayChuaSanSangLive,
      soNgayThieu: 0,
      lanChayOkGanNhat: lanChayOkTheoStream["tiktok/analytics_lives"],
      bayGio: now,
    });
    content = (
      <div className="flex flex-col gap-4">
        <NoiDungSection
          video={video}
          live={live}
          sp={sp}
          trangVideo={trangVideo}
          trangLive={trangLive}
          taiKhoanDangLoc={taiKhoanDangLoc}
          chuThichVideo={chuThichVideo}
          chuThichLive={chuThichLive}
        />
        <ChuThichNguon nguon={["TIKTOK_SHOP_ANALYTICS"]} />
      </div>
    );
  } else {
    // tab === "san-pham"
    const trang = docSoTrang(sp.trang);
    const khoi = docKhoiNguon(sp.nguon);
    const [duLieu, lanChayOkTheoStream] = await Promise.all([
      sanPhamNguonTiktok(range, khoi),
      lanChayOkGanNhatAnalyticsTheoStream(),
    ]);
    veTrangCuoiNeuVuot({
      duongDan: "/marketing",
      sp,
      trang,
      tong: duLieu.dong.length,
      soDongMoiTrang: DONG_MOI_TRANG_MARKETING,
    });
    // Bảng "Sản phẩm × nguồn" đọc `tiktok/analytics_products` (giống khối "Nguồn doanh số" ở tab
    // Tổng quan) — ruling P2-R40.
    const chuThichSanPham = tinhChuThichDoTuoi({
      mocSanSang: duLieu.mocSanSang,
      soNgayChuaSanSang: duLieu.soNgayChuaSanSang,
      soNgayThieu: duLieu.soNgayThieu,
      lanChayOkGanNhat: lanChayOkTheoStream["tiktok/analytics_products"],
      bayGio: now,
    });
    content = (
      <div className="flex flex-col gap-4">
        <SanPhamNguonSection
          duLieu={duLieu}
          khoi={khoi}
          sp={sp}
          trang={trang}
          chuThichSanPham={chuThichSanPham}
        />
        <ChuThichNguon nguon={["TIKTOK_SHOP_ANALYTICS"]} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-2xl text-ink">Marketing</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Hiệu quả nội dung · creator · quảng cáo — số do sàn báo, đặt cạnh số thật từ Pancake
        </p>
      </div>

      <MarketingTabNav tab={tab} sp={sp} />

      {content}
    </div>
  );
}
