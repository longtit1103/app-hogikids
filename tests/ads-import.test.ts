import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { importAdsExpenses, previewAdsImport } from "@/lib/actions/ads-import";
import { parseAdsFile } from "@/lib/import/ads-csv";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test import CSV ads (`hogikids_test`) — chạy trên DB thật, chỉ
 * `requireUser` bị mock (nó gọi `cookies()`, không có request scope trong
 * vitest). Auth thật đã phủ ở e2e (login) + unit session riêng. Các test này
 * tập trung kiểm LOGIC dedupe/xung đột/idempotent.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const META_CSV = readFileSync(path.resolve(process.cwd(), "tests/fixtures/ads-meta-sample.csv"));
const TIKTOK_CSV = readFileSync(path.resolve(process.cwd(), "tests/fixtures/ads-tiktok-sample.csv"));

/** Buffer → ArrayBuffer đúng offset (Buffer dùng chung pool nên phải slice). */
function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** FormData mô phỏng modal gửi lên: file + preset + channelId (+ conflictMode). */
function makeForm(
  buf: Buffer,
  opts: { preset: "META" | "TIKTOK"; channelId: string; conflictMode?: "skip" | "overwrite" }
): FormData {
  const fd = new FormData();
  fd.set("file", new Blob([toArrayBuffer(buf)]), "ads.csv");
  fd.set("preset", opts.preset);
  fd.set("channelId", opts.channelId);
  if (opts.conflictMode) fd.set("conflictMode", opts.conflictMode);
  return fd;
}

/** Neo ngày giống ingest ADS_API + import (00:00 giờ VN). */
function vnDate(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+07:00`);
}

/**
 * CSV ads tối giản đúng header của preset — để dựng ca CÙNG ngày + CÙNG tên chiến dịch + CÙNG số
 * tiền nhưng khác nguồn/kênh (fixture sẵn có đặt tên chiến dịch khác nhau nên không dựng được ca này).
 */
function makeCsv(
  preset: "META" | "TIKTOK",
  rows: { date: string; name: string; amount: number }[]
): Buffer {
  const header = preset === "META" ? "Ngày,Tên chiến dịch,Số tiền đã chi tiêu (VND)" : "Date,Campaign name,Cost";
  const body = rows.map((r) => `${r.date},${r.name},${r.amount}`).join("\n");
  return Buffer.from(`${header}\n${body}\n`, "utf8");
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("parseAdsFile", () => {
  it("META fixture → 5 chiến dịch DUY NHẤT (6 dòng gồm 1 trùng nội bộ) + 1 dòng lỗi thiếu tiền", () => {
    const { rows, errors } = parseAdsFile(toArrayBuffer(META_CSV), "META");

    // parse KHÔNG dedupe: 5 dòng hợp lệ khác nhau + 1 dòng lặp lại = 6 rows.
    expect(rows).toHaveLength(6);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/số tiền/i);

    // 5 chiến dịch DUY NHẤT (khớp mô tả brief "5 valid").
    const unique = new Set(rows.map((r) => `${r.date.toISOString()}|${r.campaignName}|${r.amount}`));
    expect(unique.size).toBe(5);

    // Ngày được neo 00:00 giờ VN (00:00+07 == 17:00Z hôm trước).
    expect(rows[0].campaignName).toContain("Chiến dịch A");
    expect(rows[0].amount).toBe(150000);
    expect(rows[0].date.toISOString()).toBe("2026-06-30T17:00:00.000Z");
  });

  it("TikTok fixture → 3 dòng hợp lệ, 0 lỗi", () => {
    const { rows, errors } = parseAdsFile(toArrayBuffer(TIKTOK_CSV), "TIKTOK");
    expect(rows).toHaveLength(3);
    expect(errors).toHaveLength(0);
    expect(rows[0].amount).toBe(120000);
  });
});

describe("importAdsExpenses — idempotent", () => {
  it("import cùng file 2 lần → lần 2 imported=0, skippedDuplicates=5", async () => {
    const first = await importAdsExpenses(makeForm(META_CSV, { preset: "META", channelId: "facebook" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 6 dòng parse → dedupe nội bộ còn 5 → import 5; 1 dòng thiếu tiền = invalid.
    expect(first.data.imported).toBe(5);
    expect(first.data.skippedInvalid).toBe(1);
    expect(first.data.skippedDuplicates).toBe(0);
    expect(await prisma.expense.count({ where: { categoryId: "ads", source: "IMPORT" } })).toBe(5);

    const second = await importAdsExpenses(makeForm(META_CSV, { preset: "META", channelId: "facebook" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.imported).toBe(0);
    expect(second.data.skippedDuplicates).toBe(5);
    // Không sinh thêm dòng nào.
    expect(await prisma.expense.count({ where: { categoryId: "ads", source: "IMPORT" } })).toBe(5);
  });
});

describe("importAdsExpenses — dedupe theo nguồn ads", () => {
  const TRUNG = [{ date: "2026-07-01", name: "Chiến dịch trùng tên", amount: 150000 }];

  it("cùng ngày+tên+tiền nhưng KHÁC nguồn ads → nhập CẢ HAI (không bỏ sót chi tiêu)", async () => {
    // GIỮ NGUYÊN `channelId` giữa hai lượt để phép thử chỉ biến thiên ĐÚNG chiều `adsSource`.
    // Đổi cả kênh lẫn nguồn thì test vẫn xanh kể cả khi ai đó gỡ `adsSource` khỏi khoá — xanh giả.
    const meta = await importAdsExpenses(
      makeForm(makeCsv("META", TRUNG), { preset: "META", channelId: "facebook" })
    );
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.data.imported).toBe(1);

    // Dòng META vừa ghi KHÔNG được chặn dòng TikTok: hai sàn đặt trùng tên chiến dịch, trùng ngân
    // sách ngày là chuyện thường — bỏ sót một bên là chi tiêu ads hụt, lợi nhuận cao ảo.
    const tiktok = await importAdsExpenses(
      makeForm(makeCsv("TIKTOK", TRUNG), { preset: "TIKTOK", channelId: "facebook" })
    );
    expect(tiktok.ok).toBe(true);
    if (!tiktok.ok) return;
    expect(tiktok.data.imported).toBe(1);
    expect(tiktok.data.skippedDuplicates).toBe(0);

    const rows = await prisma.expense.findMany({
      where: { categoryId: "ads", source: "IMPORT" },
      orderBy: { adsSource: "asc" },
    });
    expect(rows.map((r) => r.adsSource)).toEqual(["META", "TIKTOK_ADS"]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(300000);
  });

  it("import LẠI cùng một file mà bấm kênh khác → vẫn là trùng, KHÔNG chèn bản sao", async () => {
    // `channelId` là nhãn quy kênh chủ shop tự chọn trong modal, KHÔNG có trong file. Nếu nó nằm
    // trong khoá định danh thì thao tác rất đời thường "import lại để sửa kênh cho đúng" sẽ chèn
    // nguyên một bản sao: chi phí ads đếm 2 lần, lãi ròng thấp ảo, mà màn hình vẫn báo "bỏ qua 0
    // dòng trùng". Đo thật lúc lỗi còn sống: 700.000đ thay vì 350.000đ.
    const lan1 = await importAdsExpenses(
      makeForm(makeCsv("META", TRUNG), { preset: "META", channelId: "facebook" })
    );
    expect(lan1.ok).toBe(true);
    if (!lan1.ok) return;
    expect(lan1.data.imported).toBe(1);

    const lan2 = await importAdsExpenses(
      makeForm(makeCsv("META", TRUNG), { preset: "META", channelId: "shopee" })
    );
    expect(lan2.ok).toBe(true);
    if (!lan2.ok) return;
    expect(lan2.data.imported).toBe(0);
    expect(lan2.data.skippedDuplicates).toBe(1);

    const rows = await prisma.expense.findMany({ where: { categoryId: "ads", source: "IMPORT" } });
    expect(rows).toHaveLength(1);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(150000);
  });

  it("dòng sổ cũ BỎ TRỐNG nguồn/kênh vẫn chặn dòng file trùng (không nhập trùng lặp)", async () => {
    // Sổ có sẵn hai dòng nhập tay đời cũ: một dòng trống CẢ nguồn lẫn kênh (nhập trước khi form bắt
    // buộc chọn nguồn ads), một dòng chỉ trống kênh (kênh tới giờ vẫn không bắt buộc). Thêm chiều
    // nguồn/kênh vào khoá mà so cứng thì hai dòng này thành "khác nguồn" ⇒ import chèn thêm bản sao
    // ⇒ chi tiêu ads đếm 2 lần — đúng chiều ngược của lỗi vừa vá.
    await prisma.expense.createMany({
      data: [
        {
          date: vnDate("2026-07-01"),
          categoryId: "ads",
          adsSource: null,
          description: "Chiến dịch A - Váy hè",
          channelId: null,
          amount: 150000,
          source: "MANUAL",
          refId: null,
        },
        {
          date: vnDate("2026-07-02"),
          categoryId: "ads",
          adsSource: "META",
          description: "Chiến dịch B - Áo thun",
          channelId: null,
          amount: 200000,
          source: "MANUAL",
          refId: null,
        },
      ],
    });

    const res = await importAdsExpenses(makeForm(META_CSV, { preset: "META", channelId: "facebook" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 5 dòng duy nhất, 2 dòng đã có trong sổ → chỉ chèn 3.
    expect(res.data.skippedDuplicates).toBe(2);
    expect(res.data.imported).toBe(3);

    // Hai ngày đó vẫn đúng 1 dòng mỗi ngày — không có bản sao nào.
    expect(await prisma.expense.count({ where: { date: vnDate("2026-07-01") } })).toBe(1);
    expect(await prisma.expense.count({ where: { date: vnDate("2026-07-02") } })).toBe(1);
    expect(await prisma.expense.count({ where: { categoryId: "ads" } })).toBe(5);
  });
});

describe("importAdsExpenses — xung đột ADS_API", () => {
  async function seedApiRow(): Promise<void> {
    await prisma.expense.create({
      data: {
        date: vnDate("2026-07-01"),
        categoryId: "ads",
        adsSource: "META",
        description: "Auto Meta 01/07",
        channelId: "facebook",
        amount: 999000,
        source: "ADS_API",
        refId: "meta:2026-07-01:c1",
      },
    });
  }

  it("preview → apiConflicts đúng ngày đã có ADS_API", async () => {
    await seedApiRow();
    const res = await previewAdsImport(makeForm(META_CSV, { preset: "META", channelId: "facebook" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.apiConflicts).toHaveLength(1);
    expect(res.data.apiConflicts[0]).toEqual({ date: "2026-07-01", adsSource: "META", apiAmount: 999000 });
  });

  it('conflictMode="skip" → dòng ngày 2026-07-01 KHÔNG import, số ads ngày đó không đổi', async () => {
    await seedApiRow();
    const res = await importAdsExpenses(
      makeForm(META_CSV, { preset: "META", channelId: "facebook", conflictMode: "skip" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 5 dòng duy nhất, bỏ 07-01 (đã có API) → import 4.
    expect(res.data.imported).toBe(4);
    expect(res.data.overwrittenApiRows).toBe(0);

    // Ngày 07-01 chỉ còn đúng 1 dòng ADS_API 999.000 (không thêm dòng IMPORT).
    const day01 = await prisma.expense.findMany({ where: { date: vnDate("2026-07-01") } });
    expect(day01).toHaveLength(1);
    expect(day01[0].source).toBe("ADS_API");
    expect(day01[0].amount).toBe(999000);
    expect(await prisma.expense.count({ where: { source: "IMPORT", date: vnDate("2026-07-01") } })).toBe(0);
  });

  it('conflictMode="overwrite" → xoá dòng ADS_API, dòng IMPORT thay thế, không đếm 2 lần', async () => {
    await seedApiRow();
    const res = await importAdsExpenses(
      makeForm(META_CSV, { preset: "META", channelId: "facebook", conflictMode: "overwrite" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.imported).toBe(5);
    expect(res.data.overwrittenApiRows).toBe(1);

    // Ngày 07-01 giờ chỉ có đúng 1 dòng IMPORT 150.000, KHÔNG còn ADS_API.
    const day01 = await prisma.expense.findMany({ where: { date: vnDate("2026-07-01") } });
    expect(day01).toHaveLength(1);
    expect(day01[0].source).toBe("IMPORT");
    expect(day01[0].amount).toBe(150000);
    expect(await prisma.expense.count({ where: { source: "ADS_API" } })).toBe(0);
  });

  it('conflictMode="overwrite" → ngày vừa có dòng IMPORT trùng VỪA có ADS_API vẫn xoá ADS_API (không đếm 2 lần)', async () => {
    // Kịch bản double-count: 07-01 đã có sẵn 1 dòng IMPORT trùng hệt dòng file
    // (150.000 "Chiến dịch A - Váy hè") → dedupe DB (bước 3) loại dòng file 07-01
    // TRƯỚC khi tính ngày ghi đè. Đồng thời 07-01 có 1 dòng ADS_API 999.000
    // (đơn ads re-sync về). Nếu ngày ghi đè lấy từ afterDbDedupe, ADS_API 07-01
    // không bị xoá → 07-01 bị đếm 2 lần (IMPORT 150k + ADS_API 999k).
    await prisma.expense.create({
      data: {
        date: vnDate("2026-07-01"),
        categoryId: "ads",
        adsSource: "META",
        description: "Chiến dịch A - Váy hè", // khớp dòng file → bị dedupe DB loại
        channelId: "facebook",
        amount: 150000,
        source: "IMPORT",
        refId: null,
      },
    });
    await seedApiRow(); // ADS_API 07-01 999.000 META

    const res = await importAdsExpenses(
      makeForm(META_CSV, { preset: "META", channelId: "facebook", conflictMode: "overwrite" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 07-01 bị dedupe DB (trùng IMPORT sẵn có) → không chèn lại; 4 ngày còn lại chèn.
    expect(res.data.imported).toBe(4);
    expect(res.data.skippedDuplicates).toBe(1);
    // Dòng ADS_API 07-01 VẪN phải bị xoá dù dòng file 07-01 đã rơi ở bước dedupe DB.
    expect(res.data.overwrittenApiRows).toBe(1);

    // Ngày 07-01 chỉ còn đúng 1 dòng IMPORT 150.000, KHÔNG còn ADS_API (không đếm 2 lần).
    const day01 = await prisma.expense.findMany({ where: { date: vnDate("2026-07-01") } });
    expect(day01).toHaveLength(1);
    expect(day01[0].source).toBe("IMPORT");
    expect(day01[0].amount).toBe(150000);
    expect(await prisma.expense.count({ where: { source: "ADS_API" } })).toBe(0);

    // Import lại cùng file → không sinh thêm dòng, không còn ADS_API để xoá.
    const rerun = await importAdsExpenses(
      makeForm(META_CSV, { preset: "META", channelId: "facebook", conflictMode: "overwrite" })
    );
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    expect(rerun.data.imported).toBe(0);
    expect(rerun.data.skippedDuplicates).toBe(5);
    expect(rerun.data.overwrittenApiRows).toBe(0);
  });

  it('conflictMode="overwrite" → dòng ADS_API lệch mốc 00:00 (giữa kỳ + ngày cuối) vẫn bị phát hiện và xoá', async () => {
    // Dòng ADS_API đời cũ / sửa thẳng bằng SQL có thể mang giờ khác 00:00+07. Xung đột được PHÁT
    // HIỆN bằng khoá ngày VN, nên cả cửa sổ quét lẫn phép xoá phải theo KHOẢNG NGÀY — không thì ngày
    // đó có cả IMPORT lẫn ADS_API và `overwrittenApiRows` báo thiếu.
    await prisma.expense.createMany({
      data: [
        {
          date: new Date("2026-07-01T09:30:00+07:00"), // ngày GIỮA kỳ file
          categoryId: "ads",
          adsSource: "META",
          description: "API lệch mốc 01/07",
          channelId: "facebook",
          amount: 111000,
          source: "ADS_API",
          refId: "meta:2026-07-01:c-lech",
        },
        {
          date: new Date("2026-07-05T23:59:00+07:00"), // NGÀY CUỐI của file = biên phải
          categoryId: "ads",
          adsSource: "META",
          description: "API lệch mốc 05/07",
          channelId: "facebook",
          amount: 222000,
          source: "ADS_API",
          refId: "meta:2026-07-05:c-lech",
        },
      ],
    });

    // Preview phải báo CẢ 2 ngày — dòng ở ngày cuối từng rơi ngoài cửa sổ quét.
    const xemTruoc = await previewAdsImport(makeForm(META_CSV, { preset: "META", channelId: "facebook" }));
    expect(xemTruoc.ok).toBe(true);
    if (!xemTruoc.ok) return;
    expect(xemTruoc.data.apiConflicts.map((c) => c.date)).toEqual(["2026-07-01", "2026-07-05"]);

    const res = await importAdsExpenses(
      makeForm(META_CSV, { preset: "META", channelId: "facebook", conflictMode: "overwrite" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.imported).toBe(5);
    expect(res.data.overwrittenApiRows).toBe(2);
    expect(await prisma.expense.count({ where: { source: "ADS_API" } })).toBe(0);
    // 5 ngày = 5 dòng IMPORT, không ngày nào bị đếm 2 lần.
    expect(await prisma.expense.count()).toBe(5);
  });
});
