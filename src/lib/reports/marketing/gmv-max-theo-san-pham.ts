import { endOfDay, format } from "date-fns";

import { latestPayloads } from "@/lib/bronze/transform-raw-helpers";
import type { DateRange } from "@/lib/date-range";
import { buildVatByMonth } from "@/lib/ingest/ads-report-mapping";
import { docDemSan, docTienChuoiSan } from "@/lib/marketing/doc-so-san";
import { prisma } from "@/lib/prisma";

import { cong, khoi } from "./cong-so-san";

/**
 * GMV MAX THEO SẢN PHẨM — bảng con bung ra từ một dòng chiến dịch (`RawTiktokBusinessGmvMaxItem`,
 * khoá `<campaign>:<item_group>:<ngày>`; `item_group_id` = `Product.code`, đo 50/50 khớp ở P0).
 *
 * Hai chỗ tiền phải cẩn thận:
 *  1. `cost` cấp item là số CHƯA VAT (giống cấp campaign). Quy về GỒM VAT bằng CÙNG hàm
 *     `buildVatByMonth` mà đường dựng lại `Expense` dùng, và nhân + LÀM TRÒN THEO TỪNG NGÀY rồi
 *     mới cộng — đúng khuôn `prepareAdsExpenseRow`. Nhân vào tổng là ra một con số khác vài đồng
 *     so với sổ, và "vài đồng" là thứ không ai truy được về sau.
 *  2. Tháng đo được VAT vô lý ⇒ `rateForDate` trả null ⇒ BỎ ngày đó khỏi `chiGomVat` (phần đó rơi
 *     vào dòng "Chưa phân bổ"), KHÔNG rơi về 0,1: dựng một tỉ lệ mặc định ở đây là để bảng con nói
 *     một con số mà sổ chi phí đã từ chối ghi.
 *
 * BẤT BIẾN #2: `gmvSan`/`donSan` là số sàn TỰ NHẬN CÔNG (tham khảo) và `chiGomVat` là số quy đổi
 * để bày cạnh cột Chi tiêu — chi phí P&L vẫn CHỈ là dòng sổ `Expense`, không lấy số ở đây thay.
 */
export type DongItemGmvMax = {
  itemGroupId: string;
  /** Tên từ `Product.code`; không khớp ⇒ id trần. */
  ten: string;
  chiChuaVat: number;
  /** = Σ theo NGÀY của round(chiChuaVat × (1 + VAT tháng đó)) — cùng đơn vị với cột "Chi tiêu" của sổ. */
  chiGomVat: number;
  donSan: number | null;
  gmvSan: number | null;
};

export type BangItemChienDich = {
  campaignId: string;
  dong: DongItemGmvMax[];
  /**
   * chi GMV Max của campaign (sổ, gồm VAT) − Σ `chiGomVat`. Đo P0: breakdown thiếu ~0,60%.
   * Hiện thành DÒNG RIÊNG "Chưa phân bổ" chứ không để người đọc tự trừ — và không bao giờ âm hoá
   * bằng cách kéo giãn các dòng item. Campaign không có trong sổ ⇒ 0 (không bịa số âm).
   */
  chuaPhanBoGomVat: number;
};

type HangItem = { campaignId: string; itemGroupId: string; ngay: string; payload: unknown };

export async function gmvMaxTheoSanPham(
  range: DateRange,
  /** campaignId → chi GMV Max GỒM VAT từ sổ (lấy từ `quangCaoTheoChienDich`). */
  chiGmvMaxTheoChienDich: Record<string, number>,
): Promise<Record<string, BangItemChienDich>> {
  const to = endOfDay(range.to);

  const [rows, hoaDon] = await Promise.all([
    // So CHUỖI ngày (stat_time_day mang cả giờ ⇒ cắt 10 ký tự, cùng phép cắt với idExpr của
    // streams.ts), KHÔNG ép kiểu date — bẫy GUC TimeZone của session Postgres.
    //
    // CỐ Ý KHÔNG lọc "shopId" ở bảng NÀY, khác hẳn 5 reader analytics bên cạnh: `shopId` của
    // stream ads là ADVERTISER_ID, danh sách MỞ (chủ shop tự tạo tài khoản quảng cáo mới —
    // registry khai `shops: null` chính vì thế). Thêm mệnh đề lọc "cho đồng bộ" là ngày mai một
    // tài khoản mới ra đời thì chi tiêu của nó biến mất khỏi bảng con mà không có tín hiệu nào.
    // Tổng tiền vẫn đúng vì mỗi dòng đã gắn campaign_id, và campaign là thứ người gọi truyền vào.
    prisma.$queryRaw<HangItem[]>`
      SELECT DISTINCT ON ("shopId", "externalId")
        payload->'dimensions'->>'campaign_id'   AS "campaignId",
        payload->'dimensions'->>'item_group_id' AS "itemGroupId",
        left(payload->'dimensions'->>'stat_time_day', 10) AS ngay,
        payload
      FROM "RawTiktokBusinessGmvMaxItem"
      WHERE left(payload->'dimensions'->>'stat_time_day', 10) >= ${format(range.from, "yyyy-MM-dd")}
        AND left(payload->'dimensions'->>'stat_time_day', 10) <= ${format(to, "yyyy-MM-dd")}
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    `,
    latestPayloads("RawTiktokBusinessInvoice", {}),
  ]);

  // Cảnh báo VAT đã được đường dựng lại `Expense` bày ra ở lượt ingest (cùng hàm, cùng dữ liệu);
  // ở đây chỉ đọc để hiển thị nên không nhân bản kênh cảnh báo.
  const canhBao: string[] = [];
  const vat = buildVatByMonth(
    hoaDon.map((h) => h.payload),
    canhBao,
  );

  type Gom = { chiChuaVat: number; chiGomVat: number; donSan: number | null; gmvSan: number | null };
  const theoChienDich = new Map<string, Map<string, Gom>>();

  for (const r of rows) {
    if (!r.campaignId || !r.itemGroupId) continue;
    const metrics = khoi(r.payload, "metrics");
    const bang = theoChienDich.get(r.campaignId) ?? new Map<string, Gom>();
    const g: Gom = bang.get(r.itemGroupId) ?? { chiChuaVat: 0, chiGomVat: 0, donSan: 0, gmvSan: 0 };

    // Payload cấp item LUÔN kèm `metrics.currency` (đo 3/3 record fixture, ghi-chu-shape §9) ⇒
    // tiền tệ khác VND là hợp đồng đã trôi, đọc tiếp là cộng đô-la vào đồng. `orders` không phải
    // tiền nên không bị cổng này chặn.
    const tienTeVnd = metrics?.currency === "VND";
    const chiNgay = tienTeVnd ? docTienChuoiSan(metrics?.cost) : null;
    if (chiNgay !== null) {
      g.chiChuaVat += chiNgay;
      const tiLe = vat.rateForDate(r.ngay);
      // tiLe null ⇒ không cộng gì: phần chi ngày đó ở lại dòng "Chưa phân bổ" (thấy được), thay vì
      // chui vào một dòng item với tỉ lệ do app tự nghĩ ra.
      if (tiLe !== null) g.chiGomVat += Math.round(chiNgay * (1 + tiLe));
    }
    g.donSan = cong(g.donSan, docDemSan(metrics?.orders));
    g.gmvSan = cong(g.gmvSan, tienTeVnd ? docTienChuoiSan(metrics?.gross_revenue) : null);

    bang.set(r.itemGroupId, g);
    theoChienDich.set(r.campaignId, bang);
  }

  const moiItemId = [...new Set(rows.map((r) => r.itemGroupId).filter(Boolean))];
  const ten = new Map<string, string>();
  if (moiItemId.length > 0) {
    const sp = await prisma.product.findMany({
      where: { code: { in: moiItemId } },
      select: { code: true, name: true },
      // `Product.code` KHÔNG có @unique (schema). Đo prod 25/08: 0 mã trùng — nên đây không phải
      // rủi ro hôm nay, nhưng thứ tự phải TẤT ĐỊNH: bài học `Variant.sku` (22/08) là hai lượt chạy
      // nhặt hai bản ghi khác nhau mà không ai thấy. Bản ĐẦU theo id thắng, cố định.
      orderBy: { id: "asc" },
    });
    for (const s of sp) if (s.code && !ten.has(s.code)) ten.set(s.code, s.name);
  }

  const ra: Record<string, BangItemChienDich> = {};
  for (const [campaignId, bang] of theoChienDich) {
    const dong: DongItemGmvMax[] = [...bang.entries()]
      .map(([itemGroupId, g]) => ({
        itemGroupId,
        ten: ten.get(itemGroupId) ?? itemGroupId,
        chiChuaVat: g.chiChuaVat,
        chiGomVat: g.chiGomVat,
        donSan: g.donSan,
        gmvSan: g.gmvSan,
      }))
      .sort(
        (a, b) =>
          b.chiGomVat - a.chiGomVat ||
          b.chiChuaVat - a.chiChuaVat ||
          (a.itemGroupId < b.itemGroupId ? -1 : a.itemGroupId > b.itemGroupId ? 1 : 0),
      );
    const chiSo = chiGmvMaxTheoChienDich[campaignId];
    ra[campaignId] = {
      campaignId,
      dong,
      chuaPhanBoGomVat:
        chiSo === undefined ? 0 : chiSo - dong.reduce((s, d) => s + d.chiGomVat, 0),
    };
  }
  return ra;
}
