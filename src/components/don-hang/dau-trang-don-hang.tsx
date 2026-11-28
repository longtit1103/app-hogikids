import Link from "next/link";
import { DownloadIcon } from "lucide-react";

import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";

/**
 * Đầu trang Đơn hàng: h1, dòng phụ (kỳ · giờ đồng bộ · so với), dải "chưa đồng bộ", nút Xuất Excel.
 * Các href do trang dựng sẵn (null = không hiện): hàm dựng URL nằm ở bộ đọc tham số, không ở đây.
 */
export function DauTrangDonHang(props: {
  nhanKy: string;
  nhanKySoSanh: string | null;
  lastSyncAt: Date | null;
  hrefXemTatCa: string | null;
  hrefVeThangNay: string | null;
  hrefXuatExcel: string | null;
}) {
  const { nhanKy, nhanKySoSanh, lastSyncAt, hrefXemTatCa, hrefVeThangNay, hrefXuatExcel } = props;

  const phan: string[] = [nhanKy];
  if (lastSyncAt) phan.push(`đồng bộ Pancake lúc ${formatNgayVn(lastSyncAt, "dd/MM HH:mm")}`);
  if (nhanKySoSanh) phan.push(`so với ${nhanKySoSanh}`);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {/*
            Tiêu đề tự dựng, KHÔNG dùng `PageTitle` của shell (nó cứng font serif, spec đòi chữ không chân).
            Giữ `data-slot="page-title"` + `hidden md:flex print:flex` như trang chủ: dưới md Topbar đã ghi
            "Đơn hàng"; dòng phụ nằm NGOÀI khối này nên vẫn hiện ở mọi khổ.
          */}
          <div data-slot="page-title" className="hidden flex-col md:flex print:flex">
            <h1 className="font-sans text-2xl font-semibold tracking-tight text-tq-chu-dam">Đơn hàng</h1>
          </div>
          <p data-testid="dong-phu-don-hang" className="text-[13px] text-tq-chu-phu md:text-sm">
            {phan.join(" · ")}
            {hrefXemTatCa ? (
              <>
                {" · "}
                <Link href={hrefXemTatCa} scroll={false} className="underline underline-offset-2 hover:text-tq-chu-dam">
                  Xem tất cả thời gian
                </Link>
              </>
            ) : null}
            {hrefVeThangNay ? (
              <>
                {" · "}
                <Link href={hrefVeThangNay} scroll={false} className="underline underline-offset-2 hover:text-tq-chu-dam">
                  Về tháng này
                </Link>
              </>
            ) : null}
          </p>
        </div>

        {hrefXuatExcel ? (
          // Link thường (không phải <Link>): đây là tải file từ route handler, không phải điều hướng trang.
          <a
            href={hrefXuatExcel}
            data-testid="xuat-excel"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-[#d4d4d4] bg-tq-the px-3 text-[13px] font-medium whitespace-nowrap text-tq-chu-dam hover:bg-[#f7f7f7] md:min-h-9"
          >
            <DownloadIcon className="size-4" aria-hidden="true" />
            Xuất Excel
          </a>
        ) : null}
      </div>

      {lastSyncAt === null ? (
        <p
          data-testid="chua-dong-bo"
          role="status"
          className="rounded-lg bg-warning/10 px-3 py-2 text-[13px] text-tq-chu-dam"
        >
          Chưa đồng bộ lần nào — bấm «Đồng bộ ngay» trên thanh công cụ.
        </p>
      ) : null}
    </div>
  );
}
