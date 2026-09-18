import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { isBronzeOnly } from "@/lib/bronze/bronze-only";
import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { capNhatSoLechGiaVon } from "@/lib/gia-von/cap-nhat-so-lech";
import { capNhatSoPhieuNhapChuaGhi } from "@/lib/nhap-hang/cap-nhat-so-phieu-nhap";
import { KEY_MOC_VA_TON_KHO } from "@/lib/ingest/stock-resync-status";
import { withSyncLog } from "@/lib/ingest/sync-log";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/ingest/resync-products — dựng lại Sản phẩm + TỒN KHO từ Bronze mới nhất. Chạy mỗi đêm.
 *
 * VÌ SAO CẦN (phát hiện khi đo 2026-07-27): `/api/ingest/raw` chỉ transform entity **vừa land**
 * (`landedIds`), mà Bronze dedupe theo hash ⇒ sản phẩm không đổi payload thì KHÔNG bao giờ được
 * dựng lại. Hệ quả: nếu webhook ghi một con số tồn sai mà bên Pancake món đó không đổi gì thêm thì
 * lượt API kế tiếp cũng không sửa — đo thật: `Variant.syncedAt` cũ nhất đang là 22/07, tức 5 ngày
 * không được API ghi lại lần nào. Không có endpoint này thì câu "API là chuẩn" KHÔNG đúng với tồn.
 *
 * Cách làm: gọi `transformFromRaw("products")` KHÔNG kèm `externalIds` — quét toàn bộ Bronze, đúng
 * đường mà `scripts/rebuild-from-raw.ts` vẫn chạy trên prod (idempotent, KHÔNG đụng `costPrice` /
 * `lowStockThreshold` APP-OWNED). Xong thì xoá `stockUpdatedAt`: tồn nay do API khẳng định lại.
 *
 * CHỐT CHẶN: chỉ chạy khi lượt sync API CÒN SỐNG — tức có lượt kéo `products` shop KHO thành công
 * trong `TRAN_TUOI_GIO` giờ qua. Sync chết mà vẫn vá thì ta đè tồn bằng ảnh Bronze cũ, xoá mất số
 * webhook ĐÚNG (lúc đó webhook là nguồn duy nhất còn tươi). Thà giữ nguyên và kêu lên SyncLog.
 *
 * ĐO 2026-07-27 — vì sao thước đo là SyncLog chứ KHÔNG phải `fetchedAt` của Bronze: Bronze dedupe
 * theo hash nên `fetchedAt` chỉ nhích khi payload sản phẩm THAY ĐỔI. Trên prod lúc 18:08, lượt sync
 * `products` chạy cách đó 7,7 phút (`landed: 0` — không món nào đổi) trong khi dòng Bronze mới nhất
 * đã 1,13 giờ tuổi. Lấy Bronze làm thước đo thì mọi đêm yên ả (không ai mua gì) đều bị kết luận
 * nhầm là "sync hỏng" và lượt vá KHÔNG BAO GIỜ chạy. `SyncLog` ghi mọi lượt gọi, kể cả lượt không
 * land gì — đó mới là dấu hiệu API còn sống.
 */

/** Lượt kéo `products` shop KHO gần nhất phải nằm trong khoảng này. Sync chạy 30' ⇒ 2 giờ rất rộng. */
const TRAN_TUOI_GIO = 2;

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  return withSyncLog("PANCAKE", async (warnings) => {
    // BRONZE_ONLY = "Silver đứng yên, chờ rebuild tay". Chạy transform ở đây là lách công tắc đó.
    if (isBronzeOnly()) {
      warnings.push("BRONZE_ONLY: bỏ qua vá tồn kho (Silver đang cố ý đứng yên)");
      return { mode: "skipped" as const, reason: "bronze-only" };
    }

    // Lượt kéo `products` shop KHO gần nhất. Nhận diện qua `stats.stream`/`stats.shopId` mà
    // `/api/ingest/raw` luôn ghi — nhờ vậy lượt chạy CỦA CHÍNH endpoint này (stats không có
    // `stream`) không tự chứng nhận cho mình là "sync còn sống".
    // Chặn `startedAt` theo cửa sổ để câu này đi index `[kind, startedAt]` thay vì quét cả bảng
    // (SyncLog đẻ 1 dòng/trang ⇒ ~60k dòng/15 ngày). Không mất gì: quá trần là hỏng rồi, không cần
    // biết chính xác hỏng từ bao giờ.
    const tuLuc = new Date(Date.now() - TRAN_TUOI_GIO * 3_600_000);
    const { kho } = await layCauHinhShop();
    const [moc] = await prisma.$queryRaw<{ chayLuc: Date | null }[]>`
      SELECT MAX("startedAt") AS "chayLuc" FROM "SyncLog"
      WHERE kind = 'PANCAKE' AND status = 'OK' AND "startedAt" >= ${tuLuc}
        AND stats->>'stream' = 'products' AND stats->>'shopId' = ${kho}
    `;
    const tuoiGio = moc?.chayLuc
      ? (Date.now() - moc.chayLuc.getTime()) / 3_600_000
      : Number.POSITIVE_INFINITY;
    if (tuoiGio > TRAN_TUOI_GIO) {
      // THROW, không "return skipped": trả bình thường thì `withSyncLog` ghi status OK ⇒ banner đỏ
      // toàn app (`getRecentErrorKinds` chỉ soi status ERROR) và card Tình trạng đồng bộ vẫn XANH
      // với mốc tươi rói, trong khi thực tế lượt sync 30' đã chết và tồn kho đang chạy 100% bằng
      // webhook không ai đối chiếu. Đúng ca "hỏng âm thầm" mà cả file này sinh ra để chống.
      // Ném ⇒ SyncLog ERROR + HTTP 500 ⇒ banner đỏ 48h cho chủ shop VÀ lượt nightly đỏ trong n8n.
      throw new Error(
        `KHÔNG vá được tồn kho: lượt kéo products shop kho gần nhất ${
          moc?.chayLuc ? `cách đây ${tuoiGio.toFixed(1)} giờ` : "KHÔNG có trong nhật ký"
        } (trần ${TRAN_TUOI_GIO} giờ). Bình thường lượt vá này chỉ được gọi ở CUỐI workflow ` +
          `pancake-nightly, ngay sau khi chính nó kéo products — nên lỗi này nghĩa là bước kéo ` +
          `products trong lượt đêm đã trượt (xem lỗi phía trên trong cùng lượt chạy n8n). ` +
          `Gọi tay lúc khác cũng ra lỗi này: bấm "Đồng bộ ngay" trong app rồi thử lại. ` +
          `Tồn kho giữ theo số webhook, KHÔNG bị đè.`,
      );
    }

    // Chụp lại tồn do WEBHOOK ghi TRƯỚC khi transform đè. Tập này rất nhỏ (chỉ biến thể vừa có
    // biến động trong ngày), nhưng phải có: transform ghi tồn cho MỌI sản phẩm từ ảnh Bronze, mà
    // ảnh đó có thể cũ hơn sự kiện webhook vài phút (bán lúc 02:55, lượt vá 03:00, ảnh Bronze chụp
    // 02:30) ⇒ không giữ lại thì mỗi đêm tồn có thể lùi về trạng thái trước đơn gần nhất.
    const chupLuc = new Date();
    const webhookGhi = await prisma.variant.findMany({
      where: { stockUpdatedAt: { not: null } },
      select: { id: true, stock: true, stockUpdatedAt: true },
    });

    const t = await transformFromRaw("products", warnings);

    // AI BIẾT CHUYỆN MỚI HƠN? So mốc webhook với LÚC API ĐI NHÌN Pancake (`moc.chayLuc` = lượt kéo
    // products shop kho gần nhất), KHÔNG so với `fetchedAt` của từng sản phẩm.
    //
    // Vì sao KHÔNG dùng `fetchedAt` — cùng cái bẫy đã sửa ở chốt chặn, lần này ở dạng khó thấy hơn:
    // `fetchedAt` chỉ nhích khi payload sản phẩm ĐỔI, còn `stockUpdatedAt` nhích cả khi tồn KHÔNG
    // đổi (đo prod 2026-07-27: Pancake bắn 2 sự kiện cho một dòng đơn, sự kiện thứ hai mang
    // `remain_quantity` y hệt, chỉ khác `actual_remain_quantity`). Biến thể như vậy sẽ có
    // `stockUpdatedAt` > `fetchedAt` MÃI MÃI ⇒ nằm trong `giuLai` mọi đêm ⇒ API mất hẳn quyền sửa
    // tồn của nó và không có đường tự lành. Lượt kéo products thì luôn đọc trạng thái HIỆN TẠI của
    // Pancake, nên sự kiện cũ hơn lần API đi nhìn chắc chắn đã được phản ánh trong ảnh Bronze.
    const mocApiNhin = moc?.chayLuc?.getTime() ?? 0;

    // Webhook biết chuyện MỚI HƠN ⇒ trả tồn webhook về chỗ cũ, giữ nguyên mốc để guard thứ tự còn
    // điểm tựa. Ngược lại ⇒ API đã khẳng định, xoá mốc webhook.
    // Transform ở trên mất 10-120 giây, trong quãng đó webhook VẪN ghi tiếp. Nên cả hai câu lệnh
    // dưới đây đều phải là compare-and-set trên `stockUpdatedAt`: bản ghi nào đổi mốc kể từ lúc chụp
    // là bản MỚI HƠN mọi thứ ta đang cầm ⇒ không được đụng vào.
    const giuLai = webhookGhi.filter((v) => (v.stockUpdatedAt?.getTime() ?? 0) > mocApiNhin);
    let daGiu = 0;
    for (const v of giuLai) {
      // `stockUpdatedAt: v.stockUpdatedAt` = điều kiện "mốc chưa đổi kể từ lúc chụp". Nếu webhook vừa
      // ghi bản mới hơn trong lúc transform chạy thì 0 dòng khớp — đúng ý, số của nó mới nhất.
      const r = await prisma.variant.updateMany({
        where: { id: v.id, stockUpdatedAt: v.stockUpdatedAt },
        data: { stock: v.stock, stockUpdatedAt: v.stockUpdatedAt },
      });
      daGiu += r.count;
    }
    // Chỉ xoá mốc của những dòng đã có TRƯỚC lúc chụp (`lte: chupLuc`). Dòng do webhook ghi TRONG
    // lúc transform chạy có mốc muộn hơn ⇒ giữ lại, nếu không guard thứ tự mất điểm tựa so sánh.
    const { count } = await prisma.variant.updateMany({
      where: {
        stockUpdatedAt: { not: null, lte: chupLuc },
        id: { notIn: giuLai.map((v) => v.id) },
      },
      data: { stockUpdatedAt: null },
    });

    // Mốc để chủ shop (và người soi lỗi) biết lượt vá gần nhất chạy lúc nào — panel /cai-dat đọc key
    // này và tô đỏ khi quá 26 giờ. Không có mốc thì "vá đêm" là niềm tin, không phải sự thật kiểm được.
    await prisma.setting.upsert({
      where: { key: KEY_MOC_VA_TON_KHO },
      create: { key: KEY_MOC_VA_TON_KHO, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });

    // ĐẾM LỆCH GIÁ VỐN — nối vào đây vì đúng lúc Bronze products vừa tươi nhất trong đêm; làm chỗ
    // khác thì phải kéo lại dữ liệu đã có sẵn. Con số đẩy lên badge sidebar để chủ shop KHÔNG phải
    // nhớ mà chạy CLI (yêu cầu 2026-09-07).
    //
    // KHÔNG được để việc đếm kéo sập lượt vá tồn: vá tồn là thứ giữ cho "API là chuẩn" đúng với tồn
    // kho, còn đếm chỉ là tín hiệu nhắc việc. Hỏng thì cảnh báo rồi đi tiếp — mốc không được ghi nên
    // trạng thái tự chuyển "tre" sau 26 giờ, chủ shop vẫn thấy có gì đó không ổn.
    let soLechGiaVon: number | null = null;
    try {
      soLechGiaVon = await capNhatSoLechGiaVon();
    } catch (e) {
      warnings.push(`Đếm lệch giá vốn hỏng (vá tồn vẫn OK): ${e instanceof Error ? e.message : String(e)}`);
    }

    // ĐẾM PHIẾU NHẬP CHƯA GHI — nối vào đây vì workflow `pancake-nightly` land stream `purchases`
    // TRƯỚC khi gọi endpoint này (STREAMS chạy hết rồi mới tới bước vá tồn), nên Bronze phiếu nhập
    // đã tươi nhất trong đêm. Cùng khuôn + cùng lý do nuốt lỗi với phép đếm giá vốn ngay trên: đếm
    // chỉ là tín hiệu nhắc việc, KHÔNG được kéo sập lượt vá tồn.
    let soPhieuNhapChuaGhi: number | null = null;
    let soViecHauKiemPhieuNhap: number | null = null;
    try {
      const soViec = await capNhatSoPhieuNhapChuaGhi();
      soPhieuNhapChuaGhi = soViec.choDuyet;
      soViecHauKiemPhieuNhap = soViec.hauKiem;
    } catch (e) {
      warnings.push(
        `Đếm phiếu nhập chưa ghi hỏng (vá tồn vẫn OK): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return {
      mode: "resynced" as const,
      productsUpserted: t.productsUpserted,
      variantsUpserted: t.variantsUpserted,
      skipped: t.skipped,
      /** Số biến thể lệch giá vốn với Pancake; `null` = lượt đếm hỏng (xem warnings). */
      soLechGiaVon,
      /** Số phiếu nhập Pancake chưa vào Sổ chi phí; `null` = lượt đếm hỏng (xem warnings). */
      soPhieuNhapChuaGhi,
      /** Số phiếu ĐÃ ghi nay bị huỷ/đổi tiền/trạng thái lạ + phiếu trạng thái lạ chưa ghi. */
      soViecHauKiemPhieuNhap,
      /** Số biến thể trả tồn về cho API khẳng định. */
      stockMocXoa: count,
      /** Số biến thể GIỮ tồn webhook vì nó mới hơn ảnh Bronze (sẽ về 0 ở lượt sau). */
      stockGiuWebhook: daGiu,
    };
  });
}
