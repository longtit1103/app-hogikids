import { Badge } from "@/components/ui/badge";
// Hai ngưỡng CÙNG bằng 26 giờ nhưng là hai hằng KHÁC NHAU, cố ý không dùng chung: chúng canh hai
// lượt việc khác nhau và có thể tách giá trị bất cứ lúc nào.
import {
  GIO_COI_LA_TRE as GIO_TRE_GIA_VON,
  type TrangThaiLechGiaVon,
} from "@/lib/gia-von/trang-thai-lech-gia-von";
import { GIO_COI_LA_TRE, type TinhTrangVaTonKho } from "@/lib/ingest/stock-resync-status";
import { KET_CUC_CAN_XEM } from "@/lib/ingest/webhook-processor";

/**
 * Khối "Webhook Pancake" trong section Kết nối & Đồng bộ.
 *
 * Lý do tồn tại (chủ shop chốt 2026-07-27): app chỉ xử lý các LOẠI sự kiện đã đo đạc
 * (đơn hàng, tồn kho KHO) — loại chưa xử lý hay loại LẠ phải HIỆN LÊN ĐÂY để biết mà vào
 * fix, tuyệt đối không nuốt im lặng. Số liệu đọc thẳng từ hộp thư `RawPancakeWebhookEvent`
 * (cột `processedAs`) — không qua SyncLog.
 */

/** Nhãn tiếng Việt cho từng kết cục. Danh sách "cần xem" lấy từ `KET_CUC_CAN_XEM` — MỘT nguồn. */
const NHAN_KET_CUC: Record<string, string> = {
  "don-hang": "Đơn hàng",
  "don-hang-cu-hon": "Đơn hàng — sự kiện cũ, đã bỏ qua",
  "don-hang-can-xem": "ĐƠN HÀNG CẦN XEM",
  "ton-kho": "Tồn kho — đã cập nhật",
  "ton-kho-cu-hon": "Tồn kho — sự kiện cũ, đã bỏ qua",
  "ton-kho-bo-qua": "Tồn kho shop bán (bỏ qua — mã biến thể riêng)",
  "ton-kho-chua-co-bien-the": "Tồn kho — biến thể chưa có trong app (lượt API sẽ tạo)",
  "ton-kho-chua-cau-hinh": "Tồn kho — chưa điền Warehouse ID (xem khối Khóa kết nối)",
  "ton-kho-can-xem": "TỒN KHO CẦN XEM",
  "san-pham-bo-qua": "Sản phẩm (bỏ qua — lấy từ API)",
  "bronze-only": "BRONZE_ONLY (tạm dừng Silver)",
  "truoc-pha-2": "Nhận trước khi app xử lý webhook (chỉ lưu)",
  "ping-thu": "Ping thử đường truyền (không phải sự kiện Pancake)",
  "khong-nhan-dien": "KHÔNG NHẬN DIỆN",
  loi: "LỖI XỬ LÝ",
};

/**
 * `null` = GHI KẾT CỤC THẤT BẠI — bất thường thật, phải tô đỏ.
 *
 * Trước 2026-07-27 null còn mang nghĩa thứ hai vô hại ("nhận trước khi app xử lý webhook"), khiến
 * panel báo đỏ 19 dòng hoàn toàn bình thường ngay sau khi pha 2 lên prod — tập cho người đọc thói
 * quen bỏ qua hộp đỏ, đúng cái panel này sinh ra để tránh. Nghĩa đó nay có kết cục riêng
 * `truoc-pha-2` (migration backfill), nên null chỉ còn một nghĩa duy nhất.
 */
function canChuY(processedAs: string | null): boolean {
  if (processedAs === null) return true;
  return (KET_CUC_CAN_XEM as readonly string[]).includes(processedAs);
}

function nhan(processedAs: string | null): string {
  if (processedAs === null) return "Chưa ghi được kết cục";
  return NHAN_KET_CUC[processedAs] ?? processedAs;
}

export type DongDemWebhook = { processedAs: string | null; soLuong: number };
export type SuKienCanXem = {
  id: string;
  shopId: string;
  receivedAt: Date;
  processedAs: string | null;
  processedNote: string | null;
};

function lucVN(d: Date): string {
  return d.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WebhookEventsSection({
  demTheoKetCuc,
  canXem,
  vaTonKho,
  lechGiaVon,
  tenShop,
}: {
  /** Map shop id → tên hiển thị (từ cấu hình `Setting` — page dựng, rỗng khi chưa cấu hình). */
  tenShop: Record<string, string>;
  /** Đếm sự kiện 7 ngày gần nhất theo kết cục (source=webhook — không tính kho nạp bù). */
  demTheoKetCuc: DongDemWebhook[];
  /** Sự kiện cần người xem trong CÙNG cửa sổ 7 ngày — mỗi dòng là một việc cần vào fix. */
  canXem: SuKienCanXem[];
  /** Lượt vá tồn kho từ API gần nhất — thứ giữ cho tồn webhook không lệch lâu dài. */
  vaTonKho: TinhTrangVaTonKho;
  /** Lệch giá vốn app ↔ Pancake — số do chính lượt đêm đó chốt. */
  lechGiaVon: TrangThaiLechGiaVon;
}) {
  const tong = demTheoKetCuc.reduce((s, d) => s + d.soLuong, 0);
  const soCanChuY = demTheoKetCuc
    .filter((d) => canChuY(d.processedAs))
    .reduce((s, d) => s + d.soLuong, 0);

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-soft p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Webhook Pancake (7 ngày)</h3>
        {tong === 0 ? (
          <span className="text-xs text-muted-foreground">Chưa nhận sự kiện nào</span>
        ) : soCanChuY === 0 ? (
          <span className="text-xs text-muted-foreground">Mọi sự kiện đều được nhận diện</span>
        ) : (
          <Badge variant="destructive">{soCanChuY} sự kiện cần xem</Badge>
        )}
      </div>

      {tong > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {demTheoKetCuc
            .filter((d) => d.soLuong > 0)
            .map((d) => (
              <span
                key={d.processedAs ?? "null"}
                className={canChuY(d.processedAs) ? "font-medium text-error" : "text-muted-foreground"}
              >
                {nhan(d.processedAs)}: {d.soLuong}
              </span>
            ))}
        </div>
      )}

      {/*
        Tồn kho nay do webhook ghi trong ngày, nên lượt vá từ API mỗi đêm là thứ DUY NHẤT kéo nó về
        đúng nếu lệch. Lượt đó ngừng chạy mà không nói gì thì tồn cứ hiển thị bình thường — nên mốc
        này phải nằm ngay đây, cạnh chỗ đếm sự kiện.
      */}
      <p className={vaTonKho.muc === "ok" ? "text-sm text-muted-foreground" : "text-sm font-medium text-error"}>
        {vaTonKho.muc === "chua-co"
          ? "Tồn kho: CHƯA có lượt vá nào từ API — kiểm lượt chạy đêm (pancake-nightly)."
          : vaTonKho.muc === "tre"
            ? `Tồn kho: lượt vá từ API gần nhất ${lucVN(vaTonKho.mocLuc!)} — đã hơn ${GIO_COI_LA_TRE} giờ, kiểm lượt chạy đêm.`
            : `Tồn kho: vá từ API lần cuối ${lucVN(vaTonKho.mocLuc!)}.`}
      </p>

      {/*
        Cùng lý do với dòng trên, cho giá vốn: lượt đêm là thứ DUY NHẤT phát hiện app lệch giá vốn
        với Pancake. Nó chết thì banner nhắc việc im lặng luôn — mà im lặng ở đó trông y hệt "đang
        khớp". Mốc này để chủ shop kiểm được cơ chế còn sống, không phải tin suông.
      */}
      <p className={lechGiaVon.muc === "khop" ? "text-sm text-muted-foreground" : "text-sm font-medium text-error"}>
        {lechGiaVon.muc === "chua-kiem"
          ? "Giá vốn: CHƯA đối chiếu lần nào với Pancake — kiểm lượt chạy đêm (pancake-nightly)."
          : lechGiaVon.muc === "tre"
            ? `Giá vốn: đối chiếu gần nhất ${lucVN(lechGiaVon.mocLuc!)} — đã hơn ${GIO_TRE_GIA_VON} giờ, kiểm lượt chạy đêm.`
            : lechGiaVon.muc === "co-lech"
              ? `Giá vốn: ${lechGiaVon.soLech} mã đang lệch với Pancake (đối chiếu ${lucVN(lechGiaVon.mocLuc!)}).`
              : `Giá vốn: khớp Pancake, đối chiếu lần cuối ${lucVN(lechGiaVon.mocLuc!)}.`}
      </p>

      {canXem.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-error/10 p-3 text-sm">
          <p className="font-semibold text-error">Sự kiện app chưa hiểu — cần vào fix:</p>
          {canXem.map((s) => (
            <p key={s.id} className="text-error/90">
              {lucVN(s.receivedAt)} · {tenShop[s.shopId] ?? s.shopId} · {nhan(s.processedAs)} —{" "}
              {s.processedNote ?? "(không có ghi chú)"}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
