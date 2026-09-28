import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

/**
 * `failNextWith` — ép lượt transform NGAY SAU khi land ném lỗi, để dòng nằm lại Bronze mà không có
 * bản Silver nào (đúng hình dạng "đơn kẹt" mà backfill phải cứu).
 * `khongLamGi` — transform chạy thật nhưng trên một shop không có dòng nào ⇒ trả stats rỗng, không
 * ghi gì. Dùng để dựng ca "thử xong vẫn LEGACY" mà không phải bịa ra một đối tượng stats.
 */
const transformControl = vi.hoisted(() => ({
  failNextWith: null as Error | null,
  khongLamGi: false,
}));

// Chỉ mock hai thứ cần request scope (`cookies()` / `revalidatePath`) — mọi đường ghi khác chạy THẬT.
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user-id") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/bronze/transform-from-raw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bronze/transform-from-raw")>();
  const transformFromRaw: typeof actual.transformFromRaw = async (stream, warnings, opts) => {
    if (transformControl.failNextWith) {
      const err = transformControl.failNextWith;
      transformControl.failNextWith = null;
      throw err;
    }
    if (transformControl.khongLamGi) {
      return actual.transformFromRaw(stream, warnings, { ...opts, shopId: "shop-khong-co-that" });
    }
    return actual.transformFromRaw(stream, warnings, opts);
  };
  return { ...actual, transformFromRaw };
});

import { POST as ingestRaw } from "@/app/api/ingest/raw/route";
import { chayBackfillLegacy, khaoSatLegacy } from "@/lib/bronze/backfill-ket-cuc-legacy";
import { KET_CUC } from "@/lib/bronze/ket-cuc-silver";
import { SHOP_KHO, SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Backfill kết cục cho kho dữ liệu cũ (`silverOutcome = 'LEGACY'`).
 *
 * Nhãn `LEGACY` do migration đặt cho mọi dòng có trước nó = "chưa ai kiểm". Lượt đối soát đêm CỐ Ý
 * không đụng tới, nên phải có một lượt TAY có xác nhận dọn nốt. Hai ranh giới phải giữ:
 *  - mặc định KHÔNG ghi gì (chạy nhầm trên prod vẫn vô hại);
 *  - chỉ đụng dòng `LEGACY` — `APPLIED` đã chốt và `DISCARDED` (chủ shop chủ ý xoá) phải nguyên vẹn.
 */

const SCRIPT = "scripts/backfill-ket-cuc-legacy.ts";

function chayScript(thamSo: string[]): { stdout: string; stderr: string; status: number | null } {
  const kq = spawnSync("./node_modules/.bin/tsx", [SCRIPT, ...thamSo], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (kq.error) throw kq.error;
  return { stdout: kq.stdout, stderr: kq.stderr, status: kq.status };
}

const donShopee = (id: string) => `{
  "id":"${id}","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-BF1","name":"SP","retail_price":100000}}]}`;

/** Đơn MIRROR shop kho: hai luật mirror (nguồn Affiliate + id `AF<shop>O`) phải cùng nói "mirror". */
const donMirrorKho = (id: string) => `{
  "id":"${id}","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Affiliate","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":0,
  "items":[{"quantity":1,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-BF1","name":"SP","retail_price":200000}}]}`;

const land = (shopId: string, body: string) =>
  ingestRaw(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: "orders", shopId, payload: `{"success":true,"data":[${body}]}` }),
    })
  );

/** Land một đơn rồi ép nó về đúng hình dạng kho cũ: Bronze còn dòng, Sổ chưa có, nhãn `LEGACY`. */
async function landRoiDanhDauLegacy(shopId: string, body: string): Promise<void> {
  transformControl.failNextWith = new Error("mô phỏng chết giữa land và transform");
  await land(shopId, body);
}

const danhDauTatCaLegacy = () =>
  prisma.rawPancakeOrder.updateMany({
    data: { silverOutcome: KET_CUC.LEGACY, silverProcessedAt: null, silverNote: null },
  });

/** BẢN MỚI NHẤT của một đơn — cùng thứ tự mà mọi câu lọc kết cục dùng (một đơn có nhiều phiên bản). */
const donTheoExternalId = (externalId: string) =>
  prisma.rawPancakeOrder.findFirstOrThrow({
    where: { externalId },
    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
  });

async function donSach(): Promise<void> {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.syncLog.deleteMany();
  await prisma.setting.deleteMany({ where: { key: { in: ["bronzeBacklogPending", "khoaViecNang"] } } });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await donSach();
  transformControl.failNextWith = null;
  transformControl.khongLamGi = false;
});

afterAll(async () => {
  await donSach();
});

describe("backfill kết cục LEGACY", () => {
  it("lượt THỬ chỉ đọc — không đụng Bronze lẫn Sổ", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-THU"));
    await danhDauTatCaLegacy();
    const truoc = await prisma.rawPancakeOrder.findMany({ orderBy: { id: "asc" } });

    const ks = await khaoSatLegacy();

    expect(ks.legacyMoiNhat).toBe(1);
    expect(ks.hetLegacy).toBe(false);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.rawPancakeOrder.findMany({ orderBy: { id: "asc" } })).toEqual(truoc);
  });

  it("đơn LEGACY mới nhất: đơn thật → APPLIED (dựng được vào Sổ), đơn mirror → EXCLUDED_MIRROR", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-THAT"));
    await landRoiDanhDauLegacy(SHOP_KHO, donMirrorKho("AF714995134O777"));
    await danhDauTatCaLegacy();
    expect(await prisma.order.count()).toBe(0);

    const kq = await chayBackfillLegacy([]);

    expect((await donTheoExternalId("ORD-BF-THAT")).silverOutcome).toBe(KET_CUC.APPLIED);
    expect((await donTheoExternalId("AF714995134O777")).silverOutcome).toBe(KET_CUC.EXCLUDED_MIRROR);
    // Mirror KHÔNG vào Sổ (bất biến doanh thu #2) — đúng một đơn thật được dựng.
    expect(await prisma.order.count()).toBe(1);
    expect(kq.sau.legacyMoiNhat).toBe(0);
    expect(kq.sau.hetLegacy).toBe(true);
    expect(kq.ketCucDaThu).toEqual({ [KET_CUC.APPLIED]: 1, [KET_CUC.EXCLUDED_MIRROR]: 1 });
  });

  it("đơn LEGACY ĐÃ CÓ trong Sổ: đóng dấu APPLIED mà KHÔNG đổi một đồng nào", async () => {
    // Ca CHIẾM ĐA SỐ trên prod: dòng cũ vốn đã vào Sổ từ lâu, chỉ thiếu cái nhãn. Lượt backfill ghi
    // lại bằng CHÍNH payload đó nên mọi con số phải y nguyên — đây là bất biến tiền của lượt này.
    await land(SHOP_SHOPEE, donShopee("ORD-BF-DA-CO"));
    const truoc = await prisma.order.findFirstOrThrow({ where: { pancakeId: "ORD-BF-DA-CO" } });
    await danhDauTatCaLegacy();

    await chayBackfillLegacy([]);

    const sau = await prisma.order.findFirstOrThrow({ where: { pancakeId: "ORD-BF-DA-CO" } });
    expect((await donTheoExternalId("ORD-BF-DA-CO")).silverOutcome).toBe(KET_CUC.APPLIED);
    // `syncedAt` là dấu "lần ghi gần nhất" nên ĐƯỢC phép đổi; tiền thì không.
    expect({ ...sau, syncedAt: truoc.syncedAt }).toEqual(truoc);
  });

  it("bản CŨ mang SỐ TIỀN KHÁC không được đè bản mới đã vào Sổ", async () => {
    // Hai bản cùng đơn nhưng KHÁC tiền — hai bản GIỐNG nhau thì mọi con số vẫn khớp dù luật hỏng,
    // tức xanh giả. Thứ giữ tiền ở đây là hai tầng "chỉ chạm BẢN MỚI NHẤT": `locDonLegacy` chọn đơn
    // theo bản mới nhất, và `latestPayloads` trong transform cũng đọc bản mới nhất ⇒ payload cũ
    // KHÔNG có đường nào vào Sổ. Bản cũ chỉ được đóng `SUPERSEDED` bằng SQL thuần.
    await land(SHOP_SHOPEE, donShopee("ORD-BF-2-BAN")); // bản MỚI: itemsTotal 200.000
    const moiNhat = await donTheoExternalId("ORD-BF-2-BAN");
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: moiNhat.shopId,
        externalId: moiNhat.externalId,
        payloadHash: "hash-cu-tien-khac",
        // Bản CŨ khai 999.000 — nếu nó lọt vào Sổ thì doanh thu nhảy, thấy ngay.
        payload: JSON.parse(
          donShopee("ORD-BF-2-BAN").replace('"total_price":200000', '"total_price":999000')
        ),
        fetchedAt: new Date(moiNhat.fetchedAt.getTime() - 60_000),
        silverOutcome: KET_CUC.LEGACY,
      },
    });
    const tienTruoc = (await prisma.order.findFirstOrThrow({ where: { pancakeId: "ORD-BF-2-BAN" } }))
      .itemsTotal;

    const kq = await chayBackfillLegacy([]);

    const tienSau = (await prisma.order.findFirstOrThrow({ where: { pancakeId: "ORD-BF-2-BAN" } }))
      .itemsTotal;
    expect(tienSau).toBe(tienTruoc); // 200.000, KHÔNG phải 999.000
    expect(
      (await prisma.rawPancakeOrder.findFirstOrThrow({ where: { payloadHash: "hash-cu-tien-khac" } }))
        .silverOutcome
    ).toBe(KET_CUC.SUPERSEDED);
    expect(kq.truoc.tienSo.itemsTotal).toBe(kq.sau.tienSo.itemsTotal);
  });

  it("bản CŨ của cùng đơn → SUPERSEDED (không transform lại bằng payload cũ)", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-CU"));
    const moiNhat = await donTheoExternalId("ORD-BF-CU");
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: moiNhat.shopId,
        externalId: moiNhat.externalId,
        payloadHash: "hash-cu-hon",
        payload: moiNhat.payload as object,
        fetchedAt: new Date(moiNhat.fetchedAt.getTime() - 60_000),
      },
    });
    await danhDauTatCaLegacy();

    const kq = await chayBackfillLegacy([]);

    expect(kq.banCuDaDong).toBe(1);
    const cu = await prisma.rawPancakeOrder.findFirstOrThrow({ where: { payloadHash: "hash-cu-hon" } });
    expect(cu.silverOutcome).toBe(KET_CUC.SUPERSEDED);
    expect((await donTheoExternalId("ORD-BF-CU")).silverOutcome).toBe(KET_CUC.APPLIED);
    expect(kq.sau.hetLegacy).toBe(true);
  });

  it("KHÔNG đụng dòng không phải LEGACY — kể cả dòng chủ shop đã chủ ý xoá", async () => {
    // Đơn đã chốt APPLIED ở lượt land bình thường.
    await land(SHOP_SHOPEE, donShopee("ORD-BF-APPLIED"));
    const dauApplied = await donTheoExternalId("ORD-BF-APPLIED");
    expect(dauApplied.silverOutcome).toBe(KET_CUC.APPLIED);

    // Dòng chủ shop đã bấm "Xóa dữ liệu giao dịch" — Sổ rỗng CÓ CHỦ ĐÍCH, dựng lại là hoàn tác ngầm.
    transformControl.failNextWith = new Error("mô phỏng chết giữa land và transform");
    await land(SHOP_SHOPEE, donShopee("ORD-BF-DISCARDED"));
    await prisma.rawPancakeOrder.updateMany({
      where: { externalId: "ORD-BF-DISCARDED" },
      data: { silverOutcome: KET_CUC.DISCARDED, silverProcessedAt: new Date() },
    });

    // Đúng MỘT dòng mang nhãn LEGACY.
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-LEGACY"));
    await prisma.rawPancakeOrder.updateMany({
      where: { externalId: "ORD-BF-LEGACY" },
      data: { silverOutcome: KET_CUC.LEGACY, silverProcessedAt: null },
    });

    await chayBackfillLegacy([]);

    const sauApplied = await donTheoExternalId("ORD-BF-APPLIED");
    expect(sauApplied).toEqual(dauApplied); // không đóng dấu lại, không đổi ghi chú
    const sauDiscarded = await donTheoExternalId("ORD-BF-DISCARDED");
    expect(sauDiscarded.silverOutcome).toBe(KET_CUC.DISCARDED);
    // Sổ chỉ có đơn APPLIED cũ + đơn LEGACY vừa dựng — đơn đã xoá KHÔNG hồi sinh.
    const maDon = (await prisma.order.findMany({ select: { pancakeId: true } })).map((o) => o.pancakeId);
    expect(maDon.sort()).toEqual(["ORD-BF-APPLIED", "ORD-BF-LEGACY"]);
  });

  it("chạy lại lần hai là no-op — Sổ không đổi một dòng nào", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-LAP"));
    await danhDauTatCaLegacy();
    await chayBackfillLegacy([]);

    const soSauLuot1 = await prisma.order.findMany({ orderBy: { pancakeId: "asc" } });
    const bronzeSauLuot1 = await prisma.rawPancakeOrder.findMany({ orderBy: { id: "asc" } });

    const kq2 = await chayBackfillLegacy([]);

    expect(kq2.soLo).toBe(0);
    expect(kq2.banCuDaDong).toBe(0);
    expect(kq2.sau.hetLegacy).toBe(true);
    expect(await prisma.order.findMany({ orderBy: { pancakeId: "asc" } })).toEqual(soSauLuot1);
    expect(await prisma.rawPancakeOrder.findMany({ orderBy: { id: "asc" } })).toEqual(bronzeSauLuot1);
  });

  it("sau 'Xóa dữ liệu giao dịch': backfill KHÔNG hồi sinh Sổ, chỉ nút Dựng lại mới được", async () => {
    // Chuỗi nguy hiểm: chủ shop xoá Sổ → chạy backfill → hàng trăm ĐƠN quay lại, nhưng settlement /
    // chi tiêu quảng cáo / chi phí nhập tay thì KHÔNG ⇒ một cái Sổ phục hồi NỬA VỜI mà lượt chạy
    // vẫn báo thành công. Đi bằng ĐƯỜNG THẬT (`deleteAllData`, `dungLaiTuKhoTho`), không giả lập.
    await land(SHOP_SHOPEE, donShopee("ORD-BF-XOA-TAY"));
    await prisma.rawPancakeOrder.updateMany({
      data: { silverOutcome: KET_CUC.LEGACY, silverProcessedAt: null, silverNote: null },
    });
    const user = await prisma.user.upsert({
      where: { id: "test-user-id" },
      update: { shopName: "HogiKids Test" },
      create: {
        id: "test-user-id",
        email: "backfill-xoa@hogikids.test",
        passwordHash: `${"0".repeat(32)}:${"0".repeat(128)}`,
        shopName: "HogiKids Test",
      },
    });

    const { deleteAllData, dungLaiTuKhoTho } = await import("@/lib/actions/data-admin");
    expect((await deleteAllData(user.shopName)).ok).toBe(true);

    // ① Lượt xoá phải đóng dấu CHỦ ĐÍCH lên cả dòng LEGACY, không riêng dòng còn dở.
    expect((await donTheoExternalId("ORD-BF-XOA-TAY")).silverOutcome).toBe(KET_CUC.DISCARDED);
    expect(await prisma.order.count()).toBe(0);

    // ② Backfill chạy sau đó KHÔNG được dựng lại gì — và cũng không còn coi đó là việc của mình.
    const kq = await chayBackfillLegacy([]);
    expect(await prisma.order.count()).toBe(0);
    expect(kq.sau.hetLegacy).toBe(true);
    expect(kq.sau.tienSo.itemsTotal).toBe(0);

    // ③ Đường phục hồi ĐÚNG vẫn mở: nút "Dựng lại từ kho thô" có quyền ghi đè DISCARDED.
    expect((await dungLaiTuKhoTho()).ok).toBe(true);
    expect(await prisma.order.count()).toBe(1);
    expect((await donTheoExternalId("ORD-BF-XOA-TAY")).silverOutcome).toBe(KET_CUC.APPLIED);
  }, 60_000);

  it("thử xong vẫn LEGACY ⇒ dừng ngay (không quay vòng vô hạn) và báo CHƯA SẠCH", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-KET"));
    await danhDauTatCaLegacy();
    transformControl.khongLamGi = true;

    const canhBao: string[] = [];
    const kq = await chayBackfillLegacy(canhBao);

    expect(kq.soLo).toBe(1); // đúng MỘT lô rồi dừng, không lặp lại mãi cùng nhóm đơn
    expect(kq.sau.legacyMoiNhat).toBe(1);
    expect(kq.sau.hetLegacy).toBe(false);
    expect(kq.donKet.map((d) => d.externalId)).toEqual(["ORD-BF-KET"]);
    expect(canhBao.join(" ")).toContain("vẫn ở LEGACY");
  });
});

describe("script backfill (chạy thật, DB test)", () => {
  it("KHÔNG có cờ --ghi ⇒ chỉ báo cáo, không sửa gì, thoát 0", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-CLI-THU"));
    await danhDauTatCaLegacy();
    const truoc = await prisma.rawPancakeOrder.findMany({ orderBy: { id: "asc" } });
    const soSyncLogTruoc = await prisma.syncLog.count();

    const kq = chayScript([]);

    expect(kq.status).toBe(0);
    expect(kq.stdout).toContain("LƯỢT THỬ");
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.rawPancakeOrder.findMany({ orderBy: { id: "asc" } })).toEqual(truoc);
    // "Không ghi gì" phải đúng theo nghĩa ĐEN — không đẻ cả nhật ký đồng bộ lẫn khoá việc nặng.
    // So với mốc trước lượt chạy: lượt land ở trên đã tự đẻ một dòng SyncLog của riêng nó.
    expect(await prisma.syncLog.count()).toBe(soSyncLogTruoc);
    expect(await prisma.setting.findUnique({ where: { key: "khoaViecNang" } })).toBeNull();
  }, 120_000);

  it("cờ gõ sai ⇒ KÊU TO, không âm thầm thành lượt thử", async () => {
    // `--ghi=1` mà im lặng chạy lượt thử là kiểu hỏng tệ nhất: người chạy tin là đã ghi.
    const kq = chayScript(["--ghi=1"]);

    expect(kq.status).toBe(1);
    expect(kq.stderr).toContain("Cờ không nhận ra");
  }, 120_000);

  it("--ghi mà không --yes và không TTY ⇒ thoát 1, không ghi gì", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-CLI-TTY"));
    await danhDauTatCaLegacy();

    const kq = chayScript(["--ghi"]);

    expect(kq.status).toBe(1);
    expect(kq.stderr).toContain("--yes");
    expect((await donTheoExternalId("ORD-BF-CLI-TTY")).silverOutcome).toBe(KET_CUC.LEGACY);
    expect(await prisma.order.count()).toBe(0);
  }, 120_000);

  it("việc nặng KHÁC đang giữ khoá ⇒ thoát 1 và KHÔNG giật khoá của nó", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-CLI-KHOA"));
    await danhDauTatCaLegacy();
    const giaTriKhoa = `token-viec-khac|${Date.now() + 5 * 60_000}|phục hồi dữ liệu`;
    await prisma.setting.create({ data: { key: "khoaViecNang", value: giaTriKhoa } });

    const kq = chayScript(["--ghi", "--yes"]);

    expect(kq.status).toBe(1);
    expect(kq.stderr).toContain("phục hồi dữ liệu");
    // Khoá của việc kia phải NGUYÊN VẸN — trả nhầm khoá người khác là mở đường cho hai lượt ghi đè nhau.
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "khoaViecNang" } })).value).toBe(
      giaTriKhoa
    );
    expect((await donTheoExternalId("ORD-BF-CLI-KHOA")).silverOutcome).toBe(KET_CUC.LEGACY);
  }, 120_000);

  it("còn lượt đồng bộ PANCAKE đang chạy ⇒ thoát 1, không đẻ SyncLog mới", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-CLI-SYNC"));
    await danhDauTatCaLegacy();
    await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "RUNNING" } });
    const soSyncLogTruoc = await prisma.syncLog.count();

    const kq = chayScript(["--ghi", "--yes"]);

    expect(kq.status).toBe(1);
    expect(kq.stderr).toContain("RUNNING");
    expect(await prisma.syncLog.count()).toBe(soSyncLogTruoc); // bị chặn ⇒ không đẻ dòng nào
    expect((await donTheoExternalId("ORD-BF-CLI-SYNC")).silverOutcome).toBe(KET_CUC.LEGACY);
  }, 120_000);

  it("--ghi --yes ⇒ dọn sạch LEGACY và thoát 0", async () => {
    await landRoiDanhDauLegacy(SHOP_SHOPEE, donShopee("ORD-BF-CLI-GHI"));
    await danhDauTatCaLegacy();

    const kq = chayScript(["--ghi", "--yes"]);

    expect(kq.status).toBe(0);
    expect(kq.stdout).toContain("SẠCH");
    expect((await donTheoExternalId("ORD-BF-CLI-GHI")).silverOutcome).toBe(KET_CUC.APPLIED);
    expect(await prisma.order.count()).toBe(1);
    // Khoá việc nặng phải được trả lại, kể cả khi lượt chạy trót lọt.
    expect(await prisma.setting.findUnique({ where: { key: "khoaViecNang" } })).toBeNull();
  }, 120_000);

  it("còn đơn CẦN NGƯỜI XEM sau lượt ghi ⇒ thoát mã lỗi", async () => {
    // Payload hỏng shape: transform đóng `FAILED_SHAPE` — hết LEGACY nhưng CHƯA sạch, và im lặng
    // thoát 0 ở đây là bảo người vận hành rằng đã xong trong khi vẫn còn đơn phải xử tay.
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "ORD-BF-CLI-HONG",
        payloadHash: "hash-hong",
        payload: { khong: "phai don" },
        silverOutcome: KET_CUC.LEGACY,
      },
    });

    const kq = chayScript(["--ghi", "--yes"]);

    expect(kq.status).toBe(1);
    expect(kq.stderr).toContain("CẦN NGƯỜI XEM");
    expect((await donTheoExternalId("ORD-BF-CLI-HONG")).silverOutcome).toBe(KET_CUC.FAILED_SHAPE);
    expect(await prisma.setting.findUnique({ where: { key: "khoaViecNang" } })).toBeNull();
  }, 120_000);
});
