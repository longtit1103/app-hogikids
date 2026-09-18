import Link from "next/link";
import { Fragment } from "react";

import { adsSourceLabel } from "@/lib/ads-source-label";
import { formatVnd } from "@/lib/format";
import type { BangItemChienDich } from "@/lib/reports/marketing/gmv-max-theo-san-pham";
import type { QuangCaoTheoChienDich } from "@/lib/reports/marketing/quang-cao-chien-dich";

import { formatPct1, formatRoas } from "@/components/kenh/channel-format";
import { ItemGmvMaxBangCon } from "@/components/marketing/item-gmv-max-bang-con";
import { SoSanBao } from "@/components/marketing/so-san-bao";

/**
 * Bảng "Hiệu quả quảng cáo theo chiến dịch" ở tab `quang-cao` của `/marketing`
 * (chuyển từ `/kenh` 25/08).
 *
 * Thuần hiển thị. Tiền lấy từ sổ chi phí nên KHỚP P&L; chỉ số hiển thị/click chỉ
 * có ở Meta, Đơn/CPO/GMV sàn/ROI sàn chỉ có ở TikTok GMV Max (số sàn TỰ NHẬN CÔNG
 * — tham khảo, không phải đơn/doanh thu Pancake). MỌI số sàn báo phải đi qua
 * `<SoSanBao>`: một con số sàn nằm trần cạnh số thật sẽ được đọc như tiền thật.
 * Không có cột ROAS quy về doanh thu THẬT — app không quy được doanh thu Pancake
 * về chiến dịch, xem ghi chú trong `quang-cao-chien-dich.ts`.
 */

function soGon(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

export function QuangCaoChienDichSection({
  dulieu,
  itemTheoChienDich,
}: {
  dulieu: QuangCaoTheoChienDich;
  /** campaignId → bảng con item-level (chỉ có với chiến dịch TikTok GMV Max CÓ CHI trong kỳ). */
  itemTheoChienDich?: Record<string, BangItemChienDich>;
}) {
  // Chiến dịch 0đ trong kỳ là nhiễu (đo 2026-08-18: T6/2026 có 161 chiến dịch mà
  // 159 cái 0đ). Ẩn chúng NHƯNG nói rõ số bị ẩn — cắt câm sẽ đọc ra là "chỉ có
  // ngần này chiến dịch".
  const coChi = dulieu.chienDich.filter((c) => c.chiTieu > 0);
  const soAn = dulieu.chienDich.length - coChi.length;

  // Chú thích Đơn/CPO chỉ hiện khi bảng CÓ dòng TikTok — bảng toàn Meta mà chú
  // thích nói về TikTok là mô tả thứ không có trên màn hình.
  const coDongTiktok = coChi.some((c) => c.nguon === "TIKTOK_ADS" && !c.khongRoChienDich);
  // "—" ở Đơn/CPO của TikTok có nghĩa RIÊNG (kỳ có ngày chưa kéo lại số đơn từ
  // sàn), khác "—" của Meta (sàn không có metric) — phải nói tách bạch.
  const coTiktokThieuDon = coChi.some((c) => c.nguon === "TIKTOK_ADS" && !c.khongRoChienDich && c.donSan === null);
  // Cổng phủ-ngày của GMV đếm RIÊNG với Đơn (gross_revenue chỉ có từ 25/08, orders có từ 22/06) ⇒
  // cờ riêng: gộp chung sẽ nói sai lý do cho một trong hai cột.
  const coTiktokThieuGmv = coChi.some((c) => c.nguon === "TIKTOK_ADS" && !c.khongRoChienDich && c.gmvSan === null);
  // Lý do "sàn không cung cấp qua API" là phép đo RIÊNG cho TikTok GMV Max (probe
  // 21/08) — gán nó cho Meta/Shopee Ads/nguồn nhập tay là khẳng định sai sự thật
  // (Meta CÓ đủ chỉ số trong Bronze; nguồn khác đơn giản là app chưa kéo). Tách câu.
  const tiktokThieuHienThi = dulieu.nguonThieuChiSo.includes("TIKTOK_ADS");
  const nguonThieuKhac = dulieu.nguonThieuChiSo.filter((n) => n !== "TIKTOK_ADS");

  // Điều kiện rỗng theo `coChi`, KHÔNG theo tổng số chiến dịch: kỳ mà mọi chiến dịch
  // đều 0đ (đo: T6/2026 có 159/161 dòng 0đ) sẽ render đầu bảng + thân trắng.
  if (coChi.length === 0) {
    return (
      <section className="rounded-xl border border-hairline p-4">
        <h2 className="text-sm text-muted-foreground">Hiệu quả quảng cáo theo chiến dịch</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Kỳ này chưa ghi nhận chi tiêu quảng cáo nào.
          {soAn > 0 && ` (${soAn} chiến dịch có trong kỳ nhưng chi tiêu 0đ.)`}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-muted-foreground">Hiệu quả quảng cáo theo chiến dịch</h2>
        <p className="font-serif text-lg tabular-nums text-ink">Σ {formatVnd(dulieu.tongChiTieu)}</p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-2 font-normal">Chiến dịch</th>
              <th className="py-1.5 pr-2 font-normal">Nguồn</th>
              <th className="py-1.5 pr-2 text-right font-normal">Chi tiêu</th>
              <th className="py-1.5 pr-2 text-right font-normal">Hiển thị</th>
              <th className="py-1.5 pr-2 text-right font-normal">Click</th>
              <th className="py-1.5 pr-2 text-right font-normal">CTR</th>
              <th className="py-1.5 pr-2 text-right font-normal">CPM</th>
              <th className="py-1.5 pr-2 text-right font-normal">CPC</th>
              <th className="py-1.5 pr-2 text-right font-normal">Đơn</th>
              <th className="py-1.5 pr-2 text-right font-normal">CPO</th>
              <th className="py-1.5 pr-2 text-right font-normal">GMV sàn</th>
              <th className="py-1.5 text-right font-normal">ROI sàn</th>
            </tr>
          </thead>
          <tbody>
            {coChi.map((c) => {
              // Bảng con CHỈ có với TikTok GMV Max — `gmvMaxTheoSanPham` chỉ tạo khoá cho chiến dịch
              // thật sự có dòng item-level trong Bronze (workflow chỉ gọi API item-level cho chiến
              // dịch CÓ CHI, xem A6) ⇒ vắng khoá là bình thường, KHÔNG phải lỗi thiếu dữ liệu.
              const item =
                c.nguon === "TIKTOK_ADS" && !c.khongRoChienDich ? itemTheoChienDich?.[c.campaignId] : undefined;
              return (
                <Fragment key={`${c.nguon}:${c.campaignId}`}>
                  <tr className="border-b border-hairline/60 last:border-0">
                    <td className="max-w-[280px] truncate py-1.5 pr-2 text-ink" title={c.ten}>
                      {c.ten}
                      {c.khongRoChienDich && c.soDongGop > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">({c.soDongGop} dòng chi phí)</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">{adsSourceLabel(c.nguon)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-ink">{formatVnd(c.chiTieu)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {c.hienThi === null ? "—" : soGon(c.hienThi)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {c.click === null ? "—" : soGon(c.click)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {c.ctr === null ? "—" : formatPct1(c.ctr)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {c.cpm === null ? "—" : formatVnd(Math.round(c.cpm))}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {c.cpc === null ? "—" : formatVnd(Math.round(c.cpc))}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {c.donSan === null ? "—" : <SoSanBao>{soGon(c.donSan)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {c.cpo === null ? "—" : <SoSanBao>{formatVnd(Math.round(c.cpo))}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {c.gmvSan === null ? "—" : <SoSanBao>{formatVnd(c.gmvSan)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {c.roiSan === null ? "—" : <SoSanBao>{formatRoas(c.roiSan)}</SoSanBao>}
                    </td>
                  </tr>
                  {item && (
                    <tr>
                      <td colSpan={12} className="p-0">
                        {/* <details> chứ KHÔNG phải state client: trang là server component, và
                            Playwright click được thẳng vào <summary> (khác tooltip-hover — bài học
                            PR #73 test xanh giả). */}
                        <details className="border-t border-hairline/60 bg-surface-soft/40">
                          <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted-foreground">
                            Sản phẩm trong chiến dịch ({item.dong.length})
                          </summary>
                          <ItemGmvMaxBangCon bang={item} />
                        </details>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-hairline pt-2 text-xs text-muted-foreground">
        {soAn > 0 && <p>Đã ẩn {soAn} chiến dịch không phát sinh chi tiêu trong kỳ.</p>}
        {tiktokThieuHienThi && (
          <p>
            Dấu &quot;—&quot; ở cột Hiển thị/Click của TikTok: sàn không cung cấp chỉ số này qua API cho loại
            chiến dịch GMV Max shop đang chạy (đo 21/08). Không phải bằng 0.
          </p>
        )}
        {nguonThieuKhac.length > 0 && (
          <p>
            Dấu &quot;—&quot; ở {nguonThieuKhac.map(adsSourceLabel).join(", ")}: app chưa có chỉ số hiển thị/click
            của nguồn này trong dữ liệu đã đồng bộ. Không phải bằng 0.
          </p>
        )}
        {coDongTiktok && (
          <p>
            &quot;Đơn&quot; là số đơn TikTok tự nhận công cho chiến dịch (chỉ tham khảo — KHÔNG phải doanh thu,
            không khớp đơn Pancake); CPO (chi phí mỗi đơn) = Chi tiêu ÷ Đơn. Meta không có số đơn/GMV nên để
            &quot;—&quot;.
          </p>
        )}
        {coTiktokThieuDon && (
          <p>
            Dấu &quot;—&quot; ở cột Đơn/CPO của TikTok: kỳ có ngày app chưa có số đơn từ sàn (chưa đồng bộ lại,
            ngoài cửa sổ backfill 60 ngày, hoặc dữ liệu ngày đó không đọc được). Không phải bằng 0.
          </p>
        )}
        {coTiktokThieuGmv && (
          <p>
            Dấu &quot;—&quot; ở cột GMV/ROI sàn của TikTok: kỳ có ngày app chưa kéo lại số sàn (chỉ số này bắt
            đầu từ 25/08, ngoài cửa sổ backfill 60 ngày thì để trống). Không phải bằng 0.
          </p>
        )}
        {coDongTiktok && itemTheoChienDich && (
          <p>
            Bung một dòng TikTok GMV Max để xem sản phẩm bên trong — chỉ chiến dịch mà SÀN CÓ GỬI chi tiết theo
            từng sản phẩm mới có bảng con (sàn chỉ gửi chi tiết này cho chiến dịch GMV Max đang chạy); nhiều dòng
            vẫn sẽ không có nút bung dù có chi tiêu, vì sàn không gửi chi tiết cho chiến dịch đó.
          </p>
        )}
        <p>
          Chi tiêu lấy từ Sổ chi phí (đã gồm VAT, khớp Lãi/Lỗ) nên CPM/CPC/CPO ở đây cao hơn số sàn báo khoảng 10%.
        </p>
        {coDongTiktok && (
          <p>
            ROI sàn = GMV sàn ÷ chi CHƯA VAT theo cách TikTok tính; CPO của app tính trên chi GỒM VAT.
          </p>
        )}
        <p>
          Không có ROAS quy về doanh thu THẬT theo chiến dịch: app không quy được doanh thu Pancake về từng
          chiến dịch (ROI sàn ở trên là số TikTok tự nhận công, không phải doanh thu thật). ROAS theo KÊNH (quy về
          doanh thu Pancake) nằm ở mục <Link href="/kenh" className="underline">Kênh</Link>.
        </p>
      </div>
    </section>
  );
}
