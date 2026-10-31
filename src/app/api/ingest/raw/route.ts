import type { SyncKind } from "@/generated/prisma/client";

import { routeQuaCua } from "@/lib/backup/cong-ghi-toan-cuc";
import { hasBronzeBacklog, isBronzeOnly, markBronzeBacklog } from "@/lib/bronze/bronze-only";
import { coTheDoiSoat, demDaHachToan, loiBoDongPhaiBaoDo } from "@/lib/bronze/doi-soat-hach-toan";
import { locDonChuaDongDau } from "@/lib/bronze/ket-cuc-silver";
import { giuKhoaLandDon } from "@/lib/bronze/khoa-land-don";
import { docChupLuc, kiemCuaSoChupLuc, landRaw, LoiThieuKhoaStreamTien } from "@/lib/bronze/land-raw";
import { BRONZE_STREAMS, isBronzeStream } from "@/lib/bronze/streams";
import { transformFromRaw, type TransformStats } from "@/lib/bronze/transform-from-raw";
import { BANG_LAN_THAY } from "@/lib/bronze/transform-raw-helpers";
import { docBodyCoTran } from "@/lib/ingest/doc-body-co-tran";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { withSyncLog } from "@/lib/ingest/sync-log";
import { layCauHinhShop, shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { LUOT_ID_HOP_LE } from "@/lib/no-phai-tra/dau-luot-hoa-don-tiktok";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/ingest/raw — n8n đẩy TEXT THÔ Pancake trả về (một stream, một shop, một trang).
 * THAY HẲN /api/ingest/pancake (không giữ 2 nguồn sự thật).
 *
 * Body: `{ stream: BronzeStream, shopId: string, payload: string, ngay?: "YYYY-MM-DD", chupLuc?: ISO 8601 có múi giờ, luotId?: string }`.
 * `chupLuc` = lúc n8n BẮT ĐẦU GET trang (mốc nguồn chụp, theo TRANG) — xem nhánh kiểm bên dưới.
 * `payload` là CHUỖI: nội dung JSON của Pancake KHÔNG bị JS parse → int64 an toàn
 * (chỉ các field vỏ ngoài của request mới đi qua `JSON.parse`).
 * `ngay` chỉ dành cho stream khai `chapNhanNgay` (record không mang trường ngày) — 3 nhánh 400 ở
 * dưới, fail-closed cả hai chiều: gửi thừa cũng chặn, thiếu cũng chặn.
 * `luotId?` (mã lượt kéo — n8n gửi id execution) — mọi stream nhận, sai khuôn ⇒ 400; có thì mọi dòng SyncLog của trang
 * mang `stats.luotId` (xem dưới).
 *
 * Luồng: ① LAND (commit ngay, không lọc) → ② TRANSFORM ĐÚNG entity vừa land (`landedIds`).
 * Transform lỗi ⇒ raw vẫn còn: sửa code rồi gọi `transformFromRaw(stream, warnings)` KHÔNG kèm
 * `externalIds` (đường rebuild — quét cả bảng), KHÔNG cần fetch lại Pancake.
 *
 * `BRONZE_ONLY=true` ⇒ bỏ bước ②: chỉ land raw, Silver đứng yên (xem `bronze-only.ts`). Dựng lại
 * Silver sau bằng `scripts/rebuild-from-raw.ts` — không phải fetch lại Pancake.
 * Land throw (envelope không có mảng `data` — key hết hạn/rate-limit) ⇒ withSyncLog ghi SyncLog
 * ERROR + trả 500 cho ĐÚNG trang đó. Cố ý: kêu to, không nuốt lặng một trang dữ liệu.
 *
 * MỌI dòng SyncLog của route (RUNNING, OK, ERROR — kể cả nhánh 500) mang `stats.stream`, `stats.shopId`
 * (bc_id với `tiktokbusiness/*`) và `stats.mode`: cổng chốt sao kê thẻ (`lyDoHoaDonTiktokChuaDu`) soi trang
 * hoá đơn LỖI theo từng BC — dòng 500 thiếu dấu là trang hỏng mà cổng không thấy. `mode` của nhánh 500 =
 * `loi-<bước>` (`chuan-bi` | `land` | `transform` | `doi-soat`); dòng RUNNING mang `dang-xu-ly` (tiến trình chết
 * giữa chừng thì dòng dọn treo giữ dấu này). Request mang `luotId` ⇒ thêm `stats.luotId` trên cả ba loại dòng (cổng gom
 * trang theo lượt kéo). Từ chối ở cửa (400/413) xảy ra TRƯỚC khi có SyncLog — không ghi
 * dòng nào (không có stream hợp lệ thì không có `kind` để ghi mà không đoán).
 *
 * `stats` là số của TRANG NÀY (không phải tổng tích luỹ toàn bảng).
 */

/**
 * Trần 10MB tính theo BYTE UTF-8 của CẢ thân request (vỏ JSON + payload đã escape) — 1 trang
 * Pancake thực tế < 1MB. Áp TRƯỚC khi đọc trọn body (Content-Length rồi đếm byte theo luồng), nên
 * body khổng lồ bị chặn mà không dựng vào RAM, không đụng Postgres. Payload nằm trong body nên
 * body ≤ trần thì payload (đếm ký tự) cũng chắc chắn ≤ trần — không cần kiểm lần hai.
 */
const MAX_PAYLOAD_LENGTH = 10_000_000;

/** Cửa sổ cho transaction land 1 trang (1 truy vấn đếm + 1 INSERT nhiều dòng). */
const TIMEOUT_LAND_TRANG_MS = 60_000;

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  // Cửa ghi: đang phục hồi ⇒ 503; không thì đếm suốt request để lượt phục hồi CHỜ land + transform
  // của trang này chạy trọn rồi mới chụp bản lùi (không cắt giữa land và transform).
  return routeQuaCua(() => xuLyPost(req));
}

async function xuLyPost(req: Request): Promise<Response> {
  // Đọc thân có trần TRƯỚC khi parse. Lỗi đọc luồng (client ngắt giữa chừng) rơi về đúng nhánh
  // 400 mà `req.json()` cũ trả cho cùng ca.
  const doc = await docBodyCoTran(req, MAX_PAYLOAD_LENGTH).catch(() => null);
  if (doc === null) {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!doc.ok) {
    return Response.json(
      {
        ok: false,
        error: `payload ${doc.bytes} byte vượt trần ${MAX_PAYLOAD_LENGTH} byte — giảm page size khi fetch Pancake`,
      },
      { status: 413 }
    );
  }

  let body: { stream?: string; shopId?: string; payload?: string; ngay?: string; chupLuc?: unknown; luotId?: unknown };
  try {
    const parsed: unknown = JSON.parse(doc.text);
    // `null`/mảng/số là JSON hợp lệ nhưng không phải vỏ request — trước đây lọt tới bước
    // destructure rồi nổ 500; chặn 400 tại cửa.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not object");
    body = parsed as typeof body;
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const { stream, shopId, payload, ngay } = body;
  if (!stream || !isBronzeStream(stream)) {
    return Response.json({ ok: false, error: `stream không hợp lệ: ${stream}` }, { status: 400 });
  }
  if (!shopId || typeof shopId !== "string" || typeof payload !== "string") {
    return Response.json({ ok: false, error: "thiếu shopId hoặc payload (string)" }, { status: 400 });
  }

  // `ngay` — CỘNG THÊM, tuỳ chọn ở mức hợp đồng nhưng BẮT BUỘC với stream khai `chapNhanNgay`
  // (record là TỔNG cả cửa sổ, không mang trường ngày nào — thiếu `ngay` thì lượt hôm sau đè lượt
  // hôm trước, chuỗi ngày biến mất lặng lẽ). Kiểm Ở CỬA để n8n nhận 400 kèm lý do thay vì 500 mơ hồ
  // từ tầng dưới; landRaw vẫn kiểm lại lần nữa (webhook/script cũng gọi thẳng nó).
  const { chapNhanNgay } = BRONZE_STREAMS[stream];
  if (ngay !== undefined) {
    if (typeof ngay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ngay)) {
      return Response.json({ ok: false, error: "ngay phải đúng khuôn YYYY-MM-DD (giờ VN)" }, { status: 400 });
    }
    if (!chapNhanNgay) {
      return Response.json(
        { ok: false, error: `stream "${stream}" không nhận 'ngay' (chỉ stream khai chapNhanNgay)` },
        { status: 400 }
      );
    }
  } else if (chapNhanNgay) {
    return Response.json(
      { ok: false, error: `stream "${stream}" BẮT BUỘC có 'ngay': record không mang trường ngày nào` },
      { status: 400 }
    );
  }

  // `luotId` — mã LƯỢT kéo (n8n gửi `$execution.id`), tuỳ chọn. Gắn vào `dauNhanDien` ⇒ mọi dòng SyncLog của trang
  // (RUNNING, OK, ERROR kể cả nhánh 500) mang `stats.luotId`: cổng chốt sao kê thẻ gom trang hoá đơn theo đúng mã này
  // (`gomLuotHoaDon`), thiếu mã mới đoán theo khoảng cách. Sai khuôn ⇒ 400 TRƯỚC khi land (fail-closed như `ngay`):
  // nhận mã rác là gom nhầm lượt ở cổng.
  const luotIdTho = body.luotId;
  if (luotIdTho !== undefined && (typeof luotIdTho !== "string" || !LUOT_ID_HOP_LE.test(luotIdTho))) {
    return Response.json({ ok: false, error: "luotId phải đúng khuôn [A-Za-z0-9_-], 1–64 ký tự" }, { status: 400 });
  }
  const luotId = typeof luotIdTho === "string" ? luotIdTho : undefined;

  // `chupLuc` — tuỳ chọn, mọi stream: lúc n8n BẮT ĐẦU GET trang này. Chỉ bảng có cột lần thấy (`BANG_LAN_THAY`) dùng nó
  // (`mocChup`); stream khác nhận rồi bỏ qua, để n8n gửi đồng loạt. Sai khuôn / ngoài cửa sổ ⇒ 400 fail-closed như
  // `ngay`, TRƯỚC khi mở SyncLog: mốc tương lai nằm trong kho thô là ghim bản đó lên đầu khoá mãi mãi.
  const docChup = docChupLuc(body.chupLuc);
  if (!docChup.ok) return Response.json({ ok: false, error: docChup.loi }, { status: 400 });
  const coLanThay = BANG_LAN_THAY.has(BRONZE_STREAMS[stream].table);
  const chupLuc = coLanThay ? docChup.chupLuc : undefined;
  if (chupLuc !== undefined) {
    // Soi lại theo đồng hồ Postgres — đồng hồ mà mốc này sẽ bị so cùng (`fetchedAt`/`lanThayCuoi`).
    const loi = await kiemCuaSoChupLuc(chupLuc);
    if (loi !== null) return Response.json({ ok: false, error: loi }, { status: 400 });
  }

  // SyncLog PHẢI tách theo NGUỒN — 3 nguồn đi chung endpoint này:
  //   `tiktok/*`         → TikTok Shop Open API (phí + đối soát)
  //   `tiktokbusiness/*` → TikTok Business (chi tiêu quảng cáo) — API KHÁC HẲN, token khác
  //   `meta/*`           → Meta Marketing API (chi tiêu quảng cáo Facebook)
  //   còn lại            → Pancake (doanh thu)
  // Ghi chung một kind sẽ khiến nguồn này chạy OK "sơn xanh" trạng thái nguồn kia — chủ shop tin đơn
  // vẫn về trong khi Pancake đã chết nhiều ngày — và đẩy log thật ra khỏi 10 dòng gần nhất.
  const kind: SyncKind = stream.startsWith("tiktokbusiness/")
    ? "TIKTOK_ADS"
    : // Analytics + affiliate phải đứng TRƯỚC nhánh `tiktok/`: cả hai cũng bắt đầu bằng "tiktok/"
      // nên nếu để sau thì rơi vào TIKTOK_SHOP và lượt 02:30 sẽ "sơn xanh" trạng thái tài chính
      // 02:00 vừa chết. `tiktok/affiliate_` đi cùng lượt 02:30 nên chung kind với analytics.
      stream.startsWith("tiktok/analytics_") || stream.startsWith("tiktok/affiliate_")
      ? "TIKTOK_SHOP_ANALYTICS"
      : stream.startsWith("tiktok/")
        ? "TIKTOK_SHOP"
        : stream.startsWith("meta/")
          ? "META_ADS"
          : "PANCAKE";

  // Bước đang chạy — `dauKhiLoi` đọc lúc ném để dòng ERROR nói hỏng ở đâu (xem đầu file).
  let buoc: "chuan-bi" | "land" | "transform" | "doi-soat" = "chuan-bi";
  const dauNhanDien = { stream, shopId, mode: "dang-xu-ly", ...(luotId !== undefined ? { luotId } : {}) };
  const dauKhiLoi = () => ({ mode: `loi-${buoc}` });

  return withSyncLog(kind, async (warnings, syncLogId) => {
    // Resolve cấu hình shop TRƯỚC khi mở transaction: bước land của `orders` chạy trong
    // transaction giữ khoá tư vấn — để landRaw tự tra bảng `Setting` lúc đó là xin kết nối
    // THỨ HAI trong khi kết nối thứ nhất đang giữ khoá (webhook xếp hàng chờ cùng khoá cũng
    // giữ kết nối) ⇒ pool cạn là mọi đường ingest cùng nghẽn. Thiếu cấu hình ⇒ throw ngay ở
    // đây, withSyncLog ghi ERROR + 500 với thông báo "Chưa cấu hình shop ID" — kêu to đúng chỗ.
    //
    // Resolve LƯỜI theo stream: stream danh sách MỞ (`shops: null` — báo cáo ads Meta/TikTok
    // Business) không dùng shop id Pancake nào, ép nó chờ cấu hình Pancake là buộc hai nguồn
    // không liên quan chết chung (bản clone chỉ bật ads vẫn phải điền shop Pancake mới land được).
    const { shops } = BRONZE_STREAMS[stream];
    const cauHinh = shops === null ? null : await layCauHinhShop();
    const shopIdsHopLe = shops === null ? undefined : await shopIdsChoVai(shops);

    // Stream `orders` land TRONG transaction có khoá tư vấn — cùng khoá mà guard thứ tự của
    // webhook giữ (`khoa-land-don.ts`). Không có bước này thì guard bên webhook vẫn hở: nó đọc
    // xong, trang API chen vào land bản mới, rồi webhook mới land bản cũ đè lên. Stream khác
    // KHÔNG có guard đọc-rồi-ghi nào nên giữ nguyên đường cũ (một INSERT tự nó đã nguyên tử).
    let ketQuaLand: Awaited<ReturnType<typeof landRaw>>;
    buoc = "land";
    try {
      ketQuaLand =
        stream === "orders"
          ? await prisma.$transaction(
              async (tx) => {
                await giuKhoaLandDon(tx);
                return landRaw(stream, shopId, payload, syncLogId, tx, shopIdsHopLe);
              },
              { timeout: TIMEOUT_LAND_TRANG_MS }
            )
          : await landRaw(stream, shopId, payload, syncLogId, undefined, shopIdsHopLe, ngay, chupLuc);
    } catch (err) {
      // Stream TIỀN có record thiếu khoá ⇒ landRaw đã từ chối CẢ trang (0 dòng Bronze). Báo ERROR mà
      // vẫn HTTP 200: ném tiếp thành 500 thì n8n thử lại cùng trang rồi dừng mọi trang sau của lượt.
      // KHÔNG bật cờ backlog: không có gì nằm trong kho thô để dựng lại — lượt kéo lại mới cứu được.
      if (!(err instanceof LoiThieuKhoaStreamTien)) throw err;
      warnings.push(err.message);
      return {
        stream,
        shopId,
        landed: 0,
        skippedNoId: err.soThieuKhoa,
        seen: 0,
        mode: "tu-choi-thieu-khoa" as const,
        loiSauKhiGhi: err.message,
      };
    }
    const { landed, skippedNoId, landedIds, seenIds, reseenIds, soKhoaKetDuoiDau } = ketQuaLand;
    if (skippedNoId > 0) warnings.push(`${skippedNoId} record thiếu 'id' → không land được`);
    // Bảng có lần thấy mà trang KHÔNG kèm `chupLuc` (workflow n8n chưa cập nhật, script): `landRaw` không cho trang này
    // vượt bản đầu của khoá đã có mốc chụp, khoá thuần di sản giữ luật cũ.
    //  - Có khoá THẬT SỰ bị chặn (nguồn báo nội dung khác bản đầu) ⇒ ĐỎ: SyncLog ERROR, HTTP 200, dữ liệu đã land. Bản
    //    mới chỉ lên đầu ở lượt CÓ `chupLuc` kế tiếp — workflow bị lùi / cài dở thì lượt đó không tới, biến thể mới thiếu
    //    giá vốn hay chi phí ads ngày cũ kẹt mãi (ads ra khỏi cửa sổ 7 ngày là kẹt hẳn) mà cảnh báo trên dòng OK không
    //    ai thấy (banner chỉ soi ERROR). KHÔNG bật cờ backlog: dựng lại từ kho thô đọc đúng bản đầu cũ, không cứu được.
    //  - Không chặn gì (khoá thuần di sản — trước khi nhập workflow mới, hoặc nội dung trùng bản đầu) ⇒ chỉ cảnh báo, để
    //    giai đoạn chuyển tiếp không đỏ mỗi đêm.
    const loiKetDuoiDau =
      soKhoaKetDuoiDau > 0
        ? `Stream "${stream}" (shop ${shopId}): ${soKhoaKetDuoiDau} khoá có nội dung mới bị giữ DƯỚI bản đầu vì trang ` +
          "không kèm chupLuc — còn workflow chưa gửi chupLuc (bị lùi bản / cài dở), bản mới nằm dưới bản đầu tới lượt " +
          "có chupLuc. Cài lại workflow theo n8n/huong-dan-cai-dat-workflows.md rồi chạy lại lượt kéo; dựng lại từ kho " +
          "thô KHÔNG cứu được."
        : null;
    if (loiKetDuoiDau !== null) {
      warnings.push(loiKetDuoiDau);
    } else if (coLanThay && chupLuc === undefined) {
      warnings.push(
        "trang không kèm chupLuc ⇒ không vượt được bản đầu của khoá đã có mốc chụp (bản mới chỉ lên đầu ở lượt có chupLuc kế tiếp); còn workflow chưa cài lại?",
      );
    }

    // Chế độ chỉ-land: dừng ngay sau Bronze. Ghi warning để SyncLog nói rõ vì sao Silver không đổi —
    // im lặng bỏ transform sẽ khiến người đọc log tưởng dữ liệu đã lên bảng nghiệp vụ.
    if (isBronzeOnly()) {
      await markBronzeBacklog();
      warnings.push("BRONZE_ONLY: chỉ land raw, KHÔNG dựng Silver");
      return {
        stream,
        shopId,
        landed,
        skippedNoId,
        seen: seenIds.length,
        mode: "bronze-only" as const,
        ...(loiKetDuoiDau !== null ? { loiSauKhiGhi: loiKetDuoiDau } : {}),
      };
    }

    buoc = "transform";
    // Backlog từ đợt trước (BRONZE_ONLY cố ý HOẶC transform lỗi ngoài ý): raw đã nằm sẵn trong
    // Bronze nên kéo lại chỉ ra hash TRÙNG (`landedIds` rỗng) ⇒ transform theo trang KHÔNG dựng
    // được gì. Phải rebuild toàn bảng, nếu không thì đơn cũ lặng lẽ không bao giờ vào Silver →
    // doanh thu thiếu mà log vẫn báo OK.
    if (await hasBronzeBacklog()) {
      warnings.push(
        "CÓ BACKLOG Bronze chưa dựng Silver (đợt BRONZE_ONLY hoặc transform lỗi trước đó) — " +
          "chạy `npx tsx scripts/rebuild-from-raw.ts`, đồng bộ theo trang KHÔNG bù được"
      );
    }

    // CHỈ transform entity vừa land ở trang này — CỘNG các đơn của trang mà bản mới nhất trong
    // Bronze vẫn CHƯA đóng dấu kết cục.
    //
    // Vế thứ hai là đường TỰ CHỮA: tiến trình chết giữa "Bronze đã commit" và "Silver ghi xong"
    // thì lượt n8n gửi lại đúng trang đó trùng `payloadHash` ⇒ `landedIds` RỖNG ⇒ nếu chỉ nhìn nó
    // thì transform không có gì làm, HTTP 200 sạch trơn, đơn kẹt vĩnh viễn (đo thật trước khi vá:
    // `landed:0`, `ordersUpserted:0`, 0 cảnh báo).
    //
    // CHỈ hỏi các id THẤY MÀ KHÔNG VỪA LAND: dòng vừa insert luôn mang trạng thái "chưa đóng dấu"
    // (mặc định của cột), nên hỏi cả chúng thì MỌI đơn mới đều bị kể là "còn dở từ lượt trước" —
    // cảnh báo giả ở mọi lượt đồng bộ bình thường, đúng thứ làm người đọc log mất phản xạ.
    const landedSet = new Set(landedIds);
    const seenNhungKhongLand = seenIds.filter((id) => !landedSet.has(id));
    const donChuaXong =
      stream === "orders" ? await locDonChuaDongDau(shopId, seenNhungKhongLand) : [];
    if (donChuaXong.length > 0) {
      warnings.push(
        `${donChuaXong.length} đơn của trang này còn dở từ lượt trước (nhiều khả năng tiến trình ` +
          `dừng giữa chừng) — dựng lại trong lượt này`
      );
    }
    // Vế thứ ba: khoá mà nguồn trả LẠI một nội dung cũ đã có (A→B→A) — trùng hash nên không vào
    // `landedIds`, nhưng `landRaw` vừa đưa bản đó lên đầu (`lanThayCuoi`) ⇒ Silver phải dựng lại theo
    // nó. Chỉ đúng các khoá đó (không cả trang); bảng ngoài `BANG_LAN_THAY` luôn rỗng.
    const canTransform = [...new Set([...landedIds, ...donChuaXong, ...reseenIds])];

    let t: TransformStats;
    try {
      // Truyền shopId → nhánh orders lọc raw theo shop (dùng index + tránh over-transform khi 2
      // shop trùng externalId). Các nhánh khác bỏ qua (neo shop cố định theo nghiệp vụ).
      t = await transformFromRaw(stream, warnings, { externalIds: canTransform, shopId });
    } catch (err) {
      // Bronze đã COMMIT dòng nhưng Silver dựng LỖI. Bật backlog để lần ingest sau KÊU TO:
      // retry cùng payload trùng hash ⇒ landedIds rỗng ⇒ transform 0 dòng ⇒ nếu không cờ này
      // sẽ trả OK im lặng dù đơn chưa vào Silver. Ném tiếp để withSyncLog ghi ERROR + 500.
      await markBronzeBacklog();
      throw err;
    }
    // Đối soát "đã land" vs "đã hạch toán": mọi id đã land PHẢI được hạch toán ĐÚNG Ý = vào Silver,
    // bị luật loại CÓ CHỦ ĐÍCH (mirror kho — bất biến #2), hoặc không ghi vì Silver đang giữ bản MỚI
    // HƠN. `t.skipped` (record hỏng shape hoặc upsert lỗi) KHÔNG tính là hạch toán: nó đã nằm trong
    // Bronze mà KHÔNG vào Silver, và dedupe theo hash chặn transform lại ⇒ kẹt vĩnh viễn = thiếu số
    // âm thầm. CỐ Ý để nó rơi vào `distinctLanded > accounted` ⇒ bật backlog + cảnh báo, buộc sửa
    // mapping rồi dựng lại (KHÔNG crash — phần đã dựng vẫn đúng).
    //
    // Công thức + phạm vi soi nằm MỘT chỗ (`doi-soat-hach-toan.ts`) vì đường webhook soi cùng luật và
    // test khoá cùng công thức; chép ra nhiều bản thì bản nào trôi cũng làm cổng này im lặng.
    // Phạm vi hiện tại: `orders`, `products` (shop kho), và 3 stream tiền-đã-về 1:1
    // (`tiktok/statements`, `tiktok/payments`, `shopee/wallet`). CỐ Ý ngoài phạm vi:
    // `tiktok/statement_transactions` (land mọi giao dịch, chỉ khoản quảng cáo có Silver) và các
    // stream land-only — soi chúng là kêu oan backlog mỗi đêm dù không mất gì.
    //
    // Số KỲ VỌNG là tập ĐÃ YÊU CẦU DỰNG (`canTransform`), không phải riêng tập vừa land: lượt tự
    // chữa có `landed = 0` nhưng vẫn đang dựng lại một đơn còn dở, nên nếu vẫn so theo `landedIds`
    // thì phép so thành `0 > 0` — cổng im lặng đúng lúc lượt cứu chữa THẤT BẠI LẦN NỮA, tức đơn
    // kẹt vẫn kẹt mà HTTP vẫn 200. Với stream khác `canTransform` chính bằng `landedIds` nên công
    // thức không đổi.
    buoc = "doi-soat";
    const accounted = demDaHachToan(t);
    const distinctLanded = new Set(canTransform).size;
    if (coTheDoiSoat(stream, shopId, cauHinh) && distinctLanded > accounted) {
      warnings.push(
        `Stream "${stream}": ${distinctLanded} id cần dựng nhưng chỉ ${accounted} được hạch toán` +
          (t.skipped > 0 ? ` (${t.skipped} record hỏng shape — xem cảnh báo bên trên)` : "") +
          ` — có dòng chưa vào Silver; sửa mapping rồi dựng lại từ kho thô`
      );
      await markBronzeBacklog();
    }
    // Hoá đơn / ảnh chụp chi phí TikTok Business: một record bỏ là sai tiền (nợ thẻ / tín dụng tặng) mà cổng đối
    // soát ở trên không soi được (danh sách bc_id mở) ⇒ báo ĐỎ: cờ backlog + SyncLog ERROR, HTTP vẫn 200 (`withSyncLog`
    // — n8n không thử lại, các trang sau vẫn được gửi).
    // Stream tiền còn lại (TikTok Shop sao kê / giao dịch / lệnh rút): record đã land mà transform bỏ
    // (vd tiền không đọc được — mapper từ chối để KHÔNG ghi 0 đè số đúng) cũng là sai tiền ⇒ cùng
    // luật đỏ. Câu riêng của hai stream TikTok Business (nói rõ hậu quả nợ thẻ / tín dụng) đi trước.
    const loiBoDong =
      loiBoDongPhaiBaoDo(stream, t.skipped) ??
      (BRONZE_STREAMS[stream].laStreamTien && t.skipped > 0
        ? `Stream "${stream}": ${t.skipped} record đã vào kho thô nhưng KHÔNG dựng được Silver (xem cảnh báo) — ` +
          "số tiền cũ trong Silver được giữ nguyên, bản mới bị bỏ. Sửa mapping rồi dựng lại từ kho thô."
        : null);
    if (loiBoDong !== null) await markBronzeBacklog();
    // Hai lỗi sau-khi-ghi độc lập nhau ⇒ giữ cả hai trong `error` của SyncLog (lỗi bỏ dòng tiền đi trước).
    const loiSauKhiGhi = [loiBoDong, loiKetDuoiDau].filter((l): l is string => l !== null).join(" | ");
    return {
      stream,
      shopId,
      landed,
      skippedNoId,
      seen: seenIds.length,
      mode: "land+transform" as const,
      ...t,
      ...(loiSauKhiGhi ? { loiSauKhiGhi } : {}),
    };
  }, { dauNhanDien, dauKhiLoi });
}
