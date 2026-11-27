import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

/** Tập dấu băm GIẢ đổi được theo ca — xem `ingest-raw-hoa-don-others-tru-so-du-da-xac-minh.integration.test.ts`. */
const tapGia = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/ingest/tiktok-hoa-don-others-tru-so-du-da-xac-minh", async (importOriginal) => {
  const goc = await importOriginal<typeof import("@/lib/ingest/tiktok-hoa-don-others-tru-so-du-da-xac-minh")>();
  return { ...goc, DAU_BAM_OTHERS_TRU_SO_DU_DA_XAC_MINH: tapGia };
});
// Đường nút Cài đặt đi qua action THẬT `dungLaiTuKhoTho` — chỉ giả phiên đăng nhập (cổng chủ shop) và `revalidatePath`
// (cần ngữ cảnh request Next). Mọi thứ còn lại (khoá, SyncLog, `dungLaiGiaoDichTuKhoTho`, transform, DB) là thật.
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST } from "@/app/api/ingest/raw/route";
import { dungLaiTuKhoTho } from "@/lib/actions/data-admin";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { rebuildFromRaw } from "@/lib/bronze/rebuild";
import { prisma } from "@/lib/prisma";

import {
  BC,
  DONG_NAP,
  DONG_OTHERS,
  DONG_P8,
  ID_OTHERS,
  STREAM_HOA_DON,
  tapGiaTuOthers,
  trangHoaDon,
} from "../helpers/hoa-don-tiktok-others-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * HAI đường dựng lại với hoá đơn OTHERS: `rebuildFromRaw` (chính hàm `scripts/rebuild-from-raw.ts` gọi) và nút "Dựng lại
 * từ kho thô" ở Cài đặt (action `dungLaiTuKhoTho` → `dungLaiGiaoDichTuKhoTho`, có điều kiện hạ cờ riêng). Dòng trong tập đã
 * xác minh là bỏ CÓ CHỦ ĐÍCH ⇒ không tính `skipped` ⇒ cờ backlog đang bật được HẠ; còn một dòng ngoài tập ⇒ GIỮ cờ; dòng
 * trong tập mà bảng hoá đơn đã có dòng cùng mã ⇒ GIỮ cờ và GIỮ NGUYÊN dòng đó.
 * Kịch bản thật: trang hoá đơn land khi tập chưa có (ERROR + backlog), bản vá thêm tập, lượt dựng lại chữa cờ.
 */

const post = (payload: string, luotId = "luot-dung-lai") =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: STREAM_HOA_DON, shopId: BC, payload, luotId }),
    }),
  );

type KetQua = { skipped: number; boQuaTruSoDuDaXacMinh: number; hoaDonAdsUpserted?: number; warnings: string[] };

/** Nút Cài đặt: gọi action thật, đọc số liệu đầy đủ + cảnh báo từ dòng SyncLog của chính lượt đó. */
async function quaNutCaiDat(): Promise<KetQua> {
  const res = await dungLaiTuKhoTho();
  expect(res.ok).toBe(true);
  const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "PANCAKE" }, orderBy: { startedAt: "desc" } });
  const stats = log.stats as unknown as KetQua;
  // Bộ đếm bỏ có chủ đích cũng có trong dữ liệu action trả về client.
  if (res.ok) expect(res.data.boQuaTruSoDuDaXacMinh).toBe(stats.boQuaTruSoDuDaXacMinh);
  return { ...stats, warnings: stats.warnings ?? [] };
}

async function quaRebuildFromRaw(): Promise<KetQua> {
  const warnings: string[] = [];
  const stats = await rebuildFromRaw(warnings);
  return { ...stats, warnings };
}

const DUONG_DUNG_LAI = [
  ["rebuildFromRaw (script)", quaRebuildFromRaw],
  ["nút Cài đặt dungLaiTuKhoTho", quaNutCaiDat],
] as const;

const datTap = (viTri: readonly number[]) => {
  tapGia.clear();
  for (const h of tapGiaTuOthers(viTri)) tapGia.add(h);
};

async function cleanup(): Promise<void> {
  await truncateBusinessTables();
  // Lượt dựng lại quét MỌI bảng kho thô — dọn các bảng nó đọc để dòng sót của file khác không thành `skipped` oan.
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  await prisma.rawTiktokShopPayment.deleteMany();
  await prisma.rawShopeeWalletTxn.deleteMany();
  await prisma.rawTiktokBusinessCost.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawMetaAdsReport.deleteMany();
  await prisma.tiktokBcHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  // Mọi loại: lượt nút Cài đặt ghi SyncLog PANCAKE, sót dòng RUNNING là lượt sau bị chặn "đang có lượt chạy".
  await prisma.syncLog.deleteMany();
  await prisma.setting.deleteMany({ where: { key: { in: ["bronzeBacklogPending", "khoaViecNang"] } } });
  tapGia.clear();
}

beforeAll(async () => {
  await seedReference();
}, 60_000);
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** Land trang N + O1–O8 + P8 khi tập RỖNG (hành vi trước bản vá) ⇒ ERROR + cờ backlog bật. */
async function landKhiChuaCoTap(): Promise<void> {
  expect((await post(trangHoaDon([DONG_NAP, ...DONG_OTHERS, DONG_P8]))).status).toBe(200);
  expect(await hasBronzeBacklog()).toBe(true);
}

describe.each(DUONG_DUNG_LAI)("%s — hoá đơn OTHERS trừ số dư đã xác minh", (_ten, dungLai) => {
  it("kho thô chỉ còn OTHERS trong tập ⇒ skipped 0, bỏ có chủ đích 8, cờ backlog được HẠ", async () => {
    await landKhiChuaCoTap();
    datTap([0, 1, 2, 3, 4, 5, 6, 7]);

    const kq = await dungLai();

    expect(kq).toMatchObject({ skipped: 0, boQuaTruSoDuDaXacMinh: 8, hoaDonAdsUpserted: 2 });
    expect(kq.warnings.filter((w) => w.includes("không biết chiều tiền"))).toEqual([]);
    expect(await hasBronzeBacklog()).toBe(false);
    expect(await prisma.tiktokAdsHoaDon.count()).toBe(2);
  });

  it("còn 1 OTHERS ngoài tập ⇒ skipped 1, cờ backlog GIỮ, cảnh báo nêu đúng id đó", async () => {
    await landKhiChuaCoTap();
    datTap([0, 1, 2, 3, 4, 5, 6]);

    const kq = await dungLai();

    expect(kq).toMatchObject({ skipped: 1, boQuaTruSoDuDaXacMinh: 7 });
    const nhacToi = ID_OTHERS.filter((id) => kq.warnings.some((w) => w.includes(id)));
    expect(nhacToi).toEqual([ID_OTHERS[7]]);
    expect(await hasBronzeBacklog()).toBe(true);
  });

  it("bản đứng đầu là OTHERS trong tập nhưng bảng hoá đơn đã có dòng POSITIVE cùng mã ⇒ dòng đó GIỮ NGUYÊN, skipped 1, cờ GIỮ", async () => {
    // TikTok trả bản POSITIVE của O2 trước (vào Silver, tính nợ thẻ), sau đó trả lại bản OTHERS đã xác minh.
    const id = ID_OTHERS[1];
    const positive = { ...DONG_OTHERS[1], amount_type: "POSITIVE", amount: "2580243" };
    expect((await post(trangHoaDon([positive]), "luot-positive")).status).toBe(200);
    expect(await prisma.tiktokAdsHoaDon.findUnique({ where: { transactionId: id } })).toMatchObject({
      amount: 2_580_243,
      amountType: "POSITIVE",
    });
    // Bản OTHERS land khi tập còn rỗng ⇒ ERROR + cờ "1" (đúng hành vi trước khi có tập).
    expect((await post(trangHoaDon([DONG_OTHERS[1]]), "luot-others")).status).toBe(200);
    expect(await hasBronzeBacklog()).toBe(true);
    datTap([1]);

    const kq = await dungLai();

    expect(kq).toMatchObject({ skipped: 1, boQuaTruSoDuDaXacMinh: 0 });
    expect(
      kq.warnings.some((w) => w.includes(id) && w.includes("bảng hoá đơn đang có dòng cùng mã")),
      kq.warnings.join("\n"),
    ).toBe(true);
    expect(await hasBronzeBacklog()).toBe(true);
    expect(
      await prisma.tiktokAdsHoaDon.findMany({ select: { transactionId: true, amount: true, amountType: true } }),
    ).toEqual([{ transactionId: id, amount: 2_580_243, amountType: "POSITIVE" }]);
  });
});
