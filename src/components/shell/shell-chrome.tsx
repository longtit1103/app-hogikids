"use client";

import Link from "next/link";
import { useState } from "react";
import { format, parse } from "date-fns";

import type { TrangThaiLechGiaVon } from "@/lib/gia-von/trang-thai-lech-gia-von";
import { cauNhacPhieuNhap, type TrangThaiPhieuNhap } from "@/lib/nhap-hang/trang-thai-phieu-nhap";
import type { CanhBaoSapCan } from "@/lib/so-quy/du-bao-quy-types";

import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/**
 * Owns the mobile nav sheet's open state so the hamburger button (rendered
 * in `Topbar`) and the sheet content (rendered in `Sidebar`) share one
 * source of truth without prop-drilling through the server-only layout.
 */
export function ShellChrome({
  shopName,
  missingCostCount,
  lowStockWarning,
  dataSyncHasError,
  syncHasBacklog,
  saoLuuCoVanDe,
  lechGiaVon,
  soKhoanVayCoKyCho,
  phieuNhapChuaGhi,
  canhBaoSapCanQuy,
  children,
}: {
  shopName: string;
  missingCostCount: number;
  lowStockWarning: boolean;
  /** CHỈ kind ảnh hưởng số liệu (`DATA_SYNC_KINDS`) — KHÔNG gồm BACKUP, xem banner bên dưới. */
  dataSyncHasError: boolean;
  syncHasBacklog: boolean;
  /** Lượt sao lưu gần nhất LỖI, hoặc quá `GIO_QUA_HAN_SAO_LUU` giờ chưa có bản mới. */
  saoLuuCoVanDe: boolean;
  /** Lệch giá vốn app ↔ Pancake, số do lượt đêm chốt (`trang-thai-lech-gia-von.ts`). */
  lechGiaVon: TrangThaiLechGiaVon;
  /**
   * Số KHOẢN VAY đang có kỳ tới hạn chưa ghi (`demKhoanVayCoKyChoDuyet`) — mỗi khoản tối đa 1, nên
   * câu banner nói "khoản vay" chứ KHÔNG nói "kỳ". 0 thì không có banner nào.
   */
  soKhoanVayCoKyCho: number;
  /**
   * Phiếu nhập Pancake chưa vào Sổ chi phí — số do lượt đêm chốt
   * (`nhap-hang/trang-thai-phieu-nhap.ts`, cùng hàm thuần với giá vốn).
   */
  phieuNhapChuaGhi: TrangThaiPhieuNhap;
  /** Dự báo quỹ 30 ngày chạm ngưỡng tối thiểu — null = không chạm hoặc chưa mở sổ (`docCanhBaoSapCan`). */
  canhBaoSapCanQuy: CanhBaoSapCan;
  children: React.ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-canvas md:grid md:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar
        shopName={shopName}
        missingCostCount={missingCostCount}
        lowStockWarning={lowStockWarning}
        mobileOpen={mobileNavOpen}
        onMobileOpenChange={setMobileNavOpen}
      />
      <div className="flex min-h-screen min-w-0 flex-col">
        <Topbar onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 md:px-6">
          {/*
            Lưới an toàn TOÀN APP: khi Bronze còn backlog hoặc đồng bộ gần đây có lỗi,
            số liệu có thể sai/thiếu. Trước đây cảnh báo chỉ nằm ở trang Cài đặt nên chủ
            shop dễ đọc nhầm số ở Dashboard/Báo cáo. Banner sticky đỏ, dính mọi màn, dẫn
            thẳng về Cài đặt để xử lý. Chi tiết đầy đủ vẫn ở /cai-dat.

            Cờ backlog bật được từ NHIỀU nguồn, không chỉ đơn hàng: cổng đối soát của
            ingest soi cả 3 stream tiền-đã-về (statement/payment TikTok + ví Shopee), mà
            settlement/ví ĐỘC LẬP P&L (bất biến #7). Nên chữ phải nêu cả hai — nói riêng
            "số P&L thiếu" là khẳng định sai về tiền trong đúng ca đó.

            Chữ dẫn về Cài đặt là "xem cách xử lý", KHÔNG hứa "bấm nút là xong": nút
            "Dựng lại từ kho thô" tắt được cảnh báo này NHƯNG chỉ khi lượt chạy sạch
            hoàn toàn — còn kẹt thì nó giữ cờ và nói rõ vướng ở đâu, có ca phải chạy
            lệnh trên minipc mới xong (xem `dungLaiGiaoDichTuKhoTho`).

            Sao lưu (kind BACKUP) có NHÁNH RIÊNG, không trộn vào hai câu trên: backup hỏng
            không làm thiếu một đồng doanh thu nào, nói "số liệu có thể thiếu" là khẳng định
            sai. Nhưng nó cũng KHÔNG được im lặng — bỏ khỏi cảnh báo số liệu mà không đặt gì
            thay thế thì lượt backup hỏng chỉ còn dấu vết ở /cai-dat, nơi chủ shop không vào
            mỗi ngày, trong khi đây đúng là thứ phải biết TRƯỚC lúc cần bản phục hồi. Chi tiết
            ở `NON_DATA_SYNC_KINDS` (`lib/queries/sync-health.ts`).

            Thứ tự ưu tiên khi trùng nhau: backlog → lỗi đồng bộ → sao lưu. Số liệu sai dẫn
            tới quyết định kinh doanh sai ngay hôm nay; sao lưu hỏng chỉ thành thiệt hại khi
            cần phục hồi. Chỉ hiện MỘT câu để banner không thành khối chữ bị lướt qua.
          */}
          {/*
            MỘT vùng sticky chung cho MỌI banner, không để từng banner tự `sticky top-2`.
            Đo thật trên Chromium (2026-09-07): hai banner cùng `sticky top-2 z-20` thì từ
            scrollY ≈ 200 chúng TRÙNG KHÍT — banner vàng (nền 10% alpha) in đè chữ lên banner đỏ,
            và vì cả hai là <Link>, cú bấm vào banner đỏ bị banner vàng NUỐT: chủ shop bấm cảnh báo
            "số liệu có thể sai" lại bị đưa sang trang giá vốn. Tức tín hiệu ưu tiên cao nhất bị
            tín hiệu thấp hơn chặn đường, ngay trên cơ chế dựng ra để chống hỏng lặng.
          */}
          <div className="sticky top-2 z-20 flex flex-col gap-2 empty:hidden [&:not(:empty)]:mb-4">
          {(syncHasBacklog || dataSyncHasError || saoLuuCoVanDe) && (
            <Link
              href="/cai-dat"
              className="flex flex-col gap-0.5 rounded-lg border border-error bg-error p-3 text-sm text-white shadow-sm transition hover:brightness-95"
            >
              {syncHasBacklog ? (
                <span className="font-semibold">
                  Bronze còn backlog — số liệu có thể thiếu (doanh thu hoặc &quot;Tiền đã về&quot;). Mở Cài đặt để
                  xem cách xử lý.
                </span>
              ) : dataSyncHasError ? (
                <span className="font-semibold">
                  Đồng bộ gần đây có lỗi — số liệu có thể thiếu (doanh thu, chi tiêu quảng cáo hoặc
                  &quot;Tiền đã về&quot;). Mở Cài đặt để kiểm tra.
                </span>
              ) : (
                <span className="font-semibold">
                  Sao lưu đang có vấn đề — số liệu vẫn đủ, nhưng có thể không còn điểm phục hồi mới.
                  Mở Cài đặt để xem chi tiết.
                </span>
              )}
              <span className="text-white/85">Nhấn để mở trang Cài đặt &amp; Đồng bộ →</span>
            </Link>
          )}
          {/*
            NHẮC VIỆC giá vốn — KHÁC hẳn ba câu đỏ ở trên nên cố ý là banner RIÊNG, màu vàng:
            ba câu kia nói "số liệu có thể SAI/THIẾU, hệ đang hỏng"; câu này nói "hệ chạy đúng,
            có việc chờ bạn duyệt". Trộn vào chuỗi đỏ là làm loãng tín hiệu hỏng thật.

            Vì sao KHÔNG nhét vào /cai-dat: `Variant.costPrice` là APP-OWNED nên giá Pancake không
            tự chảy vào; trước 2026-09-07 cách duy nhất để biết lệch là chủ shop NHỚ mà báo rồi chạy
            CLI — chủ shop phàn nàn đúng, quy trình dựa vào trí nhớ thì kiểu gì cũng hỏng. Cảnh báo
            nằm trong tab Cài đặt là lặp lại y hệt vấn đề đó (repo có 0 kênh báo ra ngoài app).

            `tre` = quá 26 giờ chưa đếm lại ⇒ CON SỐ ĐANG CẦM ĐÃ CŨ. Phải nói thẳng, vì báo "n mã
            lệch" bằng số của ba hôm trước làm chủ shop tin là mình đang nhìn hiện tại.
          */}
          {lechGiaVon.muc !== "khop" && (
            <Link
              href="/san-pham/dong-bo-gia-von"
              className="flex flex-col gap-0.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-ink shadow-sm transition hover:bg-warning/15"
            >
              {lechGiaVon.muc === "co-lech" ? (
                <span className="font-semibold">
                  {lechGiaVon.soLech} mã có giá vốn lệch với Pancake — lãi đang tính theo giá cũ.
                </span>
              ) : lechGiaVon.muc === "tre" ? (
                <span className="font-semibold">
                  Đã hơn một ngày chưa đối chiếu được giá vốn với Pancake — con số đang hiển thị có
                  thể đã cũ.
                </span>
              ) : (
                /*
                  `chua-kiem` = lượt đêm CHƯA LẦN NÀO ghi được mốc. Ca này bắt buộc phải kêu, dù
                  nghe như "chưa có gì xảy ra": mốc chưa từng có thì lưới "quá 26 giờ" KHÔNG BAO GIỜ
                  bật (nó xét mốc-có-hợp-lệ trước), nên im ở đây là im VĨNH VIỄN. Đúng ngay sau
                  deploy prod cũng rơi vào mức này — đo 07/09: hai ô Setting còn vắng.
                */
                <span className="font-semibold">
                  Chưa đối chiếu giá vốn với Pancake lần nào — kiểm lượt đồng bộ đêm ở Cài đặt.
                </span>
              )}
              <span className="text-muted-foreground">Nhấn để xem danh sách và duyệt →</span>
            </Link>
          )}
          {/*
            NHẮC VIỆC khoản vay — cùng hạng với banner giá vốn (vàng, "có việc chờ bạn duyệt"), KHÔNG
            phải hạng đỏ "hệ đang hỏng". Kỳ tới hạn chưa ghi làm SAI CẢ HAI trục cùng lúc: Lãi/Lỗ
            thiếu tiền lãi, quỹ thiếu tiền gốc đã chuyển đi — nên câu phải nói thẳng là số đang lạc
            quan hơn thực tế, đừng chỉ nói "có kỳ chờ".
          */}
          {soKhoanVayCoKyCho > 0 && (
            <Link
              href="/tai-chinh?tab=dong-tien#khoan-vay"
              className="flex flex-col gap-0.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-ink shadow-sm transition hover:bg-warning/15"
            >
              <span className="font-semibold">
                {soKhoanVayCoKyCho} khoản vay có kỳ trả nợ tới hạn chưa ghi — lợi nhuận và quỹ đang
                lạc quan hơn thực tế.
              </span>
              <span className="text-muted-foreground">Nhấn để xem danh sách và duyệt →</span>
            </Link>
          )}
          {/*
            NHẮC VIỆC chi phí nhập hàng — cùng hạng vàng "có việc chờ bạn duyệt". Đặt SAU khoản vay
            cố ý: kỳ vay quá hạn làm sai CẢ Lãi/Lỗ lẫn quỹ, còn phiếu nhập chưa ghi chỉ làm quỹ cao
            hơn thực tế (danh mục "Nhập hàng" không vào P&L) — nặng hơn thì nằm trên.

            Nằm TRONG vùng sticky chung ở trên, TUYỆT ĐỐI không tự `sticky top-2`: đo thật trên
            Chromium 07/09 — hai banner cùng `sticky top-2 z-20` thì từ scrollY ≈ 200 chúng TRÙNG
            KHÍT và banner này NUỐT cú bấm của banner kia.
          */}
          {phieuNhapChuaGhi.muc !== "khop" && (
            <Link
              href="/tai-chinh/chi-phi-nhap-hang"
              className="flex flex-col gap-0.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-ink shadow-sm transition hover:bg-warning/15"
            >
              {phieuNhapChuaGhi.muc === "co-lech" ? (
                /*
                  Câu do hàm THUẦN `cauNhacPhieuNhap` sinh: "3 phiếu chờ ghi" và "1 phiếu đã ghi nay
                  bị huỷ bên Pancake" là HAI việc khác nhau, lệch quỹ hai chiều NGƯỢC nhau. Gộp một
                  con số rồi in câu "chưa vào Sổ chi phí" là làm chủ shop bấm vào rồi không thấy gì
                  để duyệt — lần sau họ lướt qua banner.
                */
                <span className="font-semibold">{cauNhacPhieuNhap(phieuNhapChuaGhi)}</span>
              ) : phieuNhapChuaGhi.muc === "tre" ? (
                <span className="font-semibold">
                  Đã hơn một ngày chưa đối chiếu phiếu nhập hàng với Pancake — con số đang hiển thị
                  có thể đã cũ.
                </span>
              ) : (
                /* `chua-kiem` = lượt đêm CHƯA LẦN NÀO ghi được mốc; im ở đây là im VĨNH VIỄN vì
                   lưới "quá 26 giờ" xét mốc-có-hợp-lệ trước. Xem banner giá vốn ngay trên. */
                <span className="font-semibold">
                  Chưa đối chiếu phiếu nhập hàng với Pancake lần nào — kiểm lượt đồng bộ đêm ở Cài đặt.
                </span>
              )}
              <span className="text-muted-foreground">Nhấn để xem danh sách và duyệt →</span>
            </Link>
          )}
          {/*
            NHẮC VIỆC quỹ sắp cạn — cùng hạng vàng "có việc chờ bạn xem", KHÔNG phải "hệ đang hỏng".
            `docCanhBaoSapCan()` (lib) tự bắt lỗi và trả null khi hỏng nên layout không cần bọc thêm ở
            đây — null cũng là trạng thái bình thường "không chạm ngưỡng trong 30 ngày tới".
          */}
          {canhBaoSapCanQuy && (
            <Link
              href="/tai-chinh?tab=so-quy"
              className="flex flex-col gap-0.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-ink shadow-sm transition hover:bg-warning/15"
              data-testid="banner-du-bao-quy-sap-can"
            >
              {/* Chưa đặt ngưỡng (= 0) thì "chạm" nghĩa là quỹ dự báo ÂM — nói thẳng như vậy; câu chi tiết
                  hơn (quỹ đã dưới mức ngay hôm nay…) nằm ở khối cảnh báo tab Sổ quỹ. */}
              <span className="font-semibold">
                {canhBaoSapCanQuy.nguongDaDat ? "Dự báo quỹ chạm mức tối thiểu ngày " : "Dự báo quỹ ÂM ngày "}
                {format(parse(canhBaoSapCanQuy.ngay, "yyyy-MM-dd", new Date()), "dd/MM")} — xem Sổ quỹ
              </span>
              <span className="text-muted-foreground">Nhấn để xem chi tiết →</span>
            </Link>
          )}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
