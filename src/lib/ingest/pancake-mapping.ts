import type { OrderStatus, ProductStatus } from "@prisma/client";

import { usesRealPlatformFee } from "@/lib/channels/real-fee-channels";
import type { PancakeOrder, PancakeProduct } from "./pancake-schemas";
import { suyVoucherSanTuCod } from "./suy-voucher-san-tu-cod";
import { phanBoVoucherSanTheoDong, voucherSanApDung } from "./voucher-san-tai-tro";

/**
 * Mapping THUẦN (không chạm DB) từ payload Pancake → shape domain.
 * Công thức tiền + khoá liên kết: xem `tests/fixtures/pancake/ghi-chu-shape-thuc-te.md`.
 * Mọi số VND làm tròn qua `round` (Math.round — nửa lên).
 */

const round = (n: number) => Math.round(n);

// ---- Status ----------------------------------------------------------------
// Nghĩa mã ĐÃ XÁC NHẬN với chủ shop (2026-07-07): 0=mới, 1=đã xác nhận, 2=đã gửi hàng,
// 8=đang đóng hàng → đều là đơn HỢP LỆ đang xử lý (TÍNH doanh thu). 3=delivered/4=returning/
// 6=canceled thấy trong data thật. 5/7 suy diễn (đều loại → an toàn). Mã lạ → CANCELLED + warning.
// Hợp lệ cho P&L = KHÔNG RETURNED/CANCELLED.
export const PANCAKE_STATUS_MAP: Record<string, OrderStatus> = {
  "0": "PENDING", // mới
  "1": "PENDING", // đã xác nhận
  "8": "PENDING", // đang đóng hàng (trước khi gửi) — P&L tính như PENDING
  "2": "SHIPPING", // đã gửi hàng
  "3": "COMPLETED", // delivered
  "4": "RETURNED", // returning
  "5": "RETURNED", // suy diễn — loại khỏi P&L
  "6": "CANCELLED", // canceled
  "7": "CANCELLED", // suy diễn — loại khỏi P&L
};

// Dự phòng khi Pancake trả status dạng TÊN thay vì mã số (tránh loại nhầm đơn COMPLETED → under-count).
const PANCAKE_STATUS_NAME_MAP: Record<string, OrderStatus> = {
  delivered: "COMPLETED",
  returning: "RETURNED",
  returned: "RETURNED",
  canceled: "CANCELLED",
  cancelled: "CANCELLED",
};

/**
 * Prefix warning cho mã status HOÀN TOÀN LẠ (không khớp cả code lẫn status_name) → bị loại như
 * CANCELLED. Transform đếm warning khớp prefix này (`stats.unknownStatusOrders`) để UI cảnh báo:
 * Pancake KHÔNG công khai bảng mã số (verified 2026-07-23), nên mã mới hợp lệ CÓ THỂ bị loại nhầm
 * khỏi doanh thu — phải HIỆN cho chủ shop thấy, không để mất đơn âm thầm. (Nhánh "khớp tên" KHÔNG
 * tính vì vẫn map đúng, không mất doanh thu.)
 */
export const UNKNOWN_STATUS_WARNING = "Mã trạng thái Pancake lạ";

export function mapStatus(raw: number | string, warnings: string[], statusName?: string | null): OrderStatus {
  const byCode = PANCAKE_STATUS_MAP[String(raw)];
  if (byCode) return byCode;
  const byName = statusName ? PANCAKE_STATUS_NAME_MAP[statusName.trim().toLowerCase()] : undefined;
  if (byName) {
    warnings.push(`Status code "${raw}" lạ nhưng khớp tên "${statusName}" → ${byName}; bổ sung code vào PANCAKE_STATUS_MAP`);
    return byName;
  }
  warnings.push(
    `${UNKNOWN_STATUS_WARNING} "${raw}"${statusName ? `/"${statusName}"` : ""} → loại khỏi doanh thu (xử như CANCELLED); bổ sung PANCAKE_STATUS_MAP`,
  );
  return "CANCELLED";
}

const MIRROR_MARKETPLACE_IDS = new Set(["-3", "-9"]); // −3 Shopee, −9 TikTok
/**
 * Đơn MIRROR trong shop kho: nguồn "Affiliate" + marketplace Shopee/TikTok — là bản sao đơn gốc
 * (khác id) để trừ tồn. TUYỆT ĐỐI KHÔNG tính doanh thu (chống đếm 2 lần — invariant #2).
 * Dùng ở ingest route để skip khi (lỡ) kéo đơn từ shop kho.
 */
export function isAffiliateMirror(
  raw: Pick<PancakeOrder, "order_sources_name" | "marketplace_id">,
): boolean {
  const src = (raw.order_sources_name ?? "").trim().toLowerCase();
  const mkt = raw.marketplace_id != null ? String(raw.marketplace_id) : "";
  return src === "affiliate" && MIRROR_MARKETPLACE_IDS.has(mkt);
}

// ---- Channel ---------------------------------------------------------------
// Hiện: Shopee + TikTok (đơn gốc). Facebook/website mở rộng sau.
export function mapChannel(rawSource: string | null | undefined, warnings: string[]): string {
  const s = (rawSource ?? "").toLowerCase();
  if (s.includes("shopee")) return "shopee";
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("face") || s.includes("insta") || s.includes("messenger") || s.includes("pancake")) {
    return "facebook";
  }
  if (!s) warnings.push(`Đơn không có nguồn → website`);
  else warnings.push(`Nguồn đơn lạ "${rawSource}" → website`);
  return "website";
}

/** Ước tính phí sàn theo % (DỰ PHÒNG cho kênh chưa có phí thật — FB/website). Shopee/TikTok dùng fee_marketplace thật. */
export function calcPlatformFeeEst(
  itemsTotal: number,
  ch: { platformFeePct: number; paymentFeePct: number },
): number {
  return round((itemsTotal * (ch.platformFeePct + ch.paymentFeePct)) / 100);
}

/**
 * Parse thời gian Pancake ("2026-06-19T23:15:18.000000") → Date (instant đúng).
 * Pancake xuất datetime naive (KHÔNG hậu tố TZ) nhưng giá trị là giờ **UTC**, không phải VN
 * (verified 2026-07-22 qua neo epoch: chuỗi "...10:47:58" khớp chính xác 10:47:58Z, không phải 17:47 VN).
 * → chuỗi thiếu TZ được neo "Z" (UTC); chuỗi có sẵn Z/offset giữ nguyên.
 * Trước đây neo nhầm "+07:00" → orderedAt lùi 7h, đơn đặt 00:00–06:59 VN bị đẩy về hôm trước.
 * Giây là TUỲ CHỌN: chuỗi datetime thiếu giây ("2026-07-06T02:10") vẫn neo UTC (bù ":00"), KHÔNG
 * rơi vào `new Date()` suy diễn giờ LOCAL (+07 trong container) — giữ nhất quán chủ đích neo UTC dù
 * upstream (webhook / field khác) đổi định dạng bớt giây.
 */
export function parseVnDate(s: string): Date {
  // Nhận datetime (separator "T" lẫn khoảng trắng, giây + phần lẻ giây tuỳ chọn) VÀ date-only;
  // rồi neo TZ. KHÔNG còn fallback `new Date(s)` cho định dạng ngoài khuôn: parser hệ của V8
  // CHUẨN HOÁ ngày tràn ở đủ mọi dạng ("2026-2-31", "02/31/2026", "2026/02/31" → đều ra 02–03/03)
  // — mọi nguồn thật (Pancake API + webhook, đo toàn bộ fixture) chỉ dùng đúng các dạng ở đây,
  // chuỗi ngoài khuôn là dữ liệu hỏng: phải nổi lên thành Invalid Date (caller lọc
  // `Number.isNaN(d.getTime())`, đơn bị bỏ qua CÓ cảnh báo) chứ không thành một ngày sai câm.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(:\d{2}(?:\.\d+)?)?(.*))?$/);
  if (!m) return new Date(NaN);
  const [, y, mon, day, hh, mi, ssFrac, tail] = m;
  // V8 chuẩn hoá ngày tràn lịch cả ở ISO đủ giờ ("2026-02-31T10:00:00Z" → 03/03) lẫn date-only
  // ("2026-02-31" → 03/03) — kiểm lịch thật trước khi đưa vào Date.
  const soNgayTrongThang = new Date(Date.UTC(Number(y), Number(mon), 0)).getUTCDate();
  if (
    Number(mon) < 1 || Number(mon) > 12 ||
    Number(day) < 1 || Number(day) > soNgayTrongThang ||
    (hh !== undefined && (Number(hh) > 23 || Number(mi) > 59 || (ssFrac ? Number(ssFrac.slice(1, 3)) > 59 : false)))
  ) {
    return new Date(NaN);
  }
  if (hh === undefined) return new Date(`${y}-${mon}-${day}T00:00:00Z`); // date-only: nửa đêm UTC như cũ
  // Đuôi sau giây phải RỖNG hoặc là TZ thật — trước đây đuôi rác ("…garbage") bị LẶNG LẼ neo "Z".
  // Phần lẻ giây KHÔNG có giây đi trước ("10:00.500Z") cũng rơi vào đây → Invalid.
  const tz = tail === "" ? "Z" : /^([zZ]|[+-]\d{2}:?\d{2})$/.test(tail) ? tail : null;
  if (tz === null) return new Date(NaN);
  // GIỮ phần lẻ giây (V8 nhận fraction dài tuỳ ý, tự cắt về mili) — bản cũ rơi rớt:
  // "…T10:00:00.500Z" thành 10:00:00 tròn, và `webhook-stock.ts` phải tự vá lại phần mili.
  return new Date(`${y}-${mon}-${day}T${hh}:${mi}${ssFrac ?? ":00"}${tz}`);
}

/**
 * Thời điểm đơn VÀO trạng thái hiện tại: entry status_history khớp mã status,
 * lấy mốc MUỘN nhất (đơn đổi qua lại thì lần vào gần nhất mới đúng). Fallback
 * updated_at đầu đơn (nhảy cả khi sàn đối soát phí — chấp nhận khi thiếu
 * history); không có gì → null. Naive datetime là giờ UTC → parseVnDate.
 */
export function deriveStatusChangedAt(
  raw: Pick<PancakeOrder, "status" | "status_history" | "updated_at">,
): Date | null {
  const code = String(raw.status);
  const times = (raw.status_history ?? [])
    .filter((h) => h.status != null && String(h.status) === code && !!h.updated_at)
    .map((h) => parseVnDate(h.updated_at as string).getTime())
    .filter((t) => !Number.isNaN(t));
  if (times.length) return new Date(Math.max(...times));
  if (!raw.updated_at) return null;
  // Fallback KHÔNG được trả về một Date hỏng. `updated_at` chỉ bị zod ép là chuỗi nên mọi khuôn lạ
  // đều lọt, và `parseVnDate` cố ý trả `new Date(NaN)` thay vì ném. Đẩy tiếp xuống Prisma thì cả
  // lượt ghi đơn hỏng — tức MẤT DOANH THU chỉ vì một mốc thời gian PHỤ (`statusChangedAt` không
  // tham gia P&L, chỉ để hiển thị "đơn vào trạng thái này lúc nào"). Hạ về null an toàn hơn nhiều.
  const t = parseVnDate(raw.updated_at);
  return Number.isNaN(t.getTime()) ? null : t;
}

function labelFromFields(fields: { value?: string | null }[] | null | undefined): string {
  const label = (fields ?? [])
    .map((f) => f.value)
    .filter((v): v is string => !!v)
    .join(" / ");
  return label || "Mặc định";
}

// ---- Types -----------------------------------------------------------------
export type MappedOrderItem = {
  variationPancakeId: string | null; // UUID per-shop (thường không khớp Variant.pancakeId cross-shop)
  sku: string; // = variation_info.display_id — khoá tra Variant.sku
  productName: string;
  /**
   * `variation_info.detail` — phân loại người mua chọn ("Phân loại B,Cỡ 2"). KHÔNG lưu xuống
   * `OrderItem` (schema là hợp đồng, không thêm cột cho việc này); chỉ đi qua bộ nhớ để làm một
   * phần khoá của bảng ghép thủ công (`ghep-variant-thu-cong.ts`). Vắng ⇒ chuỗi rỗng.
   */
  variantDetail: string;
  quantity: number;
  unitPrice: number; // đơn giá 1 sp (gross)
  lineDiscount: number; // giảm giá dòng SHOP CHỊU = quantity × discount_each_product − voucher sàn phân bổ về dòng (Σ dòng khớp itemsTotal)
};

export type MappedOrder = {
  pancakeId: string;
  code: string;
  channelId: string;
  status: OrderStatus;
  orderedAt: Date;
  statusChangedAt: Date | null; // thời điểm đơn VÀO trạng thái hiện tại (status_history; fallback updated_at)
  customerName: string | null;
  itemsTotal: number; // total_price − (Σ quantity×discount_each_product − marketplace_voucher áp dụng) — chỉ trừ phần shop chịu
  shipFeeCustomer: number;
  discount: number; // voucher mức đơn
  platformFeeEst: number; // = fee_marketplace THẬT (marketplace) | ước tính % (khác)
  returnedFee: number; // = advanced_platform_fee.returned_fee (clamp ≥0) — phí sàn thực giữ trên đơn hoàn/hủy, 0 khi vắng/chưa đối soát
  items: MappedOrderItem[];
  warnings: string[];
};

export type MappedVariant = {
  pancakeId: string;
  sku: string;
  label: string;
  sellPrice: number;
  stock: number;
  costPrice: number; // = average_imported_price (CHỈ set khi CREATE — upsert không ghi đè)
};

export type MappedProduct = {
  pancakeId: string;
  name: string;
  code: string | null;
  categoryName: string | null;
  imageUrl: string | null;
  status: ProductStatus;
  variants: MappedVariant[];
};

export type MapOrderCtx = {
  channels: Record<string, { platformFeePct: number; paymentFeePct: number }>;
};

// ---- Order mapping ---------------------------------------------------------
export function mapPancakeOrder(raw: PancakeOrder, ctx: MapOrderCtx): MappedOrder {
  const warnings: string[] = [];
  const channelId = mapChannel(raw.order_sources_name, warnings);
  const status = mapStatus(raw.status, warnings, raw.status_name);

  const items = raw.items ?? [];
  // `discount_each_product` là giảm giá MỖI ĐƠN VỊ (OpenAPI Pancake: "Giảm giá cho từng sản phẩm"),
  // KHÔNG phải giảm giá cả dòng ⇒ phải × quantity mới cùng cơ sở với `total_price` (= Σ qty×retail_price).
  // Verify 2026-08-03 trên 1076 dòng Bronze: `items[].total_discount == quantity × discount_each_product`
  // đúng 1076/1076 (cách hiểu cũ chỉ đúng 1062/1076 — hụt đúng 14 dòng qty>1 có giảm giá). Trọng tài độc
  // lập: đơn MIRROR kho có `fee_marketplace = 0` nên `cod` là giá trị hàng ròng Pancake tự chốt —
  // `AF100975192O322` cod 578.000 khớp `tp − Σ(qty×dep)`, lệch hẳn 689.000 của cách cũ.
  // Clamp ≥ 0 (dữ liệu âm sẽ thổi phồng doanh thu âm thầm).
  const giamGiaDong = items.map((it) => Math.max(0, round(it.discount_each_product)) * it.quantity);
  const sumEachDiscount = giamGiaDong.reduce((s, v) => s + v, 0);

  // CỔNG CHẶN NGỮ NGHĨA: `items[].total_discount` là cùng số đó do Pancake tự tính sẵn. Lệch ⇒ Pancake
  // đổi cách hiểu field ⇒ phải biết NGAY chứ không im lặng sai tiền như lần trước (lỗi này sống 4 tháng
  // vì mọi dòng có giảm giá trong fixture đều quantity = 1 nên hai cách hiểu ra cùng kết quả).
  items.forEach((it, i) => {
    if (it.total_discount == null) return;
    const td = Math.max(0, round(it.total_discount));
    if (td !== giamGiaDong[i])
      warnings.push(`Đơn ${raw.id} dòng ${i}: quantity×discount_each_product (${giamGiaDong[i]}) ≠ item.total_discount (${td}) — Pancake có thể đã đổi nghĩa field, KIỂM TRA trước khi tin số doanh thu`);
  });
  const grossTotal = round(raw.total_price);

  // Tách phần SÀN tài trợ ra khỏi giảm giá dòng: nó nằm trong `discount_each_product` nhưng sàn trả
  // lại cho shop, nên KHÔNG trừ vào doanh thu (chứng minh + số đo: `voucher-san-tai-tro.ts`).
  const voucherSanTho = Math.max(0, round(raw.advanced_platform_fee?.marketplace_voucher ?? 0));
  const voucherSanDaKhai = voucherSanApDung(voucherSanTho, sumEachDiscount);
  if (voucherSanTho > sumEachDiscount) {
    warnings.push(`Đơn ${raw.id}: voucher sàn tài trợ (${voucherSanTho}) > Σ giảm giá dòng (${sumEachDiscount}) → kẹp về Σ giảm giá dòng, kiểm tra dữ liệu`);
  }
  // Có đơn Pancake GỘP phần sàn gánh vào giảm giá dòng nhưng QUÊN khai ở `marketplace_voucher` —
  // `cod` (tiền hàng ròng Pancake tự chốt) là trọng tài phát hiện ra. Luật hẹp, xem
  // `suy-voucher-san-tu-cod.ts`: không thoả đủ điều kiện thì chỉ cảnh báo chứ không đụng số.
  const suyRa = suyVoucherSanTuCod({
    maDon: raw.id,
    status,
    grossTotal,
    sumEachDiscount,
    voucherSanDaKhai,
    cod: raw.cod == null ? null : round(raw.cod),
    feeMarketplace: Math.max(0, round(raw.fee_marketplace)),
    // Kẹp ≥ 0 như mọi nơi khác: trên đơn đã giao, `total_discount` âm là cách Pancake ghi khoản
    // SÀN gánh (không phải khoản shop trừ) nên không được vào vế mốc — xem `suy-voucher-san-tu-cod.ts`.
    discountMucDon: Math.max(0, round(raw.total_discount)),
    // `cod` gồm cả ship ⇒ đơn có ship thì đẳng thức thiếu số hạng. Cộng CẢ HAI nguồn ship: đo prod
    // thấy mỗi đơn dính một kiểu (`shipping_fee` 42.500 đ ở đơn này, `diff_shipping_fee` 8.000 đ ở
    // đơn kia), soi thiếu một cái là vẫn lọt.
    tienShip:
      Math.abs(round(raw.shipping_fee)) +
      Math.abs(round(raw.advanced_platform_fee?.diff_shipping_fee ?? 0)),
    dungPhiThat: usesRealPlatformFee(channelId),
  });
  if (suyRa.canhBao) warnings.push(suyRa.canhBao);
  const voucherSan = voucherSanDaKhai + suyRa.boSung;
  // Phân bổ về từng dòng để `Σ (unitPrice×qty − lineDiscount)` vẫn khớp `itemsTotal` (tab Sản phẩm).
  const voucherSanTheoDong = phanBoVoucherSanTheoDong(giamGiaDong, voucherSan);
  const giamGiaShopTheoDong = giamGiaDong.map((d, i) => d - voucherSanTheoDong[i]);
  const giamGiaShop = sumEachDiscount - voucherSan;
  if (giamGiaShop > grossTotal) {
    warnings.push(`Đơn ${raw.id}: giảm giá shop chịu (${giamGiaShop}) > total_price (${grossTotal}) → itemsTotal âm, kiểm tra dữ liệu`);
  }
  // total_price = Σ qty×retail_price (GỘP, trước giảm giá dòng — verify 60/60 đơn) → trừ discount_each ĐÚNG 1 lần.
  // total_discount là voucher mức đơn ĐỘC LẬP (verify: đơn có cả hai, total_discount < Σ discount_each) → trừ riêng.
  const itemsTotal = grossTotal - giamGiaShop;
  const discount = Math.max(0, round(raw.total_discount));

  // Phí sàn: marketplace → số THẬT fee_marketplace; kênh khác → ước tính % (dự phòng).
  const ch = ctx.channels[channelId] ?? { platformFeePct: 0, paymentFeePct: 0 };
  const platformFeeEst = usesRealPlatformFee(channelId)
    ? Math.max(0, round(raw.fee_marketplace)) // clamp ≥0: phí sàn âm bất thường sẽ cộng vào doanh thu
    : calcPlatformFeeEst(itemsTotal, ch);
  // Phí sàn THỰC sàn giữ trên đơn hoàn/hủy (Pancake, UI-verified). Vắng/null → 0. Clamp ≥0.
  const returnedFee = Math.max(0, round(raw.advanced_platform_fee?.returned_fee ?? 0));

  const mappedItems: MappedOrderItem[] = items.map((it, i) => {
    const vi = it.variation_info;
    const sku = vi?.display_id ?? "";
    if (!sku) warnings.push(`Đơn ${raw.id}: item không có SKU (variation_info.display_id) → không tra được giá vốn`);
    return {
      variationPancakeId: it.variation_id ?? null,
      sku,
      productName: vi?.name ?? "",
      variantDetail: vi?.detail ?? "",
      quantity: it.quantity,
      unitPrice: round(vi?.retail_price ?? 0),
      lineDiscount: giamGiaShopTheoDong[i],
    };
  });

  return {
    pancakeId: String(raw.id),
    code: raw.system_id != null ? String(raw.system_id) : String(raw.id),
    channelId,
    status,
    orderedAt: parseVnDate(raw.inserted_at),
    statusChangedAt: deriveStatusChangedAt(raw),
    customerName: raw.customer?.name ?? null,
    itemsTotal,
    shipFeeCustomer: round(raw.shipping_fee),
    discount,
    platformFeeEst,
    returnedFee,
    items: mappedItems,
    warnings,
  };
}

// ---- Product mapping (shop kho) --------------------------------------------
export function mapPancakeProduct(raw: PancakeProduct): MappedProduct {
  const status: ProductStatus = raw.is_hidden ? "HIDDEN" : "ACTIVE";
  const variants: MappedVariant[] = (raw.variations ?? []).map((v) => ({
    pancakeId: String(v.id),
    sku: v.display_id ?? v.custom_id ?? "",
    label: labelFromFields(v.fields),
    sellPrice: round(v.retail_price),
    stock: round(v.remain_quantity),
    // Giá vốn prefill từ kho — ưu tiên average_imported_price, fallback last_imported_price.
    costPrice: round(v.average_imported_price || v.last_imported_price || 0),
  }));
  return {
    pancakeId: String(raw.id),
    name: raw.name,
    code: raw.custom_id ?? raw.display_id ?? null,
    categoryName: raw.category_name ?? null,
    imageUrl: raw.image ?? raw.image_url ?? null,
    status,
    variants,
  };
}
