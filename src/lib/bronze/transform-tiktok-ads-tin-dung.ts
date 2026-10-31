import type { Prisma } from "@/generated/prisma/client";
import { buildVatByMonth } from "@/lib/ingest/ads-report-mapping";
import {
  mapAnhChupChiPhiTiktok,
  type AnhChupChiPhiTho,
} from "@/lib/ingest/tiktok-ads-tin-dung-mapping";
import {
  ghiAnhChupTinDungTiktok,
  khoaNgayTinDung,
  type BoDemTinDung,
  type KetQuaGhiTinDung,
} from "@/lib/ingest/tiktok-ads-tin-dung-upsert";
import { prisma } from "@/lib/prisma";

import {
  chamMoc,
  mocPhienBanSql,
  thuTuPhienBanSql,
  type TransformOptions,
  type TransformStats,
} from "./transform-raw-helpers";

/**
 * Nhánh chi phí quảng cáo theo tài khoản (`tiktokbusiness/cost`) → Silver `TiktokAdsTinDung` (phần ads trả bằng
 * TÍN DỤNG TIKTOK TẶNG theo ngày). Gọi từ `transform-from-raw.ts`, chạy ở CẢ đường ingest thường ngày
 * (`/api/ingest/raw`, theo `externalIds` = ngày vừa land) lẫn lượt dựng lại (quét cả bảng). `BRONZE_ONLY` do route
 * chặn TRƯỚC khi tới đây — lượt dựng lại bù sau.
 *
 * Người đọc DUY NHẤT của Silver: P&L (`pnl.ts`). Không chạm `Expense` (bảng app sở hữu) ⇒ không cần cờ `rebuild`,
 * không cắt tại mốc Nợ phải trả M (P&L không đổi theo M; chủ shop chốt áp TOÀN BỘ lịch sử).
 *
 * THỨ TỰ khi hai lượt chạy song song (trang ingest đêm + lượt dựng lại, hai trang cùng ngày): mỗi ảnh chụp (bc, ngày)
 * là MỘT transaction giữ khoá NGÀY (`khoaNgayTinDung`) TỪ bước ĐỌC ảnh mới nhất trong kho thô TỚI bước ghi. Đọc ngoài
 * khoá (như trước) thì lượt cầm ảnh cũ có thể ghi SAU lượt cầm ảnh mới — đè số cũ và xoá advertiser chỉ có trong ảnh
 * mới. Chốt `nguonFetchedAt` ở câu ghi là lưới thứ hai.
 */

type AnhChupRow = AnhChupChiPhiTho & { externalId: string; mocPhienBan: Date };

/** Timeout transaction một ảnh chụp: đọc + ghi vài chục dòng là mili-giây; phần dư cho lúc chờ khoá ngày. */
const TIMEOUT_MOT_ANH_MS = 30_000;

type Loc = { shopId?: string; externalIds?: string[] };

/** Điều kiện WHERE + tham số cho bộ lọc (bc_id, ngày). `null` = `externalIds` rỗng ⇒ không có gì để đọc. */
function dieuKienLoc(filter: Loc): { where: string; params: unknown[] } | null {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.shopId !== undefined) {
    params.push(filter.shopId);
    conds.push(`"shopId" = $${params.length}`);
  }
  if (filter.externalIds !== undefined) {
    if (filter.externalIds.length === 0) return null;
    params.push(filter.externalIds);
    conds.push(`"externalId" = ANY($${params.length}::text[])`);
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

/**
 * Các ảnh chụp (bc_id, ngày) cần dựng — CHỈ khoá, không payload: payload đọc lại trong transaction có khoá ngày
 * (`docAnhChupMoiNhat`). `externalIds` mảng rỗng ⇒ 0 khoá (KHÔNG rơi về quét cả bảng) — hợp đồng `LatestFilter`.
 */
async function docKhoaAnhChup(filter: Loc): Promise<{ bcId: string; ngay: string }[]> {
  const loc = dieuKienLoc(filter);
  if (loc === null) return [];
  return prisma.$queryRawUnsafe<{ bcId: string; ngay: string }[]>(
    `SELECT DISTINCT "shopId" AS "bcId", "externalId" AS ngay FROM "RawTiktokBusinessCost" ${loc.where} ORDER BY 1, 2`,
    ...loc.params,
  );
}

/**
 * Ảnh chụp MỚI NHẤT của mỗi (bc_id, ngày) + đầu từng TRANG + các phần tử `cost_list` của MỌI trang rút thành CHUỖI
 * ngay trong Postgres. Dòng Bronze có hình `{"trang":[<envelope trang 1>, …], "_ngay": …}` (xem
 * `bocAnhChupChiPhiTiktok`).
 *
 * Vì sao không `latestPayloads`: payload qua Prisma là `JSON.parse` ⇒ `advertiser_id` nếu là SỐ JSON 19 chữ số bị làm
 * tròn int64. Rút TỪNG trường cấp một của mỗi phần tử bằng `#>> '{}'` (jsonb giữ số chính xác — tiền âm dạng số
 * JSON `-995050` thành chuỗi `"-995050"`) — mapping chỉ đọc chuỗi. Phần tử không phải object ⇒ `null` ⇒ mapping trả
 * lý do (không ném lỗi Postgres thô giữa lượt). `trang` không phải mảng ⇒ `cacTrang` NULL ⇒ mapping bỏ ảnh chụp.
 *
 * `externalIds` mảng rỗng = không có gì mới land ⇒ 0 dòng (KHÔNG rơi về quét cả bảng) — cùng hợp đồng `LatestFilter`.
 * `shopId` (= bc_id) có thì lọc để dùng index `[shopId, externalId, fetchedAt]`. `db` = client transaction đang giữ
 * khoá ngày — đọc ở đây là đọc SAU khi giành khoá.
 */
async function docAnhChupMoiNhat(db: Prisma.TransactionClient, filter: Loc): Promise<AnhChupRow[]> {
  const loc = dieuKienLoc(filter);
  if (loc === null) return [];
  return db.$queryRawUnsafe<AnhChupRow[]>(
    `
    SELECT DISTINCT ON ("shopId", "externalId")
      "shopId" AS "bcId",
      "externalId",
      ${mocPhienBanSql("RawTiktokBusinessCost")} AS "mocPhienBan",
      payload->>'_ngay' AS ngay,
      CASE WHEN jsonb_typeof(payload->'trang') = 'array' THEN (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object(
              'code', p.e->>'code',
              'kieuData', jsonb_typeof(p.e->'data'),
              'kieuDanhSach', jsonb_typeof(p.e->'data'->'cost_list'),
              'trang', p.e->'data'->'page_info'->>'page',
              'tongTrang', p.e->'data'->'page_info'->>'total_page',
              'tongDong', p.e->'data'->'page_info'->>'total_number'
            )
            ORDER BY p.i
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(payload->'trang') WITH ORDINALITY AS p(e, i)
      ) END AS "cacTrang",
      CASE WHEN jsonb_typeof(payload->'trang') = 'array' THEN (
        SELECT coalesce(
          jsonb_agg(
            CASE WHEN jsonb_typeof(t.e) = 'object'
              THEN (SELECT jsonb_object_agg(x.k, x.v #>> '{}') FROM jsonb_each(t.e) AS x(k, v))
            END
            ORDER BY p.i, t.i
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(payload->'trang') WITH ORDINALITY AS p(e, i)
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.e->'data'->'cost_list') = 'array' THEN p.e->'data'->'cost_list' ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS t(e, i)
      ) END AS dong
    FROM "RawTiktokBusinessCost"
    ${loc.where}
    ORDER BY "shopId", "externalId", ${thuTuPhienBanSql("RawTiktokBusinessCost")}
    `,
    ...loc.params,
  );
}

/**
 * Bản mới nhất của các hoá đơn Business Center TẠO trong các THÁNG cần đo VAT (khoá `YYYY-MM` của `create_time`,
 * giờ ad account) — đọc MỘT lần mỗi lượt transform, chỉ đúng các tháng của ảnh chụp đang dựng thay vì cả kho hoá đơn
 * (mỗi đêm nhánh này chạy ~7 lần/BC). `buildVatByMonth` gom theo cùng khoá tháng đó nên kết quả y như đọc cả bảng.
 */
async function docHoaDonTheoThang(thang: string[]): Promise<unknown[]> {
  if (thang.length === 0) return [];
  const rows = await prisma.$queryRawUnsafe<{ payload: unknown }[]>(
    `
    SELECT payload FROM (
      SELECT DISTINCT ON ("shopId", "externalId") payload
      FROM "RawTiktokBusinessInvoice"
      ORDER BY "shopId", "externalId", ${thuTuPhienBanSql("RawTiktokBusinessInvoice")}
    ) moi_nhat
    WHERE left(payload->>'create_time', 7) = ANY($1::text[])
    `,
    thang,
  );
  return rows.map((r) => r.payload);
}

/**
 * Advertiser ĐÃ TỪNG có báo cáo chi tiêu trong kho thô (`RawTiktokBusinessReport.shopId` = advertiser_id, TOÀN lịch
 * sử) — nguồn của `Expense` ads TikTok (dựng lại `Expense` đọc đúng bảng này). Một truy vấn mỗi lượt transform.
 *
 * Vì sao lọc: ảnh chụp `/bc/account/cost/get/` gom MỌI advertiser của Business Center, còn P&L kẹp tín dụng theo
 * NGÀY (không theo advertiser). Advertiser có tín dụng mà không có `Expense` (chưa cấp quyền report) ⇒ tín dụng của
 * nó bị trừ vào ads của advertiser KHÁC ⇒ Lãi/Lỗ phồng. Đã đo một lần thật: T9 trừ nhầm 39.561đ.
 */
async function docAdvertiserCoBaoCao(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ shopId: string }[]>(
    `SELECT DISTINCT "shopId" FROM "RawTiktokBusinessReport"`,
  );
  return new Set(rows.map((r) => r.shopId));
}

/** Kết cục một ảnh chụp trong transaction — áp vào bộ đếm/cảnh báo SAU khi commit (rollback thì không đếm dở). */
type KetCucAnh =
  | { loai: "khong-con" }
  | { loai: "loi"; loi: string }
  | { loai: "xong"; ghi: KetQuaGhiTinDung; ngay: string; ngoaiSo: string[] };

/** Ảnh chụp chi phí TikTok trong kho thô → Silver `TiktokAdsTinDung` (cộng theo advertiser, nhân VAT tháng). */
export async function transformTiktokAdsTinDung(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, shopId, checkpoint } = opts;
  const cacKhoa = await docKhoaAnhChup({ shopId, externalIds });
  if (cacKhoa.length === 0) return;

  // VAT đo từ hoá đơn Business Center trong kho thô theo THÁNG — CÙNG hàm mà lượt dựng lại `Expense` ads dùng
  // (`transform-ads-expense.ts`). `Expense` ghi mỗi đêm thì dùng VAT đo trên CỬA SỔ ngày của n8n (`tinhVat`), nên
  // hai suất có thể lệch vài phần triệu ⇒ phần trừ ra lệch vài đồng/ngày (chấp nhận; dựng lại thì khớp). Cảnh báo của bước đo VAT
  // (tháng có hoá đơn mà không dòng nào khớp loại BILL|PAYMENT…) chỉ đẩy ở lượt DỰNG LẠI: trang ingest mỗi đêm
  // gọi nhánh này 7 lần/BC, lặp lại cùng câu cảnh báo cấp tháng là nhiễu nhật ký. Tháng lấy từ khoá (khoá = `_ngay`).
  const canhBaoVat: string[] = [];
  const thangCanDo = [...new Set(cacKhoa.map((k) => k.ngay.slice(0, 7)))];
  const [hoaDon, coBaoCao] = await Promise.all([docHoaDonTheoThang(thangCanDo), docAdvertiserCoBaoCao()]);
  const vat = buildVatByMonth(hoaDon, canhBaoVat);
  if (externalIds === undefined) warnings.push(...canhBaoVat);

  // advertiser (kèm BC) chưa có báo cáo chi tiêu → các ngày bị bỏ tín dụng trong lượt này. Gom lại để cảnh báo MỘT
  // câu mỗi advertiser thay vì một câu mỗi ngày.
  const ngoaiSo = new Map<string, { bcId: string; ngay: string[] }>();

  let i = 0;
  for (const k of cacKhoa) {
    await chamMoc(checkpoint, i++);
    let kq: KetCucAnh;
    try {
      kq = await prisma.$transaction(
        async (tx): Promise<KetCucAnh> => {
          await khoaNgayTinDung(tx, k.ngay);
          const [a] = await docAnhChupMoiNhat(tx, { shopId: k.bcId, externalIds: [k.ngay] });
          if (!a) return { loai: "khong-con" }; // kho thô vừa bị xoá (xoá dữ liệu) giữa hai bước đọc
          const m = mapAnhChupChiPhiTiktok(a);
          // Kẹt ở Bronze ⇒ `skipped`: lượt dựng lại giữ cờ backlog tới khi sửa mapping, đường ingest thường ngày báo
          // ĐỎ (route `/api/ingest/raw`); số cũ của ngày đó giữ nguyên.
          if (!m.ok) {
            return { loai: "loi", loi: `Bỏ qua ảnh chụp chi phí TikTok ${a.bcId} ngày ${a.externalId}: ${m.loi}` };
          }
          const vatRate = vat.rateForDate(m.ngay);
          // Tháng đo được VAT mà tỉ lệ vô lý — cùng luật lượt dựng lại `Expense` (không ghi số sai).
          if (vatRate === null) {
            return {
              loai: "loi",
              loi:
                `Bỏ qua tín dụng TikTok ${a.bcId} ngày ${m.ngay}: VAT tháng ${m.ngay.slice(0, 7)} ` +
                "đo được ngoài dải hợp lý",
            };
          }
          // Lọc TRƯỚC khi ghi: người ghi `deleteMany` theo danh sách SAU lọc ⇒ dòng cũ của advertiser lạc (ghi trước khi
          // có luật này) bị gỡ ở lượt kế — đúng ý, không còn trừ nhầm. Advertiser mới chưa kịp có báo cáo đêm đầu ⇒ tín
          // dụng ngày đó tạm bỏ; đêm sau (cửa sổ 7 ngày land lại ảnh chụp) có báo cáo thì tự ghi. KHÔNG `skipped` — đây
          // không phải dữ liệu hỏng, báo đỏ mỗi đêm là nhiễu. Chỉ cảnh báo/đếm khi advertiser THẬT có tín dụng (grant ≠ 0).
          const boNgoaiSo: string[] = [];
          const theoAdvertiser = m.theoAdvertiser.filter((d) => {
            if (coBaoCao.has(d.advertiserId)) return true;
            if (d.grantExVat !== 0) boNgoaiSo.push(d.advertiserId);
            return false;
          });
          const ghi = await ghiAnhChupTinDungTiktok(tx, a.bcId, { ...m, theoAdvertiser }, vatRate, a.mocPhienBan);
          return { loai: "xong", ghi, ngay: m.ngay, ngoaiSo: boNgoaiSo };
        },
        { timeout: TIMEOUT_MOT_ANH_MS },
      );
    } catch (e) {
      // Lỗi ghi ⇒ transaction cuộn lại cả ảnh (số cũ của ngày đó giữ nguyên) — `skipped` như mọi ảnh không dựng được.
      stats.skipped++;
      warnings.push(`Bỏ qua tín dụng TikTok ${k.bcId} ngày ${k.ngay}: ${e instanceof Error ? e.message : "ghi lỗi"}`);
      continue;
    }
    if (kq.loai === "loi") {
      stats.skipped++;
      warnings.push(kq.loi);
    } else if (kq.loai === "xong") {
      stats.tinDungAdsUpserted += kq.ghi.ghi;
      stats.tinDungAdsSkippedStale += kq.ghi.cuHon;
      for (const advertiserId of kq.ngoaiSo) {
        const g = ngoaiSo.get(advertiserId) ?? { bcId: k.bcId, ngay: [] };
        g.ngay.push(kq.ngay);
        ngoaiSo.set(advertiserId, g);
      }
    }
  }

  if (ngoaiSo.size > 0) {
    // `TransformStats` không khai trường này (file chung của các nhánh) ⇒ ghi qua kiểu bộ đếm của module tín dụng; khoá
    // chỉ xuất hiện khi có advertiser bị lọc.
    const dem: BoDemTinDung = stats;
    for (const [advertiserId, g] of ngoaiSo) {
      dem.tinDungAdvertiserNgoaiSo = (dem.tinDungAdvertiserNgoaiSo ?? 0) + g.ngay.length;
      const ngay = g.ngay.sort();
      const ds = ngay.length > 3 ? `${ngay.slice(0, 3).join(", ")}… (${ngay.length} ngày)` : ngay.join(", ");
      warnings.push(
        `Bỏ tín dụng TikTok của advertiser ${advertiserId} (BC ${g.bcId}, ngày ${ds}): advertiser chưa có báo cáo ` +
          `chi tiêu trong kho — không trừ vào ads advertiser khác. Cấp quyền báo cáo cho advertiser này thì lượt sau tự ghi.`,
      );
    }
  }
}
