/**
 * Đo CHỈ ĐỌC: sự kiện webhook đơn Pancake (`RawPancakeWebhookEvent`) vắng khoá nào trong nhóm field bán
 * trực tiếp mà guard land webhook soi có điều kiện (`FIELD_BAN_TRUC_TIEP`, `webhook-processor.ts`).
 *
 *   npx tsx scripts/do-field-webhook-pancake.ts --db-test [--tu 2026-09-23]
 *   npx tsx scripts/do-field-webhook-pancake.ts --prod [--tu 2026-09-23]
 *   npx tsx scripts/do-field-webhook-pancake.ts --prod --liet-ke-don-direct-sai
 *
 * BẮT BUỘC đúng một cờ DB: `--db-test` (TEST_DATABASE_URL, tên DB phải kết thúc `_test`) hoặc `--prod`
 * (DATABASE_URL — CHỈ ĐỌC, chạy theo phép của chủ shop). `--tu` mặc định 2026-09-23 (ngày kênh bán trực
 * tiếp bắt đầu), biên theo giờ VN trên `receivedAt`.
 *
 * Bảng đo tách ba nhóm sự kiện `type = "orders"`:
 *   - payload mang `received_at_shop = true`;
 *   - payload KHÔNG mang `true` nhưng Silver đang giữ đơn đó ở kênh `direct` — đây đúng là ca nguy hiểm
 *     (sự kiện vắng dấu nhận-tại-shop của đơn quầy; trước bản vá guard nó được land và đè Silver);
 *   - còn lại (đơn sàn/website).
 * Đọc kết quả: nhóm 3 vắng có hệ thống ⇒ khẳng định không được soi 6 khoá này trên đơn sàn; nhóm 1/2 vắng
 * có hệ thống ⇒ đơn quầy sẽ luôn chờ lượt API (chấp nhận: tiền quầy đúng quan trọng hơn tươi).
 * Cột `advanced_platform_fee.diff_shipping_fee` là THAM KHẢO (mapping đọc, guard chưa soi — chờ số đo này).
 *
 * `--liet-ke-don-direct-sai`: in mã đơn `channelId = 'direct'`, `COMPLETED`, `paidAtShop = 0` để chủ shop
 * kéo lại API theo mã (nút "Đồng bộ ngay"). Script KHÔNG ghi gì — dựng lại từ kho thô không chữa được ca
 * này (nó chọn lại đúng bản webhook đang đứng đầu).
 *
 * Mã đơn lấy qua `JSON.parse` (đủ để tra Silver: mã đơn Pancake hôm nay là chuỗi — đo prod). Nếu Pancake
 * đổi sang số int64 thì tra Silver có thể trượt và sự kiện rơi về nhóm 3 — script in số sự kiện có mã số.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { phanTichCheDoDb } from "@/lib/no-phai-tra/khao-sat-chenh-nguon";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
let cheDo: ReturnType<typeof phanTichCheDoDb>;
try {
  cheDo = phanTichCheDoDb(process.argv, process.env);
} catch (e) {
  console.error(`${e instanceof Error ? e.message : String(e)}\nVí dụ: npx tsx scripts/do-field-webhook-pancake.ts --db-test --tu 2026-09-23`);
  process.exit(2);
}
process.env.DATABASE_URL = cheDo.databaseUrl;

const TU_MAC_DINH = "2026-09-23";
const LO = 1000;
const COT_THAM_KHAO = "advanced_platform_fee.diff_shipping_fee";

function thamSo(ten: string): string | undefined {
  const i = process.argv.indexOf(ten);
  return i === -1 ? undefined : process.argv[i + 1];
}

const bang = (dau: string[], dong: string[][]) =>
  [`| ${dau.join(" | ")} |`, `|${dau.map(() => "---").join("|")}|`, ...dong.map((d) => `| ${d.join(" | ")} |`)].join("\n");

type Nhom = "payload-true" | "silver-direct" | "khac";
const TEN_NHOM: Record<Nhom, string> = {
  "payload-true": "payload received_at_shop = true",
  "silver-direct": "payload KHÔNG true, Silver đang direct",
  khac: "còn lại (sàn/website)",
};
type Dem = { suKien: number; thieuItNhatMot: number; thieu: Record<string, number> };
const demRong = (field: readonly string[]): Dem => ({
  suKien: 0,
  thieuItNhatMot: 0,
  thieu: Object.fromEntries([...field, COT_THAM_KHAO].map((k) => [k, 0])),
});

type Prisma = Awaited<typeof import("@/lib/prisma")>["prisma"];

/** Payload là TEXT thô (có thể hỏng) — chỉ nhận object JSON có `type = "orders"`. */
function docDon(payload: string): Record<string, unknown> | null {
  try {
    const o: unknown = JSON.parse(payload);
    if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    return r.type === "orders" ? r : null;
  } catch {
    return null;
  }
}

/** `field` = `FIELD_BAN_TRUC_TIEP` của guard — truyền vào (import động sau khi đã chốt DATABASE_URL). */
async function doField(prisma: Prisma, field: readonly string[], tu: string): Promise<void> {
  const batDau = new Date(`${tu}T00:00:00+07:00`);
  const dem: Record<Nhom, Dem> = { "payload-true": demRong(field), "silver-direct": demRong(field), khac: demRong(field) };
  let tongDong = 0;
  let khongPhaiDon = 0;
  let maSo = 0;
  let cursor: string | undefined;

  for (;;) {
    const lo = await prisma.rawPancakeWebhookEvent.findMany({
      where: { receivedAt: { gte: batDau } },
      select: { id: true, payload: true },
      orderBy: { id: "asc" },
      take: LO,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (lo.length === 0) break;
    cursor = lo[lo.length - 1].id;
    tongDong += lo.length;

    const don = lo.map((d) => docDon(d.payload));
    const ma = don.filter((d): d is Record<string, unknown> => d !== null).map((d) => String(d.id));
    const silverDirect = new Set(
      (
        await prisma.order.findMany({
          where: { pancakeId: { in: [...new Set(ma)] }, channelId: "direct" },
          select: { pancakeId: true },
        })
      ).map((o) => o.pancakeId),
    );

    for (const d of don) {
      if (d === null) {
        khongPhaiDon++;
        continue;
      }
      if (typeof d.id === "number") maSo++;
      const nhom: Nhom = d.received_at_shop === true ? "payload-true" : silverDirect.has(String(d.id)) ? "silver-direct" : "khac";
      const g = dem[nhom];
      g.suKien++;
      // JSON null tính như VẮNG — guard (webhook-processor) cũng coi null của nhóm bán trực tiếp là thiếu.
      const vang = field.filter((k) => !Object.hasOwn(d, k) || d[k] === null);
      if (vang.length > 0) g.thieuItNhatMot++;
      for (const k of vang) g.thieu[k]++;
      const apf = d.advanced_platform_fee;
      if (!(apf !== null && typeof apf === "object" && Object.hasOwn(apf, "diff_shipping_fee"))) g.thieu[COT_THAM_KHAO]++;
    }
  }

  console.log(`\nĐã quét ${tongDong} sự kiện từ ${tu} (giờ VN) · bỏ qua ${khongPhaiDon} sự kiện không phải đơn/không đọc được JSON · ${maSo} sự kiện mã đơn kiểu số`);
  console.log("\n## Số sự kiện VẮNG khoá (khoá không có mặt trong payload — cùng nghĩa toán tử jsonb `?` của guard)\n");
  const cot = [...field, COT_THAM_KHAO];
  console.log(
    bang(
      ["Nhóm", "Số sự kiện", "Vắng ≥ 1 trong 6", ...cot.map((k) => (k === COT_THAM_KHAO ? `${k} (tham khảo)` : k))],
      (Object.keys(dem) as Nhom[]).map((n) => [
        TEN_NHOM[n],
        String(dem[n].suKien),
        String(dem[n].thieuItNhatMot),
        ...cot.map((k) => String(dem[n].thieu[k])),
      ]),
    ),
  );
}

async function lietKeDonDirectSai(prisma: Prisma): Promise<void> {
  const ds = await prisma.order.findMany({
    where: { channelId: "direct", status: "COMPLETED", paidAtShop: 0 },
    select: { pancakeId: true, code: true, orderedAt: true, itemsTotal: true, discount: true, shipFeeCustomer: true },
    orderBy: { orderedAt: "asc" },
  });
  console.log(`\n## Đơn bán trực tiếp COMPLETED có paidAtShop = 0: ${ds.length} đơn\n`);
  if (ds.length === 0) return;
  console.log(
    bang(
      ["pancakeId", "Mã đơn", "Ngày đặt (VN)", "Phải trả (hàng ròng + ship)"],
      ds.map((o) => [o.pancakeId, o.code, khoaNgayVn(o.orderedAt), (o.itemsTotal - o.discount + Math.max(0, o.shipFeeCustomer)).toLocaleString("vi-VN")]),
    ),
  );
  console.log("\nCách chữa: kéo lại API theo mã đơn (\"Đồng bộ ngay\"). KHÔNG ghi tay DIRECT_SALE (đếm 2 lần), KHÔNG dựng lại từ kho thô.");
}

async function main(): Promise<void> {
  const lietKe = process.argv.includes("--liet-ke-don-direct-sai");
  const tu = thamSo("--tu") ?? TU_MAC_DINH;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tu) || Number.isNaN(new Date(`${tu}T00:00:00+07:00`).getTime())) {
    console.error(`--tu phải dạng yyyy-MM-dd, nhận "${tu}".`);
    process.exit(2);
  }
  const url = new URL(process.env.DATABASE_URL ?? "postgres://thieu");
  console.log(`CHỈ ĐỌC · DB đích (${cheDo.che}): ${url.host}${url.pathname}`);
  if (cheDo.che === "prod") console.warn("CHỈ ĐỌC — chạy trên prod theo phép của chủ shop.");

  // Import ĐỘNG cả hai: `webhook-processor` kéo theo `@/lib/prisma`, import tĩnh thì client dựng TRƯỚC
  // khi DATABASE_URL bị ép theo cờ — `--db-test` sẽ âm thầm đọc DB trong `.env`.
  const { prisma } = await import("@/lib/prisma");
  const { FIELD_BAN_TRUC_TIEP } = await import("@/lib/ingest/webhook-processor");
  try {
    if (lietKe) await lietKeDonDirectSai(prisma);
    else await doField(prisma, FIELD_BAN_TRUC_TIEP, tu);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
