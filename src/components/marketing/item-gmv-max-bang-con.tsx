import { SoSanBao } from "@/components/marketing/so-san-bao";
import { formatVnd } from "@/lib/format";
import type { BangItemChienDich } from "@/lib/reports/marketing/gmv-max-theo-san-pham";

/**
 * Bảng con item-level khi bung một dòng chiến dịch TikTok GMV Max ở tab `quang-cao` (spec §5.4/A6,
 * task-8-brief Step 4). Chi (gồm VAT) là số ĐÃ quy đổi từ sổ (`gmvMaxTheoSanPham` đã tính, KHÔNG bọc
 * `<SoSanBao>` — đúng tiền, không phải claim của sàn); Đơn/GMV sàn là số TikTok TỰ NHẬN CÔNG ⇒ bọc.
 */

function soGon(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

export function ItemGmvMaxBangCon({ bang }: { bang: BangItemChienDich }) {
  return (
    <div className="px-2 pb-3 pt-1">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-xs">
          <thead>
            <tr className="border-b border-hairline/60 text-left text-muted-foreground">
              <th className="py-1 pr-2 font-normal">Sản phẩm</th>
              <th className="py-1 pr-2 text-right font-normal">Chi (gồm VAT)</th>
              <th className="py-1 pr-2 text-right font-normal">Đơn</th>
              <th className="py-1 text-right font-normal">GMV sàn</th>
            </tr>
          </thead>
          <tbody>
            {bang.dong.map((d) => (
              <tr key={d.itemGroupId} className="border-b border-hairline/40 last:border-0">
                <td className="max-w-[220px] truncate py-1 pr-2 text-ink" title={d.ten}>
                  {d.ten}
                </td>
                <td className="py-1 pr-2 text-right tabular-nums text-ink">{formatVnd(d.chiGomVat)}</td>
                <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                  {d.donSan === null ? "—" : <SoSanBao>{soGon(d.donSan)}</SoSanBao>}
                </td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {d.gmvSan === null ? "—" : <SoSanBao>{formatVnd(d.gmvSan)}</SoSanBao>}
                </td>
              </tr>
            ))}
            {bang.chuaPhanBoGomVat !== 0 && (
              <tr>
                <td className="py-1 pr-2 text-ink">Chưa phân bổ</td>
                <td className="py-1 pr-2 text-right tabular-nums text-ink">{formatVnd(bang.chuaPhanBoGomVat)}</td>
                <td className="py-1 pr-2 text-right text-muted-foreground">—</td>
                <td className="py-1 text-right text-muted-foreground">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Chi ở bảng con là số sàn báo cho từng sản phẩm, đã quy về <strong>gồm VAT</strong> theo cùng hệ số tháng
        với cột Chi tiêu. Tổng các sản phẩm thường <strong>nhỏ hơn</strong> chi của chiến dịch — phần chênh nằm
        ở dòng &quot;Chưa phân bổ&quot; (đo 25/08: ~0,6%). Số này thỉnh thoảng có thể ÂM (tổng các sản phẩm
        nhỉnh hơn chi của chiến dịch một chút, do làm tròn theo từng ngày) — không phải app tính sai. Chi phí
        vào Lãi/Lỗ vẫn lấy ở cấp chiến dịch, không lấy ở đây.
      </p>
    </div>
  );
}
