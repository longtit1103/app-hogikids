import { formatVnd } from "@/lib/format";
import type { AffiliateTheoKy } from "@/lib/reports/marketing/affiliate-pancake";
import type { HoanHuyTach } from "@/lib/reports/marketing/hoan-huy-tach";
import type { KhachTheoKy } from "@/lib/reports/marketing/khach-tiktok";

import { formatPct1 } from "@/components/kenh/channel-format";

/**
 * Ba khối "đã có sẵn dữ liệu" của tab Tổng quan `/marketing` (spec §5.1b).
 *
 * KHÁC hẳn bảng chiến dịch bên tab Quảng cáo: mọi số ở đây là TIỀN/ĐƠN THẬT từ Pancake — cùng nguồn
 * với Lãi/Lỗ và `/kenh` ⇒ TUYỆT ĐỐI KHÔNG bọc `<SoSanBao>` (dán nhãn "sàn báo" lên số thật là nói
 * sai về nguồn, đúng lớp lỗi ngược với việc để số sàn nằm trần).
 *
 * Thuần hiển thị: không cộng lại, không suy ra tiền mới. Chỉ có ba tỉ số hiển thị được suy tại chỗ
 * từ chính cặp tử/mẫu mà reader trả về (cùng khuôn `deriveRatios` của `/kenh`).
 *
 * PHẠM VI KÊNH nằm ngay trong tiêu đề từng khối và phải khớp `channelId` mà `page.tsx` truyền cho
 * reader: hai khối đầu chỉ TikTok (Shopee không có key `affiliate_commission`, và mù ~60% khoá khách
 * — đo 24/08), khối hoàn/hủy lấy mọi kênh. Đổi phạm vi ở page thì PHẢI đổi tiêu đề ở đây, nếu không
 * màn hình sẽ khai sai đang đếm những đơn nào.
 */

function soGon(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

/** Chia an toàn: mẫu 0 ⇒ null (KHÔNG trả 0 — "0%" đọc ra là "đo được và bằng 0"). */
function tiLe(tu: number, mau: number): number | null {
  return mau === 0 ? null : (tu / mau) * 100;
}

function OChiSo({ nhan, giaTri, phu }: { nhan: string; giaTri: string; phu?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-surface-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{nhan}</p>
      <p className="mt-1 font-serif text-2xl tabular-nums text-ink">{giaTri}</p>
      {phu && <p className="mt-1 text-[11px] text-muted-foreground">{phu}</p>}
    </div>
  );
}

/** Export cho tab `creator` (P3): khối Pancake đứng CẠNH bảng creator sàn — hai nguồn, hai nhãn,
 *  không trộn, không đối chiếu "lệch" (sàn liệt kê đơn quy công; Pancake chỉ ghi khi bị trừ tiền). */
export function KhoiAffiliate({ d }: { d: AffiliateTheoKy }) {
  const pct = tiLe(d.soDonCoHoaHong, d.tongSoDonHopLe);
  return (
    <section className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-muted-foreground">Affiliate / KOC theo kỳ — TikTok</h2>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Pancake</span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <OChiSo
          nhan="Đơn có hoa hồng"
          giaTri={`${soGon(d.soDonCoHoaHong)} / ${soGon(d.tongSoDonHopLe)} đơn`}
          phu={pct === null ? "Kỳ này chưa có đơn hợp lệ nào." : `${formatPct1(pct)} số đơn hợp lệ trong kỳ`}
        />
        <OChiSo nhan="Doanh thu gộp (nhóm đơn có hoa hồng)" giaTri={formatVnd(d.doanhThuDonCoHoaHong)} />
        <OChiSo nhan="Hoa hồng đã trả" giaTri={formatVnd(d.tongHoaHong)} />
      </div>

      <p className="mt-3 border-t border-hairline pt-2 text-xs text-muted-foreground">
        Pancake chỉ cho biết đơn CÓ hoa hồng, không cho biết KOC nào.
      </p>
    </section>
  );
}

function KhoiKhach({ d }: { d: KhachTheoKy }) {
  const pctMoi = tiLe(d.khachMoiTrongKy, d.khachTrongKy);
  const pctLifetime = tiLe(d.khachLifetimeQuayLai, d.khachCoSoLieuLifetime);
  return (
    <section className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-muted-foreground">Khách mua hàng — TikTok</h2>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Pancake</span>
      </div>

      {/*
        HAI Ô, HAI NHÃN TÁCH BẠCH — không được gộp thành một tỉ lệ "khách quay lại": ô trái cắt đúng
        kỳ nhưng chỉ thấy phần lịch sử app giữ, ô phải là snapshot lifetime của sàn KHÔNG cắt kỳ được.
        Gộp hai định nghĩa vào một nhãn là bịa một con số không có thật.
      */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <OChiSo
          nhan="Mới / quay lại trong kỳ (theo dữ liệu app)"
          giaTri={`${soGon(d.khachMoiTrongKy)} mới / ${soGon(d.khachQuayLaiTrongKy)} quay lại`}
          phu={
            pctMoi === null
              ? "Kỳ này chưa đọc được khách nào."
              : `${soGon(d.khachTrongKy)} khách trong kỳ · ${formatPct1(pctMoi)} là khách mới`
          }
        />
        <OChiSo
          nhan="Tỉ lệ khách đã mua ≥ 2 lần (theo số lần mua trọn đời Pancake ghi nhận, không cắt theo kỳ)"
          giaTri={pctLifetime === null ? "—" : formatPct1(pctLifetime)}
          phu={
            pctLifetime === null
              ? "Kỳ này không khách nào có số lần mua lifetime để tính."
              : `${soGon(d.khachLifetimeQuayLai)} / ${soGon(d.khachCoSoLieuLifetime)} khách đọc được số lần mua`
          }
        />
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-hairline pt-2 text-xs text-muted-foreground">
        {d.donThieuKhoaKhach > 0 && (
          <p>
            {soGon(d.donThieuKhoaKhach)} đơn không đọc được khoá khách (trên {soGon(d.donHopLeTrongKy)} đơn hợp
            lệ trong kỳ) — những đơn đó không vào số khách ở trên.
          </p>
        )}
        <p>
          Hai ô là HAI cách đếm khác nhau, không cộng/so với nhau được: bên trái tính theo lịch sử đơn app
          đang giữ, bên phải là số lần mua trọn đời do sàn báo tại thời điểm đồng bộ đơn.
        </p>
      </div>
    </section>
  );
}

function KhoiHoanHuy({ d }: { d: HoanHuyTach }) {
  const dong = [
    { ten: "Hoàn (khách nhận rồi trả)", n: d.hoan },
    { ten: "Hủy / bom (chết trước khi giao)", n: d.huy },
    // Chỉ hiện khi CÓ đơn: dòng 0 thường trực chỉ làm bảng nhiễu, còn khi > 0 thì bắt buộc phải thấy
    // — tổng ba nhóm phải khớp số hoàn/bom của /kenh, thiếu một nhóm là bảng tự nói dối.
    ...(d.khongRoMa.soDon > 0 ? [{ ten: "Không rõ mã gốc", n: d.khongRoMa }] : []),
  ];

  return (
    <section className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-muted-foreground">Hoàn ↔ Hủy/bom — tất cả kênh</h2>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Pancake</span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[360px] text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-2 font-normal">Nhóm</th>
              <th className="py-1.5 pr-2 text-right font-normal">Số đơn</th>
              <th className="py-1.5 text-right font-normal">Giá trị đơn</th>
            </tr>
          </thead>
          <tbody>
            {dong.map((r) => (
              <tr key={r.ten} className="border-b border-hairline/60 last:border-0">
                <td className="py-1.5 pr-2 text-ink">{r.ten}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-ink">{soGon(r.n.soDon)}</td>
                <td className="py-1.5 text-right tabular-nums text-ink">{formatVnd(r.n.tien)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 border-t border-hairline pt-2 text-xs text-muted-foreground">
        Mục Kênh và Lãi/Lỗ gộp hai nhóm này làm một (&quot;Hoàn/Bom&quot;); tách ở đây vì chúng là hai vấn đề
        khác nhau. &quot;Giá trị đơn&quot; là Σ tiền hàng của nhóm — KHÔNG phải doanh thu (đơn hoàn/hủy không
        vào doanh thu) và cũng KHÔNG phải khoản lỗ: phí sàn thực giữ trên đơn hoàn/hủy đã nằm trong Lãi/Lỗ.
      </p>
    </section>
  );
}

export function TongQuanP1Section({
  affiliate,
  khach,
  hoanHuy,
}: {
  affiliate: AffiliateTheoKy;
  khach: KhachTheoKy;
  hoanHuy: HoanHuyTach;
}) {
  return (
    <div className="flex flex-col gap-4">
      <KhoiAffiliate d={affiliate} />
      <KhoiKhach d={khach} />
      <KhoiHoanHuy d={hoanHuy} />
    </div>
  );
}
