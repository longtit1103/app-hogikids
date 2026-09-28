import { prisma } from "@/lib/prisma";

import {
  chupCoBacklog,
  haCoBacklogNeuChuaBiBatLai,
  hasBronzeBacklog,
} from "./bronze-only";
import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { transformFromRaw, type TransformStats } from "./transform-from-raw";

/**
 * Dựng lại Silver TỪ BRONZE — KHÔNG fetch lại Pancake.
 * Dùng khi sửa mapping / thêm field / sửa luật lọc mirror.
 *
 * BẤT BIẾN: TUYỆT ĐỐI không đụng dữ liệu APP-OWNED (Pancake không có):
 *   - Variant.costPrice, Variant.lowStockThreshold  → upsert CHỈ set lúc CREATE
 *     (src/lib/ingest/pancake-upsert.ts — nhánh `update` KHÔNG có 2 field này).
 *   - Chi phí NHẬP TAY (`Expense` source MANUAL/RECURRING/IMPORT), ExpenseCategory tự tạo
 *     → KHÔNG BAO GIỜ chạm. Riêng chi tiêu quảng cáo (`source=ADS_API`) thì CÓ dựng lại: kho thô
 *     giữ nguyên bản gốc báo cáo Meta/TikTok nên dựng lại được đúng từng đồng; cổng chặn theo
 *     `source` nằm ở `upsertOneAdsExpense`.
 * Vì mọi nhánh chỉ upsert theo khoá gốc (`pancakeId` / `refId`), rebuild chạy bao nhiêu lần cũng ra
 * cùng kết quả (idempotent) và không mất công nhập giá vốn / chi phí tay của chủ shop.
 *
 * Products TRƯỚC orders: OrderItem tra Variant theo SKU để lấy giá vốn (COGS) — chưa có Variant
 * thì item mồ côi, COGS = 0.
 *
 * KHÔNG truyền `externalIds` ⇒ quét TOÀN BỘ bảng raw (khác đường per-page của /api/ingest/raw).
 *
 * CHỈ UPSERT, KHÔNG XOÁ ⇒ "sửa luật rồi dựng lại" đúng cho THÊM/SỬA, KHÔNG đúng cho XOÁ.
 * Nên cuối lượt phải PHÁT HIỆN + CẢNH BÁO đơn Silver kẹt (xem `warnStuckSilverOrders`).
 *
 * HẠ CỜ BACKLOG CÓ ĐIỀU KIỆN — 2 điều kiện, thiếu một là GIỮ cờ (xem khối ở cuối hàm).
 */
export async function rebuildFromRaw(
  warnings: string[] = [],
  /**
   * Mốc tiến độ: chủ việc gia hạn khoá việc nặng và tự kiểm còn quyền ghi không. Ném ⇒ dừng ngay.
   * Lượt này quét TOÀN BỘ bảng nên chạy hàng phút — đủ lâu để một khoá không được gia hạn hết hạn
   * và việc khác (vd xoá dữ liệu giao dịch) giành mất; ghi tiếp lúc đó là dựng lại đúng phần vừa
   * bị xoá có chủ đích.
   */
  checkpoint?: () => Promise<void>,
): Promise<TransformStats> {
  // Chụp cờ TRƯỚC dòng ghi đầu tiên (transform `products` ngay dưới): mốc trong ảnh chụp là căn cứ để
  // cuối lượt biết cờ có bị bật lại giữa chừng không. Chụp muộn hơn là tự bỏ qua đúng quãng nguy hiểm
  // nhất — lượt này quét TOÀN BỘ bảng nên chạy hàng phút.
  const anhCo = await chupCoBacklog();

  await checkpoint?.();
  const p = await transformFromRaw("products", warnings, { checkpoint });

  // Rebuild = "dựng lại Silver theo đúng dữ liệu API". Tồn kho vừa bị ghi đè bằng ảnh Bronze, nên
  // mốc `stockUpdatedAt` (lần cuối WEBHOOK ghi tồn) không còn mô tả đúng cột `stock` nữa. Giữ mốc
  // cũ lại sẽ khiến guard thứ tự của webhook so với một mốc đã mất nghĩa và chặn oan sự kiện mới.
  // Xoá = trả quyền quyết định về cho API, đúng ý nghĩa của lượt rebuild.
  //
  // Chấm mốc TRƯỚC câu ghi NGOÀI VÒNG LẶP này: chamMoc trong products chỉ bảo vệ các lượt ghi
  // TRONG vòng, còn câu updateMany đây nằm ngoài. Nếu products trả mảng rỗng (không lượt ghi nào)
  // hoặc câu nạp treo lâu hơn hạn thì không có mốc nào chạy, và ta vẫn xoá stockUpdatedAt sau khi
  // đã mất quyền — đúng thứ hàng rào sinh ra để chặn.
  await checkpoint?.();
  await prisma.variant.updateMany({
    where: { stockUpdatedAt: { not: null } },
    data: { stockUpdatedAt: null },
  });

  const rejectedOrderIds: string[] = [];
  await checkpoint?.();
  const o = await transformFromRaw("orders", warnings, {
    onRejected: (id) => rejectedOrderIds.push(id),
    checkpoint,
    // Chủ shop chủ động yêu cầu dựng lại ⇒ được ghi đè cả kết cục đã chốt (đơn từng bị xoá tay,
    // đơn đã dừng thử lại). Đây là ĐƯỜNG DUY NHẤT cứu lại được chúng.
    luotTayDuocGhiDe: true,
  });
  await warnStuckSilverOrders(rejectedOrderIds, warnings);

  // TikTok Shop settlement → Silver "Tiền đã về" (Phase 2). Độc lập P&L; quét
  // TOÀN BỘ bảng raw như products/orders. Ads dùng nhận-diện cross-version (C2).
  await checkpoint?.();
  const st = await transformFromRaw("tiktok/statements", warnings, {
    checkpoint,
  });
  await checkpoint?.();
  const ad = await transformFromRaw("tiktok/statement_transactions", warnings, {
    checkpoint,
  });
  await checkpoint?.();
  const pay = await transformFromRaw("tiktok/payments", warnings, {
    checkpoint,
  });

  // Shopee ví (import tay) → Silver "Tiền đã về" Shopee. Độc lập P&L; quét TOÀN BỘ
  // bảng raw như các Silver khác (import chồng nhiều kỳ → rebuild dựng lại đủ).
  await checkpoint?.();
  const sh = await transformFromRaw("shopee/wallet", warnings, { checkpoint });

  // Chi tiêu quảng cáo → `Expense` source=ADS_API (CHỈ dòng ads, xem `upsertOneAdsExpense`). Cờ
  // `rebuild` là điều kiện BẮT BUỘC: thiếu nó nhánh ads đứng yên (xem `TransformOptions.rebuild`).
  await checkpoint?.();
  const meta = await transformFromRaw("meta/report", warnings, {
    rebuild: true,
    checkpoint,
  });
  await checkpoint?.();
  const ttAds = await transformFromRaw("tiktokbusiness/report", warnings, {
    rebuild: true,
    checkpoint,
  });

  const skipped =
    p.skipped +
    o.skipped +
    st.skipped +
    ad.skipped +
    pay.skipped +
    sh.skipped +
    meta.skipped +
    ttAds.skipped;

  // HẠ CỜ CÓ ĐIỀU KIỆN — 2 điều kiện, thiếu một là GIỮ cờ:
  //  1. `skipped === 0`: lượt này quét TOÀN BỘ bảng raw, nên Silver chỉ thực sự đuổi kịp Bronze khi
  //     KHÔNG còn record nào kẹt lại — `skipped` = "đã nằm trong Bronze mà không vào được Silver", và
  //     dedupe theo hash chặn transform chạy lại ⇒ record đó kẹt vĩnh viễn cho tới khi mapping được
  //     sửa. Hạ cờ khi vẫn còn kẹt là tắt đúng cảnh báo đang báo THẬT, mà banner lại chỉ chủ shop
  //     chạy chính lệnh này ⇒ họ làm theo, cờ tắt, số vẫn thiếu và không còn dấu hiệu nào.
  //     (`boQuaCoChuDich` — ngày chủ shop đã ghi đè bằng file, khoá thuộc chi phí nhập tay — CỐ Ý
  //     KHÔNG vào điều kiện: đó là kết cục ĐÚNG, tính vào thì một lần import ghi đè là cờ dính
  //     vĩnh viễn.)
  //  2. Cờ CHƯA BỊ BẬT LẠI kể từ lúc lượt này bắt đầu: lượt quét cả bảng chạy HÀNG PHÚT, mà trong
  //     quãng đó webhook Pancake và `/api/ingest/raw` KHÔNG bị chặn — chúng vẫn bật cờ được cho một
  //     dòng VỪA tới mà lượt này chưa hề chữa (dòng đó land sau lượt quét, rồi dedupe theo hash chặn
  //     transform chạm lại). Điều kiện nằm TRONG câu UPDATE (xem `haCoBacklogNeuChuaBiBatLai`),
  //     không phải đọc-rồi-ghi.
  //
  // KHÔNG cần điều kiện "còn sản phẩm kho kẹt ở Bronze" (`conSanPhamKetOBronze`) như đường nút bấm:
  // lượt này CÓ chạy stream `products` trên toàn bảng, nên mọi sản phẩm kho trong kho thô hoặc đã lên
  // Silver, hoặc ghi lỗi và rơi thẳng vào `skipped` (`upsertOneProduct` bọc product + toàn bộ variant
  // trong MỘT transaction, hỏng là `skipped++`). Sản phẩm land SAU khi stream products chạy xong thì
  // hoặc được chính trang ingest dựng luôn, hoặc trang đó đã bật cờ (`/api/ingest/raw` gọi
  // `markBronzeBacklog()` cả khi transform ném lẫn khi cổng đối soát "đã land vs đã hạch toán" lệch)
  // ⇒ điều kiện 2 bắt được. Đường nút bấm phải hỏi riêng vì nó CỐ Ý không chạy stream `products`.
  const daHaCo = skipped === 0 && (await haCoBacklogNeuChuaBiBatLai(anhCo));

  if (skipped > 0) {
    // `scripts/rebuild-from-raw.ts` đọc `skipped` của chính bảng số liệu này để đặt exit code ≠ 0 —
    // cùng MỘT con số, không có bản chép nào để trôi.
    warnings.push(
      `${skipped} record trong kho thô KHÔNG dựng được sang Silver (xem cảnh báo bên trên) — GIỮ cờ ` +
        `backlog: sửa mapping rồi chạy lại lượt dựng lại này, cảnh báo mới tắt`,
    );
  } else if (!daHaCo && (await hasBronzeBacklog())) {
    // Kết cục KHÁC hẳn ca trên, nên phải nói khác: lượt này dựng SẠCH, không có mapping nào để sửa —
    // chỉ là có dòng mới tới giữa chừng mà lượt này không chạm tới. Chạy lại là xong.
    warnings.push(
      "Kho thô còn backlog chưa lên Silver — cảnh báo vừa được BẬT LẠI trong lúc lượt dựng lại chạy " +
        "(có dòng mới tới không lên được Silver), lượt này chưa chữa ca đó nên GIỮ cờ. Chạy lại lượt " +
        "dựng lại để dựng nốt dòng vừa tới",
    );
  }

  return {
    productsUpserted: p.productsUpserted,
    variantsUpserted: p.variantsUpserted,
    ordersUpserted: o.ordersUpserted,
    ordersSkippedMirror: o.ordersSkippedMirror,
    ordersSkippedStale: o.ordersSkippedStale,
    // Đường tay ghi đè vô điều kiện nên bộ đếm này luôn 0 ở đây — giữ cho đủ hợp đồng UpsertStats.
    ordersDiscardedGiuaChung: o.ordersDiscardedGiuaChung,
    skipped,
    boQuaCoChuDich:
      p.boQuaCoChuDich +
      o.boQuaCoChuDich +
      st.boQuaCoChuDich +
      ad.boQuaCoChuDich +
      pay.boQuaCoChuDich +
      sh.boQuaCoChuDich +
      meta.boQuaCoChuDich +
      ttAds.boQuaCoChuDich,
    unknownStatusOrders: o.unknownStatusOrders, // chỉ orders sinh mã trạng thái lạ
    settlementsUpserted: st.settlementsUpserted,
    adsUpserted: ad.adsUpserted,
    paymentsUpserted: pay.paymentsUpserted,
    shopeeUpserted: sh.shopeeUpserted,
    adsExpensesUpserted: meta.adsExpensesUpserted + ttAds.adsExpensesUpserted,
  };
}

/**
 * Dựng lại RIÊNG sổ sách GIAO DỊCH từ Bronze: đơn hàng + số liệu "Tiền đã về" + chi tiêu quảng cáo.
 * Đây là đường phục hồi mà nút "Dựng lại từ kho thô" trong Cài đặt gọi (sau khi chủ shop xoá dữ
 * liệu giao dịch).
 *
 * VÌ SAO KHÔNG chạy stream `products` như `rebuildFromRaw`: tồn kho hiện do webhook Pancake ghi gần
 * như tức thời, còn Bronze `products` chỉ giữ ẢNH của lượt kéo đêm ⇒ transform products sẽ kéo
 * `Variant.stock` lùi về số ban đêm và xoá mốc `stockUpdatedAt`. `/api/ingest/resync-products` phải
 * dựng cả một cổng chặn "lượt kéo API còn sống" mới dám làm việc đó; nút do người bấm không có cổng
 * ấy. Mà products cũng KHÔNG cần dựng lại nữa: lượt xoá không còn chạm `Product`/`Variant` (giá vốn
 * APP-OWNED phải sống sót), nên chạy products ở đây chỉ có hại.
 *
 * HẠ CỜ BACKLOG CÓ ĐIỀU KIỆN — 3 điều kiện, thiếu một là GIỮ cờ:
 *  1. `skipped === 0`: không còn dòng nào land vào Bronze mà không dựng được sang Silver. (Dòng bỏ
 *     CÓ CHỦ ĐÍCH — ngày chủ shop đã ghi đè bằng file — đếm riêng ở `boQuaCoChuDich`, KHÔNG tính vào
 *     đây; tính vào thì một lần import ghi đè là cờ dính vĩnh viễn.)
 *  2. Không còn sản phẩm shop kho kẹt ở Bronze (`conSanPhamKetOBronze`) — lượt này CỐ Ý không quét
 *     stream `products` nên phải hỏi riêng, hạ khống là tắt đúng cảnh báo đang báo thật.
 *  3. Cờ CHƯA BỊ BẬT LẠI kể từ lúc lượt này bắt đầu: lượt quét cả bảng chạy HÀNG PHÚT, mà trong
 *     quãng đó webhook Pancake và `/api/ingest/raw` KHÔNG bị chặn — chúng vẫn bật cờ được cho một
 *     dòng VỪA tới mà lượt này chưa hề chữa. Điều kiện nằm TRONG câu UPDATE (xem
 *     `haCoBacklogNeuChuaBiBatLai`), không phải đọc-rồi-ghi.
 *
 * ⚠️ GIỚI HẠN CÒN LẠI (biết mà chấp nhận): điều kiện 2 chỉ phát hiện được sản phẩm/biến thể CHƯA CÓ
 * dòng Silver nào. Sản phẩm đã có trong Silver mà bản Bronze mới hơn chưa được áp (đổi tên, đổi giá
 * bán, đổi tồn) thì lượt này KHÔNG dựng lại và cũng KHÔNG phát hiện được ⇒ cờ vẫn hạ. Chấp nhận vì
 * phần lệch đó không đụng P&L (`Variant.costPrice` là APP-OWNED, doanh thu/COGS không đọc tên hay
 * giá bán), và vì quét `products` ở đây sẽ kéo `Variant.stock` lùi về ảnh ban đêm rồi xoá
 * `stockUpdatedAt` — đắt hơn nhiều so với thứ nó chữa. Đường dựng lại ĐỦ vẫn là
 * `scripts/rebuild-from-raw.ts`.
 */
export async function dungLaiGiaoDichTuKhoTho(
  warnings: string[] = [],
  /** Mốc tiến độ — xem `rebuildFromRaw`. */
  checkpoint?: () => Promise<void>,
): Promise<TransformStats> {
  // Chụp cờ TRƯỚC dòng ghi đầu tiên: mốc trong ảnh chụp là căn cứ để cuối lượt biết cờ có bị bật
  // lại giữa chừng không. Chụp sau khi đã ghi vài stream là tự bỏ qua đúng quãng nguy hiểm nhất.
  const anhCo = await chupCoBacklog();

  const rejectedOrderIds: string[] = [];
  await checkpoint?.();
  const o = await transformFromRaw("orders", warnings, {
    onRejected: (id) => rejectedOrderIds.push(id),
    checkpoint,
    // Chủ shop chủ động yêu cầu dựng lại ⇒ được ghi đè cả kết cục đã chốt (đơn từng bị xoá tay,
    // đơn đã dừng thử lại). Đây là ĐƯỜNG DUY NHẤT cứu lại được chúng.
    luotTayDuocGhiDe: true,
  });
  await warnStuckSilverOrders(rejectedOrderIds, warnings);

  await checkpoint?.();
  const st = await transformFromRaw("tiktok/statements", warnings, {
    checkpoint,
  });
  await checkpoint?.();
  const ad = await transformFromRaw("tiktok/statement_transactions", warnings, {
    checkpoint,
  });
  await checkpoint?.();
  const pay = await transformFromRaw("tiktok/payments", warnings, {
    checkpoint,
  });
  await checkpoint?.();
  const sh = await transformFromRaw("shopee/wallet", warnings, { checkpoint });

  // Chi tiêu quảng cáo Meta + TikTok: kho thô giữ bản gốc báo cáo nên dựng lại được. CHỈ chạm dòng
  // `Expense` source=ADS_API — chi phí chủ shop nhập tay không có nguồn nào để dựng lại, đụng vào
  // là mất vĩnh viễn (cổng chặn ở `upsertOneAdsExpense`). Cờ `rebuild` là điều kiện BẮT BUỘC để
  // nhánh ads chạy — trang ingest thường ngày không được ghi chi phí (xem `TransformOptions`).
  await checkpoint?.();
  const meta = await transformFromRaw("meta/report", warnings, {
    rebuild: true,
    checkpoint,
  });
  await checkpoint?.();
  const ttAds = await transformFromRaw("tiktokbusiness/report", warnings, {
    rebuild: true,
    checkpoint,
  });

  const skipped =
    o.skipped +
    st.skipped +
    ad.skipped +
    pay.skipped +
    sh.skipped +
    meta.skipped +
    ttAds.skipped;

  // 3 điều kiện hạ cờ — xem khối tài liệu trên đầu hàm. Hỏi phần sản phẩm SAU khi transform xong để
  // đọc được cả những dòng vừa dựng trong chính lượt này.
  const sanPhamKet = skipped === 0 ? await conSanPhamKetOBronze() : 0;
  const daHaCo =
    skipped === 0 &&
    sanPhamKet === 0 &&
    (await haCoBacklogNeuChuaBiBatLai(anhCo));

  // Cờ còn bật thì nói rõ VÌ SAO lượt này không tắt được nó, kèm đường xử lý — im lặng để nguyên
  // banner đỏ sẽ bị đọc thành "bấm nút chẳng ăn thua".
  if (!daHaCo && (await hasBronzeBacklog())) {
    const lyDo =
      skipped > 0
        ? `${skipped} record không dựng được sang Silver (xem cảnh báo bên trên)`
        : sanPhamKet > 0
          ? `${sanPhamKet} sản phẩm trong kho thô chưa có đủ bản Silver, mà lượt bấm nút cố ý không ` +
            `dựng lại sản phẩm/tồn kho`
          : "cảnh báo vừa được bật lại trong lúc lượt này chạy (có dòng mới tới không lên được " +
            "Silver) — lượt này chưa chữa ca đó";
    warnings.push(
      `Kho thô còn backlog chưa lên Silver — ${lyDo}. Chạy \`scripts/rebuild-from-raw.ts\` trên ` +
        `minipc để dựng nốt (gồm cả sản phẩm) rồi cảnh báo mới tắt`,
    );
  }

  return {
    // Lượt này không chạm Product/Variant ⇒ 2 bộ đếm sản phẩm luôn 0, không phải "chạy mà ra 0".
    productsUpserted: 0,
    variantsUpserted: 0,
    ordersUpserted: o.ordersUpserted,
    ordersSkippedMirror: o.ordersSkippedMirror,
    ordersSkippedStale: o.ordersSkippedStale,
    // Đường tay ghi đè vô điều kiện nên bộ đếm này luôn 0 ở đây — giữ cho đủ hợp đồng UpsertStats.
    ordersDiscardedGiuaChung: o.ordersDiscardedGiuaChung,
    skipped,
    boQuaCoChuDich:
      o.boQuaCoChuDich +
      st.boQuaCoChuDich +
      ad.boQuaCoChuDich +
      pay.boQuaCoChuDich +
      sh.boQuaCoChuDich +
      meta.boQuaCoChuDich +
      ttAds.boQuaCoChuDich,
    unknownStatusOrders: o.unknownStatusOrders,
    settlementsUpserted: st.settlementsUpserted,
    adsUpserted: ad.adsUpserted,
    paymentsUpserted: pay.paymentsUpserted,
    shopeeUpserted: sh.shopeeUpserted,
    adsExpensesUpserted: meta.adsExpensesUpserted + ttAds.adsExpensesUpserted,
  };
}

/**
 * Đếm sản phẩm shop KHO còn KẸT ở Bronze: bản mới nhất trong kho thô mà Silver chưa có `Product`
 * tương ứng, HOẶC có `Product` nhưng thiếu ít nhất một `Variant` của payload đó.
 *
 * Vì sao phải hỏi: lượt bấm nút CỐ Ý không chạy stream `products` (chạy sẽ kéo `Variant.stock` lùi
 * về ảnh ban đêm rồi xoá `stockUpdatedAt`), mà cờ backlog thì bật được VÌ products — cổng đối soát
 * của `/api/ingest/raw` soi stream `products` của shop kho, và chế độ chỉ-land bật cờ cho mọi stream.
 * Hạ cờ mà không hỏi phần này là tắt cảnh báo cho một ca lượt này không hề chạm tới.
 *
 * Phải soi CẢ biến thể, không chỉ `Product`: upsert product + variants nằm trong CÙNG một
 * transaction (`upsertOneProduct`), nên một biến thể ghi lỗi là rollback cả product — `Product` cũ
 * từ lượt trước vẫn còn, chỉ biến thể MỚI là thiếu. Phép chỉ hỏi "`externalId` này đã có `Product`
 * chưa" sẽ trả lời "đủ rồi" trong đúng ca đó và hạ cờ trong lúc COGS còn thiếu giá vốn biến thể mới.
 *
 * Lọc theo shop KHO (id từ cấu hình `Setting`) là BẮT BUỘC: trang products của shop bán VẪN được
 * land (whitelist cả 3 shop) nhưng transform CỐ Ý chỉ đọc shop kho (nguồn giá vốn) — không lọc
 * thì luôn còn dòng "chưa lên Silver" và cờ không bao giờ hạ được.
 *
 * `jsonb_typeof(...) = 'array'`: payload đời cũ / hỏng có thể không có `variations` hoặc để `null`,
 * mà `jsonb_array_elements` gặp giá trị vô hướng thì NÉM LỖI — cả lượt dựng lại đổ vì một dòng rác.
 * Bản đồ này soi gương `mapPancakeProduct` (`raw.variations ?? []`).
 *
 * Đo prod 31/07 (chỉ đọc): 216 sản phẩm kho trong kho thô, 0 thiếu `Product`, 0 thiếu biến thể.
 */
async function conSanPhamKetOBronze(): Promise<number> {
  const { kho } = await layCauHinhShop();
  const [row] = await prisma.$queryRaw<{ n: number }[]>`
    WITH ban_moi_nhat AS (
      SELECT DISTINCT ON ("externalId") "externalId", payload
      FROM "RawPancakeProduct"
      WHERE "shopId" = ${kho}
      ORDER BY "externalId", "fetchedAt" DESC, "id" DESC
    )
    SELECT COUNT(*)::int AS n
    FROM ban_moi_nhat r
    WHERE NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."pancakeId" = r."externalId")
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(r.payload -> 'variations') = 'array'
                THEN r.payload -> 'variations' ELSE '[]'::jsonb END
         ) v
         WHERE NOT EXISTS (SELECT 1 FROM "Variant" vn WHERE vn."pancakeId" = v ->> 'id')
       )
  `;
  return row?.n ?? 0;
}

/**
 * ĐẾM đơn Silver mang id mà luật HIỆN TẠI loại (mirror / hỏng shape) ⇒ nghi đếm doanh thu 2 lần.
 *
 * Đơn BÙ từ bản sao kho CỐ Ý mang id bị luật mirror loại — chúng nằm trong Silver là ĐÚNG Ý, không
 * phải "kẹt". Không trừ ra thì lượt dựng lại nào cũng khuyên chủ shop xoá đúng phần doanh thu thật
 * đã bù (cụm đơn tháng 3–4), và cổng chống-đếm-2-lần có nền cố định nên bản sao lọt thật về sau
 * chỉ làm số nhích 1, không ai nhận ra.
 *
 * Tách hàm riêng vì CẢ HAI đường dựng lại đều phải soi đúng luật này — lượt dựng lại toàn bộ và
 * lượt backfill kết cục `LEGACY` (tập nhiều mirror kho nhất). Hai bản sao là hai luật trôi lệch.
 */
export async function demDonBiLuatLoaiConTrongSo(rejectedIds: string[]): Promise<number> {
  if (rejectedIds.length === 0) return 0;
  return prisma.order.count({
    where: { pancakeId: { in: rejectedIds }, backfilledFromMirror: false },
  });
}

/**
 * PHÁT HIỆN (không xoá) đơn Silver mà rebuild KHÔNG dựng lại được — 2 loại, 2 hàm ý khác nhau:
 *
 *  1. Silver có, Bronze KHÔNG có dòng nào → đơn cũ hơn cửa sổ Bronze (Bronze chỉ giữ ~60 ngày
 *     lịch sử fetch). Đây là lý do TUYỆT ĐỐI KHÔNG được truncate `Order` rồi rebuild: doanh thu
 *     cũ sẽ bốc hơi vĩnh viễn vì không có raw để dựng lại.
 *  2. Silver có, Bronze CÓ, nhưng luật HIỆN TẠI loại nó (mirror / hỏng shape) → bản ghi KẸT thật
 *     sự: nó lọt vào Silver dưới luật cũ, rebuild chỉ ngừng upsert chứ không xoá ⇒ vẫn cộng
 *     doanh thu (mirror = đếm 2 lần). Phải xoá tay.
 *
 * Chỉ ĐẾM + CẢNH BÁO: tự động xoá là thao tác không hoàn tác được trên dữ liệu tiền.
 */
async function warnStuckSilverOrders(
  rejectedIds: string[],
  warnings: string[],
): Promise<void> {
  const [orphan] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM "Order" o
    WHERE NOT EXISTS (
      SELECT 1 FROM "RawPancakeOrder" r WHERE r."externalId" = o."pancakeId"
    )
  `;
  const orphans = orphan?.n ?? 0;
  if (orphans > 0) {
    warnings.push(
      `${orphans} đơn Silver không có raw Bronze (lịch sử ngoài cửa sổ Bronze) — ` +
        `rebuild không dựng lại được, đừng bao giờ truncate Order`,
    );
  }

  const stuck = await demDonBiLuatLoaiConTrongSo(rejectedIds);
  if (stuck > 0) {
    warnings.push(
      `${stuck} đơn Silver nay bị luật loại nhưng vẫn còn trong Silver ` +
        `(doanh thu có thể đếm 2 lần) — cần xoá tay`,
    );
  }

  // Đơn BÙ có bản KHÁC cùng (kênh + mã đơn) — NGHI đơn gốc đã quay lại (script bù có khe đua với
  // sync, và Pancake có thể trả lại đơn cũ bất kỳ lúc nào về sau) ⇒ doanh thu có thể đếm 2 lần.
  // CHỈ soi cặp có đơn bù, và KHÔNG khẳng định xoá: mã hiển thị Pancake KHÔNG duy nhất trong kênh
  // (prod 2026-08-07 có cặp trùng hợp lệ ở tiktok, trùng trong CÙNG NGÀY) — bằng chứng phân xử
  // (khớp số tiền + thời điểm) nằm ở audit của script bù, chỉ tay người dùng sang đó.
  const [demTrungDoi] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM "Order" bu
    WHERE bu."backfilledFromMirror" = true
      AND EXISTS (
        SELECT 1 FROM "Order" goc
        WHERE goc."channelId" = bu."channelId" AND goc.code = bu.code AND goc.id <> bu.id
      )
  `;
  if ((demTrungDoi?.n ?? 0) > 0) {
    warnings.push(
      `${demTrungDoi.n} đơn BÙ có bản khác cùng (kênh, mã đơn) — nghi đơn gốc đã quay lại ` +
        `(doanh thu có thể đếm 2 lần); chạy "npx tsx scripts/bu-don-shopee-tu-don-kho.ts" để xem ` +
        `bằng chứng từng cặp (số tiền + thời điểm) rồi mới xoá tay`,
    );
  }

  // Lượt dựng lại KHÔNG tái tạo được đơn bù (luật mirror loại chúng ở đầu vào). Sau một lượt "Xoá dữ
  // liệu giao dịch" + dựng lại, chúng biến mất mà không cảnh báo nào bật ⇒ mất tiền không dấu vết.
  // Nhắc ngay tại đây, kèm đúng lệnh phải chạy.
  const daBu = await prisma.order.count({
    where: { backfilledFromMirror: true },
  });
  if (daBu > 0) {
    warnings.push(
      `${daBu} đơn đang là đơn BÙ từ bản sao kho — lượt dựng lại KHÔNG tự tái tạo chúng. ` +
        `Nếu vừa xoá dữ liệu giao dịch, phải chạy lại: npx tsx scripts/bu-don-shopee-tu-don-kho.ts --ghi`,
    );
  }
}
