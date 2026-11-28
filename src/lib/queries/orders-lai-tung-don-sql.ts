import { Prisma } from "@/generated/prisma/client";

import { KENH_BAN_TRUC_TIEP } from "@/lib/channels/kenh-ban-truc-tiep";
import { REAL_FEE_CHANNELS } from "@/lib/channels/real-fee-channels";
import { mauTimKiemIlike } from "@/lib/escape-ilike";
import {
  CHIP_CAN_GIA_VON,
  SAP_XEP_CAN_GIA_VON,
  type BoLocDonHang,
  type KieuSapXepDonHang,
} from "@/lib/orders/don-hang-kieu-du-lieu";
import { PROVISIONAL_SETTLEMENT_WINDOW_DAYS } from "@/lib/orders/provisional-fee";

import type { QuyenGiaVon } from "./che-gia-von-types";

/**
 * Bộ dựng SQL DÙNG CHUNG cho trang Đơn hàng: danh sách, thẻ tổng, đếm tab, đơn kề bên và Excel đều đi
 * qua CTE `don` ở đây ⇒ một đơn chỉ có MỘT con số lãi ở mọi nơi.
 *
 * Lãi từng đơn = ĐÚNG `calcOrderProfit` + `calcOrderCogs` (`src/lib/orders/order-profit.ts`), cùng luật
 * cấp đơn với `pnl.ts`:
 *  - đơn hợp lệ: `itemsTotal − discount − platformFeeEst − Σ(quantity × Variant.costPrice)`; dòng không
 *    khớp biến thể (NULL sau LEFT JOIN) hay `costPrice = 0` góp 0 và làm đơn "thiếu giá vốn";
 *  - đơn hoàn/hủy: `−returnedFee` (không bao giờ thiếu giá vốn, không bao giờ "lỗ");
 *  - đơn không dòng hàng: không có nhóm dòng hàng ⇒ giá vốn 0, KHÔNG thiếu.
 * Mọi phép nhân/cộng tiền chạy ở `bigint` (SL × giá vốn vượt int4 là chuyện thật với lô lớn) rồi đổi về
 * `number` qua `soNguyenAnToan` (`orders-lai-tung-don-doi-dong.ts`) — ngoài miền số nguyên an toàn thì NÉM.
 *
 * Che giá vốn: nhánh thiếu quyền KHÔNG join `Variant`, không có cột `cogs`/`lai_don`/
 * `thieu_gia_von` — chip/sắp xếp cần lãi lọt vào nhánh này là lỗi lập trình ⇒ ném (gọi `kepBoLocTheoQuyen`
 * ở đầu mỗi hàm public để kẹp trước).
 *
 * An toàn SQL: chỉ `Prisma.sql` có tham số; tên cột/chiều sắp lấy từ bảng trắng, không từ chuỗi người dùng.
 */

const NGAY_MS = 86_400_000;

/** Lớp 2 của che giá vốn: bỏ chip/sắp xếp cần lãi khi thiếu quyền — KHÔNG tin bộ đọc URL đã kẹp. */
export function kepBoLocTheoQuyen(boLoc: BoLocDonHang, quyen: QuyenGiaVon): BoLocDonHang {
  if (quyen.coQuyenGiaVon) return boLoc;
  return {
    ...boLoc,
    loc: boLoc.loc.filter((c) => !CHIP_CAN_GIA_VON.includes(c)),
    sx: SAP_XEP_CAN_GIA_VON.includes(boLoc.sx) ? "moi" : boLoc.sx,
  };
}

/**
 * Mốc thời gian vào cột `timestamp` không múi giờ (Prisma lưu giờ UTC): gửi chuỗi ISO rồi
 * `::timestamptz AT TIME ZONE 'UTC'` ⇒ đúng giờ UTC bất kể `TimeZone` của phiên DB (cùng cách
 * `ensure-recurring-expenses.ts`).
 */
function thoiDiemUtc(d: Date): Prisma.Sql {
  return Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

const HOP_LE = Prisma.sql`o.status NOT IN ('RETURNED', 'CANCELLED')`;

/** Phạm vi lọc trên bảng gốc (dùng được index `orderedAt`): kỳ, kênh, tìm kiếm. */
export type PhamViDon = Pick<BoLocDonHang, "ky" | "channels" | "q">;

/** `WHERE …` trên bảng `"Order" o` theo phạm vi; rỗng khi không lọc gì (tất cả thời gian, mọi kênh). */
function dieuKienPhamVi(pv: PhamViDon): Prisma.Sql | null {
  const dk: Prisma.Sql[] = [];
  if (pv.ky.loai === "khoang") {
    dk.push(Prisma.sql`o."orderedAt" >= ${thoiDiemUtc(pv.ky.from)} AND o."orderedAt" <= ${thoiDiemUtc(pv.ky.to)}`);
  }
  if (pv.channels.length > 0) dk.push(Prisma.sql`o."channelId" IN (${Prisma.join(pv.channels)})`);
  const q = pv.q.trim();
  if (q !== "") {
    const mau = mauTimKiemIlike(q);
    // Tên khách chỉ so với đơn bán tại shop — cùng phạm vi với chỗ hiển thị tên khách (cột `ten_khach`).
    // Kênh sàn mà vẫn khớp theo tên thì gõ một cái tên là lọc ra được đơn sàn của người đó dù màn đã ẩn tên.
    dk.push(Prisma.sql`(
      o.code ILIKE ${mau} OR o."pancakeId" ILIKE ${mau}
      OR (o."channelId" = ${KENH_BAN_TRUC_TIEP} AND o."customerName" ILIKE ${mau})
      OR EXISTS (
        SELECT 1 FROM "OrderItem" oi
        WHERE oi."orderId" = o.id AND (oi.sku ILIKE ${mau} OR oi."productName" ILIKE ${mau})
      )
    )`);
  }
  return dk.length > 0 ? Prisma.sql`WHERE ${Prisma.join(dk, " AND ")}` : null;
}

/**
 * Gộp dòng hàng theo đơn bằng MỘT lượt GROUP BY (hash) — không LATERAL từng đơn: đo trên 20k đơn, LATERAL
 * join `Variant` cho planner chọn quét cả bảng `Variant` MỖI đơn (~1s), GROUP BY ~25ms. Có điều kiện phạm
 * vi thì chỉ gộp dòng của đơn trong phạm vi (semi-join cùng điều kiện) ⇒ kỳ một tháng không quét mọi dòng.
 * Nhánh thiếu quyền KHÔNG join `Variant`, không có cột giá vốn.
 */
function gopDongHang(pv: PhamViDon, quyen: QuyenGiaVon): Prisma.Sql {
  const dieuKien = dieuKienPhamVi(pv);
  const hanChe = dieuKien ? Prisma.sql`WHERE oi."orderId" IN (SELECT o.id FROM "Order" o ${dieuKien})` : Prisma.empty;
  return quyen.coQuyenGiaVon
    ? Prisma.sql`(
      SELECT
        oi."orderId" AS order_id,
        COUNT(*)::bigint AS so_dong,
        SUM(oi.quantity)::bigint AS tong_sl,
        SUM(oi.quantity::bigint * v."costPrice")::bigint AS cogs,
        BOOL_OR(v."costPrice" IS NULL OR v."costPrice" = 0) AS thieu_dong
      FROM "OrderItem" oi
      LEFT JOIN "Variant" v ON v.id = oi."variantId"
      ${hanChe}
      GROUP BY oi."orderId"
    )`
    : Prisma.sql`(
      SELECT oi."orderId" AS order_id, COUNT(*)::bigint AS so_dong, SUM(oi.quantity)::bigint AS tong_sl
      FROM "OrderItem" oi
      ${hanChe}
      GROUP BY oi."orderId"
    )`;
}

/**
 * `WITH don AS (…)` — mỗi dòng một đơn trong phạm vi, kèm cột suy ra. `demDongHang` thêm cột đếm dòng/tổng
 * SL (chỉ danh sách/Excel cần) — nhánh thiếu quyền mà không cần đếm thì không chạm `OrderItem` chút nào.
 * Đơn không dòng hàng: LEFT JOIN rỗng ⇒ giá vốn 0, đếm 0, KHÔNG thiếu giá vốn.
 */
export function cteDon(pv: PhamViDon, quyen: QuyenGiaVon, now: Date, demDongHang: boolean): Prisma.Sql {
  // Phí tạm tính — ĐÚNG huy hiệu bảng đơn: `isProvisionalPlatformFee` (đơn hợp lệ) hoặc
  // `returnedOrderFeeDisplay(...).provisional` (đơn hoàn/hủy, tuổi ≤ cửa sổ ⇔ orderedAt ≥ now − cửa sổ).
  // `10 × phí < tiền hàng` ở bigint ⇔ `phí / tiền hàng < 10%` khi tiền hàng > 0.
  const mocTuoi = new Date(now.getTime() - PROVISIONAL_SETTLEMENT_WINDOW_DAYS * NGAY_MS);
  const phiTam = Prisma.sql`(
    o."channelId" IN (${Prisma.join([...REAL_FEE_CHANNELS])}) AND (
      (${HOP_LE} AND o."itemsTotal" > 0 AND 10::bigint * o."platformFeeEst" < o."itemsTotal")
      OR (NOT (${HOP_LE}) AND o."returnedFee" <= 0 AND o."platformFeeEst" > 0 AND o."orderedAt" >= ${thoiDiemUtc(mocTuoi)})
    )
  )`;

  const canGop = quyen.coQuyenGiaVon || demDongHang;
  const cotDem = demDongHang
    ? Prisma.sql`,
      COALESCE(gi.so_dong, 0) AS so_dong,
      COALESCE(gi.tong_sl, 0) AS tong_sl`
    : Prisma.empty;
  const cotGiaVon = quyen.coQuyenGiaVon
    ? Prisma.sql`,
      COALESCE(gi.cogs, 0) AS cogs,
      CASE WHEN ${HOP_LE}
        THEN o."itemsTotal"::bigint - o.discount - o."platformFeeEst" - COALESCE(gi.cogs, 0)
        ELSE -(o."returnedFee"::bigint)
      END AS lai_don,
      (${HOP_LE} AND COALESCE(gi.thieu_dong, false)) AS thieu_gia_von`
    : Prisma.empty;

  return Prisma.sql`WITH don AS (
    SELECT
      o.id,
      o.code,
      o."pancakeId" AS pancake_id,
      o."backfilledFromMirror" AS backfilled_from_mirror,
      o."orderedAt" AS ordered_at,
      o."statusChangedAt" AS status_changed_at,
      o."channelId" AS channel_id,
      c.name AS channel_name,
      c.color AS channel_color,
      -- Tên khách CHỈ cho đơn bán tại shop; kênh sàn là PII không cần cho màn này.
      CASE WHEN o."channelId" = ${KENH_BAN_TRUC_TIEP} THEN o."customerName" END AS ten_khach,
      o."itemsTotal" AS items_total,
      o.discount AS discount,
      o."platformFeeEst" AS platform_fee_est,
      o."returnedFee" AS returned_fee,
      o.status::text AS status,
      (${HOP_LE}) AS hop_le,
      ${phiTam} AS phi_tam
      ${cotDem}
      ${cotGiaVon}
    FROM "Order" o
    JOIN "Channel" c ON c.id = o."channelId"
    ${canGop ? Prisma.sql`LEFT JOIN ${gopDongHang(pv, quyen)} gi ON gi.order_id = o.id` : Prisma.empty}
    ${dieuKienPhamVi(pv) ?? Prisma.empty}
  )`;
}

/**
 * Dòng danh sách/Excel: lọc + sắp + cắt (`gioiHan` = LIMIT/OFFSET) TRÊN CTE trước, rồi mới tra sản phẩm
 * đầu (dòng `OrderItem.id` nhỏ nhất) cho đúng các dòng giữ lại — trang 20 dòng chỉ tra 20 lần dù tập lọc
 * vài chục nghìn đơn. Sắp lại ở vòng ngoài vì JOIN không bảo toàn thứ tự của truy vấn con.
 */
export function chonDongDon(boLoc: BoLocDonHang, quyen: QuyenGiaVon, now: Date, gioiHan: Prisma.Sql): Prisma.Sql {
  const thuTu = thuTuDon(boLoc.sx, quyen);
  return Prisma.sql`
    ${cteDon(boLoc, quyen, now, true)}
    SELECT p.*, dau.ten AS sp_dau_ten, dau.so_luong AS sp_dau_sl
    FROM (
      SELECT * FROM don
      ${whereDon(boLoc, quyen, true)}
      ORDER BY ${thuTu}
      ${gioiHan}
    ) p
    LEFT JOIN LATERAL (
      SELECT oi."productName" AS ten, oi.quantity AS so_luong
      FROM "OrderItem" oi WHERE oi."orderId" = p.id
      ORDER BY oi.id LIMIT 1
    ) dau ON TRUE
    ORDER BY ${thuTu}`;
}

/**
 * WHERE trên CTE `don`: chip (AND) + trạng thái khi `coTrangThai`. Đếm tab dùng `coTrangThai = false`
 * (mọi bộ lọc TRỪ chính trạng thái).
 */
export function whereDon(boLoc: BoLocDonHang, quyen: QuyenGiaVon, coTrangThai: boolean): Prisma.Sql {
  const dk: Prisma.Sql[] = [];
  for (const chip of boLoc.loc) {
    if (CHIP_CAN_GIA_VON.includes(chip) && !quyen.coQuyenGiaVon) {
      throw new Error(`Chip "${chip}" cần quyền giá vốn — bộ lọc chưa được kẹp theo quyền`);
    }
    if (chip === "lo") dk.push(Prisma.sql`(hop_le AND lai_don < 0)`);
    else if (chip === "thieu_gv") dk.push(Prisma.sql`thieu_gia_von`);
    else dk.push(Prisma.sql`phi_tam`);
  }
  if (coTrangThai && boLoc.statuses.length > 0) dk.push(Prisma.sql`status IN (${Prisma.join(boLoc.statuses)})`);
  return dk.length > 0 ? Prisma.sql`WHERE ${Prisma.join(dk, " AND ")}` : Prisma.empty;
}

/** Bảng trắng sắp xếp — `id` là khoá phân xử cuối để OFFSET và ROW_NUMBER ổn định. */
const THU_TU: Record<KieuSapXepDonHang, Prisma.Sql> = {
  moi: Prisma.sql`ordered_at DESC, id DESC`,
  cu: Prisma.sql`ordered_at ASC, id ASC`,
  tien_cao: Prisma.sql`items_total DESC, ordered_at DESC, id DESC`,
  tien_thap: Prisma.sql`items_total ASC, ordered_at DESC, id DESC`,
  lai_thap: Prisma.sql`lai_don ASC, ordered_at DESC, id DESC`,
  lai_cao: Prisma.sql`lai_don DESC, ordered_at DESC, id DESC`,
};

export function thuTuDon(sx: KieuSapXepDonHang, quyen: QuyenGiaVon): Prisma.Sql {
  if (SAP_XEP_CAN_GIA_VON.includes(sx) && !quyen.coQuyenGiaVon) {
    throw new Error(`Sắp xếp "${sx}" cần quyền giá vốn — bộ lọc chưa được kẹp theo quyền`);
  }
  return THU_TU[sx];
}

