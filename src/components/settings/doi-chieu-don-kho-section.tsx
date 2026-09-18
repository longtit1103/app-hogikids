import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import type { KetQuaDoiChieuKho } from "@/lib/reports/doi-chieu-don-kho";
import { cn } from "@/lib/utils";

/**
 * Khối "Đối chiếu đơn với kho" trong section Kết nối & Đồng bộ.
 *
 * Mỗi đơn sàn đều có một bản sao trong shop Kho Tổng để trừ tồn. Bản sao không tính doanh thu,
 * nhưng nó tồn tại độc lập với đơn gốc nên làm được việc mà không ai khác làm được: chứng minh app
 * đang thiếu đơn. Khối này hiện kết quả phép so đó — im lặng khi khớp, đỏ khi hụt.
 *
 * Vì sao đáng một khối riêng: lần thiếu đơn Shopee tháng 3–4/2026 (một cụm đơn bị thiếu)
 * nằm im 4 tháng, chỉ lộ ra khi chủ shop tình cờ so tay với Pancake. Log đồng bộ lúc đó vẫn xanh —
 * vì sync không hề lỗi, Pancake chỉ đơn giản không còn trả đơn cũ nữa.
 */

const NHAN_KENH: Record<string, string> = { shopee: "Shopee", tiktok: "TikTok Shop" };
const NHAN_TRANG_THAI: Record<string, string> = {
  delivered: "đã giao",
  returning: "đang hoàn",
  returned: "đã hoàn",
  canceled: "đã hủy",
};

export function DoiChieuDonKhoSection({ ketQua }: { ketQua: KetQuaDoiChieuKho | null }) {
  // null = phép đối chiếu không chạy được (thường: chưa cấu hình shop ID) — trang Cài đặt vẫn
  // phải render vì chính nó là nơi điền cấu hình.
  if (ketQua === null) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-ink">Đối chiếu đơn với kho</h3>
        <p className="text-xs text-muted-foreground">
          Chưa chạy được — kiểm tra đã điền đủ Shop ID ở khối &quot;Khóa kết nối&quot; phía trên chưa.
        </p>
      </div>
    );
  }
  const { tongBanSao, thieu, tienThieuDaGiao } = ketQua;
  const khop = thieu.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-ink">Đối chiếu đơn với kho</h3>
        <Badge variant={khop ? "secondary" : "destructive"}>
          {khop ? `Khớp ${tongBanSao} đơn` : `Thiếu ${thieu.length} đơn`}
        </Badge>
      </div>

      {khop ? (
        <p className="text-xs text-muted-foreground">
          Mọi đơn có bản sao trong Kho Tổng đều đã có trong app. Đây là phép kiểm chống mất đơn âm
          thầm — sàn ngừng trả đơn cũ thì log đồng bộ vẫn xanh, chỉ chỗ này phát hiện được.
        </p>
      ) : (
        <>
          <div className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/5 p-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-error" />
            <div className="flex flex-col gap-1 text-xs">
              <p className="text-ink">
                Kho có bản sao của <strong>{thieu.length} đơn</strong> mà app không có đơn gốc
                {tienThieuDaGiao > 0 && (
                  <>
                    {" "}
                    — trong đó <strong>{formatVnd(tienThieuDaGiao)}</strong> là đơn đã giao, tức
                    doanh thu báo cáo đang thiếu đúng chừng đó.
                  </>
                )}
              </p>
              <p className="text-muted-foreground">
                Thường do sàn ngừng trả đơn cũ qua Pancake. Bù bằng{" "}
                <code className="rounded bg-surface-soft px-1">scripts/bu-don-shopee-tu-don-kho.ts</code>{" "}
                sau khi xem danh sách dưới đây.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-hairline">
            <table className="w-full text-xs">
              <thead className="bg-surface-soft text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Ngày đặt</th>
                  <th className="px-3 py-2 text-left font-medium">Kênh</th>
                  <th className="px-3 py-2 text-left font-medium">Mã đơn</th>
                  <th className="px-3 py-2 text-left font-medium">Trạng thái</th>
                  <th className="px-3 py-2 text-right font-medium">Tiền hàng</th>
                </tr>
              </thead>
              <tbody>
                {thieu.map((d) => (
                  <tr key={`${d.kenh}-${d.code}`} className="border-t border-hairline">
                    <td className="px-3 py-1.5 tabular-nums">
                      {d.ngayDat ? d.ngayDat.toLocaleDateString("vi-VN") : "?"}
                    </td>
                    <td className="px-3 py-1.5">{NHAN_KENH[d.kenh] ?? d.kenh}</td>
                    <td className="px-3 py-1.5 font-mono">{d.code}</td>
                    <td
                      className={cn(
                        "px-3 py-1.5",
                        d.trangThaiKho === "delivered" ? "text-error" : "text-muted-foreground"
                      )}
                    >
                      {NHAN_TRANG_THAI[d.trangThaiKho] ?? d.trangThaiKho}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatVnd(d.tienHang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Chỉ đơn <span className="text-error">đã giao</span> mới ảnh hưởng doanh thu; đơn hủy/hoàn
            bù vào để tỉ lệ hoàn/hủy ở <Link href="/kenh" className="underline">trang Kênh</Link> đúng.
          </p>
        </>
      )}
    </div>
  );
}
