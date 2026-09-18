import {
  dongDauKetCuc,
  dongDauKetCucBoiLuotTay,
  KET_CUC,
  KetCucDaXoaTay,
  type KetCucSilver,
} from "@/lib/bronze/ket-cuc-silver";
import {
  isAffiliateMirror,
  mapPancakeOrder,
  UNKNOWN_STATUS_WARNING,
  type MapOrderCtx,
} from "@/lib/ingest/pancake-mapping";
import {
  pancakeOrderSchema,
  pancakeProductSchema,
} from "@/lib/ingest/pancake-schemas";
import { upsertOneOrder, upsertOneProduct } from "@/lib/ingest/pancake-upsert";
import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import {
  chamMoc,
  latestPayloads,
  type TransformOptions,
  type TransformStats,
} from "./transform-raw-helpers";

/**
 * Nhánh Pancake của transform — ĐƯỜNG TIỀN (doanh thu/P&L, bất biến #1/#2). Gọi từ
 * `transform-from-raw.ts`; luật loại đơn khỏi Silver nằm DUY NHẤT ở file này.
 */

/** id đơn MIRROR shop kho theo discovery: `AF<shopId>O<n>` (vd `AF1942992175O123`). */
const KHO_MIRROR_ID = /^AF\d+O/;

/**
 * Đơn shop KHO là 100% MIRROR của Shopee/TikTok (discovery) → TUYỆT ĐỐI không vào Silver,
 * nếu lọt sẽ đếm doanh thu 2 lần kèm `fee_marketplace` thật (phá invariant #2).
 *
 * `isAffiliateMirror()` chỉ nhận diện qua nguồn ("Affiliate" + marketplace −3/−9). Mirror nào ghi
 * nguồn khác (vd "Shopee") sẽ LỌT → dùng thêm luật id `AF<shopId>O`. Mirror = 1 trong 2 luật khớp,
 * áp cho MỌI shop (chốt 2026-08-21): mã `AF...O` là dấu mirror của Pancake bất kể đơn nằm shop
 * nào, còn đơn gốc Shopee/TikTok mang mã sàn không bao giờ có tiền tố này. Trước đây luật id chỉ
 * áp cho shop kho — tức cổng an toàn tiền phụ thuộc việc so ĐÚNG một id cấu hình; id sai (bản
 * clone điền nhầm) là cổng tắt ÂM THẦM và doanh thu đếm 2 lần. Luật rộng hơn = an toàn hơn cho
 * tiền và KHÔNG phụ thuộc cấu hình. 2 luật BẤT ĐỒNG → cảnh báo để phát hiện luật trôi so với
 * dữ liệu thật (đơn gốc hai luật đều false nên không gây nhiễu cảnh báo).
 */
function isMirrorOrder(
  shopId: string,
  externalId: string,
  raw: Parameters<typeof isAffiliateMirror>[0],
  warnings: string[],
): boolean {
  const bySource = isAffiliateMirror(raw);
  const byId = KHO_MIRROR_ID.test(externalId);
  if (bySource !== byId) {
    warnings.push(
      `Đơn ${externalId} (shop ${shopId}): 2 luật mirror bất đồng (nguồn "${raw.order_sources_name ?? ""}"/marketplace ` +
        `"${raw.marketplace_id ?? ""}" → ${bySource}; id khớp AF<shop>O → ${byId}) — vẫn LOẠI khỏi Silver ` +
        `để không đếm doanh thu 2 lần; kiểm lại luật mirror`,
    );
  }
  return bySource || byId;
}

/**
 * Products CHỈ lấy từ shop KHO — nguồn giá vốn (invariant #5). Shop bán cũng có `/products`
 * (đã land để đối chiếu) nhưng product id khác nhau mỗi shop và không có giá vốn ⇒ transform
 * chúng sẽ đẻ Variant trùng SKU với costPrice 0 → tra giá vốn theo SKU nhập nhằng, COGS sai.
 */
export async function transformProducts(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, checkpoint } = opts;
  // Id shop kho từ cấu hình `Setting` (transform chạy NGOÀI transaction land nên tự resolve được).
  const { kho } = await layCauHinhShop();
  let iP = 0;
  for (const row of await latestPayloads("RawPancakeProduct", {
    shopId: kho,
    externalIds,
  })) {
    await chamMoc(checkpoint, iP++);
    const parsed = pancakeProductSchema.safeParse(row.payload);
    if (!parsed.success) {
      stats.skipped++;
      warnings.push(
        `Bỏ qua product ${row.externalId} lỗi shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
      continue;
    }
    await upsertOneProduct(parsed.data, stats, warnings);
  }
}

/**
 * Đơn MIRROR shop kho → raw GIỮ, Silver BỎ (chống đếm 2 lần — invariant #2).
 * zod safeParse TỪNG record → hỏng chỉ `skipped++` + warning, KHÔNG giết batch.
 */
export async function transformOrders(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, onRejected, shopId, luotTayDuocGhiDe, checkpoint } =
    opts;
  // Một chỗ duy nhất quyết định "được ghi đè kết cục cũ hay không", để nhánh nào cũng dùng đúng
  // quyền hạn của lượt đang chạy.
  const dauKetCuc = luotTayDuocGhiDe ? dongDauKetCucBoiLuotTay : dongDauKetCuc;
  // Đóng dấu kết cục nhánh loại-trừ (mirror/shape); CAS thua vì dòng vừa bị "Xóa dữ liệu giao
  // dịch" đóng DISCARDED là kết cục CÓ CHỦ ĐÍCH — đếm `ordersDiscardedGiuaChung` (cổng đối soát
  // tính là đã-hạch-toán) và trả true để caller BỎ bộ đếm thường, KHÔNG để ném trào ra huỷ cả lô.
  // Đường tay (`dongDauKetCucBoiLuotTay`) ghi đè vô điều kiện nên không bao giờ vào nhánh catch.
  const dongDauHoacDaXoa = async (
    rawRowId: string,
    ketCuc: KetCucSilver,
    note?: string,
  ): Promise<boolean> => {
    try {
      await dauKetCuc(prisma, rawRowId, ketCuc, note);
      return false;
    } catch (e) {
      if (e instanceof KetCucDaXoaTay) {
        stats.ordersDiscardedGiuaChung++;
        return true;
      }
      throw e;
    }
  };
  const channels = await prisma.channel.findMany({
    select: { id: true, platformFeePct: true, paymentFeePct: true },
  });
  const ctx: MapOrderCtx = {
    channels: Object.fromEntries(
      channels.map((c) => [
        c.id,
        { platformFeePct: c.platformFeePct, paymentFeePct: c.paymentFeePct },
      ]),
    ),
  };

  // Lô đơn có thể chạy hàng phút (đo: 6133ms/50 đơn). Chấm mốc ở dòng đầu (i=0) để bắt cả ca câu
  // nạp treo lâu hơn hạn, rồi mỗi CHAM_MOC_MOI dòng.
  let iO = 0;
  for (const row of await latestPayloads("RawPancakeOrder", {
    shopId,
    externalIds,
  })) {
    await chamMoc(checkpoint, iO++);
    const parsed = pancakeOrderSchema.safeParse(row.payload);
    if (!parsed.success) {
      const lyDo = parsed.error.issues[0]?.message ?? "unknown";
      // Payload Bronze bất biến ⇒ map hỏng là lỗi TẤT ĐỊNH: đóng dấu để lượt đối soát đêm thôi
      // thử lại (nhưng vẫn hiện "cần xem"). Sửa mapping xong thì lượt dựng lại TAY chạy qua
      // đúng đường này và ghi đè lại thành APPLIED. Đóng dấu TRƯỚC khi đếm: dòng vừa bị xoá tay
      // giữa chừng thì KHÔNG phải "hỏng shape" nữa — không đếm skipped, không cảnh báo.
      if (await dongDauHoacDaXoa(row.id, KET_CUC.FAILED_SHAPE, `Lỗi shape: ${lyDo}`)) continue;
      stats.skipped++;
      onRejected?.(row.externalId);
      warnings.push(`Bỏ qua order ${row.externalId} lỗi shape: ${lyDo}`);
      continue;
    }
    if (isMirrorOrder(row.shopId, row.externalId, parsed.data, warnings)) {
      // CỐ Ý không vào Silver (bất biến doanh thu #2) — là kết cục ĐÚNG, không phải việc dở dang.
      if (await dongDauHoacDaXoa(row.id, KET_CUC.EXCLUDED_MIRROR)) continue;
      stats.ordersSkippedMirror++; // mirror: raw GIỮ, Silver BỎ
      onRejected?.(row.externalId);
      continue;
    }
    const mo = mapPancakeOrder(parsed.data, ctx);
    // Ngày giờ KHÔNG hợp lệ phải chặn TẠI ĐÂY, trước khi xuống Prisma. `inserted_at` chỉ bị zod
    // ép là chuỗi không rỗng nên mọi khuôn lạ đều lọt, rồi `parseVnDate` trả một Date hỏng và
    // Prisma ném ở tận lượt ghi. Lỗi đó rơi vào nhánh "lỗi ghi" (để dòng ở chưa-xong, thử lại
    // đêm sau) — nhưng payload Bronze bất biến nên nó hỏng y hệt MỌI đêm, tức lượt đối soát hỏng
    // vĩnh viễn. Đây là lỗi DỮ LIỆU tất định, phải mang nhãn dừng-thử-lại ngay từ lượt đầu.
    if (Number.isNaN(mo.orderedAt.getTime())) {
      const lyDo = `ngày giờ không hợp lệ: inserted_at="${parsed.data.inserted_at}"`;
      if (await dongDauHoacDaXoa(row.id, KET_CUC.FAILED_SHAPE, lyDo)) continue;
      stats.skipped++;
      onRejected?.(row.externalId);
      warnings.push(`Bỏ qua order ${row.externalId} — ${lyDo}`);
      continue;
    }
    // `rawRowId` để kết cục APPLIED/SUPERSEDED được đóng dấu NGAY TRONG transaction ghi Silver.
    const kqGhi = await upsertOneOrder(mo, row.payload, stats, warnings, row.fetchedAt, {
      rawRowId: row.id,
      luotTayDuocGhiDe,
    });
    // Đếm đơn có MÃ TRẠNG THÁI LẠ (bị loại như CANCELLED) + cảnh báo mapping — SAU khi biết kết
    // cục ghi, và BỎ QUA khi đơn vừa bị "Xóa dữ liệu giao dịch" đóng DISCARDED giữa chừng: cảnh
    // báo về thứ đã cố ý xoá là cảnh báo MA — webhook sẽ tô "cần xem" oan (nhánh ② chạy trước ③b)
    // và SyncLog giữ cảnh báo cho đơn không còn tồn tại. Mọi kết cục KHÁC (kể cả LOI/SUPERSEDED)
    // vẫn đếm/cảnh báo như cũ — lưới chống mất doanh thu âm thầm không đổi.
    if (kqGhi !== "DISCARDED") {
      if (mo.warnings.some((w) => w.startsWith(UNKNOWN_STATUS_WARNING)))
        stats.unknownStatusOrders++;
      warnings.push(...mo.warnings);
    }
  }
}
