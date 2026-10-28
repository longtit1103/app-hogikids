/**
 * Nạp LỊCH SỬ tín dụng TikTok tặng theo ngày: gọi `/bc/account/cost/get/` TỪNG NGÀY (mặc định 2026-01-14 → hôm nay
 * giờ VN) cho MỌI Business Center, land ảnh chụp ngày vào Bronze `RawTiktokBusinessCost` (stream
 * `tiktokbusiness/cost`, qua `landRaw` — cùng đường với n8n) rồi dựng Silver `TiktokAdsTinDung`. Từ đó lượt kéo đêm
 * `tiktok-business-nightly` tự nạp 7 ngày gần nhất. Chủ shop chốt 24/10: Lãi/Lỗ trừ tín dụng tặng TOÀN BỘ LỊCH SỬ.
 *
 * IDEMPOTENT: Bronze append-only (ảnh chụp mới nhất mỗi ngày thắng), Silver upsert theo (advertiser, ngày) ⇒ chạy lại
 * bao nhiêu lần cũng không nhân đôi. Chỉ ĐỌC TikTok (GET), không đụng `Expense`/quỹ/nợ thẻ.
 *
 * Endpoint (đo 24/10): `page_size` trần 50 (100 ⇒ code 40002 "page_size: number must be most 50") ⇒ kéo MỌI trang
 * tới `total_page`, land cả ngày thành MỘT ảnh chụp. Tiền báo bằng SỐ ÂM (chi phí) — mapping đổi dấu.
 * Ngày không chi tiêu: TikTok trả `cost_list: []` + `total_page 0` (đo 24/10) ⇒ một trang rỗng, vẫn land (gỡ số cũ).
 * 40002 là LỖI THAM SỐ chung: CHỈ bỏ qua BC khi THÔNG ĐIỆP nói thiếu quyền finance (finance / no access to … BC /
 * not authorized — KHÔNG khớp `permission` trơn), in đủ thông điệp BC bị bỏ; mọi lỗi khác ⇒ exit 1. TikTok báo vượt tần suất trong THÂN envelope (HTTP 200) ⇒ lùi
 * rồi thử lại như HTTP 429.
 *
 * Cuối lượt in hai bảng theo THÁNG (giờ VN): (1) Σ tín dụng (grant CHƯA VAT + grantGomVat P&L trừ); (2) ĐỐI CHIẾU
 * Σ(cash + grant) × (1 + VAT tháng) của endpoint này với Σ `Expense` ads TIKTOK_ADS cùng tháng — lệch > 1% ⇒ cảnh
 * báo (endpoint trả MỌI advertiser của BC, `Expense` chỉ có advertiser đã cấp quyền: tháng lệch là tháng tín dụng có
 * thể đang trừ nhầm advertiser không có trong Sổ). Còn ảnh chụp không dựng được (`skipped`) ⇒ exit 1.
 *
 * Token: `Setting.tiktokBusinessToken` (chuẩn dự án — cùng ô n8n đọc), không có thì rơi về env
 * `TIKTOK_BUSINESS_ACCESS_TOKEN`. KHÔNG BAO GIỜ in ra. Giành `khoaViecNang` như các script dựng lại khác: không chạy
 * chồng với xoá dữ liệu / dựng lại / phục hồi DB.
 *
 *   Từ máy dev — Prisma 7 KHÔNG tự nạp .env, phải nạp tường minh (DATABASE_URL trong .env = PROD):
 *   `npx tsx --env-file=.env scripts/backfill-tiktok-ads-tin-dung.ts`
 *   Trên minipc (container có env PROD; token đọc từ bảng Setting):
 *   `docker compose run --rm app npx --no-install tsx scripts/backfill-tiktok-ads-tin-dung.ts`
 *   Tuỳ chọn khoảng: `--tu=2026-01-14 --den=2026-10-23` (ngày VN, gồm cả hai đầu).
 */
import { giuKhoaViecNang, taoCheckpoint, traKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { landRaw } from "@/lib/bronze/land-raw";
import { latestPayloads } from "@/lib/bronze/transform-raw-helpers";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { buildVatByMonth } from "@/lib/ingest/ads-report-mapping";
import { bocAnhChupChiPhiTiktok, laNgayCoThat, soTrangAnhChupChiPhi } from "@/lib/ingest/tiktok-ads-tin-dung-mapping";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const ENDPOINT_CHI_PHI = "/bc/account/cost/get/";
/** Ngày `Expense` ads TikTok đầu tiên trên prod là 15/01 — lấy từ 14/01 cho chắc (P&L kẹp theo NGÀY nên thừa vô hại). */
const TU_NGAY_MAC_DINH = "2026-01-14";
/** Trần `page_size` của endpoint chi phí (đo 24/10). */
const PAGE_SIZE = 50;
/** Trần số trang mỗi ngày — vượt là nghi phân trang không dừng. */
const TRAN_TRANG = 50;
const DAY = 86_400_000;
/** 429/5xx và mã vượt tần suất trong thân envelope là lỗi tạm thời phía TikTok — lùi rồi thử lại (cùng nhịp n8n). */
const BACKOFF_MS = [3_000, 8_000, 20_000];
/** Nghỉ giữa hai lần gọi — ~300 ngày × số BC, không cần nhanh, cần không chạm rate-limit. */
const NGHI_GIUA_LAN_GOI_MS = 150;
/** Lệch đối chiếu tháng (endpoint × VAT vs Sổ chi phí) quá ngưỡng này ⇒ cảnh báo. */
const NGUONG_LECH_DOI_CHIEU = 0.01;

/**
 * BC thiếu vai trò tài chính — CHỈ theo THÔNG ĐIỆP (40002 trần là lỗi tham số). Không khớp `permission` trơn: lỗi quyền
 * mức token/advertiser cũng mang chữ đó mà không phải thiếu finance. Soi gương n8n `THIEU_QUYEN_FINANCE`.
 */
const THIEU_QUYEN_FINANCE = /finance|no access to .*bc|not authorized/i;
/** TikTok báo vượt tần suất bằng HTTP 200 + code ≠ 0. */
const VUOT_TAN_SUAT = /too many|frequen|rate limit|qps|limit exceeded/i;
const MA_VUOT_TAN_SUAT = new Set([40100, 40133, 50002]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Envelope = { code?: unknown; message?: unknown; data?: Record<string, unknown> };

function docThamSo(ten: string): string | undefined {
  const tienTo = `--${ten}=`;
  return process.argv.find((a) => a.startsWith(tienTo))?.slice(tienTo.length);
}

/** Mọi ngày "YYYY-MM-DD" trong [tu, den], cộng theo lịch UTC nên không lệch múi. */
function danhSachNgay(tu: string, den: string): string[] {
  const ra: string[] = [];
  for (let t = Date.parse(`${tu}T00:00:00Z`); t <= Date.parse(`${den}T00:00:00Z`); t += DAY) {
    ra.push(new Date(t).toISOString().slice(0, 10));
  }
  return ra;
}

/** Đọc envelope CHỈ để kiểm `code` — text land vào Bronze vẫn là bản thô, không phải bản parse này. */
function docEnvelope(path: string, text: string): Envelope {
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    throw new Error(`${path}: body không phải JSON: ${text.slice(0, 120)}`);
  }
}

/** Lỗi TikTok mang mã + thông điệp GỐC — người gọi phân loại thiếu quyền theo thông điệp này. */
class LoiTiktok extends Error {
  readonly ma: number;
  readonly thongDiep: string;
  constructor(path: string, ma: number, thongDiep: string) {
    super(`${path}: code ${ma} — ${thongDiep}`);
    this.ma = ma;
    this.thongDiep = thongDiep;
  }
}

/**
 * GET TEXT THÔ (không parse-serialize lại) + kiểm `code`. HTTP 429/5xx hoặc thân báo vượt tần suất ⇒ lùi rồi thử
 * lại; `code ≠ 0` khác ⇒ ném `LoiTiktok`. Lỗi không bao giờ mang token (token nằm ở header, không ở URL).
 */
async function goiTiktok(token: string, path: string, qs: Record<string, string>): Promise<{ text: string; env: Envelope }> {
  const url = `${BASE}${path}?${new URLSearchParams(qs).toString()}`;
  for (let lan = 0; ; lan++) {
    const res = await fetch(url, { headers: { "Access-Token": token } });
    if ((res.status === 429 || res.status >= 500) && lan < BACKOFF_MS.length) {
      console.warn(`${path}: HTTP ${res.status}, chờ ${BACKOFF_MS[lan] / 1000}s rồi thử lại (lần ${lan + 1})`);
      await sleep(BACKOFF_MS[lan]);
      continue;
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const text = await res.text();
    const env = docEnvelope(path, text);
    const ma = Number(env.code);
    if (ma === 0) return { text, env };
    const thongDiep = String(env.message ?? "");
    if ((MA_VUOT_TAN_SUAT.has(ma) || VUOT_TAN_SUAT.test(thongDiep)) && lan < BACKOFF_MS.length) {
      console.warn(`${path}: TikTok báo vượt tần suất (code ${ma}), chờ ${BACKOFF_MS[lan] / 1000}s rồi thử lại (lần ${lan + 1})`);
      await sleep(BACKOFF_MS[lan]);
      continue;
    }
    throw new LoiTiktok(path, ma, thongDiep);
  }
}

/** Mọi Business Center token đọc được — shop có nhiều BC (đo 14/07: 2). Trang > 1 ⇒ ném (đang bỏ sót BC). */
async function layBcIds(token: string): Promise<string[]> {
  const { env } = await goiTiktok(token, "/bc/get/", { page_size: "50" });
  const data = env.data ?? {};
  const list = Array.isArray(data.list) ? (data.list as { bc_info?: { bc_id?: unknown } }[]) : [];
  const pageInfo = (data.page_info ?? {}) as { total_page?: unknown };
  if (Number(pageInfo.total_page ?? 1) > 1) throw new Error("/bc/get/ có nhiều trang — đang bỏ sót Business Center");
  const bcs = list.map((b) => b.bc_info?.bc_id).filter((id) => id !== undefined && id !== null).map(String);
  if (bcs.length === 0) throw new Error("/bc/get/: không có Business Center nào");
  return bcs;
}

/** Mọi trang chi phí của MỘT ngày (TEXT THÔ, đúng thứ tự). */
async function keoCacTrangNgay(token: string, bcId: string, ngay: string): Promise<string[]> {
  const cacTrang: string[] = [];
  for (let page = 1; page <= TRAN_TRANG; page++) {
    const { text, env } = await goiTiktok(token, ENDPOINT_CHI_PHI, {
      bc_id: bcId,
      filtering: JSON.stringify({ start_date: ngay, end_date: ngay }),
      page: String(page),
      page_size: String(PAGE_SIZE),
    });
    cacTrang.push(text);
    if (page >= soTrangAnhChupChiPhi(env.data, page)) return cacTrang;
    await sleep(NGHI_GIUA_LAN_GOI_MS);
  }
  throw new Error(`${ENDPOINT_CHI_PHI} (bc ${bcId}, ${ngay}): quá ${TRAN_TRANG} trang — DỪNG, nghi phân trang không dừng.`);
}

/** Token chuẩn dự án: `Setting.tiktokBusinessToken` (ô n8n đọc), rơi về env khi bảng chưa có. */
async function docToken(): Promise<string> {
  const o = await prisma.setting.findUnique({ where: { key: "tiktokBusinessToken" } });
  const token = o?.value?.trim() || process.env.TIKTOK_BUSINESS_ACCESS_TOKEN?.trim() || "";
  if (!token) {
    throw new Error("Thiếu token TikTok Business: chưa có Setting.tiktokBusinessToken và env TIKTOK_BUSINESS_ACCESS_TOKEN.");
  }
  return token;
}

type DongThang = { thang: string; so: number; grant: bigint; grantGomVat: bigint; cash: bigint; amount: bigint };
type ExpenseThang = { thang: string; tong: bigint };

/** In Σ tín dụng theo tháng + bảng đối chiếu endpoint × VAT vs Sổ chi phí ads TikTok. */
async function inBangThang(): Promise<void> {
  // `ngay`/`date` là timestamp KHÔNG múi (Prisma lưu UTC) ⇒ gắn UTC trước rồi mới đổi sang giờ VN — bỏ bước gắn UTC
  // là lùi 7 tiếng, mọi dòng (neo 00:00 VN = 17:00 UTC hôm trước) rơi sang ngày/tháng trước.
  const [rows, expense, hoaDon] = await Promise.all([
    prisma.$queryRaw<DongThang[]>`
      SELECT to_char((ngay AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS thang,
             COUNT(*)::int AS so,
             COALESCE(SUM("grantExVat"), 0)::bigint AS "grant",
             COALESCE(SUM("grantGomVat"), 0)::bigint AS "grantGomVat",
             COALESCE(SUM("cashExVat"), 0)::bigint AS cash,
             COALESCE(SUM("amountExVat"), 0)::bigint AS amount
      FROM "TiktokAdsTinDung"
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.$queryRaw<ExpenseThang[]>`
      SELECT to_char((date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS thang,
             COALESCE(SUM(amount), 0)::bigint AS tong
      FROM "Expense"
      WHERE "categoryId" = 'ads' AND "adsSource" = 'TIKTOK_ADS'
      GROUP BY 1
    `,
    latestPayloads("RawTiktokBusinessInvoice", {}),
  ]);

  console.log("\n=== Σ tín dụng TikTok tặng theo tháng (giờ VN) — grant/cash/amount CHƯA VAT, grantGomVat = P&L trừ ===");
  console.table(
    rows.map((r) => ({
      thang: r.thang,
      dong: r.so,
      grantChuaVat: r.grant.toString(),
      grantGomVat: r.grantGomVat.toString(),
      cashChuaVat: r.cash.toString(),
      amountChuaVat: r.amount.toString(),
    })),
  );

  const vat = buildVatByMonth(
    hoaDon.map((h) => h.payload),
    [],
  );
  const expenseTheoThang = new Map(expense.map((e) => [e.thang, Number(e.tong)]));
  const lechNhieu: string[] = [];
  const doiChieu = rows.map((r) => {
    const rate = vat.rateForDate(`${r.thang}-01`);
    const endpointGomVat = rate === null ? null : Math.round(Number(r.cash + r.grant) * (1 + rate));
    const so = expenseTheoThang.get(r.thang) ?? 0;
    const lech = endpointGomVat === null || so === 0 ? null : (endpointGomVat - so) / so;
    if (lech === null || Math.abs(lech) > NGUONG_LECH_DOI_CHIEU) lechNhieu.push(r.thang);
    return {
      thang: r.thang,
      vat: rate === null ? "ngoài dải" : `${(rate * 100).toFixed(2)}%`,
      endpointGomVat: endpointGomVat === null ? "—" : String(endpointGomVat),
      expenseTiktok: String(so),
      lech: lech === null ? "—" : `${(lech * 100).toFixed(2)}%`,
    };
  });
  console.log("\n=== Đối chiếu Σ(cash + grant) × (1 + VAT) của endpoint vs Σ Expense ads TIKTOK_ADS (giờ VN) ===");
  console.table(doiChieu);
  if (lechNhieu.length > 0) {
    console.warn(
      `⚠ Tháng lệch > ${NGUONG_LECH_DOI_CHIEU * 100}% (hoặc không so được): ${lechNhieu.join(", ")} — endpoint trả MỌI ` +
        "advertiser của BC, Sổ chỉ có advertiser đã cấp quyền: soi xem tín dụng tháng đó có thuộc advertiser không có " +
        "chi tiêu trong Sổ không (P&L kẹp theo ngày ≤ ads TikTok ngày đó, nhưng vẫn có thể trừ nhầm advertiser).",
    );
  }
}

async function main(): Promise<void> {
  const tu = docThamSo("tu") ?? TU_NGAY_MAC_DINH;
  const den = docThamSo("den") ?? khoaNgayVn(new Date());
  if (!laNgayCoThat(tu) || !laNgayCoThat(den) || tu > den) {
    throw new Error(`Khoảng ngày không hợp lệ: --tu=${tu} --den=${den} (YYYY-MM-DD, tu ≤ den)`);
  }
  const ngays = danhSachNgay(tu, den);
  const token = await docToken();

  const khoa = await giuKhoaViecNang("nạp tín dụng TikTok tặng (script)");
  if (!khoa.the) {
    process.exitCode = 1;
    console.error(`Đang có "${khoa.dangGiu}" chạy — chờ xong rồi chạy lại.`);
    return;
  }
  const the = khoa.the;
  const checkpoint = taoCheckpoint(the);
  try {
    const bcIds = await layBcIds(token);
    console.log(`Business Center: ${bcIds.join(", ")} · ${ngays.length} ngày (${tu} → ${den})`);

    let soAnhChup = 0;
    const bcBoQua: string[] = [];
    for (const bcId of bcIds) {
      let boQuaBc = false;
      for (const ngay of ngays) {
        await checkpoint();
        let cacTrang: string[];
        try {
          cacTrang = await keoCacTrangNgay(token, bcId, ngay);
        } catch (e) {
          // CHỈ bỏ qua BC khi thông điệp GỐC nói thiếu quyền — 40002 trần (lỗi tham số) phải ném ⇒ exit 1.
          if (e instanceof LoiTiktok && THIEU_QUYEN_FINANCE.test(e.thongDiep)) {
            console.warn(`⚠ BỎ QUA BC ${bcId} — thiếu quyền finance (code ${e.ma}, thông điệp TikTok: "${e.thongDiep}"; lỗi: ${e.message}).`);
            bcBoQua.push(bcId);
            boQuaBc = true;
            break;
          }
          throw e;
        }
        // Cùng đường land với n8n: ảnh chụp ngày (mọi trang) bọc nối chuỗi, `ngay` vào khoá + hash.
        await landRaw("tiktokbusiness/cost", bcId, bocAnhChupChiPhiTiktok(cacTrang), undefined, undefined, undefined, ngay);
        soAnhChup++;
        if (soAnhChup % 30 === 0) console.log(`… đã land ${soAnhChup} ảnh chụp (bc ${bcId}, tới ${ngay})`);
        await sleep(NGHI_GIUA_LAN_GOI_MS);
      }
      if (!boQuaBc) console.log(`BC ${bcId}: xong ${ngays.length} ngày`);
    }

    const warnings: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/cost", warnings, { checkpoint });
    console.log(
      `\nLand ${soAnhChup} ảnh chụp · Silver ghi ${stats.tinDungAdsUpserted} dòng (advertiser × ngày) · skipped: ${stats.skipped}` +
        (bcBoQua.length ? ` · BC bỏ qua (thiếu quyền finance): ${bcBoQua.join(", ")}` : ""),
    );
    if (warnings.length) {
      console.log(`\n${warnings.length} cảnh báo (20 dòng đầu):`);
      warnings.slice(0, 20).forEach((w) => console.warn("⚠", w));
    }

    await inBangThang();
    if (stats.skipped > 0) process.exitCode = 1;
  } finally {
    await traKhoaViecNang(the);
  }
}

main()
  .catch((e) => {
    // Chỉ in thông điệp — mọi lỗi tự tạo ở trên không mang token; lỗi mạng của fetch cũng không chứa header.
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
