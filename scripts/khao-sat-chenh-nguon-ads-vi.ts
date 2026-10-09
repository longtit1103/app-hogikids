/**
 * Khảo sát CHỈ ĐỌC: chênh nguồn ads (Sổ chi phí) ↔ ví TikTok + đo hiện trạng "nợ phải trả".
 *
 *   npx tsx scripts/khao-sat-chenh-nguon-ads-vi.ts --db-test --tu 2026-07-01 --den 2026-09-30
 *   npx tsx scripts/khao-sat-chenh-nguon-ads-vi.ts --prod --tu 2026-07-01 --den 2026-09-30 [--moc-t 2026-08-01,2026-09-01]
 *
 * BẮT BUỘC đúng một cờ DB: `--db-test` (ép DATABASE_URL = TEST_DATABASE_URL, tên DB phải kết thúc `_test`)
 * hoặc `--prod` (dùng DATABASE_URL — CHỈ ĐỌC, chạy theo phép của chủ shop). Không cờ ⇒ thoát mã 2.
 * `--tu`/`--den` mặc định = 3 tháng gần nhất; `--moc-t` = danh sách phẩy, mặc định các ngày mùng 1 trong cửa sổ.
 *
 * Script chỉ gọi findMany/aggregate/groupBy/queryRaw SELECT — không có câu ghi nào. Kết quả KHÔNG phải số
 * điều chỉnh quỹ; ngày lệch qua lại giữa hai nguồn là hiện tượng trục thời gian, không phải "quỹ sai".
 */
import { existsSync } from "node:fs";
import path from "node:path";

import {
  chonMocT,
  congNgay,
  khaoSatChenhNguon,
  phanTichCheDoDb,
  type KetQuaKhaoSat,
} from "@/lib/no-phai-tra/khao-sat-chenh-nguon";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
let cheDo: ReturnType<typeof phanTichCheDoDb>;
try {
  cheDo = phanTichCheDoDb(process.argv, process.env);
} catch (e) {
  console.error(`${e instanceof Error ? e.message : String(e)}\nVí dụ: npx tsx scripts/khao-sat-chenh-nguon-ads-vi.ts --db-test --tu 2026-07-01 --den 2026-09-30`);
  process.exit(2);
}
process.env.DATABASE_URL = cheDo.databaseUrl;

function thamSo(ten: string): string | undefined {
  const i = process.argv.indexOf(ten);
  return i === -1 ? undefined : process.argv[i + 1];
}

function kiemNgay(ten: string, v: string | undefined): string | undefined {
  if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${ten} phải dạng yyyy-MM-dd, nhận "${v}".`);
  return v;
}

/** Lùi `n` tháng lịch từ khoá ngày (tính UTC thuần). */
function luiThang(khoa: string, n: number): string {
  const d = new Date(`${khoa}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

const vnd = (n: number) => `${n.toLocaleString("vi-VN")} ₫`;
const bang = (dau: string[], dong: string[][]) =>
  [`| ${dau.join(" | ")} |`, `|${dau.map(() => "---").join("|")}|`, ...dong.map((d) => `| ${d.join(" | ")} |`)].join("\n");

function inKhaoSat(r: KetQuaKhaoSat): void {
  console.log("\n## 1. Ads TIKTOK_ADS (Sổ chi phí) vs ví TikTok theo tuần\n");
  console.log(
    bang(
      ["Tuần (T2)", "Σ ads", "Σ ví (tuyệt đối)", "Tỉ lệ ví/ads", "Bank về (PAID)"],
      r.tuan.map((t) => [
        t.tuanBatDau,
        vnd(t.adsTiktok),
        vnd(t.viTiktok),
        t.tiLeViTrenAds === null ? "—" : t.tiLeViTrenAds.toFixed(3),
        vnd(t.bankVe),
      ]),
    ),
  );
  console.log("\n## 2. Độ phủ theo ngày + độ trễ đồng bộ\n");
  console.log(`- Ngày ads>0 mà ví=0: ${r.soNgayAdsCoViKhong}`);
  console.log(`- Ngày ví>0 mà ads=0: ${r.soNgayViCoAdsKhong}`);
  const ngay = (x: number | null) => (x === null ? "—" : `${x.toFixed(2)} ngày`);
  console.log(`- Trung vị trễ (syncedAt − orderCreateTime): ${ngay(r.trungViTreDongBoNgay)}`);
  console.log(`  - Chỉ dòng không backfill (syncedAt ≤ orderCreateTime + 30 ngày): ${ngay(r.trungViTreKhongBackfillNgay)}`);
  console.log("  - Ghi chú: syncedAt là lần sync đầu; dữ liệu backfill làm phồng số trung vị toàn bộ.");
  console.log(`- Dòng ads KHÔNG có adsSource: ${r.soDongAdsKhongNguon}`);
  console.log(`- Dòng ads theo source: ${JSON.stringify(r.adsTheoSource)}`);
  console.log(`- Dòng ads theo adsSource: ${JSON.stringify(r.adsTheoNguon)}`);
  if (r.moc.length > 0) {
    console.log("\n## 3. Hai phía quanh từng mốc T (±7 ngày) — KHÔNG phải số điều chỉnh quỹ\n");
    console.log(
      bang(
        ["T", "ads < T", "ads ≥ T", "ví < T", "ví ≥ T", "ước lượng lệch hai trục (tham khảo)"],
        r.moc.map((m) => [m.t, vnd(m.adsTruocT), vnd(m.adsTuT), vnd(m.viTruocT), vnd(m.viTuT), vnd(m.uocLuongLechHaiTruc)]),
      ),
    );
    console.log("\nƯớc lượng lệch hai trục = |(ads≥T) − (ví≥T)| − |(ads<T) − (ví<T)|. KHÔNG phải số điều chỉnh quỹ.");
  }
}

async function main(): Promise<void> {
  console.log("KHÔNG PHẢI SỐ ĐIỀU CHỈNH QUỸ — chỉ khảo sát chênh nguồn và độ phủ");

  const den = kiemNgay("--den", thamSo("--den")) ?? khoaNgayVn(new Date());
  const tu = kiemNgay("--tu", thamSo("--tu")) ?? luiThang(den, 3);
  const { mocT, canhBao } = chonMocT(tu, den, thamSo("--moc-t"));
  for (const c of canhBao) console.warn(`CẢNH BÁO: ${c}`);
  if (cheDo.che === "prod") console.warn("CHỈ ĐỌC — chạy trên prod theo phép của chủ shop.");
  // Biên nửa mở theo giờ VN: [tu 00:00, den+1 00:00).
  const batDau = new Date(`${tu}T00:00:00+07:00`);
  const ketThuc = new Date(`${congNgay(den, 1)}T00:00:00+07:00`);

  const url = new URL(process.env.DATABASE_URL ?? "postgres://thieu");
  console.log(`DB đích (${cheDo.che}): ${url.host}${url.pathname} · cửa sổ ${tu} → ${den} · mốc T: ${mocT.join(", ") || "—"}`);

  const { prisma } = await import("@/lib/prisma");
  try {
    // Đọc nới ±8 ngày quanh cửa sổ để phép đo mốc T sát biên không bị cắt; bảng tuần lọc lại trong cửa sổ.
    const doc = {
      tu: new Date(batDau.getTime() - 8 * 24 * 3600 * 1000),
      den: new Date(ketThuc.getTime() + 8 * 24 * 3600 * 1000),
    };

    const [ads, vi, payment] = await Promise.all([
      prisma.expense.findMany({
        where: { categoryId: "ads", date: { gte: doc.tu, lt: doc.den } },
        select: { adsSource: true, source: true, date: true, amount: true },
      }),
      prisma.tiktokAdsSettlement.findMany({
        where: { orderCreateTime: { gte: doc.tu, lt: doc.den } },
        select: { orderCreateTime: true, settlementAmount: true, syncedAt: true },
      }),
      prisma.tiktokPayment.findMany({
        where: { status: "PAID", paidTime: { gte: batDau, lt: ketThuc } },
        select: { paidTime: true, settlementValue: true },
      }),
    ]);
    const trong = (d: Date) => d >= batDau && d < ketThuc;
    const r = khaoSatChenhNguon({ ads, vi, payment, mocT });
    const trongCuaSo = khaoSatChenhNguon({
      ads: ads.filter((a) => trong(a.date)),
      vi: vi.filter((v) => trong(v.orderCreateTime)),
      payment,
    });
    inKhaoSat({ ...trongCuaSo, moc: r.moc });

    await inHienTrangNo(prisma, batDau, ketThuc);
  } finally {
    await prisma.$disconnect();
  }
}

type Prisma = Awaited<typeof import("@/lib/prisma")>["prisma"];

/** Khối "hiện trạng nợ": nhập hàng đã ghi, phiếu Bronze chưa ghi, mẫu định kỳ, và dòng ví Shopee lạ. */
async function inHienTrangNo(prisma: Prisma, batDau: Date, ketThuc: Date): Promise<void> {
  console.log("\n## 4. Hiện trạng nợ\n");

  const nhap = await prisma.expense.findMany({
    where: { categoryId: "purchase", date: { gte: batDau, lt: ketThuc } },
    select: { amount: true, refId: true },
  });
  const coRef = nhap.filter((e) => e.refId !== null);
  const sum = (xs: { amount: number }[]) => xs.reduce((s, e) => s + e.amount, 0);
  console.log(`- Expense purchase trong cửa sổ: ${nhap.length} dòng, Σ ${vnd(sum(nhap))}`);
  console.log(`  - có refId: ${coRef.length} dòng, Σ ${vnd(sum(coRef))} (mẫu refId: ${coRef.slice(0, 3).map((e) => e.refId).join(", ") || "—"})`);
  console.log(`  - không refId (nhập tay/định kỳ): ${nhap.length - coRef.length} dòng, Σ ${vnd(sum(nhap.filter((e) => e.refId === null)))}`);

  try {
    const { docDeXuatPhieuNhap } = await import("@/lib/nhap-hang/doc-phieu-nhap-bronze");
    const px = await docDeXuatPhieuNhap();
    console.log(
      `- Phiếu Bronze actual_purchase status=1 CHƯA có Expense: ${px.deXuat.length} phiếu, Σ ${vnd(px.deXuat.reduce((s, p) => s + p.soTien, 0))}` +
        ` (đã ghi ${px.daGhi.length}, trước ngày mở sổ ${px.boQuaTruocD0.soPhieu}, việc hậu kiểm ${px.soViecHauKiem}, tổng phiếu thật ${px.soPhieuNhapThat})`,
    );
  } catch (e) {
    console.log(`- Phiếu Bronze: KHÔNG đọc được (${e instanceof Error ? e.message.slice(0, 120) : String(e)}) — thường do DB test chưa cấu hình shop.`);
  }

  const mau = await prisma.recurringExpense.findMany({
    where: { categoryId: "purchase", active: true },
    select: { id: true, amount: true, dayOfMonth: true, description: true, activeFrom: true },
  });
  console.log(`- Mẫu RecurringExpense purchase đang bật: ${mau.length}`);
  for (const m of mau) {
    console.log(`  - ${m.id} · ngày ${m.dayOfMonth} · ${vnd(m.amount)} · "${m.description}" · từ ${m.activeFrom ? khoaNgayVn(m.activeFrom) : "không cận dưới"}`);
  }

  const theoLoai = await prisma.shopeeSettlement.groupBy({ by: ["type"], _count: { _all: true }, _sum: { amount: true } });
  console.log("\n### ShopeeSettlement theo type (toàn bảng)\n");
  console.log(bang(["type", "số dòng", "Σ amount"], theoLoai.map((g) => [g.type, String(g._count._all), vnd(g._sum.amount ?? 0)])));

  // Mô tả gốc ("Loại giao dịch" tiếng Việt) KHÔNG được lưu — parser chỉ giữ type đã quy đổi. Nên nhóm dòng
  // KHÔNG phải REVENUE/WITHDRAWAL theo (type, status, có mã đơn?, chiều tiền) — dấu vết tốt nhất còn lại.
  const la = await prisma.shopeeSettlement.findMany({
    where: { type: { notIn: ["REVENUE", "WITHDRAWAL"] } },
    select: { type: true, status: true, orderCode: true, amount: true },
  });
  const nhom = new Map<string, { n: number; tong: number }>();
  for (const d of la) {
    const k = `${d.type} · status="${d.status}" · ${d.orderCode === null ? "không mã đơn" : "có mã đơn"} · ${d.amount < 0 ? "ra" : "vào"}`;
    const g = nhom.get(k) ?? { n: 0, tong: 0 };
    g.n += 1;
    g.tong += d.amount;
    nhom.set(k, g);
  }
  const top5 = [...nhom].sort((a, b) => b[1].n - a[1].n).slice(0, 5);
  console.log("\n### 5 nhóm thường gặp của dòng KHÔNG phải REVENUE/WITHDRAWAL\n");
  console.log(
    top5.length === 0
      ? "(không có dòng nào)"
      : bang(["nhóm (type · status · mã đơn · chiều)", "số dòng", "Σ"], top5.map(([k, g]) => [k, String(g.n), vnd(g.tong)])),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
