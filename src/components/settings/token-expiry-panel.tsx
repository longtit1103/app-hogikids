import { Badge } from "@/components/ui/badge";
import { coCanhBaoToken, type HanToken, type MucCanhBaoToken } from "@/lib/tokens/token-expiry";

/**
 * Khối "Hạn kết nối" trong section Kết nối & Đồng bộ.
 *
 * Lý do tồn tại: token Meta KHÔNG gia hạn tự động được nên phải có người cấp lại trước hạn. Workflow
 * n8n đã cảnh báo, nhưng cảnh báo đó nằm trong log n8n — chủ shop không mở n8n nên coi như không có.
 * Đây là chỗ chủ shop thật sự nhìn thấy.
 */

const NHAN: Record<MucCanhBaoToken, { chu: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ok: { chu: "Còn hạn", variant: "secondary" },
  "sap-het": { chu: "Sắp hết hạn", variant: "outline" },
  gap: { chu: "Cần làm sớm", variant: "destructive" },
  "het-han": { chu: "ĐÃ HẾT HẠN", variant: "destructive" },
  "chua-biet": { chu: "Chưa có mốc", variant: "outline" },
};

function ngayVN(d: Date): string {
  return d.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" });
}

function dongThoiGian(t: HanToken): string {
  if (!t.hetHanLuc || t.conNgay === null) return "Sẽ hiện sau lần kết nối kế tiếp";
  if (t.conNgay <= 0) return `Hết hạn ${ngayVN(t.hetHanLuc)}`;
  return `${ngayVN(t.hetHanLuc)} · còn ${t.conNgay} ngày`;
}

export function TokenExpiryPanel({ danhSach }: { danhSach: HanToken[] }) {
  const canChuY = coCanhBaoToken(danhSach);
  const phaiLamTay = danhSach.filter((t) => !t.tuGiaHan && (t.muc === "gap" || t.muc === "sap-het" || t.muc === "het-han"));

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-soft p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Hạn kết nối</h3>
        {!canChuY && <span className="text-xs text-muted-foreground">Chưa có việc gì cần làm</span>}
      </div>

      {/* Có việc phải làm tay ⇒ nói THẲNG phải làm gì, ngay đầu khối, không bắt đọc bảng để suy ra. */}
      {phaiLamTay.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-error/10 p-3 text-sm text-error">
          {phaiLamTay.map((t) => (
            <p key={t.ten}>
              <span className="font-semibold">{t.ten}</span>{" "}
              {t.conNgay !== null && t.conNgay > 0 ? `còn ${t.conNgay} ngày` : "đã hết hạn"} — {t.viecCanLam}
            </p>
          ))}
        </div>
      )}

      <ul className="flex flex-col divide-y divide-hairline">
        {danhSach.map((t) => (
          <li key={t.ten} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-ink">{t.ten}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{dongThoiGian(t)}</span>
                <Badge variant={NHAN[t.muc].variant}>{NHAN[t.muc].chu}</Badge>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t.tuGiaHan ? "Máy tự gia hạn — không phải làm gì. " : ""}
              {t.moTa}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
