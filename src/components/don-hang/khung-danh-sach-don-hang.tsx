"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { BangDonHang } from "@/components/don-hang/bang-don-hang";
import { HangChipDangApDonHang } from "@/components/don-hang/hang-chip-dang-ap-don-hang";
import { DOI_XOA_LOC, type DoiThamSoDonHang } from "@/components/don-hang/lua-chon-loc-don-hang";
import { PhanTrangDonHang } from "@/components/don-hang/phan-trang-don-hang";
import { TabTrangThaiDonHang } from "@/components/don-hang/tab-trang-thai-don-hang";
import { TheDonHangDienThoai } from "@/components/don-hang/the-don-hang-dien-thoai";
import { ThanhLocDonHang, type KenhLoc } from "@/components/don-hang/thanh-loc-don-hang";
import { hrefDonHang } from "@/lib/orders/doc-tham-so-don-hang";
import type { BoLocDonHang, KieuSapXepDonHang, TrangDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { cn } from "@/lib/utils";

/**
 * Thẻ trắng bọc tab trạng thái → thanh lọc → hàng chip đang áp → danh sách (bảng ≥ 1280px, thẻ dưới đó) →
 * phân trang, hoặc khung rỗng. Không giữ state lọc: mọi thay đổi ghi URL qua `hrefDonHang` rồi
 * `router.replace` trong `startTransition`, nên trang mờ + `aria-busy` đúng lúc server đang tải lại.
 * Dữ liệu đến hoàn toàn qua props (không tự gọi DB, không tính lại lãi/tổng).
 */
export function KhungDanhSachDonHang(props: {
  trang: TrangDonHang;
  boLoc: BoLocDonHang;
  sp: Record<string, string | undefined>;
  kenh: KenhLoc[];
  /** Có lọc ngoài kỳ (kênh/trạng thái/tìm/chip) — quyết định lời của khung rỗng. */
  coLoc: boolean;
  now: Date;
}) {
  const { trang, boLoc, sp, kenh, coLoc, now } = props;
  const router = useRouter();
  const [dangChuyen, batDauChuyen] = useTransition();

  /** Đổi tham số lọc/sắp xếp/trang (thay thế lịch sử, không cuộn lên đầu). */
  function dieuHuong(doi: DoiThamSoDonHang) {
    batDauChuyen(() => router.replace(hrefDonHang(sp, doi), { scroll: false }));
  }

  const hrefDon = (id: string) => hrefDonHang(sp, { don: id });
  const moDon = (id: string) => router.push(hrefDon(id), { scroll: false });
  const hrefTrang = (t: number) => hrefDonHang(sp, { trang: String(t) });

  const rong = trang.tong.soDon === 0;

  return (
    <section
      aria-label="Danh sách đơn"
      aria-busy={dangChuyen}
      data-testid="khung-danh-sach-don-hang"
      // Không `overflow-hidden`: nó làm tiêu đề bảng (`sticky`) mất khả năng dính khi cuộn trang.
      className="rounded-xl bg-tq-the shadow-tq-the"
    >
      <TabTrangThaiDonHang
        dem={trang.demTheoTrangThai}
        dangLoc={boLoc.statuses}
        onChon={(slug) => dieuHuong({ trang_thai: slug })}
      />
      <ThanhLocDonHang boLoc={boLoc} kenh={kenh} coQuyenGiaVon={trang.coQuyenGiaVon} dieuHuong={dieuHuong} />
      <HangChipDangApDonHang boLoc={boLoc} kenh={kenh} dieuHuong={dieuHuong} />

      <div className={cn("transition-opacity", dangChuyen && "opacity-60")}>
        {rong ? (
          <div data-testid="don-hang-rong" className="px-4 py-12 text-center text-tq-chu-phu">
            <b className="mb-1 block text-sm font-semibold text-tq-chu-dam">
              {coLoc ? "Không có đơn nào khớp bộ lọc" : "Chưa có đơn nào trong kỳ này"}
            </b>
            {coLoc ? (
              <>
                Thử bỏ bớt điều kiện, hoặc xóa lọc để xem lại toàn bộ đơn của kỳ.
                <br />
                <button
                  type="button"
                  onClick={() => dieuHuong(DOI_XOA_LOC)}
                  className="mt-3.5 inline-flex min-h-11 items-center rounded-lg border border-[#d4d4d4] bg-white px-3 text-[13px] font-medium text-tq-chu-dam hover:bg-[#f7f7f7] md:min-h-9"
                >
                  Xóa lọc
                </button>
              </>
            ) : boLoc.ky.loai === "khoang" ? (
              <Link
                href={hrefDonHang(sp, { ky: "tat_ca" })}
                scroll={false}
                className="mt-1 inline-block text-[13px] text-[#1d4f91] underline underline-offset-2"
              >
                Xem tất cả thời gian
              </Link>
            ) : null}
          </div>
        ) : (
          <>
            <div className="hidden min-[1280px]:block">
              <BangDonHang
                trang={trang}
                boLoc={boLoc}
                now={now}
                hrefDon={hrefDon}
                onMoDon={moDon}
                onSapXep={(sx: KieuSapXepDonHang) => dieuHuong({ sx })}
              />
            </div>
            <div className="min-[1280px]:hidden">
              <TheDonHangDienThoai trang={trang} donDangMo={boLoc.don} now={now} hrefDon={hrefDon} />
            </div>
            <PhanTrangDonHang trang={boLoc.trang} tongDon={trang.tong.soDon} hrefTrang={hrefTrang} />
          </>
        )}
      </div>
    </section>
  );
}
