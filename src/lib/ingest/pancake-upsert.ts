import { Prisma } from "@prisma/client";

import { dongDauKetCuc, dongDauKetCucBoiLuotTay, KET_CUC, KetCucDaXoaTay } from "@/lib/bronze/ket-cuc-silver";
import { prisma } from "@/lib/prisma";

import { ghepVariantThuCong } from "./ghep-variant-thu-cong";
import { laLoiHeThong } from "./loi-he-thong";

import { mapPancakeProduct, type MappedOrder } from "./pancake-mapping";

/**
 * Kết cục một lượt ghi đơn — nguồn để đóng dấu `RawPancakeOrder.silverOutcome`.
 * `CHAN` (đơn khác cùng kênh+mã) và `LOI` không có giá trị enum tương ứng: `CHAN` chỉ xảy ra ở
 * script bù đơn (không đi qua transform), còn `LOI` cố ý để dòng ở lại "chưa xong" để retry.
 */
export type KetCucGhiDon = "APPLIED" | "SUPERSEDED" | "CHAN" | "LOI" | "DISCARDED";

/**
 * Lỗi HỆ THỐNG lọt ra từ lượt ghi một đơn — người gọi PHẢI coi cả lô là không đáng tin.
 *
 * Không nuốt nó thành "đơn này hỏng": lượt đối soát đêm đếm lượt thử theo từng dòng và đủ số lượt
 * thì chôn dòng vĩnh viễn. Một sự cố hệ thống (thiếu dữ liệu tham chiếu, mất kết nối, cạn pool)
 * dính vào MỌI đơn, nên nuốt nó là sau vài đêm toàn bộ đơn bị chôn.
 */
export class LoiHeThongKhiGhiDon extends Error {
  constructor(
    public readonly pancakeId: string,
    cause: unknown
  ) {
    super(`Lỗi hệ thống khi ghi đơn ${pancakeId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LoiHeThongKhiGhiDon";
  }
}
import type { PancakeProduct } from "./pancake-schemas";
/** Chọn hàm đóng dấu theo quyền hạn của lượt đang chạy. */
const dauKetCuc = (opts?: { luotTayDuocGhiDe?: boolean }) =>
  opts?.luotTayDuocGhiDe ? dongDauKetCucBoiLuotTay : dongDauKetCuc;


export type UpsertStats = {
  productsUpserted: number;
  variantsUpserted: number;
  ordersUpserted: number;
  ordersSkippedMirror: number; // đơn mirror shop kho bị loại (chống đếm 2 lần)
  /**
   * Đơn KHÔNG ghi vì Silver đang giữ bản MỚI HƠN (xem `Order.rawFetchedAt`). Phải là bộ đếm RIÊNG,
   * KHÔNG gộp vào `skipped`: `skipped` mang nghĩa cố định "đã land nhưng KHÔNG vào Silver = mất dòng
   * thật" và bị hai cổng đối soát CỐ Ý loại khỏi phần đã-hạch-toán (luật ING-H1). Nhét ca này vào đó
   * sẽ bật cờ backlog + trả kết cục `loi` cho một kết cục ĐÚNG — báo động giả dai dẳng, mà đường
   * chữa duy nhất (chạy `rebuild-from-raw.ts`) lại kéo tồn kho realtime lùi về ảnh ban đêm.
   */
  ordersSkippedStale: number;
  /**
   * Đơn KHÔNG ghi vì dòng Bronze vừa bị "Xóa dữ liệu giao dịch" đóng `DISCARDED` GIỮA khe
   * land→transform (xoá chạy song song với ingest/webhook). Kết cục CÓ CHỦ ĐÍCH: lượt ghi Silver đã
   * cuộn lại (không hồi sinh thứ vừa xoá) và dòng đã có số phận rõ ràng.
   *
   * Phải là bộ đếm RIÊNG và được `demDaHachToan` tính là ĐÃ hạch toán — nhét vào `skipped` là cổng
   * đối soát lệch ⇒ bật cờ backlog GIẢ dính (chỉ rebuild hạ được, mà rebuild TAY ghi đè DISCARDED
   * lại hồi sinh đúng đơn vừa cố ý xoá). Cùng họ lý do với `ordersSkippedStale`/`boQuaCoChuDich`.
   */
  ordersDiscardedGiuaChung: number;
  skipped: number; // record lỗi shape/upsert
  /**
   * Dòng KHÔNG ghi vì kết cục ĐÚNG Ý CHỦ SHOP, không phải hỏng hóc: ngày chủ shop đã ghi đè bằng
   * file import, hoặc khoá `refId` đang thuộc một khoản chi phí nhập tay (xem `upsertOneAdsExpense`).
   *
   * Phải là bộ đếm RIÊNG, KHÔNG gộp vào `skipped`: `skipped` mang nghĩa cố định "đã land nhưng KHÔNG
   * vào Silver = MẤT DÒNG THẬT", và nay có cổng hạ cờ backlog soi đúng điều kiện `skipped === 0`.
   * Gộp chung thì chỉ cần chủ shop import file ads ghi đè MỘT lần là mọi lượt dựng lại về sau đều có
   * `skipped > 0` vĩnh viễn ⇒ cờ backlog không bao giờ hạ được, banner đỏ dính mãi rồi bị bỏ qua.
   */
  boQuaCoChuDich: number;
  unknownStatusOrders: number; // đơn có MÃ TRẠNG THÁI LẠ (→ CANCELLED) — cảnh báo UI, có thể mất doanh thu
  settlementsUpserted: number; // Silver TiktokSettlement (Phase 2)
  adsUpserted: number; // Silver TiktokAdsSettlement (ads TikTok trừ)
  paymentsUpserted: number; // Silver TiktokPayment (lệnh rút bank)
  shopeeUpserted: number; // Silver ShopeeSettlement (ví Shopee import tay)
  adsExpensesUpserted: number; // Expense source=ADS_API dựng lại từ báo cáo ads trong kho thô
};

const now = () => new Date();

/**
 * Ghi 1 PRODUCT (đã parse zod) vào Silver — nguồn: shop KHO (có giá vốn).
 *
 * - `Variant.costPrice` prefill từ kho `average_imported_price` CHỈ khi CREATE.
 *   UPDATE TUYỆT ĐỐI KHÔNG đụng `costPrice`/`lowStockThreshold` (APP-OWNED — chủ shop sửa tay).
 * - Product + variants trong CÙNG `$transaction` → chạy lại không nhân đôi.
 * - Lỗi 1 product chỉ `skipped++` + warning, KHÔNG giết batch.
 */
export async function upsertOneProduct(
  raw: PancakeProduct,
  stats: UpsertStats,
  warnings: string[]
): Promise<void> {
  const mp = mapPancakeProduct(raw);
  try {
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.upsert({
        where: { pancakeId: mp.pancakeId },
        create: {
          pancakeId: mp.pancakeId,
          name: mp.name,
          code: mp.code,
          categoryName: mp.categoryName,
          imageUrl: mp.imageUrl,
          status: mp.status,
          syncedAt: now(),
        },
        update: {
          name: mp.name,
          code: mp.code,
          categoryName: mp.categoryName,
          imageUrl: mp.imageUrl,
          status: mp.status,
          syncedAt: now(),
        },
      });
      for (const v of mp.variants) {
        await tx.variant.upsert({
          where: { pancakeId: v.pancakeId },
          // CREATE: prefill costPrice từ kho average_imported_price (APP-OWNED sau đó).
          create: {
            pancakeId: v.pancakeId,
            productId: product.id,
            sku: v.sku,
            label: v.label,
            sellPrice: v.sellPrice,
            stock: v.stock,
            costPrice: v.costPrice,
            syncedAt: now(),
          },
          // UPDATE: TUYỆT ĐỐI KHÔNG đụng costPrice / lowStockThreshold (APP-OWNED).
          update: {
            productId: product.id,
            sku: v.sku,
            label: v.label,
            sellPrice: v.sellPrice,
            stock: v.stock,
            syncedAt: now(),
          },
        });
        stats.variantsUpserted++;
      }
    });
    stats.productsUpserted++;
  } catch (e) {
    warnings.push(`Bỏ qua product ${mp.pancakeId}: ${e instanceof Error ? e.message : String(e)}`);
    stats.skipped++;
  }
}

/**
 * Ghi 1 ORDER (đã map) vào Silver. Đơn MIRROR đã bị loại TRƯỚC khi gọi (invariant #2).
 *
 * - Item tra `Variant` theo `variation_id` (thường miss cross-shop) rồi theo **SKU**.
 * - Upsert đơn + xoá-tạo-lại items trong CÙNG `$transaction` → chạy lại không nhân đôi.
 * - `raw` được lưu nguyên vào `Order.raw` (tham chiếu; nguồn sự thật vẫn là bảng Bronze).
 */
export async function upsertOneOrder(
  mo: MappedOrder,
  raw: unknown,
  stats: UpsertStats,
  warnings: string[],
  /**
   * `fetchedAt` của dòng kho thô sinh ra bản này = SỐ PHIÊN BẢN. Bỏ trống ⇒ ghi vô điều kiện
   * (giữ nguyên hành vi cũ cho các đường gọi chưa có mốc, vd test mapping).
   */
  mocNguon?: Date,
  opts?: {
    /**
     * Đơn BÙ từ bản sao kho (`scripts/bu-don-shopee-tu-don-kho.ts`): gắn cờ NGAY TRONG transaction
     * upsert để cờ và đơn không bao giờ tách rời — cờ false trên đơn bù làm rebuild khuyên xoá tay
     * đúng doanh thu thật. Đường sync/webhook thường KHÔNG truyền ⇒ cột không bị đụng.
     */
    backfilledFromMirror?: boolean;
    /**
     * CHẶN GHI khi đã có đơn KHÁC (khác `pancakeId`) cùng (channelId, code) — kiểm TRONG chính
     * transaction ghi, SAU khoá tư vấn theo (kênh, mã) mà mọi lượt ghi đơn đều giữ: hai đường ghi
     * cùng (kênh, mã) tuần tự hoá, nên "sync chen đơn gốc vào giữa kiểm-và-ghi" không còn khe.
     * Bị chặn: KHÔNG ghi gì, `boQuaCoChuDich`++ + warning. Chỉ script bù đơn truyền; đường
     * sync/webhook không truyền ⇒ hành vi y nguyên. Ca "đơn gốc quay lại NHIỀU NGÀY SAU khi đơn
     * bù đã ghi" thì không lượt kiểm ghi nào đỡ được — audit cuối lượt script + guard trong
     * `rebuild.ts#warnStuckSilverOrders` trực phần đó.
     */
    chanKhiCoDonKhacCungKenhMa?: boolean;
    /**
     * `id` dòng `RawPancakeOrder` đã dựng nên bản này. Có thì kết cục `APPLIED`/`SUPERSEDED` được
     * đóng dấu NGAY TRONG transaction ghi Silver (xem `dongDauKetCuc`) — hai thứ cùng sống hoặc
     * cùng chết. Bỏ trống (test mapping, script bù đơn) ⇒ không đóng dấu gì.
     */
    rawRowId?: string;
    /** Lượt dựng lại TAY được ghi đè kết cục cũ (xem `transformFromRaw`). */
    luotTayDuocGhiDe?: boolean;
  }
): Promise<KetCucGhiDon> {
  try {
    const varIds = [...new Set(mo.items.map((i) => i.variationPancakeId).filter((x): x is string => !!x))];
    /**
     * Ghép biến thể THỦ CÔNG — nhánh CUỐI, chỉ xét dòng mà Pancake KHÔNG trả khoá nào
     * (`variation_id` và `display_id` cùng vắng, ca `one_time_product`). Tính TRƯỚC lượt tra
     * biến thể để nạp luôn `Variant.pancakeId` cần thiết trong CÙNG một truy vấn — không đẻ truy
     * vấn thứ hai, và không đổi hành vi của dòng bình thường.
     * `map` (KHÔNG `filter`) để chỉ số luôn khớp 1-1 với `mo.items`: lệch pha là dán biến thể
     * sang NHẦM DÒNG của cùng đơn — đơn nhiều dòng mất khoá có thật trong dữ liệu prod.
     * Phạm vi + căn cứ từng dòng: `ghep-variant-thu-cong.ts`.
     */
    const ghepTayTheoDong = mo.items.map((it) =>
      it.variationPancakeId || it.sku
        ? undefined
        : ghepVariantThuCong({
            pancakeId: mo.pancakeId,
            productName: it.productName,
            variantDetail: it.variantDetail,
          })
    );
    const skus = [...new Set(mo.items.map((i) => i.sku).filter((s) => s.length > 0))];
    const varIdsCanTra = [
      ...new Set([...varIds, ...ghepTayTheoDong.filter((g) => !!g).map((g) => g!.variantPancakeId)]),
    ];
    const rows =
      varIdsCanTra.length || skus.length
        ? await prisma.variant.findMany({
            where: {
              OR: [
                ...(varIdsCanTra.length ? [{ pancakeId: { in: varIdsCanTra } }] : []),
                ...(skus.length ? [{ sku: { in: skus } }] : []),
              ],
            },
            // `label` + `product.pancakeId` CHỈ để đối chứng bảng ghép tay — không dùng việc gì khác.
            select: {
              id: true,
              pancakeId: true,
              sku: true,
              label: true,
              costPrice: true,
              product: { select: { pancakeId: true } },
            },
            // LUẬT CHỌN khi một SKU có NHIỀU biến thể (dữ liệu thật CÓ ca này): ưu tiên bản ĐÃ CÓ
            // giá vốn, hoà thì lấy `id` nhỏ nhất. Không có ORDER BY thì Postgres trả theo thứ tự
            // tuỳ lúc ⇒ COGS của cùng một đơn có thể đổi giữa hai lượt dựng lại mà không ai đụng
            // dữ liệu — lãi gộp nhảy số không giải thích được. Chọn bản có giá vốn cũng là chọn
            // phía THẬN TRỌNG cho tiền: thà tính COGS cao (lãi thấp) còn hơn coi hàng như miễn phí.
            orderBy: [{ costPrice: "desc" }, { id: "asc" }],
          })
        : [];
    const byPancakeId = new Map(rows.map((r) => [r.pancakeId, r.id]));
    const dongVariantTheoPancakeId = new Map(rows.map((r) => [r.pancakeId, r]));
    const bySku = new Map<string, string>();
    for (const r of rows) {
      if (bySku.has(r.sku)) {
        warnings.push(
          `SKU "${r.sku}" trùng nhiều variant → lấy bản có giá vốn (hoà thì id nhỏ nhất); kiểm lại dữ liệu sản phẩm`
        );
      } else {
        bySku.set(r.sku, r.id);
      }
    }

    const items = mo.items.map((it, i) => {
      const ghepTay = ghepTayTheoDong[i];
      // ĐỐI CHỨNG NHÃN: UUID còn đó nhưng đã trỏ sang hàng khác thì TỪ CHỐI ghép. Ghép bừa ở đây
      // là sửa COGS trong im lặng — thà để COGS 0 (đã có cảnh báo bên dưới) còn hơn sai số tiền.
      const dongVariantTay = ghepTay ? dongVariantTheoPancakeId.get(ghepTay.variantPancakeId) : undefined;
      // Đối chứng HAI phần: nhãn một mình không đủ (nhiều sản phẩm dùng chung nhãn phân loại),
      // nên phải khớp thêm sản phẩm chứa biến thể — chép nhầm UUID sang SP khác cùng nhãn sẽ lệch.
      const doiChungLech =
        !!dongVariantTay &&
        (dongVariantTay.label !== ghepTay!.nhanBienThe ||
          dongVariantTay.product.pancakeId !== ghepTay!.sanPhamPancakeId);
      const variantId =
        (it.variationPancakeId ? byPancakeId.get(it.variationPancakeId) : undefined) ??
        (it.sku ? bySku.get(it.sku) : undefined) ??
        // Nhánh CUỐI: chỉ chạm tới khi hai khoá Pancake đều trượt (ghepTay chỉ khác undefined khi đó).
        (dongVariantTay && !doiChungLech ? dongVariantTay.id : undefined) ??
        null;
      // Ghi sku kho vào chính dòng hàng: `OrderItem.sku` vốn để trống ở ca này (Pancake không trả
      // display_id). Đây là DẤU VẾT BỀN duy nhất đọc được bằng SQL sau khi log đã trôi, đồng thời
      // đưa dòng về đúng rổ "sửa được ở màn Sản phẩm" của P&L (pnl.ts phân rổ theo `sku`).
      // Lấy sku HIỆN HÀNH của biến thể (`dongVariantTay.sku`), KHÔNG lấy `ghepTay.skuKho`: sku bị
      // lượt ingest products ghi đè mỗi đêm, nên giá trị khai trong bảng có thể đã cũ. Ghi bản cũ
      // là dấu vết trỏ sang chỗ không còn tồn tại — đúng loại lỗi im lặng mà cả khối này né.
      // (Khoá CHỌN biến thể vẫn là `Variant.pancakeId`; `skuKho` chỉ còn để người đọc tra tay.)
      const skuGhi = ghepTay && dongVariantTay && variantId === dongVariantTay.id ? dongVariantTay.sku : it.sku;
      // Ghép tay LUÔN để lại dấu: khoản này sửa COGS nên không được im lặng sống mãi trong sổ.
      // Định danh bằng `pancakeId` chứ KHÔNG phải `code` — mã đơn có ca trùng trong cùng kênh.
      if (ghepTay && variantId) {
        warnings.push(
          `Đơn ${mo.pancakeId} (mã ${mo.code}): dòng "${it.productName}" (${it.variantDetail}) ghép biến thể THỦ CÔNG → ${ghepTay.nhanBienThe} [sku hiện hành ${skuGhi}]`
        );
      }
      // Hai ca dưới là BẢNG HỎNG, không phải "Pancake thiếu dữ liệu" — tách ra để người đọc log
      // biết phải đi sửa bảng chứ không đi tìm dữ liệu Pancake.
      if (ghepTay && !dongVariantTay) {
        warnings.push(
          `Đơn ${mo.pancakeId} (mã ${mo.code}): bảng ghép thủ công trỏ biến thể ${ghepTay.variantPancakeId} nhưng không có biến thể nào mang pancakeId đó — kiểm lại ghep-variant-thu-cong.ts`
        );
      }
      if (doiChungLech) {
        warnings.push(
          `Đơn ${mo.pancakeId} (mã ${mo.code}): TỪ CHỐI ghép thủ công — biến thể ${ghepTay!.variantPancakeId} nay mang nhãn "${dongVariantTay!.label}" thuộc sản phẩm ${dongVariantTay!.product.pancakeId}, khai trong bảng là "${ghepTay!.nhanBienThe}" / ${ghepTay!.sanPhamPancakeId}; kiểm lại ghep-variant-thu-cong.ts`
        );
      }
      if (!variantId) warnings.push(`Đơn ${mo.code}: item SKU "${it.sku}" không khớp variant`);
      return {
        variantId,
        sku: skuGhi,
        productName: it.productName,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineDiscount: it.lineDiscount,
      };
    });

    const data = {
      code: mo.code,
      channelId: mo.channelId,
      status: mo.status,
      orderedAt: mo.orderedAt,
      statusChangedAt: mo.statusChangedAt,
      customerName: mo.customerName,
      itemsTotal: mo.itemsTotal,
      shipFeeCustomer: mo.shipFeeCustomer,
      discount: mo.discount,
      platformFeeEst: mo.platformFeeEst,
      returnedFee: mo.returnedFee,
      syncedAt: now(),
      raw: (raw ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      rawFetchedAt: mocNguon ?? null,
      ...(opts?.backfilledFromMirror ? { backfilledFromMirror: true } : {}),
    };
    /**
     * Một lượt ghi. Trả `false` = KHÔNG ghi vì Silver đang giữ bản mới hơn (kết cục ĐÚNG).
     *
     * ĐIỀU KIỆN PHIÊN BẢN NẰM TRONG CHÍNH CÂU UPDATE chứ không phải "đọc rồi so rồi ghi": ở mức
     * READ COMMITTED, Postgres ĐÁNH GIÁ LẠI mệnh đề WHERE sau khi nhả khoá dòng, nên hai lượt song
     * song không thể cùng thấy "mình mới hơn". Đọc-rồi-ghi thì cả hai đều lọt.
     */
    // "chan" = precondition (kênh, mã) phát hiện đơn khác NGAY TRONG transaction → không ghi gì.
    let donKhacCungKenhMa: string | null = null;
    const ghiMotLuot = (): Promise<boolean | "chan"> =>
      prisma.$transaction(async (tx) => {
        // KHOÁ TƯ VẤN theo (kênh, mã) cho MỌI lượt ghi đơn: hai transaction khác `pancakeId` nhưng
        // cùng (kênh, mã) — script bù kiểm-rồi-ghi vs sync/webhook chen đơn gốc — phải TUẦN TỰ
        // HOÁ, nếu không thì ở READ COMMITTED vẫn tái hiện được "script đọc 'chưa có' → ingest
        // commit đơn gốc → đơn bù vẫn commit" = đếm đôi. Khoá băm theo khoá chữ nên (kênh, mã)
        // khác nhau không chờ nhau; trùng băm chỉ over-serialize vô hại; `_xact_lock` tự nhả khi
        // transaction kết thúc. `$executeRaw` chứ KHÔNG `$queryRaw` — hàm trả `void`, `$queryRaw`
        // ném "Failed to deserialize column" (cùng lý do với `khoa-ghi-chi-tieu-ads.ts`).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`don:${mo.channelId}|${mo.code}`}, 0))`;
        if (opts?.chanKhiCoDonKhacCungKenhMa) {
          const khac = await tx.order.findFirst({
            where: { channelId: mo.channelId, code: mo.code, NOT: { pancakeId: mo.pancakeId } },
            select: { pancakeId: true },
          });
          if (khac) {
            donKhacCungKenhMa = khac.pancakeId;
            return "chan";
          }
        }
        // `lte` (nhận mốc BẰNG NHAU) là BẮT BUỘC, không phải lỏng tay: đường dựng lại từ kho thô
        // đọc lại đúng `fetchedAt` cũ của dòng Bronze rồi truyền vào đây làm mốc nguồn, nên nếu đòi
        // "phải mới hơn thật" thì mọi lượt dựng lại bị từ chối sạch (đúng lượt cứu dữ liệu).
        // Đánh đổi đã chấp nhận: hai bản KHÁC nhau của cùng một đơn mà trùng mốc tới mili-giây thì
        // bản tới sau thắng. Không xảy ra trong thực tế — hai lượt land của cùng một đơn bị khoá tư
        // vấn tuần tự hoá (giữa chúng luôn có ≥1 COMMIT có fsync + nhiều round-trip DB), còn hai bản
        // trong CÙNG một trang API thì đến từ MỘT lần chụp nên không có khái niệm cũ/mới.
        const dieuKienMoiHon: Prisma.OrderWhereInput = mocNguon
          ? { OR: [{ rawFetchedAt: null }, { rawFetchedAt: { lte: mocNguon } }] }
          : {};
        const sua = await tx.order.updateMany({
          where: { pancakeId: mo.pancakeId, ...dieuKienMoiHon },
          data,
        });

        if (sua.count === 0) {
          // Không sửa được: hoặc đơn CHƯA có (→ tạo), hoặc Silver đang giữ bản MỚI HƠN (→ bỏ qua).
          const dangCo = await tx.order.findUnique({
            where: { pancakeId: mo.pancakeId },
            select: { id: true },
          });
          if (dangCo) {
            // Bản cũ tới muộn — KHÔNG được đè. Đây CHÍNH LÀ kết cục `SUPERSEDED`, và nó phân biệt
            // sạch với mọi lỗi khác: điều kiện phiên bản nằm trong chính câu UPDATE nên "0 dòng
            // khớp + đơn đang tồn tại" chỉ có đúng một nghĩa; hỏng hóc khác đều NÉM ra ngoài.
            if (opts?.rawRowId) await dauKetCuc(opts)(tx, opts.rawRowId, KET_CUC.SUPERSEDED);
            return false;
          }
          await tx.order.create({ data: { pancakeId: mo.pancakeId, ...data } });
        }

        const order = await tx.order.findUniqueOrThrow({
          where: { pancakeId: mo.pancakeId },
          select: { id: true },
        });
        await tx.orderItem.deleteMany({ where: { orderId: order.id } });
        if (items.length) {
          await tx.orderItem.createMany({ data: items.map((it) => ({ ...it, orderId: order.id })) });
        }
        // Dấu "đã hạch toán" đi CÙNG lượt ghi Silver, không phải sau — hai thứ tách transaction
        // thì luôn còn một khe để tiến trình chết vào giữa.
        if (opts?.rawRowId) await dauKetCuc(opts)(tx, opts.rawRowId, KET_CUC.APPLIED);
        return true;
      });

    // ĐƠN LẦN ĐẦU + hai lượt song song: cả hai thấy "chưa có" rồi cùng `create`, lượt sau đụng khoá
    // duy nhất `pancakeId` (P2002). Lỗi trong transaction Postgres làm ABORT cả transaction nên
    // KHÔNG thể chữa tại chỗ — phải chạy lại TỪ ĐẦU đúng một lần. Lượt chạy lại thấy đơn đã tồn tại
    // nên đi nhánh `updateMany` có điều kiện phiên bản, tức bản MỚI vẫn thắng đúng luật.
    // Không có bước này thì lượt thua bị ném ra ngoài thành "Bỏ qua đơn" — và nếu nó cầm bản mới
    // (phí sàn thật, trạng thái RETURNED) thì Silver giữ số cũ, đúng cái bất biến #1 phải bảo vệ.
    let daGhi: boolean | "chan";
    try {
      daGhi = await ghiMotLuot();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        daGhi = await ghiMotLuot();
      } else {
        throw e;
      }
    }

    if (daGhi === "chan") {
      // Không phải lỗi dữ liệu (`skipped`) cũng không phải bản cũ (`ordersSkippedStale`) — đơn bị
      // CHẶN CHỦ ĐÍCH vì đơn khác cùng (kênh, mã) đã tồn tại (thường là đơn gốc vừa quay lại).
      warnings.push(
        `Bỏ qua đơn ${mo.pancakeId}: đã có đơn khác cùng (${mo.channelId}, mã ${mo.code}) — pancakeId ${donKhacCungKenhMa}`
      );
      stats.boQuaCoChuDich++;
      return "CHAN";
    }
    if (!daGhi) {
      // Bộ đếm RIÊNG, không phải `skipped` — xem ghi chú ở `UpsertStats.ordersSkippedStale`.
      stats.ordersSkippedStale++;
      return "SUPERSEDED";
    }
    stats.ordersUpserted++;
    return "APPLIED";
  } catch (e) {
    // Dòng vừa bị "Xóa dữ liệu giao dịch" đóng DISCARDED giữa chừng — transaction trên ĐÃ cuộn lại
    // (đơn không hồi sinh, đúng ý chủ shop). Đây là kết cục CÓ CHỦ ĐÍCH, không phải mất dòng: đếm
    // riêng để cổng đối soát tính là đã-hạch-toán, TUYỆT ĐỐI không rơi vào `skipped` (bật backlog giả).
    if (e instanceof KetCucDaXoaTay) {
      stats.ordersDiscardedGiuaChung++;
      return "DISCARDED";
    }
    // LỖI HỆ THỐNG thì ném tiếp, KHÔNG hạ cấp thành "đơn này hỏng". Xem `LoiHeThongKhiGhiDon`:
    // nuốt nó ở đây là để lượt đối soát đếm nhầm thành lượt-thử-của-dòng, và sau vài đêm chôn sạch
    // đơn chỉ vì một sự cố hạ tầng. Ca đã đo: DB thiếu dữ liệu kênh ⇒ MỌI đơn dính khoá ngoại.
    if (laLoiHeThong(e)) throw new LoiHeThongKhiGhiDon(mo.pancakeId, e);

    warnings.push(`Bỏ qua đơn ${mo.pancakeId}: ${e instanceof Error ? e.message : String(e)}`);
    stats.skipped++;
    // KHÔNG đóng dấu: lỗi ghi của RIÊNG dòng này có thể tự lành, nên dòng phải ở lại "chưa xong"
    // để lượt đối soát đêm còn nhặt lên thử tiếp. Đóng dấu ở đây là chôn sống một đơn có tiền.
    return "LOI";
  }
}
