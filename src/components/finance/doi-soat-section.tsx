import Link from "next/link";

import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import { PROVISIONAL_FEE_TITLE } from "@/lib/orders/provisional-fee";
import type { DoiSoatTienVe } from "@/lib/reports/doi-soat-tien-ve";
import { CUA_SO_CHO_QUYET_TOAN_NGAY } from "@/lib/reports/doi-soat-tien-ve";
import { cn } from "@/lib/utils";

/**
 * Khối "Đối soát tiền về" của tab Dòng tiền — kênh TikTok, cấp TỪNG ĐƠN.
 *
 * Thuần hiển thị. Số quyết toán ở đây KHÔNG sửa gì trong P&L (bất biến #7); hai
 * cột đứng cạnh nhau để người đọc tự so.
 *
 * ⚠️ Mốc 30 ngày của lưới "hoàn mà còn tiền" neo NGÀY ĐẶT, KHÔNG neo lúc đánh
 * hoàn — mốc kia bị đẩy lùi mỗi lượt sửa Pancake. Chữ trên màn phải nói đúng mốc
 * đó, kẻo chỉ chủ shop đi kiểm sai chỗ.
 *
 * Vì sao không có ngưỡng %: đo prod 2026-08-18 thấy dữ liệu chia hai cực dứt
 * khoát — 288/295 đơn khớp TỪNG ĐỒNG, 7 đơn còn lại lệch trên 10%. Không có đơn
 * nào rơi vào khoảng 0–10%, nên mọi ngưỡng đều chỉ tạo chỗ cho lỗi thật lọt qua.
 * Lệch một đồng cũng nêu.
 */

/** Một ô đếm trong dải tổng kết. */
function ODemDoiSoat({
  nhan,
  so,
  mo,
  canhBao,
}: {
  nhan: string;
  so: number;
  mo?: string;
  canhBao?: boolean;
}) {
  return (
    <div className="rounded-lg bg-surface-soft px-3 py-2">
      <p className={cn("font-serif text-lg tabular-nums", canhBao && so > 0 ? "text-error" : "text-ink")}>{so}</p>
      <p className="text-xs text-muted-foreground">{nhan}</p>
      {mo && <p className="text-[11px] text-muted-foreground/80">{mo}</p>}
    </div>
  );
}

/**
 * Dùng cho CẢ HAI kênh. Shopee mang thêm `khongDuKhoa` (đơn mirror lịch sử không nối được với ví);
 * TikTok không truyền field đó nên ô thứ 7 tự vắng — không cần nhân bản component.
 */
export function DoiSoatSection({
  doiSoat,
  tenKenh,
  nguon,
}: {
  doiSoat: DoiSoatTienVe & { khongDuKhoa?: number; chuaNhapVi?: number };
  tenKenh: string;
  /** Nguồn số của sàn, hiện trong dòng khai trục để không ai tưởng hai kênh cùng một đường dữ liệu. */
  nguon: string;
}) {
  const {
    khop, lech, chuaThay, treoChuaGiao, dangCho,
    tongDelta, tongLechTuyetDoi, danhSachLech,
    hoanConTien, tongTienVeDonHoan,
  } = doiSoat;
  // Cộng cả hai nhóm "không kết luận được" vào phép đếm ẩn khối: kỳ toàn đơn mirror (vd tháng 3 —
  // 0/9 nối được) mà ẩn sạch thì chủ shop không thấy gì, kể cả chính lời giải thích vì sao không thấy.
  const daKetLuan =
    khop + lech + chuaThay + treoChuaGiao + (doiSoat.khongDuKhoa ?? 0) + (doiSoat.chuaNhapVi ?? 0);

  // Kỳ không có đơn TikTok nào thì khối này là nhiễu — ẩn hẳn thay vì hiện dải số 0.
  if (daKetLuan + dangCho + hoanConTien.length === 0) return null;

  const canKiemTra = hoanConTien.filter((d) => !d.choGiaoDichDao);
  // Nguồn nào KHÔNG đo được "doanh thu sàn ghi nhận" thì ẩn hẳn cột, không in 0. "Không đo được" và
  // "đo được và bằng 0" là hai chuyện khác nhau — cùng luật đã dựng cho bảng quảng cáo theo chiến dịch.
  const coDoanhThuSan = hoanConTien.some((d) => d.doanhThuSan !== null);

  // Σ có DẤU bị bù trừ: hai đơn lệch ngược chiều 500k triệt tiêu thành "Σ 0đ" đọc
  // ra là "hoà, không mất gì". Nên màu bám theo CÓ ĐƠN LỆCH HAY KHÔNG, và khi hai
  // con số khác nhau thì phải hiện cả hai.
  const coBuTru = lech > 0 && tongDelta !== tongLechTuyetDoi && tongDelta !== -tongLechTuyetDoi;

  return (
    <div className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Đối soát tiền về — {tenKenh}, từng đơn</p>
          {/* Khai TRỤC: khối "Tiền đã về" ngay trên chạy theo NGÀY SAO KÊ và gồm cả
              giao dịch quảng cáo, khối này theo NGÀY ĐẶT đơn. Không nói ra thì chủ
              shop sẽ cộng cột rồi so với card trên, thấy vênh và tưởng app sai. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            đơn lọc theo NGÀY ĐẶT · tiền sàn tính tới HÔM NAY (gồm cả giao dịch đảo rơi ngoài kỳ) ·
            nguồn: {nguon} · khác trục với &quot;Tiền đã về&quot; ở trên (ngày sao kê) — hai số không
            cộng khớp nhau
          </p>
        </div>
        {lech === 0 && chuaThay === 0 && canKiemTra.length === 0 && khop > 0 && (
          <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
            ✓ {khop}/{khop} đơn khớp từng đồng
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <ODemDoiSoat nhan="Khớp từng đồng" so={khop} />
        <ODemDoiSoat nhan="Lệch" so={lech} canhBao />
        <ODemDoiSoat nhan="Chưa thấy quyết toán" so={chuaThay} mo="đơn đã giao xong" canhBao />
        <ODemDoiSoat nhan="Treo chưa giao" so={treoChuaGiao} mo={`quá ${CUA_SO_CHO_QUYET_TOAN_NGAY} ngày`} />
        <ODemDoiSoat nhan="Đang chờ sàn" so={dangCho} mo={`dưới ${CUA_SO_CHO_QUYET_TOAN_NGAY} ngày`} />
        {/* Ô thứ 6: thiếu nó thì dải tổng kết toàn số 0 trong khi ngay dưới là bảng
            báo tiền treo — người đọc lướt dải ô sẽ kết luận "kỳ này sạch".
            Đếm số VIỆC PHẢI LÀM (`canKiemTra`), không đếm cả `hoanConTien`: nhóm
            "chờ giao dịch đảo" là chưa kết luận được, đỏ nó lên là phá đúng quy ước
            mà hai ô "Treo chưa giao"/"Đang chờ sàn" đang giữ. Và vì sàn LUÔN trả
            tiền trước rồi mới đảo, mọi đơn hoàn đều đi qua nhóm chờ ⇒ đỏ theo tổng
            sẽ sáng gần như thường trực, tới lúc chủ shop thôi đọc màu đỏ. */}
        {/* Ô RIÊNG, cố ý KHÔNG canhBao: nhóm này vô phương cứu và sẽ không bao giờ đổi. Nhét nó vào
            "Chưa thấy quyết toán" là dựng một vệt đỏ vĩnh viễn, mà vệt đỏ không tắt thì người ta thôi
            đọc màu đỏ — giết luôn cảnh báo thật. */}
        {doiSoat.khongDuKhoa !== undefined && doiSoat.khongDuKhoa > 0 && (
          <ODemDoiSoat
            nhan="Không đủ khoá liên kết lịch sử"
            so={doiSoat.khongDuKhoa}
            mo="đơn cũ không còn mã sàn"
          />
        )}
        {/* Cũng KHÔNG cảnh báo: nguyên nhân nằm ở chỗ chưa nhập file, không phải sàn thiếu tiền. */}
        {doiSoat.chuaNhapVi !== undefined && doiSoat.chuaNhapVi > 0 && (
          <ODemDoiSoat nhan="Chưa nhập file kỳ này" so={doiSoat.chuaNhapVi} mo="ngoài vùng file đã nhập" />
        )}
        <ODemDoiSoat
          nhan="Hoàn mà còn tiền"
          so={canKiemTra.length}
          mo={
            hoanConTien.length > canKiemTra.length
              ? `+${hoanConTien.length - canKiemTra.length} đang chờ đảo`
              : "đặt quá hạn, sàn chưa đảo"
          }
          canhBao
        />
      </div>

      {lech > 0 && (
        <div className="mt-3 border-t border-hairline pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-ink">Đơn lệch — sàn trả khác số app tính</p>
            <p className="font-serif tabular-nums text-error">
              Tổng lệch {formatVnd(tongLechTuyetDoi)}
              {coBuTru && (
                <span className="ml-2 text-xs font-sans text-muted-foreground">
                  (ròng {formatVnd(tongDelta)} — hụt và dư bù trừ nhau)
                </span>
              )}
            </p>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-2 font-normal">Đơn</th>
                  <th className="py-1.5 pr-2 font-normal">Trạng thái</th>
                  <th className="py-1.5 pr-2 text-right font-normal">App tính nhận</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Sàn trả thật</th>
                  <th className="py-1.5 text-right font-normal">Lệch</th>
                </tr>
              </thead>
              <tbody>
                {danhSachLech.map((d) => (
                  <tr key={d.id} className="border-b border-hairline/60 last:border-0">
                    <td className="py-1.5 pr-2">
                      <Link href={`/don-hang?don=${d.id}`} className="text-ink underline-offset-2 hover:underline">
                        #{d.code}
                      </Link>
                      {/* Mã ngắn KHÔNG định danh được đơn (TikTok có 2 cặp mã trùng) —
                          hiện đuôi mã sàn để tra bên Pancake không nhầm đơn. */}
                      <span className="ml-1 text-xs text-muted-foreground" title={d.pancakeId}>
                        …{d.pancakeId.slice(-6)}
                      </span>
                      <span className="ml-1 text-xs text-muted-foreground">({d.soGiaoDich} gd)</span>
                      {d.phiTamTinh && (
                        <Badge
                          variant="outline"
                          className="ml-1 border-warning/40 text-warning"
                          title={PROVISIONAL_FEE_TITLE}
                        >
                          tạm tính
                        </Badge>
                      )}
                    </td>
                    <td className="py-1.5 pr-2">
                      <OrderStatusBadge status={d.status} />
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatVnd(d.thucNhanApp)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatVnd(d.sanTra)}</td>
                    {/* Lệch DƯƠNG cũng là bất khớp cần soi, không phải tin vui —
                        không tô xanh. Xanh chỉ dành cho "khớp". */}
                    <td className={cn("py-1.5 text-right tabular-nums", d.delta < 0 ? "text-error" : "text-warning")}>
                      {d.delta > 0 ? "+" : ""}
                      {formatVnd(d.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {danhSachLech.some((d) => d.phiTamTinh) && (
              <p>
                Đơn gắn nhãn <span className="text-warning">tạm tính</span>: app CHƯA nhận được phí sàn thật
                vì sàn chưa đối soát xong — lệch ở đây KHÔNG phải mất tiền. Phí thật tự về khi đơn
                được đồng bộ lại; nếu quá lâu mà phí vẫn thấp bất thường thì báo hỗ trợ Pancake, đừng đi
                tra soát với sàn.
              </p>
            )}
            <p>
              Các đơn còn lại: lệch âm thường là đơn bị hoàn sau khi sàn đã quyết toán, hoặc sàn thu thêm
              phí sau đối soát. Bấm mã đơn để xem chi tiết từng khoản.
            </p>
            <p>Số sàn trả về chỉ để ĐỐI CHIẾU — không sửa gì trong Lãi/Lỗ.</p>
          </div>
        </div>
      )}

      {hoanConTien.length > 0 && (
        <div className="mt-3 border-t border-hairline pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-ink">Đơn hoàn/hủy mà sàn vẫn ghi nhận tiền</p>
            <p className="font-serif tabular-nums text-error">
              Tiền đã về của đơn hoàn {formatVnd(tongTienVeDonHoan)}
            </p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Các đơn này đang bị LOẠI khỏi doanh thu Lãi/Lỗ vì mang trạng thái hoàn/hủy, nhưng sàn thì vẫn
            ghi nhận doanh thu hoặc vẫn trả tiền về. Chỉ cảnh báo — app không tự sửa trạng thái và không tự
            đưa số này vào Lãi/Lỗ.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            ⚠️ Đây là tiền sàn <strong>ĐÃ chuyển</strong>, không phải khoản thu thêm —{" "}
            <strong>đừng cộng vào bất kỳ tổng nào ở trên</strong>. Tổng chỉ cộng những đơn sàn trả dương,
            nên cộng tay cả cột có thể ra số khác.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-2 font-normal">Đơn</th>
                  <th className="py-1.5 pr-2 font-normal">Trạng thái</th>
                  {coDoanhThuSan && (
                    <th className="py-1.5 pr-2 text-right font-normal">Sàn ghi doanh thu</th>
                  )}
                  <th className="py-1.5 pr-2 text-right font-normal">Sàn đã trả</th>
                  <th className="py-1.5 font-normal">Cần làm gì</th>
                </tr>
              </thead>
              <tbody>
                {hoanConTien.map((d) => (
                  <tr key={d.id} className="border-b border-hairline/60 last:border-0">
                    <td className="py-1.5 pr-2">
                      <Link href={`/don-hang?don=${d.id}`} className="text-ink underline-offset-2 hover:underline">
                        #{d.code}
                      </Link>
                      <span className="ml-1 text-xs text-muted-foreground" title={d.pancakeId}>
                        …{d.pancakeId.slice(-6)}
                      </span>
                      <span className="ml-1 text-xs text-muted-foreground">({d.soGiaoDich} gd)</span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <OrderStatusBadge status={d.status} />
                    </td>
                    {coDoanhThuSan && (
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {d.doanhThuSan === null ? "—" : formatVnd(d.doanhThuSan)}
                      </td>
                    )}
                    <td className={cn("py-1.5 pr-2 text-right tabular-nums", d.sanTra > 0 && "text-error")}>
                      {formatVnd(d.sanTra)}
                    </td>
                    <td className="py-1.5 text-xs">
                      {d.choGiaoDichDao ? (
                        <span className="text-muted-foreground">Chờ giao dịch đảo</span>
                      ) : (
                        <span className="text-error">Cần kiểm tra trạng thái</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {hoanConTien.some((d) => d.choGiaoDichDao) && (
              <p>
                <span className="text-muted-foreground">Chờ giao dịch đảo</span>: đơn ĐẶT trong vòng{" "}
                {CUA_SO_CHO_QUYET_TOAN_NGAY} ngày — sàn thường trả tiền trước rồi mới phát sinh giao dịch
                đảo, nên chưa kết luận được.
              </p>
            )}
            {canKiemTra.length > 0 && (
              <p>
                <span className="text-error">Cần kiểm tra trạng thái</span>: đơn ĐẶT đã quá{" "}
                {CUA_SO_CHO_QUYET_TOAN_NGAY} ngày mà sàn vẫn chưa có giao dịch đảo — đối chiếu trạng thái
                thật bên sàn. Nếu lệch mà Pancake khoá không cho sửa tay (đơn sàn thường bị khoá), báo hỗ
                trợ Pancake đồng bộ lại đơn. {canKiemTra.length} đơn đang ở nhóm này.
              </p>
            )}
          </div>
        </div>
      )}

      {chuaThay > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
          ⚠️ {chuaThay} đơn đã giao xong và quá {CUA_SO_CHO_QUYET_TOAN_NGAY} ngày mà sàn vẫn chưa có giao dịch
          quyết toán nào.
        </p>
      )}

      {treoChuaGiao > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
          ⚠️ {treoChuaGiao} đơn quá {CUA_SO_CHO_QUYET_TOAN_NGAY} ngày mà vẫn chưa giao xong — nhiều khả năng
          Pancake chưa cập nhật trạng thái, không phải sàn thiếu tiền.
        </p>
      )}

    </div>
  );
}
