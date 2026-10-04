/**
 * ĐO thời gian truy vấn server của 4 tab chính (Dashboard `/`, Tài chính `/tai-chinh` tab Lãi/Lỗ,
 * Đơn hàng `/don-hang`, Tồn kho `/ton-kho`) + layout `(app)` — CHỈ ĐỌC.
 *
 * Mỗi kịch bản gọi ĐÚNG các hàm lib mà trang gọi, tham số mặc định (không searchParams ⇒ range
 * `this_month`, giờ VN), theo ĐÚNG thứ tự `await` / `Promise.all` của trang (mô phỏng waterfall).
 * Hai cách đo mỗi trang:
 *  - "chuyển tab": CHỈ segment trang — Next giữ nguyên layout chung khi client-navigate
 *    (Partial Rendering), nên đây là thời gian chờ khi chạm tab dưới.
 *  - "tải đầy đủ": layout ‖ trang chạy song song — mở app lạnh / F5 / PWA mở lại.
 * Chạy 3 lượt (lượt 1 lạnh: cache Postgres + plan chưa ấm). Cuối cùng đo CÔ LẬP từng hàm (chạy
 * một mình, tuần tự) kèm số câu SQL — tách "tự thân chậm" khỏi "chậm vì tranh pool kết nối".
 *
 * KHÔNG GỌI hàm có GHI — bỏ qua và in riêng:
 *  - `ensureRecurringExpensesForMonths` (Dashboard + Tài chính): transaction Serializable, có thể
 *    INSERT `Expense`. Thay bằng MÔ PHỎNG CHỈ-ĐỌC đúng các câu SELECT của nó (findMany mẫu +
 *    findFirst từng mẫu, tuần tự) — thiếu BEGIN/SET ISOLATION/COMMIT nên số đo là CẬN DƯỚI.
 *  - Xác thực phiên (`docNguoiDungPhien` → `getSession` đọc cookie, phụ thuộc request) ⇒ tái tạo đúng
 *    câu DB của nó: `kiemPhien` (`User.findUnique` theo id + so `sessionEpoch`) với một OWNER có thật.
 *    Layout còn `docShopProfile` (ShopProfile id=1). Góc nhìn đo = CHỦ SHOP: đủ quyền, không che giá vốn
 *    (`coQuyenGiaVon: true`), nên layout nạp đủ 10 nguồn cảnh báo như OWNER thật.
 * Kết nối mở với `default_transaction_read_only=on` qua tham số `options` của URL — nhà máy
 * `taoPrismaClient` GIỮ `options` sẵn có và nối `search_path`/`TimeZone` vào sau, nên chốt này sống cùng
 * schema `app`. Script in ra giá trị Postgres báo về để xác nhận chốt chặn ghi có hiệu lực.
 *
 * Chạy (prod, controller):
 *   docker compose run --rm -T -v <file>:/app/scripts/do-thoi-gian-truy-van-trang.ts app \
 *     npx --no-install tsx scripts/do-thoi-gian-truy-van-trang.ts
 * Chạy (dev — BẮT BUỘC trỏ DB TEST, `.env` máy dev trỏ DB PROD):
 *   DATABASE_URL="$(grep ^TEST_DATABASE_URL= .env | cut -d= -f2- | tr -d '"')" \
 *     npx --no-install tsx scripts/do-thoi-gian-truy-van-trang.ts
 *
 * Một file duy nhất (không tách module) vì được mount lẻ vào container prod.
 * Lưu ý sai số: `cache()` của React không nhớ ngoài request RSC ⇒ `ngayMoSoTrongRequest` /
 * `docPhanDuBaoTrongRequest` có thể chạy lặp vài câu nhỏ hơn prod (đo hơi DƯ ở phần sổ quỹ).
 */
import os from "node:os";
import { performance } from "node:perf_hooks";

import { startOfDay, startOfMonth, endOfMonth, endOfDay, subMonths, format } from "date-fns";

import { taoPrismaClient } from "@/lib/tao-prisma-client";

const SO_LUOT = 3;

// ── Kết nối: client có log sự kiện query, chốt read-only, gắn vào global TRƯỚC khi nạp lib ──────
function urlChiDoc(raw: string): string {
  const u = new URL(raw);
  u.searchParams.set("options", "-c default_transaction_read_only=on");
  u.searchParams.set("application_name", "do-thoi-gian-truy-van-trang");
  return u.toString();
}

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error("Thiếu DATABASE_URL — dừng.");
  process.exit(1);
}
const dich = new URL(rawUrl);
const client = taoPrismaClient(urlChiDoc(rawUrl), { logTruyVan: true });
let soCau = 0;
let msDbCongDon = 0;
client.$on("query", (e) => {
  soCau++;
  msDbCongDon += e.duration;
  if (/^\s*(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(e.query)) {
    console.error(`⛔ Phát hiện câu GHI — dừng ngay: ${e.query.slice(0, 120)}`);
    process.exit(2);
  }
});
(globalThis as unknown as { prisma?: typeof client }).prisma = client;

// ── Đo ───────────────────────────────────────────────────────────────────────────────────────────
type Buoc = { ten: string; ms: number; con?: Buoc[] };

async function doMot<T>(ten: string, f: () => Promise<T>, nhat: Buoc[]): Promise<T> {
  const t0 = performance.now();
  try {
    return await f();
  } finally {
    nhat.push({ ten, ms: performance.now() - t0 });
  }
}

/** `Promise.all` như trang, đo từng phần tử + tường của cả nhóm. */
async function doNhom(ten: string, cac: [string, () => Promise<unknown>][], nhat: Buoc[]): Promise<void> {
  const con: Buoc[] = [];
  const t0 = performance.now();
  await Promise.all(cac.map(([t, f]) => doMot(t, f, con)));
  con.sort((a, b) => b.ms - a.ms);
  nhat.push({ ten, ms: performance.now() - t0, con });
}

const f0 = (n: number) => n.toFixed(0).padStart(6);

function inBuoc(buoc: Buoc[], thut = "  "): void {
  for (const b of buoc) {
    console.log(`${thut}${f0(b.ms)} ms  ${b.ten}`);
    if (b.con) inBuoc(b.con, thut + "        ");
  }
}

async function main(): Promise<void> {
  // Nạp lib SAU khi đã gắn client vào global (src/lib/prisma.ts lấy global nếu có).
  const { resolveRangeFromParams, resolveRangePreset, lastMonthToSameDay, clampRangeEndToNow } =
    await import("@/lib/date-range");
  const { monthStartsInRange, mauDinhKySinhChoThang, ngayDenHanDinhKy } = await import(
    "@/lib/expenses/ensure-recurring-expenses"
  );
  const { calcPnl, computeChannelPnl } = await import("@/lib/reports/pnl");
  const { computeDailySeries } = await import("@/lib/reports/daily-series");
  const { computeProductReport } = await import("@/lib/reports/product-report");
  const { countMissingCostVariants, hasLowStockVariants, getLowStockPreview, getVariantListPage } = await import(
    "@/lib/queries/variants"
  );
  const { getRecentDataErrorKinds } = await import("@/lib/queries/sync-health");
  const { hasBronzeBacklog } = await import("@/lib/bronze/bronze-only");
  const { docTrangThaiSaoLuu } = await import("@/lib/backup/doc-trang-thai-sao-luu");
  const { KEY_MOC_KIEM_GIA_VON, KEY_SO_LECH_GIA_VON } = await import("@/lib/gia-von/trang-thai-lech-gia-von");
  const { KEY_MOC_KIEM_PHIEU_NHAP, KEY_SO_PHIEU_NHAP_CHUA_GHI, KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP } = await import(
    "@/lib/nhap-hang/trang-thai-phieu-nhap"
  );
  const { docCanhBaoSapCan } = await import("@/lib/so-quy/du-bao-quy-queries");
  const { demKhoanVayCoKyChoDuyet } = await import("@/lib/so-quy/khoan-vay-queries");
  const { sumGmv } = await import("@/lib/reports/cash-flow");
  const { computePlatformFeeComponents, computeBackfilledPlatformFee } = await import(
    "@/lib/reports/platform-fee-breakdown"
  );
  const { computeVoucherBreakdown } = await import("@/lib/reports/voucher-breakdown");
  const { getOrderListPage, getLastPancakeSyncAt } = await import("@/lib/queries/orders");

  const prisma = client;
  type DateRange = { from: Date; to: Date };

  const { kiemPhien } = await import("@/lib/quyen/nguoi-dung-phien");
  const { docShopProfileKhongCache } = await import("@/lib/shop-profile/doc-shop-profile");
  const chu = await prisma.user.findFirst({
    where: { role: "OWNER", isActive: true },
    select: { id: true, sessionEpoch: true },
  });
  if (!chu) {
    // DB trắng (vd DB test): vẫn chạy được — câu `findUnique` vẫn chạy, chỉ trả null.
    console.log("⚠️ Không có OWNER đang hoạt động — phiên mẫu dùng id giả, câu xác thực phiên trả null.");
  }
  /** Góc nhìn CHỦ SHOP: đủ quyền giá vốn/lãi lỗ (không che). */
  const quyen = { coQuyenGiaVon: true } as const;

  // ── Tái tạo câu DB xác thực phiên (cookie bỏ qua): cùng `kiemPhien` mà `docNguoiDungPhien` gọi ──
  const docPhien = () => kiemPhien({ userId: chu?.id ?? "khong-co-owner", mocPhien: chu?.sessionEpoch });

  /** MÔ PHỎNG CHỈ-ĐỌC `ensureRecurringExpensesForMonths` — cùng dedupe tháng, cùng cổng, tuần tự. */
  let soDongSeSinh = 0;
  async function moPhongEnsureRecurring(months: Date[]): Promise<void> {
    const seen = new Set<string>();
    const today = endOfDay(new Date());
    for (const month of months) {
      const key = format(month, "yyyy-MM");
      if (seen.has(key)) continue;
      seen.add(key);
      const start = startOfMonth(month);
      const end = endOfMonth(month);
      const recurrings = await prisma.recurringExpense.findMany({ where: { active: true } });
      for (const r of recurrings) {
        if (!mauDinhKySinhChoThang(r.activeFrom, month)) continue;
        if (ngayDenHanDinhKy(r.dayOfMonth, month) > today) continue;
        const existed = await prisma.expense.findFirst({
          where: { recurringId: r.id, date: { gte: start, lte: end } },
          select: { id: true },
        });
        if (!existed) soDongSeSinh++;
      }
    }
  }

  // ── Kịch bản: layout (app) ──
  async function layout(nhat: Buoc[]): Promise<void> {
    await doMot("kiemPhien (xác thực phiên)", docPhien, nhat);
    await doNhom(
      "Promise.all 10 nguồn cảnh báo shell",
      [
        ["docShopProfile", () => docShopProfileKhongCache()],
        ["countMissingCostVariants", countMissingCostVariants],
        ["hasLowStockVariants", hasLowStockVariants],
        ["getRecentDataErrorKinds", getRecentDataErrorKinds],
        ["hasBronzeBacklog", hasBronzeBacklog],
        ["docTrangThaiSaoLuu", docTrangThaiSaoLuu],
        ["setting mốc giá vốn", () => prisma.setting.findMany({ where: { key: { in: [KEY_SO_LECH_GIA_VON, KEY_MOC_KIEM_GIA_VON] } }, select: { key: true, value: true } })],
        ["demKhoanVayCoKyChoDuyet", demKhoanVayCoKyChoDuyet],
        ["setting mốc phiếu nhập", () => prisma.setting.findMany({ where: { key: { in: [KEY_SO_PHIEU_NHAP_CHUA_GHI, KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP, KEY_MOC_KIEM_PHIEU_NHAP] } }, select: { key: true, value: true } })],
        ["docCanhBaoSapCan (dự báo quỹ 30 ngày)", docCanhBaoSapCan],
      ],
      nhat
    );
  }

  // ── Kịch bản: Dashboard `/` ──
  async function dashboard(nhat: Buoc[]): Promise<void> {
    await doMot("kiemPhien (xác thực phiên)", docPhien, nhat);
    await doNhom(
      "Promise.all cổng trống",
      [
        ["syncLog.count PANCAKE", () => prisma.syncLog.count({ where: { kind: "PANCAKE" } })],
        ["order.count (toàn bảng)", () => prisma.order.count()],
      ],
      nhat
    );
    const now = new Date();
    const range = resolveRangeFromParams({});
    const today = { from: startOfDay(now), to: now };
    const thisMonth = resolveRangePreset("this_month", now);
    const lastMonthSameDays = lastMonthToSameDay(now);
    await doMot(
      "[GHI-BỎ QUA] ensureRecurring ×2 tháng — mô phỏng đọc",
      () => moPhongEnsureRecurring([startOfMonth(now), startOfMonth(subMonths(now, 1)), ...monthStartsInRange(range)]),
      nhat
    );
    await doNhom(
      "Promise.all 8 khối dashboard",
      [
        ["calcPnl(hôm nay)", () => calcPnl(today)],
        ["calcPnl(tháng này)", () => calcPnl(thisMonth)],
        ["calcPnl(cùng kỳ tháng trước)", () => calcPnl(lastMonthSameDays)],
        ["computeDailySeries(range)", () => computeDailySeries(clampRangeEndToNow(range, now))],
        ["computeChannelPnl(range)", () => computeChannelPnl(range)],
        ["computeProductReport(range, undefined, quyen)", () => computeProductReport(range, undefined, quyen)],
        ["getLowStockPreview", () => getLowStockPreview()],
        [
          "syncLog.findFirst ×5 kind",
          () =>
            Promise.all(
              (["PANCAKE", "META_ADS", "TIKTOK_ADS", "TIKTOK_SHOP", "TIKTOK_SHOP_ANALYTICS"] as const).map((kind) =>
                prisma.syncLog.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } })
              )
            ),
        ],
      ],
      nhat
    );
  }

  // ── Kịch bản: Tài chính `/tai-chinh` (tab mặc định Lãi/Lỗ) ──
  async function taiChinh(nhat: Buoc[]): Promise<void> {
    await doMot("kiemPhien (xác thực phiên)", docPhien, nhat);
    const range = resolveRangeFromParams({});
    const monthRange: DateRange = { from: startOfMonth(range.to), to: endOfMonth(range.to) };
    const prevStart = startOfMonth(subMonths(monthRange.from, 1));
    const prevMonthRange: DateRange = { from: prevStart, to: endOfMonth(prevStart) };
    await doMot(
      "[GHI-BỎ QUA] ensureRecurring ×2 tháng — mô phỏng đọc",
      () => moPhongEnsureRecurring([monthRange.from, prevMonthRange.from]),
      nhat
    );
    await doNhom(
      "Promise.all 9 khối Lãi/Lỗ",
      [
        ["calcPnl(tháng)", () => calcPnl(monthRange)],
        ["calcPnl(tháng trước)", () => calcPnl(prevMonthRange)],
        ["sumGmv(tháng)", () => sumGmv(monthRange)],
        ["computePlatformFeeComponents(tháng) [raw JSONB]", () => computePlatformFeeComponents(monthRange)],
        ["computePlatformFeeComponents(tháng trước) [raw JSONB]", () => computePlatformFeeComponents(prevMonthRange)],
        ["computeVoucherBreakdown(tháng) [raw JSONB]", () => computeVoucherBreakdown(monthRange)],
        ["computeVoucherBreakdown(tháng trước) [raw JSONB]", () => computeVoucherBreakdown(prevMonthRange)],
        ["computeBackfilledPlatformFee(tháng)", () => computeBackfilledPlatformFee(monthRange)],
        ["computeBackfilledPlatformFee(tháng trước)", () => computeBackfilledPlatformFee(prevMonthRange)],
      ],
      nhat
    );
  }

  // ── Kịch bản: Đơn hàng `/don-hang` (không lọc, trang 1, không mở drawer) ──
  async function donHang(nhat: Buoc[]): Promise<void> {
    await doMot("kiemPhien (xác thực phiên)", docPhien, nhat);
    await doNhom(
      "Promise.all 3 nguồn",
      [
        ["getOrderListPage(trang 1, không lọc)", () => getOrderListPage({ page: 1 })],
        ["getLastPancakeSyncAt", getLastPancakeSyncAt],
        ["channel.findMany", () => prisma.channel.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true, color: true } })],
      ],
      nhat
    );
  }

  // ── Kịch bản: Tồn kho `/ton-kho` (mặc định: sort vốn desc, trang 1) ──
  async function tonKho(nhat: Buoc[]): Promise<void> {
    await doMot("kiemPhien (xác thực phiên)", docPhien, nhat);
    await doMot("getVariantListPage (4 câu NỐI TIẾP bên trong)", () =>
      getVariantListPage({ lowOnly: false, sort: "von", dir: "desc", page: 1 }, quyen), nhat);
  }

  const TRANG: [string, (n: Buoc[]) => Promise<void>][] = [
    ["Dashboard /", dashboard],
    ["Tài chính /tai-chinh (Lãi/Lỗ)", taiChinh],
    ["Đơn hàng /don-hang", donHang],
    ["Tồn kho /ton-kho", tonKho],
  ];

  // ── Đầu ra ──
  const [ro] = await prisma.$queryRaw<{ ro: string }[]>`SELECT current_setting('default_transaction_read_only') AS ro`;
  const [ver] = await prisma.$queryRaw<{ v: string }[]>`SELECT current_database() AS v`;
  console.log("══ ĐO THỜI GIAN TRUY VẤN 4 TAB ══");
  console.log(`DB đích: host=${dich.hostname} db=${ver?.v} schema=${dich.searchParams.get("schema") ?? "?"}`);
  console.log(`default_transaction_read_only = ${ro?.ro} (on = Postgres chặn mọi câu ghi)`);
  // Chốt chỉ-đọc là điều kiện để chạy vào DB prod — không có hiệu lực thì DỪNG trước khi gọi hàm lib nào.
  if (ro?.ro !== "on") {
    console.error("⛔ Kết nối KHÔNG ở chế độ chỉ-đọc — dừng, không đo.");
    process.exit(3);
  }
  console.log(`connection_limit trong URL: ${dich.searchParams.get("connection_limit") ?? "(không đặt — pg.Pool mặc định max 10)"} · CPU máy chạy script: ${os.cpus().length}`);
  console.log(`Giờ máy: ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  const [demDon] = await prisma.$queryRaw<{ don: bigint; dong: bigint; bien: bigint; log: bigint }[]>`
    SELECT (SELECT COUNT(*) FROM "Order") AS don, (SELECT COUNT(*) FROM "OrderItem") AS dong,
           (SELECT COUNT(*) FROM "Variant") AS bien, (SELECT COUNT(*) FROM "SyncLog") AS log`;
  console.log(`Quy mô: Order=${demDon?.don} OrderItem=${demDon?.dong} Variant=${demDon?.bien} SyncLog=${demDon?.log}`);
  if (Number(demDon?.don ?? 0) === 0) {
    console.log("⚠️ Bảng Order rỗng — Dashboard THẬT sẽ trả EmptyState sớm; số đo chỉ chứng minh script chạy.");
  }

  console.log("");

  const tong: Record<string, { nav: number[]; full: number[]; cauNav: number[] }> = {};
  for (let luot = 1; luot <= SO_LUOT; luot++) {
    console.log(`──────── LƯỢT ${luot}${luot === 1 ? " (lạnh)" : ""} ────────`);
    for (const [ten, kb] of TRANG) {
      tong[ten] ??= { nav: [], full: [], cauNav: [] };
      const nhatNav: Buoc[] = [];
      const c0 = soCau;
      const a = performance.now();
      await kb(nhatNav);
      const msNav = performance.now() - a;
      tong[ten].nav.push(msNav);
      tong[ten].cauNav.push(soCau - c0);
      console.log(`▸ ${ten} — CHUYỂN TAB (chỉ trang): ${msNav.toFixed(0)} ms, ${soCau - c0} câu SQL`);
      inBuoc(nhatNav);

      const nhatL: Buoc[] = [];
      const nhatP: Buoc[] = [];
      const b = performance.now();
      await Promise.all([layout(nhatL), kb(nhatP)]);
      const msFull = performance.now() - b;
      tong[ten].full.push(msFull);
      console.log(`▸ ${ten} — TẢI ĐẦY ĐỦ (layout ‖ trang): ${msFull.toFixed(0)} ms`);
      const msTrang = nhatP.reduce((s, x) => s + x.ms, 0);
      console.log(`  [trang] ${msTrang.toFixed(0)} ms (tổng các bước nối tiếp — chi tiết xem dòng CHUYỂN TAB)`);
      console.log("  [layout]");
      inBuoc(nhatL, "    ");
    }
    console.log("");
  }

  console.log("══ TÓM TẮT (ms) ══");
  console.log("| Trang | Chuyển tab L1/L2/L3 | Tải đầy đủ L1/L2/L3 | Câu SQL/lượt |");
  console.log("|---|---|---|---|");
  for (const [ten, v] of Object.entries(tong)) {
    const j = (xs: number[]) => xs.map((x) => x.toFixed(0)).join(" / ");
    console.log(`| ${ten} | ${j(v.nav)} | ${j(v.full)} | ${v.cauNav[v.cauNav.length - 1]} |`);
  }

  // ── Cô lập: từng hàm một mình (ấm), tuần tự — số câu SQL chính xác cho từng hàm ──
  console.log("\n══ CÔ LẬP TỪNG HÀM (ấm, chạy một mình) ══");
  console.log("| Hàm | ms | Câu SQL | Σ ms DB (Prisma báo) |");
  console.log("|---|---|---|---|");
  const now = new Date();
  const range = resolveRangeFromParams({});
  const thang: DateRange = { from: startOfMonth(range.to), to: endOfMonth(range.to) };
  const truoc = startOfMonth(subMonths(thang.from, 1));
  const thangTruoc: DateRange = { from: truoc, to: endOfMonth(truoc) };
  const CO_LAP: [string, () => Promise<unknown>][] = [
    ["kiemPhien (xác thực phiên)", docPhien],
    ["docCanhBaoSapCan (layout)", docCanhBaoSapCan],
    ["demKhoanVayCoKyChoDuyet (layout)", demKhoanVayCoKyChoDuyet],
    ["countMissingCostVariants (layout)", countMissingCostVariants],
    ["hasLowStockVariants (layout)", hasLowStockVariants],
    ["getRecentDataErrorKinds (layout)", getRecentDataErrorKinds],
    ["docTrangThaiSaoLuu (layout)", docTrangThaiSaoLuu],
    ["order.count (dashboard)", () => prisma.order.count()],
    ["mô phỏng ensureRecurring 1 tháng", () => moPhongEnsureRecurring([thang.from])],
    ["calcPnl(tháng này)", () => calcPnl(thang)],
    ["calcPnl(tháng trước)", () => calcPnl(thangTruoc)],
    ["computeDailySeries(tháng, kẹp nay)", () => computeDailySeries(clampRangeEndToNow(range, now))],
    ["computeChannelPnl(tháng)", () => computeChannelPnl(range)],
    ["computeProductReport(tháng)", () => computeProductReport(range, undefined, quyen)],
    ["getLowStockPreview", () => getLowStockPreview()],
    ["sumGmv(tháng)", () => sumGmv(thang)],
    ["computePlatformFeeComponents(tháng)", () => computePlatformFeeComponents(thang)],
    ["computeVoucherBreakdown(tháng)", () => computeVoucherBreakdown(thang)],
    ["computeBackfilledPlatformFee(tháng)", () => computeBackfilledPlatformFee(thang)],
    ["getOrderListPage(trang 1)", () => getOrderListPage({ page: 1 })],
    ["getLastPancakeSyncAt", getLastPancakeSyncAt],
    ["getVariantListPage(mặc định)", () => getVariantListPage({ lowOnly: false, sort: "von", dir: "desc", page: 1 }, quyen)],
  ];
  for (const [ten, f] of CO_LAP) {
    const c0 = soCau;
    const d0 = msDbCongDon;
    const a = performance.now();
    await f();
    console.log(`| ${ten} | ${(performance.now() - a).toFixed(0)} | ${soCau - c0} | ${(msDbCongDon - d0).toFixed(0)} |`);
  }

  console.log("\n══ HÀM CÓ GHI — KHÔNG GỌI ══");
  console.log("- ensureRecurringExpensesForMonths (Dashboard: tháng này + tháng trước; Tài chính Lãi/Lỗ: tháng xem + tháng trước)");
  console.log("  → mỗi tháng 1 transaction Serializable (BEGIN/SET ISOLATION/findMany/N×findFirst/[INSERT]/COMMIT), chạy TUẦN TỰ trước khối Promise.all.");
  console.log(`  → mô phỏng đọc (cộng dồn MỌI lượt đo) thấy ${soDongSeSinh} lượt "sẽ sinh" (≠0 ⇒ lần render thật tiếp theo sẽ INSERT).`);
}

main()
  .catch((e: unknown) => {
    console.error("Lỗi:", e);
    process.exitCode = 1;
  })
  .finally(() => client.$disconnect());
