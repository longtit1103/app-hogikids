import { Prisma } from "@/generated/prisma/client";

import type {
  BoLocDonHang,
  DemTrangThaiDonHang,
  TongDonHang,
  TongDonHangChe,
  TrangDonHang,
} from "@/lib/orders/don-hang-kieu-du-lieu";
import { PAGE_SIZE } from "@/lib/page-size";
import { prisma } from "@/lib/prisma";
import { kySoSanh, nhanKySoSanh } from "@/lib/trang-chu/so-sanh-ky";

import type { QuyenGiaVon } from "./che-gia-von-types";
import { dongCheTuHang, dongDayTuHang, soNguyenAnToan, trangThaiDon, type HangDon } from "./orders-lai-tung-don-doi-dong";
import { chonDongDon, cteDon, kepBoLocTheoQuyen, whereDon, type PhamViDon } from "./orders-lai-tung-don-sql";

/**
 * Trang danh sách đơn: 20 dòng của trang + thẻ tổng + đếm tab + thẻ kỳ trước — bốn câu chạy song song,
 * tất cả trên CTE `don` dùng chung (không tải hết đơn về JS).
 *
 * Thẻ tổng (spec trang đơn hàng §4.2): mọi số tiền chỉ cộng đơn hợp lệ; phí sàn đơn hoàn/hủy KHÔNG lẫn
 * vào "phí sàn" mà đi riêng `phiSanGiuHoanHuy` (cả nhánh che — không phải giá vốn), rồi trừ ĐÚNG MỘT LẦN ở
 * `lai`. Đếm tab theo mọi bộ lọc TRỪ trạng thái. Kỳ trước dùng cùng bộ lọc (trạng thái, kênh, chip) trên kỳ
 * `kySoSanh`; không so khi xem tất cả thời gian, đang tìm (tập tìm kiếm của hai kỳ không cùng nghĩa) hoặc
 * đang bật chip "Phí tạm tính" (cờ tạm tính phụ thuộc thời điểm xem: đơn hoàn/hủy tính cửa sổ 30 ngày theo
 * `now`, kỳ trước gần như không còn đơn nào "tạm" ⇒ phép so không cùng nghĩa).
 */

type HangTong = {
  so_don: unknown;
  so_hop_le: unknown;
  so_hoan_huy: unknown;
  tien_hang: unknown;
  voucher: unknown;
  phi_san: unknown;
  phi_san_giu_hoan_huy: unknown;
  lai_hop_le?: unknown;
  so_thieu_gia_von?: unknown;
};

async function docTong(pv: PhamViDon, boLoc: BoLocDonHang, quyen: QuyenGiaVon, now: Date): Promise<HangTong> {
  const cotLai = quyen.coQuyenGiaVon
    ? Prisma.sql`,
      COALESCE(SUM(lai_don) FILTER (WHERE hop_le), 0)::bigint AS lai_hop_le,
      COUNT(*) FILTER (WHERE thieu_gia_von)::bigint AS so_thieu_gia_von`
    : Prisma.empty;
  const hang = await prisma.$queryRaw<HangTong[]>(Prisma.sql`
    ${cteDon(pv, quyen, now, false)}
    SELECT
      COUNT(*)::bigint AS so_don,
      COUNT(*) FILTER (WHERE hop_le)::bigint AS so_hop_le,
      COUNT(*) FILTER (WHERE NOT hop_le)::bigint AS so_hoan_huy,
      COALESCE(SUM(items_total) FILTER (WHERE hop_le), 0)::bigint AS tien_hang,
      COALESCE(SUM(discount) FILTER (WHERE hop_le), 0)::bigint AS voucher,
      COALESCE(SUM(platform_fee_est) FILTER (WHERE hop_le), 0)::bigint AS phi_san,
      COALESCE(SUM(returned_fee) FILTER (WHERE NOT hop_le), 0)::bigint AS phi_san_giu_hoan_huy
      ${cotLai}
    FROM don
    ${whereDon(boLoc, quyen, true)}
  `);
  if (hang.length !== 1) throw new Error(`Câu tổng đơn hàng trả ${hang.length} dòng, mong 1`);
  return hang[0];
}

function tongChe(h: HangTong): TongDonHangChe {
  const tienHang = soNguyenAnToan(h.tien_hang, "tien_hang");
  const voucher = soNguyenAnToan(h.voucher, "voucher");
  const phiSan = soNguyenAnToan(h.phi_san, "phi_san");
  return {
    soDon: soNguyenAnToan(h.so_don, "so_don"),
    soHopLe: soNguyenAnToan(h.so_hop_le, "so_hop_le"),
    soHoanHuy: soNguyenAnToan(h.so_hoan_huy, "so_hoan_huy"),
    tienHang,
    voucher,
    phiSan,
    thucNhan: tienHang - voucher - phiSan,
    phiSanGiuHoanHuy: soNguyenAnToan(h.phi_san_giu_hoan_huy, "phi_san_giu_hoan_huy"),
  };
}

function tongDay(h: HangTong): TongDonHang {
  const che = tongChe(h);
  const laiHopLe = soNguyenAnToan(h.lai_hop_le, "lai_hop_le");
  return {
    ...che,
    laiHopLe,
    lai: laiHopLe - che.phiSanGiuHoanHuy,
    soDonThieuGiaVon: soNguyenAnToan(h.so_thieu_gia_von, "so_thieu_gia_von"),
  };
}

async function demTheoTrangThai(boLoc: BoLocDonHang, quyen: QuyenGiaVon, now: Date): Promise<DemTrangThaiDonHang> {
  const hang = await prisma.$queryRaw<{ status: string; so: unknown }[]>(Prisma.sql`
    ${cteDon(boLoc, quyen, now, false)}
    SELECT status, COUNT(*)::bigint AS so
    FROM don
    ${whereDon(boLoc, quyen, false)}
    GROUP BY status
  `);
  // Đủ 5 khoá, trạng thái không có đơn = 0.
  const dem: DemTrangThaiDonHang = { PENDING: 0, SHIPPING: 0, COMPLETED: 0, RETURNED: 0, CANCELLED: 0 };
  for (const h of hang) dem[trangThaiDon(h.status)] = soNguyenAnToan(h.so, "dem_trang_thai");
  return dem;
}

async function docTrang(boLoc: BoLocDonHang, quyen: QuyenGiaVon, now: Date): Promise<HangDon[]> {
  return prisma.$queryRaw<HangDon[]>(
    chonDongDon(boLoc, quyen, now, Prisma.sql`LIMIT ${PAGE_SIZE} OFFSET ${(boLoc.trang - 1) * PAGE_SIZE}`),
  );
}

export async function getTrangDonHang(boLocVao: BoLocDonHang, quyen: QuyenGiaVon, now: Date): Promise<TrangDonHang> {
  const boLoc = kepBoLocTheoQuyen(boLocVao, quyen);
  if (!Number.isSafeInteger(boLoc.trang) || boLoc.trang < 1) throw new Error(`Số trang không hợp lệ: ${boLoc.trang}`);

  const kyTruoc =
    boLoc.ky.loai === "khoang" && boLoc.q === "" && !boLoc.loc.includes("phi_tam")
      ? { range: kySoSanh({ from: boLoc.ky.from, to: boLoc.ky.to }, now), nhan: nhanKySoSanh({ from: boLoc.ky.from, to: boLoc.ky.to }, now) }
      : null;

  // Bốn câu song song trên các kết nối riêng, KHÔNG cùng một snapshot: ingest ghi xen giữa thì số đơn, đếm tab
  // và dòng có thể lệch nhau một nhịp. Chấp nhận vì màn chỉ đọc, tải lại là khớp; gom vào một transaction
  // RepeatableRead sẽ tuần tự hoá bốn câu (chậm hơn) chỉ để chống một lệch thoáng qua.
  const [hangs, tong, dem, tongTruoc] = await Promise.all([
    docTrang(boLoc, quyen, now),
    docTong(boLoc, boLoc, quyen, now),
    demTheoTrangThai(boLoc, quyen, now),
    kyTruoc
      ? docTong({ ky: { loai: "khoang", ...kyTruoc.range, nguon: "url" }, channels: boLoc.channels, q: "" }, boLoc, quyen, now)
      : null,
  ]);

  if (quyen.coQuyenGiaVon) {
    return {
      coQuyenGiaVon: true,
      rows: hangs.map(dongDayTuHang),
      tong: tongDay(tong),
      demTheoTrangThai: dem,
      kyTruoc: kyTruoc && tongTruoc ? { nhan: kyTruoc.nhan, tong: tongDay(tongTruoc) } : null,
    };
  }
  return {
    coQuyenGiaVon: false,
    rows: hangs.map(dongCheTuHang),
    tong: tongChe(tong),
    demTheoTrangThai: dem,
    kyTruoc: kyTruoc && tongTruoc ? { nhan: kyTruoc.nhan, tong: tongChe(tongTruoc) } : null,
  };
}
