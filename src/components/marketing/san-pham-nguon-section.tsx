import { formatPct1 } from "@/components/kenh/channel-format";
import { CHUA_KET_NOI_ANALYTICS, KhuTrongMarketing } from "@/components/marketing/khu-trong-marketing";
import { ChuThichDoTuoiVaThieu } from "@/components/marketing/canh-bao-do-tuoi-du-lieu";
import { DONG_MOI_TRANG_MARKETING, PhanTrangMarketing } from "@/components/marketing/phan-trang-marketing";
import { SoSanBao } from "@/components/marketing/so-san-bao";
import { formatVnd } from "@/lib/format";
import type { ChuThichDoTuoi } from "@/lib/reports/marketing/cau-do-tuoi-du-lieu";
import { KHOI_NGUON, type KhoiNguon } from "@/lib/reports/marketing/nguon-doanh-so-tiktok";
import type { SanPhamNguonTiktok } from "@/lib/reports/marketing/san-pham-nguon-tiktok";

/**
 * `sp` nhận NGUYÊN `searchParams` của `page.tsx` (không phải `KyTrenUrl` hẹp — chỉ tu/den/range):
 * `PhanTrangMarketing` phải giữ được `tab=san-pham` đang có trên URL khi đổi trang, hẹp kiểu sẽ làm
 * mất tham số đó.
 */
type SpDayDu = Record<string, string | undefined>;

/**
 * Tab `san-pham` — bảng "Sản phẩm × nguồn" (spec §5.5). Segmented control 8 lựa chọn theo
 * `KHOI_NGUON` (dùng LẠI định nghĩa của reader `nguon-doanh-so-tiktok.ts`, KHÔNG chép tên khối ra
 * đây — hai bảng tên trường là hai bảng sẽ trôi, đúng cảnh báo trong `san-pham-nguon-tiktok.ts`).
 *
 * KHÔNG có cột ảnh (A3 — Product API list không trả ảnh). ~10% dòng hiện MÃ TRẦN thay vì tên là
 * TRẠNG THÁI BÌNH THƯỜNG (đo 25/08: 133/148 = 89,9% khớp `Product.code`) — KHÔNG cảnh báo lỗi ở đây,
 * `duLieu.dong[].ten` đã tự rơi về id khi không khớp (`san-pham-nguon-tiktok.ts`).
 */

function soGon(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

function pct(v: number | null): string {
  return v === null ? "—" : formatPct1(v * 100);
}

const THU_TU_KHOI: KhoiNguon[] = [
  "total",
  "seller_video",
  "seller_live",
  "seller_product_card",
  "affiliate_total",
  "affiliate_video",
  "affiliate_live",
  "shop_tab",
];

function hrefNguon(khoi: KhoiNguon, sp: SpDayDu): string {
  const p = new URLSearchParams();
  p.set("tab", "san-pham");
  // "total" là mặc định ⇒ không gắn `?nguon=` thừa (khớp quy ước `hrefTabMarketing`).
  if (khoi !== "total") p.set("nguon", khoi);
  if (sp.tu && sp.den) {
    p.set("tu", sp.tu);
    p.set("den", sp.den);
  } else if (sp.range) {
    p.set("range", sp.range);
  }
  // Đổi nguồn ⇒ reset `trang` về 1 — KHÔNG gắn `?trang=` (mặc định) nên bỏ hẳn tham số này.
  return `/marketing?${p.toString()}`;
}

export function SanPhamNguonSection({
  duLieu,
  khoi,
  sp,
  trang,
  chuThichSanPham,
}: {
  duLieu: SanPhamNguonTiktok;
  khoi: KhoiNguon;
  sp: SpDayDu;
  trang: number;
  /** Câu chú thích ĐỘ TƯƠI — tính SẴN ở `page.tsx` (ruling P2-R35 + P2-R38), đọc stream
   *  `tiktok/analytics_products` (ruling P2-R40). */
  chuThichSanPham: ChuThichDoTuoi;
}) {
  const tong = duLieu.dong.length;
  const trang20 = duLieu.dong.slice((trang - 1) * DONG_MOI_TRANG_MARKETING, trang * DONG_MOI_TRANG_MARKETING);
  // Nguồn ĐANG CHỌN không có khái niệm "đơn"/"thêm giỏ" ⇒ CẢ CỘT (không phải từng dòng riêng lẻ)
  // luôn "—" — khác hẳn "—" do kỳ này thiếu dữ liệu (fix vòng B-2, việc #3; xem chú thích bên dưới
  // bảng). `KHOI_NGUON[khoi].truongDon` đã có sẵn ở reader, chỉ đọc lại để quyết định câu chữ.
  const khongCoDon = KHOI_NGUON[khoi].truongDon === null;
  const khongCoThemGio = khoi === "shop_tab";

  return (
    <section className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Chưa kết nối ⇒ BỎ tiêu đề của section (khu trống `KhuTrongMarketing` bên dưới đã tự có
            `<h2>` riêng) — bản cũ luôn hiện cả hai nên trang render HAI `<h2>Sản phẩm × nguồn</h2>`
            (fix vòng B-2, việc #7). Nav CHỌN NGUỒN vẫn hiện dù chưa kết nối: chủ shop bấm trước được,
            và test e2e "segmented nguồn đổi được" đi qua đúng trạng thái này. */}
        {duLieu.mocSanSang !== null && <h2 className="font-serif text-lg text-ink">Sản phẩm × nguồn</h2>}
        <nav className="flex flex-wrap gap-1 rounded-lg bg-surface-soft p-1 text-xs" aria-label="Chọn nguồn doanh số">
          {THU_TU_KHOI.map((k) => (
            <a
              key={k}
              href={hrefNguon(k, sp)}
              className={
                k === khoi
                  ? "rounded-md bg-canvas px-2.5 py-1 font-medium text-ink shadow-sm"
                  : "rounded-md px-2.5 py-1 text-muted-foreground hover:text-ink"
              }
            >
              {KHOI_NGUON[k].nhan}
            </a>
          ))}
        </nav>
      </div>

      {duLieu.mocSanSang === null ? (
        <div className="mt-3">
          <KhuTrongMarketing tieuDe="Sản phẩm × nguồn" loiNhan={CHUA_KET_NOI_ANALYTICS} />
        </div>
      ) : trang20.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Không có sản phẩm nào phát sinh ở nguồn này trong kỳ.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-2 font-normal">Sản phẩm</th>
                <th className="py-1.5 pr-2 text-right font-normal">Hiển thị</th>
                <th className="py-1.5 pr-2 text-right font-normal">Click</th>
                <th className="py-1.5 pr-2 text-right font-normal">CTR</th>
                <th className="py-1.5 pr-2 text-right font-normal">% Thêm giỏ</th>
                <th className="py-1.5 pr-2 text-right font-normal">% Click→đơn</th>
                <th className="py-1.5 pr-2 text-right font-normal">Đơn</th>
                <th className="py-1.5 text-right font-normal">GMV</th>
              </tr>
            </thead>
            <tbody>
              {trang20.map((d) => (
                <tr key={d.id} className="border-b border-hairline/60 last:border-0">
                  <td className="max-w-[260px] truncate py-1.5 pr-2 text-ink" title={d.ten}>
                    {d.ten}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {d.hienThi === null ? "—" : soGon(d.hienThi)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {d.click === null ? "—" : soGon(d.click)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">{pct(d.ctr)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">{pct(d.tiLeThemGio)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {pct(d.tiLeClickRaDon)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {d.donSan === null ? "—" : <SoSanBao>{soGon(d.donSan)}</SoSanBao>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                    {d.gmvSan === null ? "—" : <SoSanBao>{formatVnd(d.gmvSan)}</SoSanBao>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Chưa kết nối (mocSanSang null) ⇒ `KhuTrongMarketing` ở trên đã nói hết; phân trang + chú
          thích cột + câu ĐỘ TƯƠI/thiếu dữ liệu chỉ có ý nghĩa khi bảng thật sự có (hoặc từng có) dữ
          liệu để đo. */}
      {duLieu.mocSanSang !== null && (
        <>
          <PhanTrangMarketing sp={sp} trang={trang} tong={tong} donVi="sản phẩm" />

          {(khongCoDon || khongCoThemGio) && (
            <p className="mt-2 text-xs text-muted-foreground">
              Nguồn &quot;{KHOI_NGUON[khoi].nhan}&quot;: sàn không đo{" "}
              {[khongCoDon && "Đơn / % Click→đơn", khongCoThemGio && "% Thêm giỏ"].filter(Boolean).join(" và ")} — dấu
              &quot;—&quot; ở các cột này nghĩa là SÀN KHÔNG CÓ chỉ số này ở nguồn đang xem, khác với
              &quot;—&quot; do thiếu dữ liệu kỳ này.
            </p>
          )}

          <ChuThichDoTuoiVaThieu cau1={chuThichSanPham.cau1} cau2={chuThichSanPham.cau2} />
        </>
      )}
    </section>
  );
}
