/**
 * BÙ ĐƠN SHOPEE MẤT GỐC (chạy tay, một lần).
 *
 * Bối cảnh (đo prod 2026-08-05): shop Shopee trên Pancake CHỈ CÒN 21 đơn, sớm nhất 22/04/2026 —
 * lọc tháng 3 trả `total_entries: 0`. Đơn Shopee cũ đã bị Pancake xoá/ẩn khỏi shop bán, KHÔNG có
 * đường nào kéo lại. Hậu quả: app thiếu 24 đơn Shopee ĐÃ GIAO (11 đơn tháng 3 + 13 đơn 01–11/04),
 * tương đương 7.890.000 đ doanh thu — báo cáo hai tháng đó thiếu tiền.
 *
 * Bản sao của chúng vẫn còn nguyên trong shop KHO TỔNG (đơn mirror `AF<shopIdShopee>O<code>`), nên
 * đây là NGUỒN DUY NHẤT còn lại. Script dựng Silver từ bản sao đó.
 *
 * ĐÂY LÀ NGOẠI LỆ CÓ CHỦ ĐÍCH của bất biến #2 ("đơn kho TUYỆT ĐỐI không tính doanh thu"). Bất biến
 * đó tồn tại để chống ĐẾM HAI LẦN — mà ở đây đơn gốc KHÔNG tồn tại trong hệ thống, nên không có gì
 * để đếm hai lần. Ba lớp chặn giữ đúng tinh thần đó:
 *   1. Chỉ nhận đơn mirror của shop SHOPEE (`AF<SHOP_SHOPEE>O`), không đụng mirror TikTok.
 *   2. Bỏ qua ngay khi đã có `Order` cùng (channelId=shopee, code) — đơn gốc còn sống thì không bù.
 *   3. `pancakeId` giữ nguyên id mirror (`AF…`) nên không bao giờ trùng id đơn gốc, và lượt dựng lại
 *      từ kho thô vẫn LOẠI bản mirror như cũ (không ghi đè, không nhân đôi).
 *
 * PHÍ SÀN: đơn mirror có `fee_marketplace = 0` và KHÔNG có khoá chi phí nào — Pancake không chép phí
 * sang bản sao. (Chính xác hơn: object `advanced_platform_fee` KHÔNG rỗng — đo prod 2026-08-17, nó
 * khác rỗng ở 359/529 dòng mirror — nhưng bên trong chỉ có đúng một khoá `marketplace_voucher`, là
 * khoản THU chứ không phải phí. Khoá chi phí: 0/529. Xem việc C5.)
 *
 * Để lãi không bị thổi lên, script ước tính phí theo TỈ LỆ THẬT đo trên chính các đơn Shopee
 * app đang có (xem TY_LE_PHI_SHOPEE). Đây là số ƯỚC TÍNH, được đánh dấu trong `raw._buTuDonKho` để
 * sau này lọc ra được.
 *
 * Chạy thử (mặc định, KHÔNG ghi):  npx tsx scripts/bu-don-shopee-tu-don-kho.ts
 * Ghi thật:                        npx tsx scripts/bu-don-shopee-tu-don-kho.ts --ghi
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { formatVnd } from "@/lib/format";
import { mapPancakeOrder, type MapOrderCtx } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";
import { upsertOneOrder, type UpsertStats } from "@/lib/ingest/pancake-upsert";

const KENH_SHOPEE = "shopee";

/**
 * Tỉ lệ phí sàn Shopee, đo 2026-08-05 trên 11 đơn Shopee hợp lệ app đang có:
 * Σ platformFeeEst 1.124.363 / Σ itemsTotal 3.870.000 = 29,05%.
 *
 * Dùng số đo thật thay vì % cấu hình kênh (10% + 2,5% = 12,5%): cấu hình thấp hơn thực tế hơn một
 * nửa, áp vào sẽ để lãi cao ảo ~1,3 triệu — đúng cái mà việc bù này muốn tránh.
 */
const TY_LE_PHI_SHOPEE = 1_124_363 / 3_870_000;

const GHI = process.argv.includes("--ghi");

/** `AF1942992175O21` → `21` (mã đơn hiển thị của shop Shopee, = `Order.code`). */
function maSanTuIdMirror(externalId: string): string | null {
  return externalId.match(/^AF\d+O(.+)$/)?.[1] ?? null;
}

async function main(): Promise<void> {
  console.log(GHI ? "=== CHẾ ĐỘ GHI THẬT ===" : "=== CHẠY THỬ (không ghi) — thêm --ghi để ghi thật ===\n");

  // Shop id từ cấu hình `Setting` — script đọc cùng nguồn với đường ingest, không giữ bản hằng riêng.
  const { layCauHinhShop } = await import("@/lib/ket-noi/cau-hinh-shop");
  const { kho: SHOP_KHO, shopee: SHOP_SHOPEE } = await layCauHinhShop();

  const channels = await prisma.channel.findMany({
    select: { id: true, platformFeePct: true, paymentFeePct: true },
  });
  const ctx: MapOrderCtx = {
    channels: Object.fromEntries(
      channels.map((c) => [c.id, { platformFeePct: c.platformFeePct, paymentFeePct: c.paymentFeePct }])
    ),
  };

  // Bản kho thô MỚI NHẤT của mỗi đơn mirror Shopee.
  const rows = await prisma.$queryRaw<{ externalId: string; payload: unknown; fetchedAt: Date }[]>`
    SELECT DISTINCT ON ("externalId") "externalId", payload, "fetchedAt"
    FROM "RawPancakeOrder"
    WHERE "shopId" = ${SHOP_KHO} AND "externalId" LIKE ${`AF${SHOP_SHOPEE}O%`}
    ORDER BY "externalId", "fetchedAt" DESC
  `;
  console.log(`Đơn mirror Shopee trong kho thô: ${rows.length}`);

  // Đơn Shopee app ĐANG CÓ → bỏ qua, tránh đếm hai lần.
  const daCo = new Set(
    (
      await prisma.order.findMany({ where: { channelId: KENH_SHOPEE }, select: { code: true } })
    ).map((o) => o.code)
  );
  console.log(`Đơn Shopee app đang có: ${daCo.size}\n`);

  // TỰ LÀNH trước khi bù: lượt trước có thể chết giữa `upsertOneOrder` và câu gắn cờ — đơn bù nằm
  // lại với `backfilledFromMirror=false`, nhánh "đã có" phía dưới bỏ qua nó vĩnh viễn, và cờ false
  // làm `rebuild.ts` khuyên XOÁ TAY đúng doanh thu thật đã bù. Nhận diện bằng DẤU VẾT
  // `raw._buTuDonKho` do chính script này ghi cùng đơn (mọi phiên bản script đều ghi) — KHÔNG nhận
  // theo hình dạng id `AF…`: mirror ghi nguồn khác "Affiliate" (vd "Shopee") map ra đúng kênh
  // shopee (lý do luật id ra đời — `transform-pancake-orders.ts#isMirrorOrder`), lọt Silver dưới luật cũ
  // là mang đúng hình dạng đó; gắn cờ cho nó là dạy `rebuild.ts` ngừng cảnh báo đếm 2 lần đúng chỗ
  // đang đếm 2 lần thật. (Đo prod 2026-08-07: 46/46 đơn bù đều có cả cờ lẫn dấu vết.)
  const dieuKienCoThieu = Prisma.sql`
    "channelId" = ${KENH_SHOPEE} AND "pancakeId" LIKE 'AF%'
    AND "backfilledFromMirror" = false
    AND "raw" IS NOT NULL AND jsonb_exists("raw", '_buTuDonKho')`;
  if (GHI) {
    const kq = await prisma.$executeRaw`UPDATE "Order" SET "backfilledFromMirror" = true WHERE ${dieuKienCoThieu}`;
    if (kq > 0) console.log(`Đã sửa lại cờ cho ${kq} đơn bù thiếu cờ (lượt trước dở dang)\n`);
  } else {
    const [thieuCo] = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "Order" WHERE ${dieuKienCoThieu}`;
    if ((thieuCo?.n ?? 0) > 0) console.log(`Sẽ sửa lại cờ cho ${thieuCo.n} đơn bù đang thiếu cờ backfilledFromMirror\n`);
  }
  // Đơn `AF…` KHÔNG mang dấu vết script = nghi mirror lọt vào Silver — TUYỆT ĐỐI không tự gắn cờ
  // (gắn là che cảnh báo đếm 2 lần của rebuild); để nguyên và kêu to cho xử lý tay.
  const [nghiMirror] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM "Order"
    WHERE "channelId" = ${KENH_SHOPEE} AND "pancakeId" LIKE 'AF%'
      AND "backfilledFromMirror" = false
      AND ("raw" IS NULL OR NOT jsonb_exists("raw", '_buTuDonKho'))`;
  if ((nghiMirror?.n ?? 0) > 0) {
    console.error(
      `⚠️ ${nghiMirror.n} đơn Shopee mang id AF… nhưng KHÔNG có dấu vết _buTuDonKho — nghi mirror lọt vào Silver, ` +
        `script KHÔNG tự sửa cờ; chạy "Dựng lại từ kho thô" để nhận cảnh báo đếm 2 lần rồi xử lý tay.`
    );
    // Thoát mã lỗi để automation không coi lượt chạy là sạch — stderr đơn thuần dễ bị nuốt.
    process.exitCode = 1;
  }

  const stats: UpsertStats = {
    productsUpserted: 0,
    variantsUpserted: 0,
    ordersUpserted: 0,
    ordersSkippedMirror: 0,
    ordersSkippedStale: 0,
      ordersDiscardedGiuaChung: 0,
    skipped: 0,
    boQuaCoChuDich: 0,
    unknownStatusOrders: 0,
    settlementsUpserted: 0,
    adsUpserted: 0,
    paymentsUpserted: 0,
    shopeeUpserted: 0,
    adsExpensesUpserted: 0,
  };
  const warnings: string[] = [];
  const buDuoc: { code: string; ngay: string; tt: string; doanhThu: number; phi: number }[] = [];
  let boQuaDaCo = 0;
  let boQuaLoi = 0;
  let boQuaChan = 0; // đơn gốc quay lại đúng lúc ghi — precondition trong transaction chặn

  for (const row of rows) {
    const maSan = maSanTuIdMirror(row.externalId);
    if (!maSan) {
      boQuaLoi++;
      continue;
    }
    if (daCo.has(maSan)) {
      boQuaDaCo++;
      continue;
    }

    const parsed = pancakeOrderSchema.safeParse(row.payload);
    if (!parsed.success) {
      boQuaLoi++;
      warnings.push(`${row.externalId}: payload lỗi shape — ${parsed.error.issues[0]?.message ?? "?"}`);
      continue;
    }

    const mo = mapPancakeOrder(parsed.data, ctx);
    // Bản sao ghi nguồn "Affiliate" nên `mapChannel` cho ra "website", và `code` lấy từ `system_id`
    // của SHOP KHO (số riêng của kho) — cả hai đều phải ghi đè về đúng đơn Shopee gốc.
    mo.channelId = KENH_SHOPEE;
    mo.code = maSan;

    // Phí sàn ước tính (bản sao không mang phí). Đơn hoàn/hủy không vào doanh thu nên để 0 —
    // `returnedFee` cũng không có số thật để điền.
    mo.platformFeeEst =
      mo.status === "RETURNED" || mo.status === "CANCELLED" ? 0 : Math.round(mo.itemsTotal * TY_LE_PHI_SHOPEE);

    const dongLietKe = {
      code: maSan,
      ngay: mo.orderedAt.toISOString().slice(0, 10),
      tt: mo.status,
      doanhThu: mo.itemsTotal - mo.discount,
      phi: mo.platformFeeEst,
    };

    if (GHI) {
      const rawCoDau = {
        ...(row.payload as Record<string, unknown>),
        _buTuDonKho: {
          nguon: `shop kho ${SHOP_KHO}, đơn mirror ${row.externalId}`,
          lyDo: "Pancake không còn đơn gốc ở shop Shopee (chỉ giữ từ 22/04/2026)",
          tyLePhiUocTinh: Number(TY_LE_PHI_SHOPEE.toFixed(6)),
          phiLaUocTinh: true,
        },
      };
      // Cờ ở TẦNG DỮ LIỆU (không phải khoá trong `raw`, vốn là JSON tự do không ai ràng buộc) để
      // `warnStuckSilverOrders` và các phép đếm bảo vệ tiền nhận ra đơn bù — xem migration
      // `20260805170000_danh_dau_don_bu_tu_ban_sao_kho`. Gắn NGAY TRONG transaction upsert: từng
      // là hai bước rời, chết giữa chừng thì đơn bù nằm lại với cờ false và rebuild khuyên xoá tay.
      // `chanKhiCoDonKhacCungKenhMa`: snapshot `daCo` chụp đầu lượt là chưa đủ — sync/webhook chạy
      // song song có thể chen đơn gốc vào; check + khoá (kênh, mã) nằm TRONG transaction ghi.
      const truoc = { chan: stats.boQuaCoChuDich, loi: stats.skipped, stale: stats.ordersSkippedStale };
      await upsertOneOrder(mo, rawCoDau, stats, warnings, row.fetchedAt, {
        backfilledFromMirror: true,
        chanKhiCoDonKhacCungKenhMa: true,
      });
      // Danh sách + bảng "Ảnh hưởng báo cáo" chỉ được tính đơn ĐÃ GHI THẬT — đơn bị chặn (đơn gốc
      // vừa quay lại) hay upsert lỗi mà vẫn cộng thì số in ra cao hơn số vào Silver. Phân loại
      // bằng DELTA từng bộ đếm (upsert nuốt lỗi vào warning + stats, không ném).
      if (stats.boQuaCoChuDich > truoc.chan) {
        boQuaChan++;
        continue;
      }
      if (stats.skipped > truoc.loi) {
        boQuaLoi++;
        continue;
      }
      if (stats.ordersSkippedStale > truoc.stale) {
        boQuaDaCo++; // Silver đang giữ bản mới hơn của chính đơn này — coi như "đã có", không phải lỗi
        continue;
      }
    }
    buDuoc.push(dongLietKe);
  }

  buDuoc.sort((a, b) => a.ngay.localeCompare(b.ngay));
  console.log(
    `Bỏ qua ${boQuaDaCo} đơn app đã có · ${boQuaLoi} đơn không đọc được/ghi lỗi` +
      (boQuaChan > 0 ? ` · ${boQuaChan} đơn bị chặn vì đơn gốc vừa quay lại` : "")
  );
  console.log(`\n=== ${buDuoc.length} đơn ${GHI ? "ĐÃ bù" : "sẽ bù"} ===`);
  for (const d of buDuoc) {
    console.log(
      `  ${d.ngay}  mã ${d.code.padEnd(4)} ${d.tt.padEnd(10)} doanh thu ${formatVnd(d.doanhThu).padStart(12)}  phí ${formatVnd(d.phi).padStart(11)}`
    );
  }

  const theoThang = new Map<string, { n: number; dt: number; phi: number }>();
  for (const d of buDuoc) {
    if (d.tt === "RETURNED" || d.tt === "CANCELLED") continue;
    const k = d.ngay.slice(0, 7);
    const cu = theoThang.get(k) ?? { n: 0, dt: 0, phi: 0 };
    theoThang.set(k, { n: cu.n + 1, dt: cu.dt + d.doanhThu, phi: cu.phi + d.phi });
  }
  console.log(`\n=== Ảnh hưởng báo cáo (chỉ đơn hợp lệ) ===`);
  for (const [thang, v] of [...theoThang].sort()) {
    console.log(`  ${thang}: +${v.n} đơn · doanh thu +${formatVnd(v.dt)} · phí sàn +${formatVnd(v.phi)}`);
  }

  if (warnings.length) {
    console.log(`\n=== ${warnings.length} cảnh báo ===`);
    for (const w of warnings.slice(0, 20)) console.log(`  - ${w}`);
  }
  if (GHI) console.log(`\nĐã ghi: ${stats.ordersUpserted} đơn.`);
  else console.log(`\n(chạy thử — chưa ghi gì)`);

  // Upsert nuốt lỗi transaction vào `warnings` + `stats.skipped` (đã gộp vào `boQuaLoi` qua delta
  // trong vòng ghi) — exit 0 thì automation coi lượt chạy là sạch trong khi có đơn KHÔNG vào
  // Silver (thiếu doanh thu câm).
  if (boQuaLoi > 0) {
    console.error(`\n⚠️ ${boQuaLoi} đơn không đọc được hoặc ghi lỗi — xem cảnh báo phía trên.`);
    process.exitCode = 1;
  }

  // AUDIT chống đếm đôi cuối lượt: đơn BÙ nào có bản KHÁC cùng (kênh, mã). Khe ghi-đồng-thời đã
  // đóng bằng khoá (kênh, mã) trong transaction upsert, nhưng ca "đơn gốc quay lại NHIỀU NGÀY SAU
  // khi đơn bù đã ghi" thì không lượt kiểm ghi nào đỡ được — audit này + guard trong rebuild trực.
  // CHỈ soi cặp có đơn bù, và KHÔNG khẳng định "xoá đơn bù": mã hiển thị Pancake KHÔNG duy nhất
  // trong kênh (prod có cặp trùng hợp lệ ở tiktok, trùng trong CÙNG NGÀY — đo 2026-08-07) ⇒ trình
  // bằng chứng (tiền + thời điểm — bản sao sinh cách đơn gốc vài giây, tiền y nguyên, đo webhook
  // 2026-07-30) để NGƯỜI quyết.
  const trungDoi = await prisma.$queryRaw<
    { code: string; buId: string; buNgay: Date; buTien: number; gocId: string; gocNgay: Date; gocTien: number }[]
  >`
    SELECT bu.code, bu."pancakeId" AS "buId", bu."orderedAt" AS "buNgay", bu."itemsTotal" AS "buTien",
           goc."pancakeId" AS "gocId", goc."orderedAt" AS "gocNgay", goc."itemsTotal" AS "gocTien"
    FROM "Order" bu
    JOIN "Order" goc ON goc."channelId" = bu."channelId" AND goc.code = bu.code AND goc.id <> bu.id
    WHERE bu."backfilledFromMirror" = true
    ORDER BY bu.code
  `;
  if (trungDoi.length > 0) {
    console.error(`\n⚠️ NGHI ĐẾM ĐÔI: ${trungDoi.length} cặp đơn bù ↔ đơn khác cùng (kênh, mã):`);
    for (const t of trungDoi) {
      const lechGiay = Math.round(Math.abs(t.buNgay.getTime() - t.gocNgay.getTime()) / 1000);
      console.error(
        `  - mã ${t.code}: đơn bù ${t.buId} (${t.buNgay.toISOString()}, ${formatVnd(t.buTien)}) ` +
          `↔ ${t.gocId} (${t.gocNgay.toISOString()}, ${formatVnd(t.gocTien)}) — ` +
          `${t.buTien === t.gocTien ? "KHỚP tiền" : "LỆCH tiền"}, cách nhau ${lechGiay}s ` +
          `(mốc tham chiếu: đơn gốc quay lại thường KHỚP tiền và cách vài giây). ` +
          `ĐỐI CHIẾU PANCAKE trước khi xoá bất kỳ bản nào — mã Pancake có thể trùng ngẫu nhiên.`
      );
    }
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
