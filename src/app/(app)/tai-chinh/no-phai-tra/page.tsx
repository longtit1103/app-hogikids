import { format } from "date-fns";
import Link from "next/link";

import { BatChecklist } from "@/components/no-phai-tra/bat-checklist";
import { BatChonNgayForm } from "@/components/no-phai-tra/bat-chon-ngay-form";
import { BatDaBatTomTat } from "@/components/no-phai-tra/bat-da-bat-tom-tat";
import { XacNhanBatWizard } from "@/components/no-phai-tra/bat-xac-nhan-wizard";
import { GhiNhanPhieuVaoSoNo } from "@/components/no-phai-tra/ghi-nhan-phieu-vao-so-no";
import { NoPhieuNhapSection } from "@/components/no-phai-tra/no-phieu-nhap-section";
import { TheTinDungSection } from "@/components/no-phai-tra/the-tin-dung-section";
import { ViAdsSection } from "@/components/no-phai-tra/vi-ads-section";
import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { kiemDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";
import { docKhoiNoPhaiTra } from "@/lib/no-phai-tra/doc-khoi-no-phai-tra";
import { docPhieuChoGhiNo } from "@/lib/no-phai-tra/doc-phieu-cho-ghi-no";
import {
  chuanHoaNgayM,
  docDieuChinhDaGhi,
  ngayTruoc,
  nhanNgay,
  theChoBat,
  viChoBat,
} from "@/lib/no-phai-tra/doc-trang-no-phai-tra";
import { docHoSoViAds } from "@/lib/no-phai-tra/vi-ads-queries";
import { yeuCauChuShopTrang } from "@/lib/quyen/cong-trang";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

type SearchParams = { tab?: string; m?: string };

/**
 * Trang NỢ PHẢI TRẢ — chuẩn bị và xác nhận BẬT theo dõi nợ (spec `design.md` §5.4). CHỈ chủ shop.
 *
 * Chưa bật: tab **Chuẩn bị** (chọn ngày bật, checklist điều kiện, hồ sơ thẻ + gắn nền tảng, ghi nhận phiếu
 * còn nợ, hồ sơ ví quảng cáo trả trước — hồ sơ KHÔNG đổi quỹ) và tab **Xác nhận** (chỉ mở khi hôm nay ≥
 * ngày bật: khai số dư cuối ngày trước đó, đối chiếu tiền thật, chọn điều chỉnh, bật một lần). Đã bật:
 * hiện mốc + các dòng điều chỉnh đã ghi + hồ sơ ví (ví mới vẫn tạo được).
 */
export default async function NoPhaiTraPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await yeuCauChuShopTrang("/tai-chinh/no-phai-tra");
  const sp = await searchParams;
  const daBat = await docMocM();

  if (daBat !== null) {
    const [dieuChinh, vis] = await Promise.all([docDieuChinhDaGhi(), docHoSoViAds()]);
    return (
      <div className="flex flex-col gap-6">
        <TieuDe />
        <BatDaBatTomTat nhanM={format(daBat, "dd/MM/yyyy")} dieuChinh={dieuChinh} />
        <ViAdsSection vis={vis} daBat />
      </div>
    );
  }

  const mocM = chuanHoaNgayM(sp.m);
  const mocMDate = new Date(`${mocM}T00:00:00+07:00`);
  const daToiM = khoaNgayVn(new Date()) >= mocM;
  const tab = sp.tab === "xac-nhan" && daToiM ? "xac-nhan" : "chuan-bi";
  const [khoi, vis, loiDieuKien, phieuChoGhi] = await Promise.all([
    docKhoiNoPhaiTra(),
    docHoSoViAds(),
    kiemDieuKienBat({ mocM: mocMDate }),
    tab === "chuan-bi" ? docPhieuChoGhiNo() : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <TieuDe />
      <BatChonNgayForm mocM={mocM} tab={tab} />
      <nav className="flex gap-2 border-b border-hairline" aria-label="Các bước bật theo dõi nợ">
        <TabLink href={`/tai-chinh/no-phai-tra?tab=chuan-bi&m=${mocM}`} active={tab === "chuan-bi"}>
          Chuẩn bị
        </TabLink>
        {daToiM ? (
          <TabLink href={`/tai-chinh/no-phai-tra?tab=xac-nhan&m=${mocM}`} active={tab === "xac-nhan"}>
            Xác nhận
          </TabLink>
        ) : (
          <span className="px-3 py-2 text-sm text-muted-foreground" title="Mở từ ngày bật">
            Xác nhận (mở từ {nhanNgay(mocM)})
          </span>
        )}
      </nav>

      {tab === "chuan-bi" ? (
        <>
          <BatChecklist loi={loiDieuKien} />
          <TheTinDungSection the={khoi.the} mocM={null} goiYChot={khoi.goiYChot} choPhepSua laChuShop />
          <ViAdsSection vis={vis} daBat={false} />
          {khoi.phieu.length > 0 && <NoPhieuNhapSection phieu={khoi.phieu} vanTay={khoi.vanTay} mocM={null} choPhepSua />}
          <section className="flex flex-col gap-2">
            <h2 className="font-serif text-lg text-ink">Ghi nhận phiếu nhập còn nợ nhà cung cấp</h2>
            {phieuChoGhi.length === 0 ? (
              <p className="text-sm text-muted-foreground">Không có phiếu nhập Pancake nào chờ ghi nhận.</p>
            ) : (
              <GhiNhanPhieuVaoSoNo phieu={phieuChoGhi} mocM={mocM} laChuShop choPhepSua choPhepTraNgay={false} />
            )}
          </section>
        </>
      ) : (
        <XacNhanBatWizard
          mocM={mocM}
          nhanM={nhanNgay(mocM)}
          ngayTruocM={ngayTruoc(mocM)}
          nhanTruocM={nhanNgay(ngayTruoc(mocM))}
          the={theChoBat(khoi.the, mocMDate)}
          vi={viChoBat(vis)}
          loiDieuKien={loiDieuKien
            .filter((l) => l.code !== "THIEU_HO_SO_VI" && l.code !== "CON_NHAP_HANG_SAU_M")
            .map((l) => l.message)}
          thieuHoSoVi={loiDieuKien.find((l) => l.code === "THIEU_HO_SO_VI")?.message ?? null}
          nhapHangSauM={loiDieuKien.find((l) => l.code === "CON_NHAP_HANG_SAU_M")?.nhapHangSauM ?? null}
        />
      )}
    </div>
  );
}

function TieuDe() {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="font-serif text-2xl text-ink">Nợ phải trả</h1>
      <p className="text-sm text-muted-foreground">
        Theo dõi tiền hàng nhà cung cấp, thẻ tín dụng và ví quảng cáo trả trước để quỹ khớp số dư ngân hàng thật.
      </p>
    </div>
  );
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`-mb-px border-b-2 px-3 py-2 text-sm ${active ? "border-ink text-ink" : "border-transparent text-muted-foreground"}`}
    >
      {children}
    </Link>
  );
}
