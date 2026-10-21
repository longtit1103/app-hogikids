import Link from "next/link";

import { formatVnd } from "@/lib/format";
import type { TroiQuyHienThi } from "@/lib/no-phai-tra/doc-trang-no-phai-tra";

export type DongDieuChinhDaGhi = {
  id: string;
  vao: boolean;
  soTien: number;
  moTa: string;
  ngayNhan: string;
  /** Dòng của bước bật (`yeuCauId` ≠ null); false = dòng bù của lối "Sửa số tiền trước mốc". */
  cuaBuocBat: boolean;
};

const coDau = (n: number) => `${n >= 0 ? "+" : "−"}${formatVnd(Math.abs(n))}`;

/**
 * Trạng thái SAU khi bật: mốc, cảnh báo trôi quỹ trước ngày bật (nếu có), các dòng điều chỉnh quỹ của bước bật
 * (sửa số/mô tả ở Sổ quỹ — chỉ chủ shop), TÁCH RIÊNG các dòng bù do lối "Sửa số tiền trước mốc" ghi sau đó (để "N
 * dòng" và "tổng tác động" của bước bật đúng là của bước bật), và đường tới các khối nợ. Thuần hiển thị; ngày đã
 * format ở server.
 * `troi` null ⇒ không có chỉ báo (bật trước khi lưu vân tay quỹ) ⇒ ẩn khối.
 */
export function BatDaBatTomTat({
  nhanM,
  dieuChinh,
  troi = null,
}: {
  nhanM: string;
  dieuChinh: readonly DongDieuChinhDaGhi[];
  troi?: TroiQuyHienThi | null;
}) {
  const cuaBuocBat = dieuChinh.filter((d) => d.cuaBuocBat);
  const buSuaTien = dieuChinh.filter((d) => !d.cuaBuocBat);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-hairline p-4" data-testid="no-phai-tra-da-bat">
      <p className="text-sm text-ink">
        Đã bật theo dõi nợ phải trả từ <strong>{nhanM}</strong>. Từ ngày này quỹ chỉ giảm khi bạn thật trả thẻ, trả
        nhà cung cấp hoặc nạp ví quảng cáo; chi phí vẫn vào Lãi/Lỗ như cũ.
      </p>
      {troi !== null && troi.troi !== 0 && <CanhBaoTroiQuy nhanM={nhanM} troi={troi} />}
      <div>
        <p className="text-xs text-muted-foreground">Điều chỉnh quỹ ngày bật ({cuaBuocBat.length} dòng)</p>
        {cuaBuocBat.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Không có dòng điều chỉnh nào (chênh lệch bằng 0).</p>
        ) : (
          <DanhSachDieuChinh dong={cuaBuocBat} nhanTong="Tổng tác động lên quỹ" testId="no-phai-tra-lich-su-dieu-chinh" />
        )}
      </div>
      {buSuaTien.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground">
            Bù sửa số tiền trước ngày bật ({buSuaTien.length} dòng) — mỗi dòng bù đúng phần đổi số tiền một khoản chi
            trước {nhanM}, quỹ từ ngày bật không đổi.
          </p>
          <DanhSachDieuChinh dong={buSuaTien} nhanTong="Tổng bù" testId="no-phai-tra-bu-sua-tien" />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Thẻ, phiếu nợ và dòng điều chỉnh xem ở{" "}
        <Link href="/tai-chinh?tab=dong-tien" className="underline">
          Tài chính › Dòng tiền
        </Link>
        .
      </p>
    </div>
  );
}

function DanhSachDieuChinh({
  dong,
  nhanTong,
  testId,
}: {
  dong: readonly DongDieuChinhDaGhi[];
  nhanTong: string;
  testId: string;
}) {
  const tong = dong.reduce((s, d) => s + (d.vao ? d.soTien : -d.soTien), 0);
  return (
    <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid={testId}>
      {dong.map((d) => (
        <li key={d.id} className="flex justify-between gap-3">
          <span className="text-muted-foreground">
            {d.ngayNhan} · {d.moTa}
          </span>
          <span className={`tabular-nums ${d.vao ? "text-success" : "text-error"}`}>
            {d.vao ? "+" : "−"}
            {formatVnd(d.soTien)}
          </span>
        </li>
      ))}
      <li className="flex justify-between gap-3 border-t border-hairline pt-1 font-medium text-ink">
        <span>{nhanTong}</span>
        <span className="tabular-nums">{coDau(tong)}</span>
      </li>
    </ul>
  );
}

/**
 * Cảnh báo trôi quỹ trước ngày bật: nêu số chênh SO VỚI LÚC BẬT (KHÔNG khẳng định quỹ cao/thấp hơn tiền thật — chỉ
 * đúng vậy khi lúc bật đã chốt khớp toàn bộ; bật để lại phần chưa giải thích thì phần trôi có thể chính là phần
 * khớp lại), các dòng ngày trước M ghi vào app sau lúc bật (nếu dò được) và gợi ý đối chiếu — chủ shop kiểm rồi tự
 * sửa dòng điều chỉnh mở sổ nếu cần, app KHÔNG tự sửa.
 */
function CanhBaoTroiQuy({ nhanM, troi }: { nhanM: string; troi: TroiQuyHienThi }) {
  const cao = troi.troi > 0;
  const tien = formatVnd(Math.abs(troi.troi));
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-ink"
      role="status"
      data-testid="no-phai-tra-troi-quy"
    >
      <p className="font-medium">Quỹ trước ngày bật đã đổi {coDau(troi.troi)} so với lúc bật.</p>
      <p>
        Quỹ từ ngày {nhanM} đang <strong>chênh {coDau(troi.troi)}</strong> so với lúc bật. Thường do dữ liệu máy về
        muộn cho ngày trước {nhanM}: ví Shopee import thêm, TikTok, đơn bán tại quầy đổi trạng thái, ads tự động chốt
        lại. Đối chiếu Sổ quỹ với sao kê ngân hàng để biết phần chênh này làm quỹ lệch tiền thật hay chính là phần đã
        để lại chưa giải thích lúc bật.
      </p>
      <p className="text-xs text-muted-foreground">
        Quỹ app cuối ngày trước bật: {formatVnd(troi.quyLucBat)} lúc bật → {formatVnd(troi.quyHienTai)} bây giờ — số đổi ở
        trên đã tính cả phần dòng điều chỉnh mở sổ được sửa sau lúc bật.
      </p>
      {troi.soDongVeMuon > 0 ? (
        <div>
          <p className="text-xs text-muted-foreground">
            {troi.chamTran ? "Ít nhất " : ""}
            {troi.soDongVeMuon} dòng ngày trước {nhanM} được ghi vào app sau lúc bật, tổng tác động{" "}
            {coDau(troi.tacDongVeMuon)}. Lớn nhất:
          </p>
          <ul className="mt-1 flex flex-col gap-1" data-testid="no-phai-tra-troi-quy-dong">
            {troi.dongNoiBat.map((d, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="text-muted-foreground">
                  {d.ngayNhan} · {d.nhanNguon}
                  {d.moTa === "" ? "" : ` · ${d.moTa}`}
                </span>
                <span className={`tabular-nums ${d.tacDong > 0 ? "text-success" : "text-error"}`}>
                  {coDau(d.tacDong)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Không thấy dòng nào ngày trước {nhanM} được ghi vào app sau lúc bật — phần đổi có thể do đơn bán tại quầy
          đổi trạng thái, lệnh TikTok chuyển sang đã trả hay ads tự động ghi đè số ngày cũ. Đối chiếu Sổ quỹ các ngày
          trước {nhanM} với sao kê ngân hàng.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Đối chiếu xong, nếu quỹ từ ngày {nhanM} lệch tiền thật thì sửa dòng điều chỉnh ngày bật ở{" "}
        <Link href="/tai-chinh?tab=dong-tien" className="underline">
          Tài chính › Dòng tiền
        </Link>{" "}
        (chỉ chủ shop) — lệch đúng phần chênh này thì {cao ? "giảm" : "tăng"} tổng tác động {tien}.
      </p>
    </div>
  );
}
