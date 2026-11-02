import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { coTheDoiSoat, demDaHachToan } from "@/lib/bronze/doi-soat-hach-toan";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw, type TransformStats } from "@/lib/bronze/transform-from-raw";
import { bocAnhChupChiPhiTiktok } from "@/lib/ingest/tiktok-ads-tin-dung-mapping";
import { ghiAnhChupTinDungTiktok, khoaNgayTinDung } from "@/lib/ingest/tiktok-ads-tin-dung-upsert";
import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";

/**
 * HAI LƯỢT TRANSFORM SONG SONG trên cùng một bản ghi tiền TikTok: lượt CŨ đọc kho thô (ảnh cũ) rồi bị giữ lại; trong
 * lúc đó ảnh MỚI land và lượt MỚI ghi Silver xong; rồi lượt cũ mới ghi. Trước bản vá câu ghi không mang mốc nguồn nên
 * lượt cũ đè số cũ lên (và với ảnh chụp tín dụng: xoá luôn advertiser chỉ có trong ảnh mới).
 *
 * Rào chắn = `checkpoint` (hợp đồng công khai của `TransformOptions`, gọi ở dòng ĐẦU vòng ghi — SAU câu đọc, TRƯỚC câu
 * ghi đầu tiên). Không canh giờ, không giả lập thứ cần chứng minh: hai lượt chạy thật trên DB test.
 */

/** Rào: lượt bị giữ báo "đã tới chỗ chặn", người test thả khi muốn. */
function taoRao(): { checkpoint: () => Promise<void>; daToi: Promise<void>; tha: () => void } {
  let baoDaToi!: () => void;
  const daToi = new Promise<void>((r) => (baoDaToi = r));
  let tha!: () => void;
  const choTha = new Promise<void>((r) => (tha = r));
  return {
    checkpoint: async () => {
      baoDaToi();
      await choTha;
    },
    daToi,
    tha,
  };
}

const STMT = "7639761649183852999";
const sao = (soTien: number) =>
  `{"code":0,"message":"Success","data":{"statements":[{"id":"${STMT}","statement_time":1778803200,` +
  `"settlement_amount":"${soTien}","revenue_amount":"${soTien}","fee_amount":"0","adjustment_amount":"0",` +
  `"net_sales_amount":"${soTien}","shipping_cost_amount":"0","payment_status":"PROCESSING","currency":"VND"}]}}`;

const BC = "7129545797879726081";
const ADV = "7129548444015902722";
const ADV2 = "7090000000000000001";
const NGAY = "2026-10-14";
const NGAY_LUC = new Date(`${NGAY}T00:00:00+07:00`);
const dong = (adv: string, grant: number) =>
  `{"advertiser_id":"${adv}","amount":${grant},"cash_amount":0,"grant_amount":${grant},"tax_amount":0,"currency":"VND"}`;
const anh = (requestId: string, ...items: string[]) =>
  bocAnhChupChiPhiTiktok(
    `{"code":0,"message":"OK","request_id":"${requestId}","data":{"cost_list":[${items.join(",")}],` +
      `"page_info":{"page":1,"page_size":50,"total_number":${items.length},"total_page":1}}}`,
  );
const landAnh = (text: string) =>
  landRaw("tiktokbusiness/cost", BC, text, undefined, undefined, undefined, NGAY);

async function cleanup(): Promise<void> {
  await prisma.tiktokPayment.deleteMany();
  await prisma.rawTiktokShopPayment.deleteMany();
  await prisma.tiktokAdsSettlement.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  await prisma.tiktokAdsHoaDon.deleteMany();
  await prisma.tiktokSettlement.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.tiktokAdsTinDung.deleteMany();
  await prisma.rawTiktokBusinessCost.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
}

beforeEach(async () => {
  await cleanup();
  // Transform tín dụng chỉ nhận advertiser đã có báo cáo chi tiêu trong kho thô.
  await prisma.rawTiktokBusinessReport.createMany({
    data: [ADV, ADV2].map((a, i) => ({ shopId: a, externalId: `c${i}:${NGAY}`, payloadHash: `bc-${i}`, payload: {} })),
  });
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("sao kê TikTok Shop — lượt cầm ảnh cũ tới sau không đè", () => {
  it("Silver giữ số MỚI; lượt cũ đếm stale, được hạch toán (không backlog oan), không vào skipped", async () => {
    await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, sao(100_000));
    await transformFromRaw("tiktok/statements", [], { externalIds: [STMT] });

    const rao = taoRao();
    const luotCu = transformFromRaw("tiktok/statements", [], { externalIds: [STMT], checkpoint: rao.checkpoint });
    await rao.daToi; // lượt cũ ĐÃ đọc ảnh 100k, đứng trước câu ghi

    await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, sao(200_000));
    const luotMoi = await transformFromRaw("tiktok/statements", [], { externalIds: [STMT] });
    expect(luotMoi).toMatchObject({ settlementsUpserted: 1, skipped: 0 });

    rao.tha();
    const cu: TransformStats = await luotCu;

    expect((await prisma.tiktokSettlement.findUniqueOrThrow({ where: { statementId: STMT } })).settlementAmount).toBe(
      200_000,
    );
    expect(cu).toMatchObject({ settlementsUpserted: 0, settlementsSkippedStale: 1, skipped: 0 });
    // Đúng phép so của route (`distinctLanded > accounted` ⇒ bật backlog): id cần dựng = 1, đã hạch toán = 1.
    const cauHinh = await layCauHinhShop();
    expect(coTheDoiSoat("tiktok/statements", SHOP_TIKTOK_SHOP, cauHinh)).toBe(true);
    expect(demDaHachToan(cu)).toBe(1);
  });

  it("dòng di sản (nguonFetchedAt NULL) vẫn được ghi; dựng lại hai lần cùng kết quả, mốc nguồn được điền", async () => {
    await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, sao(300_000));
    // Dòng có trước cột mốc nguồn, số SAI — lượt dựng lại phải sửa được (không no-op im).
    await prisma.tiktokSettlement.create({
      data: {
        statementId: STMT,
        shopId: SHOP_TIKTOK_SHOP,
        statementTime: new Date(1778803200 * 1000),
        paymentStatus: "PROCESSING",
        settlementAmount: 1,
        revenueAmount: 1,
        feeAmount: 0,
        adjustmentAmount: 0,
        netSalesAmount: 1,
        shippingCostAmount: 0,
      },
    });
    const truoc = await prisma.tiktokSettlement.findUniqueOrThrow({ where: { statementId: STMT } });
    expect(truoc.nguonFetchedAt).toBeNull();

    const lan1 = await transformFromRaw("tiktok/statements", []);
    const sau1 = await prisma.tiktokSettlement.findUniqueOrThrow({ where: { statementId: STMT } });
    const lan2 = await transformFromRaw("tiktok/statements", []);
    const sau2 = await prisma.tiktokSettlement.findUniqueOrThrow({ where: { statementId: STMT } });

    expect(lan1).toMatchObject({ settlementsUpserted: 1, settlementsSkippedStale: 0 });
    expect(lan2).toMatchObject({ settlementsUpserted: 1, settlementsSkippedStale: 0 });
    expect(sau1.settlementAmount).toBe(300_000);
    expect(sau1.nguonFetchedAt).not.toBeNull();
    expect(sau2).toEqual(sau1);
    // `syncedAt` chỉ đặt lúc TẠO — cập nhật không đổi (người đọc "dòng về muộn" dựa vào đó).
    expect(sau2.syncedAt).toEqual(truoc.syncedAt);
  });
});

const PAY = "PAY-DUA-1";
const lenhRut = (soTien: number) =>
  `{"code":0,"message":"Success","data":{"payments":[{"id":"${PAY}","status":"PAID","paid_time":1792040400,` +
  `"amount":{"value":"${soTien}","currency":"VND"},"settlement_amount":{"value":"${soTien}","currency":"VND"},` +
  `"reserve_amount":{"value":"0","currency":"VND"}}]}}`;
const TX = "TX-ADS-DUA-1";
const truVi = (soTien: number) =>
  `{"code":0,"message":"Success","data":{"transactions":[{"id":"${TX}","type":"GMV_PAYMENT_FOR_TIKTOK_ADS",` +
  `"order_create_time":"1778770412","settlement_amount":"${-soTien}","adjustment_id":"ADJ-DUA"}]}}`;
const HD = "HD-DUA-1";
const hoaDon = (soTien: number) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"${HD}","transaction_type":"BILL_PAYMENT",` +
  `"billing_type":"CASH","amount_type":"POSITIVE","account_id":"${ADV}","bc_id":"${BC}","subtotal":${soTien / 10 * 9},` +
  `"tax_amount":${soTien / 10},"amount":${soTien},"currency":"VND","create_time":"2026-10-14 10:00:00",` +
  `"timezone":"UTC+07:00"}],"page_info":{"total_page":1}}}`;

type CaTienVe = {
  ten: string;
  stream: "tiktok/payments" | "tiktok/statement_transactions" | "tiktokbusiness/invoice";
  land: (soTien: number) => Promise<unknown>;
  loc: { externalIds: string[]; shopId?: string };
  docSo: () => Promise<number>;
  demGhi: "paymentsUpserted" | "adsUpserted" | "hoaDonAdsUpserted";
  demCu: "paymentsSkippedStale" | "adsSkippedStale" | "hoaDonAdsSkippedStale";
  /** Stream nằm trong cổng đối soát "đã land vs đã hạch toán" ⇒ bản cũ bị chặn phải được hạch toán. */
  hachToan: boolean;
};

const CA_TIEN_VE: CaTienVe[] = [
  {
    ten: "lệnh rút TikTok (TiktokPayment)",
    stream: "tiktok/payments",
    land: (v) => landRaw("tiktok/payments", SHOP_TIKTOK_SHOP, lenhRut(v)),
    loc: { externalIds: [PAY] },
    docSo: async () => (await prisma.tiktokPayment.findUniqueOrThrow({ where: { paymentId: PAY } })).settlementValue,
    demGhi: "paymentsUpserted",
    demCu: "paymentsSkippedStale",
    hachToan: true,
  },
  {
    ten: "khoản ads trừ ví TikTok (TiktokAdsSettlement)",
    stream: "tiktok/statement_transactions",
    land: (v) => landRaw("tiktok/statement_transactions", SHOP_TIKTOK_SHOP, truVi(v)),
    loc: { externalIds: [TX] },
    docSo: async () =>
      -(await prisma.tiktokAdsSettlement.findUniqueOrThrow({ where: { transactionId: TX } })).settlementAmount,
    demGhi: "adsUpserted",
    demCu: "adsSkippedStale",
    hachToan: false,
  },
  {
    ten: "hoá đơn quảng cáo TikTok (TiktokAdsHoaDon)",
    stream: "tiktokbusiness/invoice",
    land: (v) => landRaw("tiktokbusiness/invoice", BC, hoaDon(v)),
    loc: { externalIds: [HD], shopId: BC },
    docSo: async () => (await prisma.tiktokAdsHoaDon.findUniqueOrThrow({ where: { transactionId: HD } })).amount,
    demGhi: "hoaDonAdsUpserted",
    demCu: "hoaDonAdsSkippedStale",
    hachToan: false,
  },
];

describe("lệnh rút / khoản ads trừ ví / hoá đơn — lượt cầm ảnh cũ tới sau không đè", () => {
  it.each(CA_TIEN_VE)("$ten: Silver giữ số MỚI, lượt cũ đếm stale (không skipped)", async (ca) => {
    await ca.land(100_000);
    await transformFromRaw(ca.stream, [], ca.loc);

    const rao = taoRao();
    const luotCu = transformFromRaw(ca.stream, [], { ...ca.loc, checkpoint: rao.checkpoint });
    await rao.daToi;

    await ca.land(200_000);
    const moi = await transformFromRaw(ca.stream, [], ca.loc);
    expect(moi[ca.demGhi]).toBe(1);

    rao.tha();
    const cu = await luotCu;

    expect(await ca.docSo()).toBe(200_000);
    expect(cu[ca.demGhi]).toBe(0);
    expect(cu[ca.demCu]).toBe(1);
    expect(cu.skipped).toBe(0);
    // Cổng đối soát: chỉ stream nó soi được cộng bản cũ bị chặn; stream khác không làm phồng số hạch toán.
    expect(demDaHachToan(cu)).toBe(ca.hachToan ? 1 : 0);
  });
});

describe("ảnh chụp tín dụng TikTok — đọc trong khoá ngày", () => {
  it("lượt cầm ảnh cũ tới sau KHÔNG đè số mới và KHÔNG xoá advertiser chỉ có trong ảnh mới", async () => {
    await landAnh(anh("r1", dong(ADV, -9000)));
    await transformFromRaw("tiktokbusiness/cost", [], { externalIds: [NGAY], shopId: BC });

    const rao = taoRao();
    const luotCu = transformFromRaw("tiktokbusiness/cost", [], {
      externalIds: [NGAY],
      shopId: BC,
      checkpoint: rao.checkpoint,
    });
    await rao.daToi;

    await landAnh(anh("r2", dong(ADV, -5000), dong(ADV2, -1000)));
    const luotMoi = await transformFromRaw("tiktokbusiness/cost", [], { externalIds: [NGAY], shopId: BC });
    expect(luotMoi).toMatchObject({ tinDungAdsUpserted: 2, skipped: 0 });

    rao.tha();
    const cu = await luotCu;
    expect(cu.skipped).toBe(0);

    const rows = await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } });
    expect(rows.map((r) => [r.advertiserId, r.grantExVat])).toEqual([
      [ADV2, 1_000],
      [ADV, 5_000],
    ]);
  });

  it("transform CHỜ khoá ngày đang bị giữ, rồi đọc ảnh mới nhất SAU khi giành được (rào BÊN TRONG transaction)", async () => {
    await landAnh(anh("r1", dong(ADV, -9000)));

    // Một transaction khác giữ khoá ngày — đóng vai lượt transform đang ghi dở cùng ngày.
    let baoDaGiu!: () => void;
    const daGiu = new Promise<void>((r) => (baoDaGiu = r));
    let nha!: () => void;
    const choNha = new Promise<void>((r) => (nha = r));
    const giu = prisma.$transaction(
      async (tx) => {
        await khoaNgayTinDung(tx, NGAY);
        baoDaGiu();
        await choNha;
      },
      { timeout: 20_000 },
    );
    await daGiu;

    const luot = transformFromRaw("tiktokbusiness/cost", [], { externalIds: [NGAY], shopId: BC });
    const kq = await Promise.race([
      luot.then(() => "xong" as const),
      new Promise<"cho">((r) => setTimeout(() => r("cho"), 800)),
    ]);
    // Không có khoá (đột biến bỏ `khoaNgayTinDung`) ⇒ lượt chạy xong ngay với ảnh r1 và đỏ ở đây.
    expect(kq).toBe("cho");
    expect(await prisma.tiktokAdsTinDung.count()).toBe(0);

    // Trong lúc chờ: ảnh MỚI land. Lượt đang chờ phải đọc ảnh này (đọc SAU khi giành khoá), không phải r1.
    await landAnh(anh("r2", dong(ADV, -5000), dong(ADV2, -1000)));
    nha();
    await giu;
    const t = await luot;
    expect(t).toMatchObject({ skipped: 0, tinDungAdsUpserted: 2 });
    const rows = await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } });
    expect(rows.map((r) => [r.advertiserId, r.grantExVat])).toEqual([
      [ADV2, 1_000],
      [ADV, 5_000],
    ]);
  });

  it("lưới mốc nguồn: ảnh mang mốc CŨ hơn dòng đã ghi của chính BC ⇒ bỏ cả ảnh (không upsert, không xoá)", async () => {
    await landAnh(anh("r1", dong(ADV, -5000), dong(ADV2, -1000)));
    await transformFromRaw("tiktokbusiness/cost", []);
    const dang = await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } });
    const mocDang = dang[0].nguonFetchedAt!;
    expect(mocDang).not.toBeNull();

    const kq = await prisma.$transaction(async (tx) => {
      await khoaNgayTinDung(tx, NGAY);
      return ghiAnhChupTinDungTiktok(
        tx,
        BC,
        {
          ngay: NGAY,
          ngayLuc: NGAY_LUC,
          theoAdvertiser: [{ advertiserId: ADV, grantExVat: 9_000, cashExVat: 0, amountExVat: 9_000, nguon: [] }],
        },
        0.1,
        new Date(mocDang.getTime() - 1),
      );
    });
    expect(kq).toEqual({ ghi: 0, cuHon: 1 });
    expect(await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } })).toEqual(dang);
  });

  it("dựng lại hai lần liên tiếp cùng kết quả (mốc bằng nhau vẫn ghi — idempotent, không no-op)", async () => {
    await landAnh(anh("r1", dong(ADV, -5000), dong(ADV2, -1000)));
    const lan1 = await transformFromRaw("tiktokbusiness/cost", []);
    const sau1 = await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } });
    const lan2 = await transformFromRaw("tiktokbusiness/cost", []);
    const sau2 = await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } });

    expect(lan1).toMatchObject({ tinDungAdsUpserted: 2, tinDungAdsSkippedStale: 0, skipped: 0 });
    expect(lan2).toMatchObject({ tinDungAdsUpserted: 2, tinDungAdsSkippedStale: 0, skipped: 0 });
    expect(sau2).toEqual(sau1);
    expect(sau1.every((r) => r.nguonFetchedAt !== null)).toBe(true);
  });
});
