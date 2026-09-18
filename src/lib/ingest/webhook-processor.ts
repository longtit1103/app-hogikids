import { hasBronzeBacklog, isBronzeOnly, markBronzeBacklog } from "@/lib/bronze/bronze-only";
import { demDaHachToan } from "@/lib/bronze/doi-soat-hach-toan";
import { locDonChuaDongDau } from "@/lib/bronze/ket-cuc-silver";
import { giuKhoaLandDon } from "@/lib/bronze/khoa-land-don";
import { landRaw } from "@/lib/bronze/land-raw";
import { BRONZE_STREAMS } from "@/lib/bronze/streams";
import { transformFromRaw, type TransformStats } from "@/lib/bronze/transform-from-raw";
import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import type { Prisma } from "@prisma/client";

import { parseVnDate } from "./pancake-mapping";
import { xuLyTonKho } from "./webhook-stock";

/**
 * Bộ xử lý webhook Pancake pha 2 — chạy SAU khi hộp thư đã ghi (hộp thư là bất biến: nhận là ghi,
 * xử lý hỏng thì payload vẫn còn, nightly API vét bù).
 *
 * PHẠM VI: **ĐƠN HÀNG + TỒN KHO.** Sản phẩm (`products`) và mọi loại khác được nhận diện, ĐẾM rồi
 * bỏ qua — nguồn của chúng vẫn là lượt API nightly 03:00 (lịch 30' đã gỡ 2026-07-28, PR #60;
 * `pancake-sync-now` chỉ còn được gọi tay qua nút "Đồng bộ ngay"). Cố ý hẹp: webhook chỉ làm TƯƠI
 * trong ngày, API mới là chuẩn; thêm nhánh nào cũng phải chứng minh bằng số đo trước (user chốt
 * 2026-07-27). Hai nhánh đi hai đường KHÁC nhau, xem lý do ở `webhook-stock.ts`:
 *   - đơn hàng → land Bronze rồi transform (cần lịch sử, dùng lại nguyên đường API);
 *   - tồn kho  → ghi thẳng 1 cột Silver (không báo cáo nào đọc lịch sử tồn).
 *
 * Nguyên tắc "không nuốt im lặng" (yêu cầu chủ shop 2026-07-27): MỌI sự kiện đều phải có KẾT CỤC
 * (`processedAs`) ghi lên dòng hộp thư — kể cả loại app cố ý bỏ qua hay loại app chưa từng gặp.
 * Panel ở /cai-dat đọc kết cục này để chủ shop thấy sự kiện lạ mà còn vào fix.
 *
 * Định tuyến theo field `type` trong payload (đo 534/534 sự kiện đều có; `event_type` thì không —
 * KHÔNG dùng). Căn cứ toàn bộ quyết định nhánh: báo cáo
 * `plans/reports/danh-gia-mau-webhook-pancake-260727-1317-doi-chieu-api-vs-webhook-report.md`.
 */

/** Kết cục xử lý một sự kiện — giá trị ghi vào `RawPancakeWebhookEvent.processedAs`. */
export type KetCucXuLy =
  | "don-hang" // land Bronze RawPancakeOrder (+ transform Silver nếu không BRONZE_ONLY)
  | "don-hang-cu-hon" // sự kiện chụp TRƯỚC bản đang có trong Bronze — cố ý KHÔNG land (xem guard)
  | "don-hang-can-xem" // đã vào Silver nhưng có tín hiệu cần người xem (mã trạng thái lạ…)
  | "ton-kho" // variations_warehouses shop KHO → đã ghi thẳng Variant.stock
  | "ton-kho-cu-hon" // sự kiện tồn cũ hơn cái API/webhook đã xác nhận — cố ý không ghi
  | "ton-kho-bo-qua" // sự kiện tồn của shop BÁN — bộ mã biến thể riêng, cố ý bỏ
  | "ton-kho-chua-co-bien-the" // biến thể chưa có trong app — TỰ LÀNH ở lượt API kế tiếp, không báo đỏ
  | "ton-kho-chua-cau-hinh" // chưa điền Warehouse ID — đã lộ ở khối Khóa kết nối, không tô đỏ từng sự kiện
  | "ton-kho-can-xem" // kho lạ / payload sai shape / giá trị vô lý — PHẢI hiện lên panel
  | "san-pham-bo-qua" // products webhook THIẾU giá vốn+tồn — land sẽ phá dữ liệu, cố ý bỏ
  | "bronze-only" // chế độ BRONZE_ONLY: không được đụng Silver, bỏ qua có ghi chú
  | "truoc-pha-2" // dòng nhận TRƯỚC khi pha 2 sống (hộp thư chỉ lưu) + dòng nạp bù — không xử lý
  | "khong-nhan-dien" // loại sự kiện app chưa có nhánh xử lý — PHẢI hiện lên panel
  | "loi"; // xử lý ném lỗi — payload vẫn nguyên trong hộp thư

export type KetQuaXuLy = { processedAs: KetCucXuLy; note?: string };

/** Kết cục cần NGƯỜI xem — panel /cai-dat tô đỏ + in ghi chú. Một nguồn sự thật cho cả 2 nơi. */
export const KET_CUC_CAN_XEM: readonly KetCucXuLy[] = [
  "khong-nhan-dien",
  "loi",
  "don-hang-can-xem",
  "ton-kho-can-xem",
  "bronze-only",
];

/** Trần độ dài note ghi vào DB — warnings mapping có thể rất dài, đủ chẩn đoán là được. */
const NOTE_TOI_DA = 500;

export function catNote(note: string | undefined): string | undefined {
  if (!note) return undefined;
  return note.length > NOTE_TOI_DA ? `${note.slice(0, NOTE_TOI_DA)}…` : note;
}

/**
 * Đọc field `type` để định tuyến. JSON.parse ở đây CHỈ đọc `type` (chuỗi ngắn) — object đã parse
 * TUYỆT ĐỐI không dùng để land (int64 bị làm tròn khi re-serialize); land luôn đi bằng TEXT gốc.
 */
export function sniffLoaiSuKien(payload: string): { laJsonObject: boolean; type: string | null } {
  try {
    const o: unknown = JSON.parse(payload);
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      return { laJsonObject: false, type: null };
    }
    const type = (o as Record<string, unknown>).type;
    return { laJsonObject: true, type: typeof type === "string" ? type : null };
  } catch {
    return { laJsonObject: false, type: null };
  }
}

/**
 * Xử lý 1 sự kiện webhook. KHÔNG throw ra ngoài (mọi lỗi → kết cục `loi`) — route chỉ việc ghi
 * kết cục lên dòng hộp thư rồi trả 200: n8n không retry vô ích, dữ liệu không mất (hộp thư + nightly).
 */
export async function xuLySuKienWebhook(args: {
  shopId: string;
  payload: string;
}): Promise<KetQuaXuLy> {
  const { shopId, payload } = args;
  try {
    const { laJsonObject, type } = sniffLoaiSuKien(payload);
    if (!laJsonObject) {
      return { processedAs: "khong-nhan-dien", note: "payload không phải JSON object" };
    }

    if (type === "orders") return await xuLyDonHang(shopId, payload);

    if (type === "variations_warehouses") return await xuLyTonKhoRealtime(shopId, payload);

    if (type === "products") {
      // Payload products webhook VẮNG HẲN average_imported_price + remain_quantity (đo 0/174 biến
      // thể, kể cả sp đã nhập giá vốn) — land qua transform cũ sẽ ghi tồn=0 và đẻ variant mới với
      // costPrice=0 vĩnh viễn (APP-OWNED không cho sync sửa lại). Nguồn products giữ API nightly (03:00).
      return { processedAs: "san-pham-bo-qua" };
    }

    return {
      processedAs: "khong-nhan-dien",
      note: `type chưa có nhánh xử lý: ${JSON.stringify(type) ?? "null"}`.slice(0, 120),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { processedAs: "loi", note: catNote(msg) };
  }
}

/**
 * Tồn kho realtime: sự kiện `variations_warehouses` shop KHO ghi THẲNG `Variant.stock` (không qua
 * Bronze — lý do đầy đủ ở `webhook-stock.ts`). Luật ưu tiên vẫn là API MẠNH HƠN WEBHOOK: guard thứ
 * tự nằm trong `xuLyTonKho`, và mỗi lượt vá tồn từ Bronze trả quyền quyết định về cho API.
 *
 * BRONZE_ONLY chặn ở ĐÂY (trước khi đụng Silver) chứ không trong `xuLyTonKho`: chế độ đó nghĩa là
 * "Silver đứng yên, chờ rebuild" — ghi tồn lúc này là lách chính công tắc mình vừa bật.
 * Không mất dữ liệu: payload còn nguyên trong hộp thư, và lượt API kế tiếp dựng lại tồn đúng.
 */
async function xuLyTonKhoRealtime(shopId: string, payload: string): Promise<KetQuaXuLy> {
  if (isBronzeOnly()) {
    return { processedAs: "bronze-only", note: "BRONZE_ONLY: không ghi tồn kho (tồn giữ theo API)" };
  }
  const r = await xuLyTonKho(shopId, payload);
  const map = {
    ghi: "ton-kho",
    "cu-hon": "ton-kho-cu-hon",
    "bo-qua": "ton-kho-bo-qua",
    "chua-co-bien-the": "ton-kho-chua-co-bien-the",
    "chua-cau-hinh": "ton-kho-chua-cau-hinh",
    "can-xem": "ton-kho-can-xem",
  } as const;
  return { processedAs: map[r.ket], note: catNote(r.note) };
}

/**
 * Field mapping mà `mapPancakeOrder` thật sự đọc. Webhook thiếu bất kỳ field nào trong đây MÀ bản
 * API đang có ⇒ nhường API (xem `soVoiBanApi`). KHÔNG liệt kê `is_abandoned_order`: đo thật cho
 * thấy webhook luôn thiếu nó, và app không dùng — đưa vào đây là chặn nhầm mọi sự kiện.
 */
const FIELD_MAPPING_DON = [
  "system_id",
  "status",
  "status_name",
  "inserted_at",
  "updated_at",
  "status_history",
  "order_sources_name",
  "marketplace_id",
  "total_price",
  "total_discount",
  "shipping_fee",
  "fee_marketplace",
  // `cod` KHÔNG ghi thẳng vào cột Silver nào — nó là trọng tài của `suy-voucher-san-tu-cod.ts`. Vì
  // vắng nó không xoá cột nào nên KHÔNG cổng nào khác bắt được: bản webhook thiếu `cod` sẽ map lại
  // `boSung = 0`, kéo `itemsTotal` của đơn đã bù về số cũ, và KHÔNG tự lành (lượt API sau trùng
  // payloadHash nên bị bỏ qua, bản webhook vẫn là mới nhất). Phải nằm trong danh sách này.
  "cod",
  "advanced_platform_fee",
  "customer",
  "items",
];

/**
 * Field TIỀN nằm LỒNG trong `advanced_platform_fee` mà mapping thật sự đọc. Phải soi riêng vì
 * `jsonb_object_keys` chỉ thấy khoá mức 1 — có `advanced_platform_fee` không có nghĩa là có đủ ruột.
 * Thiếu `marketplace_voucher` mà bản API đang có ⇒ doanh thu đơn tụt lại đúng bằng phần sàn tài trợ.
 */
const FIELD_TIEN_LONG = ["returned_fee", "marketplace_voucher"];

/** Kết quả đối chiếu sự kiện với bản API mới nhất — rút bằng POSTGRES (id có thể là int64). */
type SoSanhBanApi = {
  /**
   * `id` đơn rút NGAY TRONG SQL (`o->>'id'`) nên lossless — payload là TEXT, JS không parse (int64).
   * Cần cả khi guard CHẶN sự kiện: lúc đó vẫn phải hỏi Bronze xem bản mới nhất của chính đơn này
   * đã dựng Silver xong chưa.
   */
  externalId: string | null;
  updatedAtMoi: string | null;
  updatedAtCu: string | null;
  /** Field mapping bản cũ CÓ mà sự kiện này KHÔNG có. */
  thieuField: string[] | null;
  /** Field trong `FIELD_TIEN_LONG` mà bản cũ CÓ còn sự kiện này KHÔNG (tiền — soi riêng vì lồng). */
  matFieldLong: string[] | null;
};

/**
 * GUARD THỨ TỰ (bịt lỗi Silver thụt lùi — chứng minh thực nghiệm 2026-07-27).
 *
 * `landRaw` đóng dấu `fetchedAt = now()` và transform luôn chọn bản `fetchedAt` mới nhất ⇒ nguồn
 * land SAU luôn thắng, BẤT KỂ nội dung nó chụp lúc nào. Đường API cũ miễn nhiễm (API luôn trả
 * trạng thái hiện tại), nhưng webhook là nguồn ĐẦU TIÊN có thể mang nội dung CŨ tới muộn:
 * 2 sự kiện cách nhau vài trăm ms chạy song song trong n8n, hoặc sự kiện bắn ngay trước lượt sync
 * nhưng tới app ngay sau. Hậu quả đã đo: phí sàn tụt từ số THẬT về số tạm, đơn RETURNED lùi về
 * PENDING và được tính lại vào doanh thu (phá bất biến #1) — và KHÔNG tự lành: lượt API kế tiếp
 * trùng hash nên không land lại, `rebuild-from-raw` cũng chọn đúng bản webhook cũ đó.
 *
 * Vì vậy sự kiện cũ hơn KHÔNG được land vào Bronze (không chỉ "không transform"): dòng Bronze cũ
 * hơn mà `fetchedAt` mới hơn là quả mìn hẹn giờ cho mọi lần rebuild sau này. Không mất dữ liệu —
 * hộp thư `RawPancakeWebhookEvent` giữ nguyên payload, nó mới là kho raw của webhook.
 *
 * So bằng `parseVnDate` (KHÔNG so chuỗi): naive datetime Pancake là giờ UTC (bất biến #3) và
 * định dạng có thể đổi separator T/khoảng trắng.
 *
 * ĐỌC-ĐỂ-QUYẾT-ĐỊNH: bản thân hàm này chỉ ĐỌC, nên nó PHẢI chạy trong cùng transaction (và cùng
 * khoá tư vấn) với bước land — xem `xuLyDonHang`. Nhận `db` chứ không tự gọi `prisma` để không có
 * đường nào lỡ đọc ngoài khoá.
 */
async function laSuKienCuHon(
  shopId: string,
  payload: string,
  db: Prisma.TransactionClient
): Promise<{ cuHon: boolean; note?: string; externalId: string | null }> {
  const [moc] = await db.$queryRawUnsafe<SoSanhBanApi[]>(
    `
    WITH moi AS MATERIALIZED (SELECT ($1::jsonb) AS o),
    cu AS MATERIALIZED (
      SELECT payload FROM "RawPancakeOrder"
      WHERE "shopId" = $2 AND "externalId" = (SELECT o->>'id' FROM moi)
      ORDER BY "fetchedAt" DESC, "id" DESC LIMIT 1
    )
    SELECT
      (SELECT o->>'id' FROM moi) AS "externalId",
      (SELECT o->>'updated_at' FROM moi) AS "updatedAtMoi",
      (SELECT payload->>'updated_at' FROM cu) AS "updatedAtCu",
      (SELECT array_agg(k) FROM jsonb_object_keys((SELECT payload FROM cu)) AS k
        WHERE k = ANY($3::text[]) AND NOT ((SELECT o FROM moi) ? k)) AS "thieuField",
      (SELECT array_agg(k) FROM unnest($4::text[]) AS k
        WHERE (SELECT o->'advanced_platform_fee'->>k FROM moi) IS NULL
          AND (SELECT payload->'advanced_platform_fee'->>k FROM cu) IS NOT NULL
          -- Giá trị 0 thì KHÔNG có gì để mất: chặn sự kiện lúc đó chỉ làm mất tính tươi. Đo prod
          -- 2026-08-03: 365/992 đơn có marketplace_voucher = 0, chặn hết là hỏng realtime vô cớ.
          AND (SELECT payload->'advanced_platform_fee'->>k FROM cu) <> '0') AS "matFieldLong"
    `,
    payload,
    shopId,
    FIELD_MAPPING_DON,
    FIELD_TIEN_LONG,
  );

  // Chưa có bản nào trong Bronze → sự kiện này là bản đầu tiên, cứ land.
  if (!moc?.updatedAtCu) return { cuHon: false, externalId: moc?.externalId ?? null };

  // API MẠNH HƠN WEBHOOK (user chốt 2026-07-27, sau khi đối chiếu đơn `584110837587871182` trên
  // TikTok Seller: phí thật 5.839đ khớp bản API, bản webhook ghi 16.000đ là số tạm). Nên khi bản
  // API đang có field mapping mà sự kiện webhook KHÔNG mang, ta NHƯỜNG — vì transform ghi đè cả
  // dòng (`updateMany` với trọn `data` ở `pancake-upsert.ts`), field vắng sẽ thành null/0 và XOÁ mất
  // số API đã có.
  // Ca thật đã đo: đơn `585179421329622462` có `customer.name` bên API nhưng payload webhook
  // vắng hẳn khoá `customer` ⇒ để nó ghi là mất tên khách.
  const thieu = [
    ...(moc.thieuField ?? []),
    ...(moc.matFieldLong ?? []).map((k) => `advanced_platform_fee.${k}`),
  ];
  if (thieu.length > 0) {
    return {
      cuHon: true,
      externalId: moc.externalId,
      note: `nhường bản API: sự kiện thiếu ${thieu.join(", ")} mà bản API đang có (ghi đè sẽ xoá mất)`,
    };
  }

  // Thiếu mốc ở một trong hai bên → không so được. Giữ hành vi cũ (land) nhưng NÓI RA, để nếu
  // Pancake bỏ field `updated_at` thì thấy ngay chứ không âm thầm mất guard.
  if (!moc.updatedAtMoi) {
    return { cuHon: false, externalId: moc.externalId, note: "không so được thứ tự: sự kiện thiếu updated_at" };
  }

  const tMoi = parseVnDate(moc.updatedAtMoi).getTime();
  const tCu = parseVnDate(moc.updatedAtCu).getTime();
  if (Number.isNaN(tMoi) || Number.isNaN(tCu)) {
    return { cuHon: false, externalId: moc.externalId, note: "không so được thứ tự: updated_at sai định dạng" };
  }

  // CHỈ land khi MỚI HƠN THẬT SỰ. Bản cùng mốc cũng bị chặn (`<=`), vì `updated_at` KHÔNG phải
  // số phiên bản đáng tin: đo 2026-07-27 trên 63 đơn có mặt cả hai nguồn, có 2 đơn mà Pancake sửa
  // phí sàn lúc ĐỐI SOÁT nhưng GIỮ NGUYÊN mốc — `584110837587871182` fee 16.000 → 5.839 kèm
  // `returned_fee` xuất hiện, `updated_at` không đổi một ký tự. Nếu cho bản cùng mốc đi tiếp thì
  // sự kiện webhook cũ sẽ đè mất số đã đối soát mà không cách nào tự lành.
  //
  // Bỏ qua bản cùng mốc KHÔNG mất gì: payload webhook là TẬP CON của payload API ở mọi field
  // mapping (đo: 61/63 đơn cùng mốc cho ra cột Silver y hệt, khoá duy nhất thiếu là
  // `is_abandoned_order` — app không dùng). Nói cách khác webhook chỉ đáng land khi nó mang một
  // phiên bản MỚI HƠN; cùng phiên bản thì nó không thêm thông tin nào.
  if (tMoi <= tCu) {
    return {
      cuHon: true,
      externalId: moc.externalId,
      note: `sự kiện chụp lúc ${moc.updatedAtMoi}, Bronze đã có bản ${moc.updatedAtCu} — bỏ qua để Silver không thụt lùi`,
    };
  }
  return { cuHon: false, externalId: moc.externalId };
}

/** Cửa sổ cho transaction "guard thứ tự + land" — chỉ 1 truy vấn đọc + 1 INSERT nên rất rộng rãi. */
const TIMEOUT_LAND_MS = 20_000;

/**
 * Đơn hàng webhook → đường Bronze/Silver Y HỆT trang API: bọc TEXT `{"data":[…]}` bằng NỐI CHUỖI
 * (không parse — int64 giữ nguyên byte) rồi `landRaw("orders")` + `transformFromRaw` theo landedIds.
 * Tái dùng nguyên guard land (mảng, khoá, dedupe hash) + mirror-filter + mapping + upsert.
 *
 * GUARD THỨ TỰ + LAND nằm trong MỘT transaction có khoá tư vấn (`giuKhoaLandDon`): tách rời hai
 * bước này là để hở đúng khe mà bản cũ chen vào sau bản mới (xem `khoa-land-don.ts`).
 *
 * Transform CỐ Ý nằm NGOÀI transaction — giữ khoá suốt cả bước upsert Silver thì mọi webhook sau
 * phải xếp hàng chờ. Thứ tự GHI SILVER được bảo đảm bằng cơ chế khác, không phải bằng khoá này:
 * `Order.rawFetchedAt` là số phiên bản và điều kiện so sánh nằm trong chính câu UPDATE, nên hai
 * lượt transform của cùng một đơn chạy so le vẫn không thể để bản cũ đè bản mới. Tóm lại: khoá tư
 * vấn giữ đúng thứ tự LAND (kho thô), `rawFetchedAt` giữ đúng thứ tự GHI (Silver).
 */
async function xuLyDonHang(shopId: string, payload: string): Promise<KetQuaXuLy> {
  const lechShop = await kiemShopIdTrongPayload(shopId, payload);
  if (lechShop) return lechShop;

  // Cờ backlog đọc MỘT LẦN, dùng cho mọi nhánh "không dựng lại Silver" bên dưới: khi nó bật thì
  // Silver CHƯA đuổi kịp Bronze (đợt BRONZE_ONLY hoặc transform lỗi trước đó), nên bất kỳ kết cục
  // "không làm gì thêm" nào cũng phải KÊU chứ không được trả màu xanh.
  const coBacklog = await hasBronzeBacklog();
  const nhacRebuild = "CÓ backlog Bronze — chạy `npx tsx scripts/rebuild-from-raw.ts`";

  const envelope = `{"data":[${payload}]}`;
  // Resolve whitelist shop TRƯỚC khi mở transaction giữ khoá tư vấn — landRaw tự tra `Setting`
  // bên trong transaction là xin kết nối thứ hai trong lúc mọi đường land đang xếp hàng cùng
  // khoá (xem ghi chú ở tham số `shopIdsHopLe` của landRaw). boQuaCache vì đường webhook GHI
  // shopId vào Bronze — cache cũ 60s sau khi đổi id là dòng mồ côi (xem layCauHinhShop).
  const shopIdsHopLe = await shopIdsChoVai(BRONZE_STREAMS.orders.shops ?? [], { boQuaCache: true });
  const { thuTu, landed, landedIds, seenIds } = await prisma.$transaction(
    async (tx) => {
      await giuKhoaLandDon(tx);
      const thuTuTx = await laSuKienCuHon(shopId, payload, tx);
      if (thuTuTx.cuHon) {
        return { thuTu: thuTuTx, landed: 0, landedIds: [] as string[], seenIds: [] as string[] };
      }
      const r = await landRaw("orders", shopId, envelope, undefined, tx, shopIdsHopLe);
      return { thuTu: thuTuTx, landed: r.landed, landedIds: r.landedIds, seenIds: r.seenIds };
    },
    { timeout: TIMEOUT_LAND_MS }
  );

  if (thuTu.cuHon) {
    // Guard đã chặn ĐÚNG: payload này KHÔNG được land, luật "API mạnh hơn webhook" giữ nguyên.
    //
    // Nhưng trước khi thoát phải hỏi thêm một câu: bản Bronze MỚI NHẤT của chính đơn này đã dựng
    // Silver xong chưa? Nếu lượt trước chết giữa "Bronze đã commit" và "Silver ghi xong" thì sự
    // kiện gửi lại sau đó mang đúng `updated_at` cũ ⇒ guard kết luận "cũ hơn" ⇒ hàm thoát ngay tại
    // đây và đơn kẹt vĩnh viễn, đúng cái mà cột kết cục sinh ra để chặn.
    //
    // Dựng lại BẢN BRONZE MỚI NHẤT (qua `externalIds`, transform tự chọn bản `fetchedAt` mới nhất),
    // TUYỆT ĐỐI không dựng payload đang bị chặn — nếu không thì đây thành cửa sau để webhook cũ đè
    // lên số API đã đối soát, tức phá chính luật guard vừa bảo vệ.
    const conDo = thuTu.externalId ? await locDonChuaDongDau(shopId, [thuTu.externalId]) : [];
    if (conDo.length > 0) {
      // Công tắc chỉ-land đang bật: KHÔNG được dựng Silver (chạy transform lúc này là lách công
      // tắc). Nhưng cũng KHÔNG được trả về như một sự kiện cũ bình thường — ta vừa nhìn thấy một
      // dòng chưa hoàn tất. Bật cờ để lượt sau biết còn nợ, và nói đúng tên trạng thái.
      if (isBronzeOnly()) {
        await markBronzeBacklog();
        return {
          processedAs: "bronze-only",
          note: catNote(`còn bản Bronze chưa dựng Silver (chờ rebuild) · ${thuTu.note}`),
        };
      }
      const warnings: string[] = [];
      try {
        const stats = await transformFromRaw("orders", warnings, { externalIds: conDo, shopId });
        // Đi qua CHÍNH sách hậu-transform dùng chung: nhánh này từng trả `don-hang` ngay khi đủ số
        // hạch toán, nuốt mất cảnh báo mã trạng thái lạ.
        return chotKetCucSauTransform(
          stats,
          conDo.length,
          warnings,
          `dựng nốt bản Bronze còn dở của đơn này (sự kiện bị bỏ qua: ${thuTu.note})`
        );
      } catch (err) {
        await markBronzeBacklog();
        const msg = err instanceof Error ? err.message : String(err);
        return { processedAs: "loi", note: catNote(`dựng nốt bản còn dở lỗi (đã bật backlog): ${msg}`) };
      }
    }
    return coBacklog
      ? { processedAs: "don-hang-can-xem", note: catNote(`${thuTu.note} · ${nhacRebuild}`) }
      : { processedAs: "don-hang-cu-hon", note: catNote(thuTu.note) };
  }

  // Đơn của sự kiện này mà bản mới nhất trong Bronze CHƯA đóng dấu kết cục — phải dựng nốt.
  // Đường webhook có ĐÚNG cùng khe với `/api/ingest/raw`: land trong transaction, transform ở
  // ngoài. Chết giữa hai bước thì sự kiện SAU của cùng đơn sẽ trùng hash và rơi vào nhánh
  // `landed === 0` ngay dưới — trả `don-hang` màu xanh trong khi đơn vẫn kẹt.
  //
  // CHỈ hỏi id THẤY MÀ KHÔNG VỪA LAND: dòng vừa insert luôn mang trạng thái "chưa đóng dấu" nên
  // hỏi cả chúng thì sự kiện nào cũng bị kể là còn dở.
  const landedSet = new Set(landedIds);
  const donChuaXong = await locDonChuaDongDau(
    shopId,
    seenIds.filter((id) => !landedSet.has(id))
  );

  if (landed === 0 && donChuaXong.length === 0) {
    // Trùng hash: bản Y HỆT đã nằm trong Bronze VÀ đã dựng xong Silver. Chỉ tới được đây khi guard
    // không so được thứ tự (sự kiện thiếu `updated_at`) — bình thường guard đã chặn từ trước.
    if (coBacklog) return { processedAs: "don-hang-can-xem", note: `trùng hash nhưng ${nhacRebuild}` };
    return { processedAs: "don-hang", note: "trùng hash — bản y hệt đã có trong Bronze" };
  }

  if (isBronzeOnly()) {
    await markBronzeBacklog();
    return { processedAs: "bronze-only", note: "đã land Bronze, CHƯA dựng Silver (chờ rebuild)" };
  }

  const canDung = [...new Set([...landedIds, ...donChuaXong])];
  const warnings: string[] = [];
  let stats;
  try {
    stats = await transformFromRaw("orders", warnings, { externalIds: canDung, shopId });
  } catch (err) {
    // Bronze đã COMMIT nhưng Silver dựng LỖI — bật backlog để rebuild vét lại (retry cùng payload
    // sẽ trùng hash → transform 0 dòng → không cờ này thì đơn kẹt ngoài Silver trong im lặng).
    await markBronzeBacklog();
    const msg = err instanceof Error ? err.message : String(err);
    return { processedAs: "loi", note: catNote(`transform lỗi (đã bật backlog): ${msg}`) };
  }

  return chotKetCucSauTransform(stats, canDung.length, warnings, thuTu.note);
}

/**
 * CHÍNH SÁCH HẬU-TRANSFORM của đường webhook — MỘT bản duy nhất.
 *
 * Mọi nhánh chạy transform (lượt thường VÀ lượt dựng nốt phần còn dở khi guard chặn sự kiện) đều
 * PHẢI đi qua đây. Viết bản thứ hai cho nhánh mới là cách chắc chắn nhất để một tín hiệu vận hành
 * biến mất: đúng chuyện đã xảy ra — nhánh tự chữa trả `don-hang` ngay khi đủ số hạch toán, nên
 * cảnh báo "mã trạng thái Pancake lạ" (đơn bị loại khỏi doanh thu) im lặng biến mất.
 *
 * Thứ tự CÓ Ý NGHĨA, không đảo được:
 *  ① đối soát số lượng — hỏng ở đây là có dòng chưa vào Silver, nặng nhất, phải bật cờ;
 *  ② mã trạng thái lạ — dữ liệu VÀO được Silver nhưng bị loại khỏi doanh thu, phải kêu;
 *  ③ mirror — bị loại CÓ CHỦ ĐÍCH, là kết cục đúng;
 *  ④ còn lại — thành công.
 */
async function chotKetCucSauTransform(
  stats: TransformStats,
  soCanDung: number,
  warnings: string[],
  ghiChuThem?: string
): Promise<KetQuaXuLy> {
  // ① Đối soát land vs hạch toán (CÙNG công thức với /api/ingest/raw — xem `doi-soat-hach-toan.ts`):
  // 1 sự kiện = 1 đơn, đơn đã land PHẢI hoặc vào Silver hoặc bị loại mirror CÓ CHỦ ĐÍCH. Rơi ra
  // ngoài = hỏng shape → kẹt. `ordersSkippedStale` cũng tính là đã hạch toán: Silver giữ bản MỚI HƠN
  // của chính đơn này (một sự kiện khác đã ghi trước) — kết cục ĐÚNG, không được tô đỏ panel như lỗi.
  //
  // Số KỲ VỌNG là tập ĐÃ YÊU CẦU DỰNG, không phải riêng `landed`: lượt tự chữa có `landed = 0`
  // nhưng vẫn đang dựng lại một đơn còn dở, nên so theo `landed` thành `0 > 0` — cổng im lặng
  // đúng lúc lượt cứu chữa thất bại lần nữa, và hàm còn trả `don-hang` màu xanh.
  if (soCanDung > demDaHachToan(stats)) {
    await markBronzeBacklog();
    return {
      processedAs: "loi",
      note: catNote(
        `đã land nhưng không hạch toán được (hỏng shape? đã bật backlog). ${warnings.join("; ")}`
      ),
    };
  }

  // ② Mã trạng thái Pancake LẠ ⇒ mapStatus trả CANCELLED ⇒ đơn bị LOẠI khỏi doanh thu. Đường
  // /api/ingest/raw hiển thị tín hiệu này qua SyncLog; đường webhook không ghi SyncLog nên phải
  // tự đẩy lên panel, nếu không là mất doanh thu âm thầm khi Pancake thêm mã mới.
  if (stats.unknownStatusOrders > 0) {
    return {
      processedAs: "don-hang-can-xem",
      note: catNote(`mã trạng thái Pancake lạ → đơn bị loại khỏi doanh thu. ${warnings.join("; ")}`),
    };
  }

  // ③ Mirror kho — cố ý không vào Silver (bất biến #2).
  if (stats.ordersSkippedMirror > 0) {
    return { processedAs: "don-hang", note: "mirror kho — cố ý không vào Silver (bất biến #2)" };
  }

  // ③b Đơn vừa bị "Xóa dữ liệu giao dịch" đóng DISCARDED giữa khe land→transform — kết cục CÓ CHỦ
  // ĐÍCH (lượt ghi đã cuộn lại, không hồi sinh). Đã tính đã-hạch-toán ở cổng ① nên không tô đỏ;
  // ghi chú rõ để người xem panel không tưởng sự kiện bị nuốt.
  if (stats.ordersDiscardedGiuaChung > 0) {
    return {
      processedAs: "don-hang",
      note: "đơn đã bị xoá tay giữa chừng (DISCARDED) — không dựng lại, đúng ý lượt xoá",
    };
  }

  const ghiChu = [ghiChuThem, warnings.join("; ")].filter(Boolean).join(" · ");
  return { processedAs: "don-hang", note: catNote(ghiChu || undefined) };
}

/**
 * Đơn Pancake mang sẵn `shop_id` (đo: khớp endpoint 321/321). Lệch = URL webhook trong Pancake bị
 * điền nhầm shop. Bronze là APPEND-ONLY: land nhầm shopId là nằm vĩnh viễn, và còn tách đôi chuỗi
 * phiên bản của đơn (guard thứ tự lọc theo shopId) làm mọi đối soát về sau lệch. Chặn NGAY tại cửa —
 * cùng tinh thần guard shopId của `landRaw`. Không mất dữ liệu: hộp thư giữ raw, nightly API vét bù.
 */
async function kiemShopIdTrongPayload(shopId: string, payload: string): Promise<KetQuaXuLy | null> {
  const [r] = await prisma.$queryRawUnsafe<{ shopIdPayload: string | null }[]>(
    `SELECT ($1::jsonb)->>'shop_id' AS "shopIdPayload"`,
    payload,
  );
  const trongPayload = r?.shopIdPayload;
  if (!trongPayload || trongPayload === shopId) return null;
  return {
    processedAs: "khong-nhan-dien",
    note: `shop_id trong đơn (${trongPayload}) khác endpoint (${shopId}) — kiểm URL webhook trong Pancake`,
  };
}
