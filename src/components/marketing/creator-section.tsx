import Link from "next/link";

import { DONG_MOI_TRANG_MARKETING, PhanTrangMarketing } from "@/components/marketing/phan-trang-marketing";
import { SoSanBao } from "@/components/marketing/so-san-bao";
import { formatVnd } from "@/lib/format";
import type { CreatorTiktok } from "@/lib/reports/marketing/creator-tiktok";

import { formatPct1 } from "@/components/kenh/channel-format";

/**
 * BẢNG CREATOR (tab `creator`, spec §5.3) — đơn affiliate cấp DÒNG SKU do TikTok quy công cho từng
 * creator (`creatorTiktok`). MỌI số ở bảng này là SỐ SÀN TỰ NHẬN CÔNG ⇒ tiền/đếm đơn bọc `<SoSanBao>`.
 *
 * Cột *HH ước tính* và *đã trả* đứng CẠNH NHAU có chủ đích — nhưng ĐỌC CÓ ĐIỀU KIỆN (review 28/08):
 * "đã trả" chỉ được làm tươi khi đơn còn trong cửa sổ đồng bộ đêm RIÊNG của khối affiliate (60 ngày
 * theo create_time — `nightlyDaysAffiliate`, từ 28/08; đơn cũ hơn chỉ được kéo lại khi ép key
 * `tiktokShopAffiliateManualDays`), nên khoảng cách ước tính↔đã trả ở kỳ GẦN phần lớn là "sàn chưa
 * chốt/app chưa kéo lại", KHÔNG suy ra "bị hoàn" — tooltip cột nói rõ. KHÔNG gộp, KHÔNG tính hiệu ở
 * tầng UI. Ước tính/đã trả có thể là "—" (sàn KHÔNG báo — cả hai bucket rỗng) khác hẳn "0 ₫" (sàn
 * báo 0 tường minh) — đừng "sửa" dấu "—" thành 0.
 *
 * Luật bọc `<SoSanBao>` (chốt sau review 28/08): TIỀN + ĐẾM ĐƠN bọc; đếm DÒNG (`dongSkuSan`,
 * Hoàn/KĐK) và tỉ trọng % để TRẦN — cả bảng đã có tiêu đề "(sàn báo)" + chú thích nguồn chân tab,
 * chip ở mọi ô chỉ làm bảng không đọc nổi.
 *
 * Khối *Affiliate theo kỳ (Pancake)* của P1 đứng CẠNH bảng này ở `page.tsx` với nhãn "Pancake" —
 * hai nguồn, hai nhãn, KHÔNG trộn, KHÔNG đối chiếu "lệch" (sàn liệt kê đơn quy công gồm cả
 * INELIGIBLE/hoàn; Pancake chỉ ghi khi thật sự bị trừ hoa hồng).
 */

function soGon(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

/** "—" khi sàn không báo; giữ 0 ₫ khi sàn báo 0 TƯỜNG MINH. */
function tienSan(n: number | null): React.ReactNode {
  return n === null ? "—" : <SoSanBao>{formatVnd(n)}</SoSanBao>;
}

function pctSan(n: number | null): string {
  return n === null ? "—" : formatPct1(n * 100);
}

/** Giữ nguyên mọi tham số trên URL (tab, kỳ, trang…), chỉ đặt `creator` để mở drawer. */
function hrefCreator(sp: Record<string, string | undefined>, ten: string): string {
  const params = new URLSearchParams();
  for (const [khoa, giaTri] of Object.entries(sp)) {
    if (khoa !== "creator" && giaTri !== undefined && giaTri !== "") params.set(khoa, giaTri);
  }
  params.set("creator", ten);
  return `/marketing?${params.toString()}`;
}

export function CreatorSection({
  duLieu,
  sp,
  trang,
}: {
  duLieu: CreatorTiktok;
  sp: Record<string, string | undefined>;
  trang: number;
}) {
  const tong = duLieu.dong.length;
  const trang20 = duLieu.dong.slice((trang - 1) * DONG_MOI_TRANG_MARKETING, trang * DONG_MOI_TRANG_MARKETING);
  const soDongKhongRoLoai = duLieu.dong.reduce((s, d) => s + d.soDongKhongRoLoai, 0);

  return (
    <section className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-muted-foreground">Creator affiliate (sàn báo)</h2>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">TikTok Shop</span>
      </div>

      {tong === 0 ? (
        // Kho RỖNG toàn bộ ≠ kỳ không có đơn (review 28/08): chưa backfill / mất scope / nightly chết
        // đều cho kho rỗng — khẳng định "kỳ này chưa có đơn" lúc đó là nói sai sự thật kinh doanh.
        <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {duLieu.ngayDonMoiNhat === null ? (
            <p>
              Chưa có dữ liệu affiliate nào trong kho — nếu vừa deploy thì chạy backfill; lượt đồng bộ
              đêm xem ở Cài đặt → Kết nối &amp; Đồng bộ.
            </p>
          ) : (
            <>
              <p>Kỳ này chưa có đơn affiliate.</p>
              <p>Đơn affiliate gần nhất app ghi nhận: {duLieu.ngayDonMoiNhat}.</p>
            </>
          )}
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-2 font-normal">Creator</th>
                <th className="py-1.5 pr-2 text-right font-normal">Đơn</th>
                <th className="py-1.5 pr-2 text-right font-normal">Dòng SKU</th>
                <th className="py-1.5 pr-2 text-right font-normal">GMV</th>
                <th
                  className="py-1.5 pr-2 text-right font-normal"
                  title="Gộp hoa hồng chuẩn + hoa hồng shop ads (hai đường trả loại trừ nhau của sàn)"
                >
                  HH ước tính
                </th>
                <th
                  className="py-1.5 pr-2 text-right font-normal"
                  title="Sàn chốt SAU khi giao/đối soát; app kéo lại đơn trong 60 ngày gần nhất mỗi đêm, đơn cũ hơn chỉ được làm tươi ở lượt kéo cửa sổ rộng — khoảng cách với cột ước tính ở kỳ gần KHÔNG suy ra 'bị hoàn'. Dòng chú thích 'n dòng chờ' = số dòng SKU sàn chưa chốt"
                >
                  HH đã trả
                </th>
                {/* Tỉ trọng theo SỐ DÒNG SKU (không phải theo GMV) — nói rõ kẻo cột đứng cạnh GMV bị
                    đọc thành "phần doanh số theo kênh". % Shop = gian hàng/showcase của CHÍNH creator
                    — kênh thứ ba thật (đo 28/08), không phải "đơn không qua KOC". */}
                <th className="py-1.5 pr-2 text-right font-normal" title="Tỉ trọng theo SỐ DÒNG SKU — không phải theo GMV">
                  % Video
                </th>
                <th className="py-1.5 pr-2 text-right font-normal" title="Tỉ trọng theo SỐ DÒNG SKU — không phải theo GMV">
                  % Live
                </th>
                <th className="py-1.5 pr-2 text-right font-normal" title="Tỉ trọng theo SỐ DÒNG SKU — không phải theo GMV">
                  % Shop
                </th>
                <th className="py-1.5 text-right font-normal">Hoàn / KĐK</th>
              </tr>
            </thead>
            <tbody>
              {trang20.map((d) => (
                <tr key={d.creatorUsername} className="border-b border-hairline/60 last:border-0">
                  <td className="max-w-[200px] truncate py-1.5 pr-2" title={d.creatorUsername}>
                    <Link
                      href={hrefCreator(sp, d.creatorUsername)}
                      className="text-ink underline-offset-2 hover:underline"
                      {...(d.creatorUsername === "" && {
                        title:
                          "Các dòng sàn không trả tên creator được gộp chung một hàng — có thể gồm NHIỀU creator khác nhau",
                      })}
                    >
                      {d.creatorUsername === "" ? "(không rõ creator)" : d.creatorUsername}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    <SoSanBao>{soGon(d.donSan)}</SoSanBao>
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {soGon(d.dongSkuSan)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">{tienSan(d.gmvSan)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {tienSan(d.hoaHongUocTinh)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {tienSan(d.hoaHongDaTra)}
                    {/* Chú thích tại chỗ (chủ shop chốt 30/08, phương án B): số dòng sàn CHƯA chốt — cùng luật
                        fail-open với drawer. Chỉ hiện khi > 0 để ô "—"/số của creator đã chốt hết giữ nguyên
                        mặt chữ (e2e đang assert "—" exact). Không phải tiền ⇒ không bọc <SoSanBao>. */}
                    {d.dongChoChot > 0 && (
                      <span
                        className="block text-[11px] text-muted-foreground"
                        title="Dòng SKU sàn chưa chốt hoa hồng (trạng thái ngoài SETTLED/INELIGIBLE, kể cả sàn chưa báo) — chốt SAU giao/đối soát, xem từng dòng trong drawer"
                      >
                        {d.dongChoChot} dòng chờ
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {pctSan(d.tiTrongVideo)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {pctSan(d.tiTrongLive)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                    {pctSan(d.tiTrongShop)}
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums text-muted-foreground"
                    title="Dòng SKU thuộc đơn hoàn toàn bộ / dòng không đủ điều kiện nhận hoa hồng (INELIGIBLE) — giữ nguyên, tách riêng để không bóp méo hoa hồng"
                  >
                    {d.dongHoanToanBo} / {d.dongIneligible}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {soDongKhongRoLoai > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {soGon(soDongKhongRoLoai)} dòng có kênh nội dung ngoài Video/Live/Shop — không tính vào ba cột
          tỉ trọng.
        </p>
      )}

      {tong > 0 && <PhanTrangMarketing sp={sp} trang={trang} tong={tong} donVi="creator" />}

      {/* Mốc ghi nhận LUÔN hiển thị khi có (review 28/08: chỉ hiện lúc bảng rỗng thì nightly chết
          nhiều ngày mà bảng vẫn có dòng cũ trông y hệt kỳ đủ dữ liệu). Đây là mốc ĐƠN GẦN NHẤT app
          đã ghi — không phải mốc sẵn sàng của sàn (đơn affiliate thưa, mốc đứng yên tuần vắng đơn
          là bình thường). */}
      {tong > 0 && duLieu.ngayDonMoiNhat !== null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Đơn affiliate gần nhất app ghi nhận: {duLieu.ngayDonMoiNhat}.
        </p>
      )}
    </section>
  );
}
