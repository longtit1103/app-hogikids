import Link from "next/link";

import { formatVnd } from "@/lib/format";
import type { LoiDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";
import { huongDanNhapHangSauM, hrefSoChiPhiTheoNgay } from "@/lib/no-phai-tra/huong-dan-nhap-hang-sau-m";

/** Dữ liệu có cấu trúc của điều kiện `CON_NHAP_HANG_SAU_M` (server đọc trong `kiemDieuKienBat`). */
export type NhapHangSauMChoManHinh = NonNullable<LoiDieuKienBat["nhapHangSauM"]>;

const nhan = (khoa: string) => khoa.split("-").reverse().join("/");

/**
 * Khối hướng dẫn khi còn chi phí Nhập hàng ghi từ ngày bật trở đi: từng dòng (ngày · số tiền · mô tả) mở Sổ
 * chi phí ĐÚNG ngày của dòng (Sổ chi phí chưa có neo theo id ⇒ lọc `?tu=&den=` một ngày), rồi ba trường hợp
 * xử lý theo thực tế. Dùng ở tab Chuẩn bị (checklist) và tab Xác nhận (wizard) — không hook, chạy được cả
 * server lẫn client component.
 */
export function NhapHangSauMHuongDan({ duLieu }: { duLieu: NhapHangSauMChoManHinh }) {
  const nhanM = nhan(duLieu.khoaM);
  const hd = huongDanNhapHangSauM(nhanM);
  return (
    <div className="flex flex-col gap-1.5 text-sm text-ink" data-testid="nhap-hang-sau-m-huong-dan">
      <p>Còn chi phí Nhập hàng ghi từ ngày bật {nhanM} trở đi — xử lý từng dòng ở Sổ chi phí:</p>
      <ul className="list-disc pl-5">
        {duLieu.dong.map((d) => (
          <li key={d.id}>
            <Link href={hrefSoChiPhiTheoNgay(d.khoaNgay)} className="underline">
              {nhan(d.khoaNgay)} · {formatVnd(d.amount)} · {d.description || "(không mô tả)"}
            </Link>
          </li>
        ))}
        {duLieu.soDongKhac > 0 && (
          <li>
            <Link href={hrefSoChiPhiTheoNgay(duLieu.khoaM, duLieu.khoaHomNay)} className="underline">
              và {duLieu.soDongKhac} dòng khác
            </Link>
          </li>
        )}
      </ul>
      <ol className="list-decimal pl-5">
        {hd.truongHop.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
      <p className="text-xs text-warning">{hd.canhBao}.</p>
    </div>
  );
}
