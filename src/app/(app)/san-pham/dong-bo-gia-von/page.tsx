import Link from "next/link";

import { ApGiaVonButton } from "@/components/products/ap-gia-von-button";
import { Badge } from "@/components/ui/badge";
import { tinhAnhHuongCogs } from "@/lib/gia-von/anh-huong-cogs";
import { docDeXuatGiaVon } from "@/lib/gia-von/doc-de-xuat-gia-von";
import { vanTayDeXuat, type CheDoDoiChieu } from "@/lib/gia-von/doi-chieu-gia-von";
import { formatVnd } from "@/lib/format";
import { requireUser } from "@/lib/session";

/**
 * Màn DUYỆT giá vốn theo Pancake — thay cho việc chủ shop phải nhớ mà báo rồi có người chạy CLI.
 *
 * Bất biến #5 (`Variant.costPrice` APP-OWNED) KHÔNG bị nới: vẫn phải có người xem danh sách rồi bấm.
 * Cái bỏ đi là bước "phải NHỚ" và bước "phải mở terminal".
 *
 * BẢNG ẢNH HƯỞNG THEO THÁNG là bắt buộc, không phải trang trí: COGS dùng giá vốn HIỆN HÀNH nên áp
 * giá hôm nay là viết lại lãi/lỗ mọi kỳ đã đóng (đo 07/09: 91,5% ΔCOGS rơi vào hàng đã bán xong
 * trước khi lô mới về kho). Chủ shop chốt chấp nhận cách tính đó VỚI ĐIỀU KIỆN thấy trước khi bấm —
 * bỏ bảng này là bỏ luôn điều kiện đã cam kết, nút bấm khi đó chỉ là CLI đẹp hơn.
 */
export default async function DongBoGiaVonPage({
  searchParams,
}: {
  searchParams: Promise<{ che_do?: string }>;
}) {
  await requireUser("/san-pham/dong-bo-gia-von");

  const sp = await searchParams;
  const cheDo: CheDoDoiChieu = sp.che_do === "chi-thieu" ? "chi-thieu" : "theo-pancake";

  const { deXuat, conPhaiNhapTay } = await docDeXuatGiaVon(cheDo);
  const anhHuong = await tinhAnhHuongCogs(deXuat);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl text-ink">Đồng bộ giá vốn từ Pancake</h1>
        <p className="text-sm text-muted-foreground">
          App giữ giá vốn riêng nên giá bên Pancake không tự chảy sang. Màn này so hai bên và cho bạn
          duyệt một lần.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <CheDoLink cheDo={cheDo} giaTri="theo-pancake" nhan="Lấy Pancake làm chuẩn" />
        <CheDoLink cheDo={cheDo} giaTri="chi-thieu" nhan="Chỉ điền mã còn trống" />
      </div>

      {deXuat.length === 0 ? (
        <div className="rounded-lg border border-hairline bg-surface-card p-6 text-sm text-muted-foreground">
          Không có mã nào lệch — giá vốn trong app đang khớp Pancake.
          {conPhaiNhapTay > 0 && (
            <>
              {" "}
              Còn <strong className="text-ink">{conPhaiNhapTay.toLocaleString("vi-VN")}</strong> mã phải
              nhập tay ở <Link href="/san-pham" className="underline">trang Sản phẩm</Link> vì Pancake
              cũng chưa khai giá vốn cho chúng.
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
            <p className="text-sm font-semibold text-ink">
              {deXuat.length.toLocaleString("vi-VN")} mã lệch giá vốn.
              {anhHuong.tongDonHopLe !== 0 && (
                <>
                  {" "}
                  Nếu áp, lãi toàn bộ lịch sử sẽ{" "}
                  {anhHuong.tongDonHopLe < 0 ? "TĂNG" : "GIẢM"}{" "}
                  {formatVnd(Math.abs(anhHuong.tongDonHopLe))}.
                </>
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              Giá vốn là số <strong>hiện hành</strong>, không chụp ảnh lúc bán — nên sửa hôm nay thì
              lãi các tháng đã qua cũng tính lại theo. Đây là thiết kế cố ý, không phải lỗi.
              {anhHuong.soBienTheChuaBan > 0 && (
                <>
                  {" "}
                  ({anhHuong.soBienTheChuaBan.toLocaleString("vi-VN")} mã chưa bán cái nào — áp giá
                  không đụng tới lãi kỳ nào.)
                </>
              )}
            </p>
          </div>

          {anhHuong.theoThang.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="font-serif text-lg text-ink">Lãi từng tháng sẽ đổi thế nào</h2>
              <div className="overflow-x-auto rounded-lg border border-hairline">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="bg-surface-soft text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Tháng</th>
                      <th className="px-3 py-2 text-right font-medium">Số lượng đã bán</th>
                      <th className="px-3 py-2 text-right font-medium">Lãi tháng đó đổi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anhHuong.theoThang.map((t) => (
                      <tr key={t.thang} className="border-t border-hairline">
                        <td className="px-3 py-2 text-ink">{thangVietNam(t.thang)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {t.soDonViDaBan.toLocaleString("vi-VN")}
                        </td>
                        {/* ΔCOGS âm = giá vốn giảm = LÃI TĂNG. Đảo dấu để cột nói đúng thứ chủ shop
                            quan tâm; nhãn cột cũng nói "lãi", không nói "giá vốn". */}
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            t.deltaCogs < 0 ? "text-success" : "text-error"
                          }`}
                        >
                          {t.deltaCogs < 0 ? "+" : "−"}
                          {formatVnd(Math.abs(t.deltaCogs))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h2 className="font-serif text-lg text-ink">Chi tiết {deXuat.length} mã</h2>
            <div className="overflow-x-auto rounded-lg border border-hairline">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-surface-soft text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Mã</th>
                    <th className="px-3 py-2 font-medium">Tên</th>
                    <th className="px-3 py-2 text-right font-medium">Giá vốn app</th>
                    <th className="px-3 py-2 text-right font-medium">Giá vốn Pancake</th>
                    <th className="px-3 py-2 text-right font-medium">Chênh</th>
                    <th className="px-3 py-2 font-medium">Nguồn số</th>
                  </tr>
                </thead>
                <tbody>
                  {deXuat.map((d) => (
                    <tr key={d.variantId} className="border-t border-hairline">
                      <td className="px-3 py-2 font-mono text-xs text-ink">{d.sku}</td>
                      <td className="max-w-[280px] truncate px-3 py-2 text-ink" title={d.ten}>
                        {d.ten}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {d.giaHienTai === 0 ? "(trống)" : formatVnd(d.giaHienTai)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink">
                        {formatVnd(d.giaDeXuat)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {d.giaDeXuat > d.giaHienTai ? "+" : "−"}
                        {formatVnd(Math.abs(d.giaDeXuat - d.giaHienTai))}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">
                          {d.nguon === "trung-binh" ? "Giá TB Pancake" : "Giá nhập lần cuối"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <ApGiaVonButton
            cheDo={cheDo}
            // Vân tay của ĐÚNG danh sách đang hiện trên màn — lượt ghi từ chối nếu nó đã đổi.
            vanTay={vanTayDeXuat(deXuat)}
            soDong={deXuat.length}
            soDongDeLen={deXuat.filter((d) => d.giaHienTai > 0).length}
            soThangAnhHuong={anhHuong.theoThang.length}
          />
        </>
      )}
    </div>
  );
}

/** `2026-09` → `Tháng 9/2026`. */
function thangVietNam(thang: string): string {
  const [nam, thg] = thang.split("-");
  return `Tháng ${Number(thg)}/${nam}`;
}

function CheDoLink({
  cheDo,
  giaTri,
  nhan,
}: {
  cheDo: CheDoDoiChieu;
  giaTri: CheDoDoiChieu;
  nhan: string;
}) {
  const dangChon = cheDo === giaTri;
  return (
    <Link
      href={`/san-pham/dong-bo-gia-von?che_do=${giaTri}`}
      className={`rounded-lg border px-3 py-1.5 text-sm transition ${
        dangChon
          ? "border-primary bg-primary/10 font-medium text-ink"
          : "border-hairline text-muted-foreground hover:bg-surface-soft"
      }`}
    >
      {nhan}
    </Link>
  );
}
