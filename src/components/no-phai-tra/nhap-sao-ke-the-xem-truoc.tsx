import type { XemTruocSaoKe } from "@/lib/actions/sao-ke-the";
import { formatVnd } from "@/lib/format";

/** `yyyy-MM-dd` ⇒ `dd/MM` (không qua `Date` — khỏi lệch múi giờ trình duyệt). */
export function nhanNgaySaoKe(khoa: string): string {
  const [, thang, ngay] = khoa.split("-");
  return `${ngay}/${thang}`;
}

/** `yyyy-MM-dd` ⇒ `dd/MM/yyyy`. */
function nhanNgayDu(khoa: string): string {
  const [nam, thang, ngay] = khoa.split("-");
  return `${ngay}/${thang}/${nam}`;
}

function O({ nhan, so, dam = false }: { nhan: string; so: string; dam?: boolean }) {
  return (
    <div className="rounded-lg border border-hairline p-2.5">
      <p className="text-xs text-muted-foreground">{nhan}</p>
      <p className={dam ? "mt-0.5 font-serif text-lg text-ink tabular-nums" : "mt-0.5 text-sm text-ink tabular-nums"}>{so}</p>
    </div>
  );
}

function Nhom({ tieuDe, children, testId }: { tieuDe: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <p className="text-xs font-medium text-ink">{tieuDe}</p>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">{children}</ul>
    </div>
  );
}

/**
 * Phần xem trước của modal "Nhập sao kê PDF" — thuần hiển thị (server đã tính hết): tóm tắt, số đề xuất + giải thích,
 * số ngân hàng còn đòi kỳ này (sao kê − trả chưa lên sao kê), bill ghi sổ trễ, chi thẻ / trả thẻ / hoàn TikTok chưa lên
 * sao kê, giao dịch ghi sai ngày, dòng khác, thanh toán, cảnh báo. Không có nút — form chốt nằm ở modal.
 */
export function NhapSaoKeTheXemTruoc({ x }: { x: XemTruocSaoKe }) {
  const { saoKe, ketQua: k } = x;
  const chenh = x.uocTinhApp === null ? null : k.soDeXuat - x.uocTinhApp;
  // Lần trả ngày ≤ ngày sao kê mà ngân hàng chưa ghi sổ: neo đã trừ, nhưng số sao kê vẫn gồm ⇒ ngân hàng chỉ còn đòi
  // phần còn lại (đúng số app lưu làm nghĩa vụ kỳ sau khi chốt).
  const conDoi = Math.max(0, saoKe.duNoCuoiKy - k.tongTraChuaLenSaoKe);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <O nhan={`Sao kê ngày ${nhanNgayDu(saoKe.ngaySaoKe)}`} so={formatVnd(saoKe.duNoCuoiKy)} />
        <O nhan="App ước tính cùng ngày" so={x.uocTinhApp === null ? "chưa có neo" : formatVnd(x.uocTinhApp)} />
      </div>
      <div className="rounded-lg bg-surface-soft p-3" data-testid="sao-ke-pdf-so-de-xuat">
        <p className="text-xs text-muted-foreground">Số đề xuất chốt</p>
        <p className="font-serif text-xl text-ink tabular-nums">{formatVnd(k.soDeXuat)}</p>
        {k.giaiThich.map((g, i) => (
          <p key={i} className="mt-1 text-xs text-muted-foreground">
            {g}
          </p>
        ))}
        {chenh !== null && chenh !== 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            Chênh app {chenh > 0 ? "+" : "−"}
            {formatVnd(Math.abs(chenh))} — thường do dòng khác bên dưới.
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {saoKe.soDong} dòng · khớp {k.soKhop} bill TikTok
          {k.soKhopHoan > 0 ? ` · ${k.soKhopHoan} lần TikTok hoàn` : ""}
        </p>
        {k.tongTraChuaLenSaoKe > 0 && (
          <p className="mt-1 text-xs text-ink" data-testid="sao-ke-pdf-phai-tra-ky">
            Trả chưa lên sao kê: {formatVnd(k.tongTraChuaLenSaoKe)} — kỳ này ngân hàng còn đòi {formatVnd(conDoi)} (sao kê{" "}
            {formatVnd(saoKe.duNoCuoiKy)} − {formatVnd(k.tongTraChuaLenSaoKe)} đã trả).
          </p>
        )}
      </div>

      {k.billGhiSoTre.length > 0 && (
        <Nhom tieuDe={`Bill ghi sổ trễ: ${k.billGhiSoTre.length} · ${formatVnd(k.tongBillGhiSoTre)} (đã cộng)`} testId="sao-ke-pdf-ghi-so-tre">
          {k.billGhiSoTre.map((b) => (
            <li key={b.id} className="tabular-nums">
              {nhanNgaySaoKe(b.ngay)} · {formatVnd(b.soTien)}
            </li>
          ))}
        </Nhom>
      )}

      {k.chiTayChuaLenSaoKe.length > 0 && (
        <Nhom
          tieuDe={`Chi trừ vào thẻ chưa lên sao kê: ${k.chiTayChuaLenSaoKe.length} · ${formatVnd(k.tongChiTayChuaLenSaoKe)} (đã cộng)`}
          testId="sao-ke-pdf-chi-tay-tre"
        >
          {k.chiTayChuaLenSaoKe.map((g) => (
            <li key={g.id} className="tabular-nums">
              {nhanNgaySaoKe(g.ngay)} · {formatVnd(g.soTien)} · {g.loai === "NAP_VI" ? "nạp ví ads" : "Sổ chi phí"}
            </li>
          ))}
        </Nhom>
      )}

      {k.traChuaLenSaoKe.length > 0 && (
        <Nhom
          tieuDe={`Trả thẻ chưa lên sao kê: ${k.traChuaLenSaoKe.length} · ${formatVnd(k.tongTraChuaLenSaoKe)} (đã trừ)`}
          testId="sao-ke-pdf-tra-chua-len"
        >
          {k.traChuaLenSaoKe.map((g) => (
            <li key={g.id} className="tabular-nums">
              {nhanNgaySaoKe(g.ngay)} · {formatVnd(g.soTien)}
            </li>
          ))}
        </Nhom>
      )}

      {k.hoanGhiSoTre.length > 0 && (
        <Nhom
          tieuDe={`Hoàn TikTok chưa lên sao kê: ${k.hoanGhiSoTre.length} · ${formatVnd(k.tongHoanGhiSoTre)} (đã trừ)`}
          testId="sao-ke-pdf-hoan-chua-len"
        >
          {k.hoanGhiSoTre.map((h) => (
            <li key={h.id} className="tabular-nums">
              {nhanNgaySaoKe(h.ngay)} · {formatVnd(h.soTien)}
            </li>
          ))}
        </Nhom>
      )}

      {(k.traSaiNgay.length > 0 || k.chiSaiNgay.length > 0) && (
        <Nhom tieuDe="Ghi sai ngày — sửa về đúng ngày ngân hàng rồi nhập lại" testId="sao-ke-pdf-sai-ngay">
          {k.traSaiNgay.map((c) => (
            <li key={c.giaoDich.id} className="tabular-nums text-error">
              Trả thẻ {formatVnd(c.giaoDich.soTien)}: app ghi {nhanNgaySaoKe(c.giaoDich.ngay)}, ngân hàng {nhanNgaySaoKe(c.dong.ngayGiaoDich)}
            </li>
          ))}
          {k.chiSaiNgay.map((c) => (
            <li key={c.giaoDich.id} className="tabular-nums text-error">
              Khoản chi thẻ {formatVnd(c.giaoDich.soTien)}: app ghi {nhanNgaySaoKe(c.giaoDich.ngay)}, ngân hàng{" "}
              {nhanNgaySaoKe(c.dong.ngayGiaoDich)}
            </li>
          ))}
        </Nhom>
      )}

      {(k.dongKhac.ghiNo.length > 0 || k.dongKhac.ghiCo.length > 0) && (
        <Nhom tieuDe="Dòng khác (không phải TikTok)" testId="sao-ke-pdf-dong-khac">
          {k.dongKhac.ghiNo.map((d, i) => (
            <li key={`no-${i}`}>
              {nhanNgaySaoKe(d.ngayGiaoDich)} · <span className="tabular-nums">{formatVnd(d.ghiNo)}</span> · {d.dienGiai}
            </li>
          ))}
          {k.dongKhac.ghiCo.map((d, i) => (
            <li key={`co-${i}`}>
              {nhanNgaySaoKe(d.ngayGiaoDich)} · <span className="tabular-nums">+{formatVnd(d.ghiCo)}</span> · {d.dienGiai}
            </li>
          ))}
          <li>
            Là chi phí shop mà chưa ghi ⇒ ghi Sổ chi phí &quot;trừ vào thẻ&quot; ĐÚNG ngày giao dịch trên sao kê (≤ ngày sao kê);
            ghi ngày sau ngày sao kê sẽ đếm hai lần. App không tự ghi.
          </li>
        </Nhom>
      )}

      {k.thanhToan.length > 0 && (
        <Nhom tieuDe="Thanh toán thẻ trên sao kê" testId="sao-ke-pdf-thanh-toan">
          {k.thanhToan.map((d, i) => (
            <li key={i} className="tabular-nums">
              {nhanNgaySaoKe(d.ngayGiaoDich)} · {formatVnd(d.ghiCo)}
            </li>
          ))}
        </Nhom>
      )}

      {k.billKhongThayTrenSaoKe.length > 0 && (
        <Nhom tieuDe={`Bill app không thấy trên sao kê: ${k.billKhongThayTrenSaoKe.length}`} testId="sao-ke-pdf-bill-khong-thay">
          {k.billKhongThayTrenSaoKe.map((b) => (
            <li key={b.id} className="tabular-nums">
              {nhanNgaySaoKe(b.ngay)} · {formatVnd(b.soTien)}
            </li>
          ))}
        </Nhom>
      )}

      {k.saoKeKhongCoTrongApp.length > 0 && (
        <Nhom tieuDe={`TikTok trên sao kê chưa có trong app: ${k.saoKeKhongCoTrongApp.length}`} testId="sao-ke-pdf-thieu-trong-app">
          {k.saoKeKhongCoTrongApp.map((d, i) => (
            <li key={i} className="tabular-nums">
              {nhanNgaySaoKe(d.ngayGiaoDich)} · {formatVnd(d.ghiNo)}
            </li>
          ))}
        </Nhom>
      )}

      {x.canhBao.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-2.5 text-xs text-ink" data-testid="sao-ke-pdf-canh-bao">
          {x.canhBao.map((c, i) => (
            <p key={i}>{c}</p>
          ))}
        </div>
      )}
    </div>
  );
}
