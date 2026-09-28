import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";

/**
 * Stream `tiktok/affiliate_orders` (P3) — land theo DÒNG SKU sau khi workflow LÀM PHẲNG
 * `data.orders[].skus[]`. Suite chạy CODE THẬT cắt từ jsCode của `tiktokshop-analytics-nightly.json`
 * (đúng khuôn `tests/ingest/workflow-tiktokshop-analytics-nightly.test.ts` — dò chuỗi thì test vẫn
 * xanh khi ai đó dời cổng đi chỗ khác). Các lời khai suite này khoá:
 *
 *  1. Làm phẳng fixture 3 đơn ⇒ land đúng 4 DÒNG (không phải 3), khoá `_don_id:sku_id`,
 *     `_ngay` = ngày TẠO đơn giờ VN nằm trong payload lưu.
 *  2. Đơn 2-SKU ⇒ 2 dòng khác khoá, cùng `_don_id`.
 *  3. Land lại ⇒ dedupe; sàn đổi một số tiền ⇒ hash đổi ⇒ bản mới (Bronze giữ lịch sử).
 *  4. Payload GỐC (chưa làm phẳng) hay envelope lỗi 105005 ⇒ THROW, không land.
 *  5. Cổng Σ == total_count đếm DÒNG SKU: total_count của TikTok đếm dòng SKU (đo 28/08: page_size
 *     20 trả 19 đơn / 20 dòng) — ca "đếm theo ĐƠN" (3 vs 4) phải làm cổng ĐỎ, chống hồi quy đúng
 *     bẫy §1 của báo cáo probe `plans/reports/p3-probe-260828-1015-...md`.
 *  6. Hợp đồng trôi (id thành SỐ — JSON.parse làm tròn int64; mất mảng `data.orders`) ⇒ THROW
 *     TRƯỚC khi land.
 */

const JS_WORKFLOW = (() => {
  const wf = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "n8n/tiktokshop-analytics-nightly.json"), "utf8")
  ) as { nodes: { type: string; parameters?: { jsCode?: string } }[] };
  const codes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.code");
  expect(codes, "workflow phải có đúng 1 node Code").toHaveLength(1);
  return codes[0].parameters?.jsCode ?? "";
})();

const FIXTURE = readFileSync(
  path.resolve(process.cwd(), "tests/fixtures/tiktokshop/affiliate/orders-search.json"),
  "utf8"
);
const F_ANALYTICS = (ten: string) =>
  readFileSync(path.join(process.cwd(), "tests/fixtures/tiktokshop/analytics", ten), "utf8");

/**
 * Cắt nguyên văn một khai báo hàm khỏi jsCode bằng cách đếm ngoặc — bản sao có chủ đích của
 * `catHam` trong `tests/ingest/workflow-tiktokshop-analytics-nightly.test.ts` (khuôn chung của
 * 3 suite workflow). Cắt sai không cho xanh oan: `new Function` biên dịch ngay.
 */
function catHam(js: string, ten: string): string {
  const viTri = js.indexOf(`function ${ten}(`);
  expect(viTri, `jsCode phải khai báo function ${ten}`).toBeGreaterThanOrEqual(0);
  const dau = js.slice(0, viTri).endsWith("async ") ? viTri - "async ".length : viTri;
  const moNgoac = js.indexOf("{", viTri);
  let sau = 0;
  for (let i = moNgoac; i < js.length; i++) {
    if (js[i] === "{") sau++;
    else if (js[i] === "}") {
      sau--;
      if (sau === 0) return js.slice(dau, i + 1);
    }
  }
  throw new Error(`function ${ten} thiếu ngoặc đóng trong jsCode`);
}

/** vnDate của workflow là const arrow (không cắt được theo tên hàm) — cấp bản y hệt cho sân khấu. */
const vnFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const vnDate = (ms: number) => vnFmt.format(new Date(ms));

type KetQuaPhang = {
  payload: string | null;
  totalCount: number | null;
  nextPageToken: string;
  soDonKhongSku: number;
};
// DAY_MS: cổng cửa sổ `_ngay` hợp lý trong lamPhang cần nó (ngày mai giờ VN).
const lamPhang = new Function(
  "vnDate",
  "DAY_MS",
  `"use strict";\n${catHam(JS_WORKFLOW, "lamPhangDonAffiliate")}\nreturn lamPhangDonAffiliate;`
)(vnDate, 86_400_000) as (text: string) => KetQuaPhang;

type KetQuaLand = { seen: number; skippedNoId: number };
type HamKeoLuot = (tu: string, den: string) => Promise<{ dongSku: number; rong: boolean }>;
type LogDong = { level: string; message: string };

/** Sân khấu tối thiểu cho `keoLuotAffiliate` — mọi thứ trừ `postRaw`/`land` là CODE THẬT từ jsCode. */
function dungSanKhau(
  js: string,
  postRaw: (path: string, qs: Record<string, unknown>, bodyText: string) => Promise<string>,
  land: (stream: string, payload: string) => Promise<KetQuaLand>
): { keoLuot: HamKeoLuot; logs: LogDong[] } {
  const nguon = [
    catHam(js, "congNgay"),
    catHam(js, "epochGiayVn"),
    catHam(js, "lamPhangDonAffiliate"),
    catHam(js, "keoLuotAffiliate"),
  ].join("\n\n");
  const logs: LogDong[] = [];
  const keoLuot = new Function(
    "CONFIG",
    "logs",
    "postRaw",
    "land",
    "sleep",
    "MAX_PAGES",
    "PAGE_SIZE_AFFILIATE",
    "vnDate",
    "DAY_MS",
    `"use strict";\n${nguon}\nreturn keoLuotAffiliate;`
  )(
    { pageDelayMs: 0 },
    logs,
    postRaw,
    land,
    async () => undefined,
    200,
    20,
    vnDate,
    86_400_000
  ) as HamKeoLuot;
  return { keoLuot, logs };
}

/** Trang "khoẻ": đúng fixture nhưng total_count = 4 (khớp 4 dòng SKU) và hết trang. */
function trangKhoe(): string {
  const sua = FIXTURE.replace('"total_count": 253', '"total_count": 4').replace(
    /"next_page_token": "[^"]*"/,
    '"next_page_token": ""'
  );
  expect(sua, "fixture đổi tên field là các ca dưới im lặng vô hiệu").not.toBe(FIXTURE);
  return sua;
}

/** `land` giả nối vào landRaw THẬT — trả đúng shape mà workflow đọc từ /api/ingest/raw. */
const landThat = async (stream: string, payload: string): Promise<KetQuaLand> => {
  const r = await landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, payload);
  expect(stream).toBe("tiktok/affiliate_orders");
  return { seen: r.seenIds.length, skippedNoId: r.skippedNoId };
};

beforeEach(async () => {
  await prisma.rawTiktokShopAffiliateOrder.deleteMany();
});

describe("lamPhangDonAffiliate + landRaw — land theo DÒNG SKU", () => {
  it("fixture 3 đơn ⇒ 4 dòng SKU, khoá _don_id:sku_id", async () => {
    const phang = lamPhang(FIXTURE);
    const r = await landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, phang.payload!);

    expect(r.landed).toBe(4); // KHÔNG phải 3 — một đơn có 2 dòng SKU
    expect(r.skippedNoId).toBe(0);
    expect([...r.landedIds].sort()).toEqual([
      "583585257652192734:1734636965579949739",
      "583585276075082966:1731910824361559723",
      "583585276075082966:1731910824361625259",
      "583601650514297876:1734651044375987883",
    ]);
  });

  it("_ngay = ngày TẠO đơn giờ VN, 4 trường cấp đơn nằm TRONG payload lưu, trường gốc còn nguyên", async () => {
    await landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, lamPhang(FIXTURE).payload!);

    // create_time 1776497985 = 18/04/2026 ~07:39 UTC ⇒ 14:39 giờ VN ⇒ _ngay 2026-04-18.
    const row = await prisma.rawTiktokShopAffiliateOrder.findFirstOrThrow({
      where: { externalId: "583585276075082966:1731910824361625259" },
    });
    const p = row.payload as Record<string, unknown>;
    expect(p._don_id).toBe("583585276075082966");
    expect(p._create_time).toBe(1776497985);
    expect(p._delivery_time).toBe(1776680594);
    expect(p._ngay).toBe("2026-04-18");
    expect(p.content_type).toBe("VIDEO");
    expect(p.creator_username).toBe("creator_1");

    // Đơn LIVE tạo 1776592037 = 19/04/2026 giờ VN — ngày khác nhau chứng minh không hard-code.
    const live = await prisma.rawTiktokShopAffiliateOrder.findFirstOrThrow({
      where: { externalId: "583601650514297876:1734651044375987883" },
    });
    expect((live.payload as Record<string, unknown>)._ngay).toBe("2026-04-19");
  });

  it("đơn 2-SKU ⇒ 2 dòng khác khoá, cùng _don_id", async () => {
    await landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, lamPhang(FIXTURE).payload!);

    const dong = await prisma.rawTiktokShopAffiliateOrder.findMany({
      where: { externalId: { startsWith: "583585276075082966:" } },
    });
    expect(dong).toHaveLength(2);
    expect(new Set(dong.map((d) => d.externalId)).size).toBe(2);
    for (const d of dong) {
      expect((d.payload as Record<string, unknown>)._don_id).toBe("583585276075082966");
    }
  });

  it("land lại ⇒ dedupe; sàn đổi một số tiền ⇒ hash đổi ⇒ bản mới (giữ lịch sử)", async () => {
    const goc = lamPhang(FIXTURE).payload!;
    expect((await landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, goc)).landed).toBe(4);
    expect((await landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, goc)).landed).toBe(0);
    expect(await prisma.rawTiktokShopAffiliateOrder.count()).toBe(4);

    // "14720" = estimated_paid_commission của đơn SHOP — xuất hiện đúng 1 lần trong fixture.
    const sua = lamPhang(FIXTURE.replace('"amount": "14720"', '"amount": "14721"')).payload!;
    expect(sua).not.toBe(goc);
    expect((await landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, sua)).landed).toBe(1);
    expect(await prisma.rawTiktokShopAffiliateOrder.count()).toBe(5);
  });

  it("payload GỐC (chưa làm phẳng) ⇒ THROW 'rút được 0 khoá', không land", async () => {
    // Elem cấp ĐƠN không có _don_id/sku_id — quên bước làm phẳng phải nổ ngay tại cửa land,
    // không được land 0 dòng trong im lặng.
    await expect(landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, FIXTURE)).rejects.toThrow(
      /rút được 0 khoá/
    );
    expect(await prisma.rawTiktokShopAffiliateOrder.count()).toBe(0);
  });

  it("envelope lỗi 105005 (thiếu scope) ⇒ THROW, không land", async () => {
    await expect(
      landRaw("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, F_ANALYTICS("loi-105005.json"))
    ).rejects.toThrow(/không có mảng tại 'data.orders'/);
    expect(await prisma.rawTiktokShopAffiliateOrder.count()).toBe(0);
  });
});

describe("lamPhangDonAffiliate — cổng hợp đồng trôi (THROW trước land)", () => {
  it("'id' của đơn thành SỐ ⇒ THROW (JSON.parse làm tròn int64, khoá Bronze hỏng vĩnh viễn)", () => {
    const xau = `{"code":0,"data":{"orders":[{"create_time":1776497985,"id":583585276075082966,"skus":[]}],"total_count":1},"message":"Success"}`;
    expect(() => lamPhang(xau)).toThrow(/không còn là CHUỖI/);
  });

  it("'sku_id' thành SỐ ⇒ THROW", () => {
    const xau = `{"code":0,"data":{"orders":[{"create_time":1776497985,"id":"583585276075082966","skus":[{"sku_id":1731910824361625259}]}],"total_count":1},"message":"Success"}`;
    expect(() => lamPhang(xau)).toThrow(/không còn là CHUỖI/);
  });

  it("mất mảng data.orders mà total_count > 0 ⇒ THROW (hợp đồng API đổi)", () => {
    expect(() => lamPhang(`{"code":0,"data":{"total_count":5},"message":"Success"}`)).toThrow(
      /KHÔNG có mảng 'data.orders'/
    );
  });

  it("total_count = 0 ⇒ trả sớm, KHÔNG đòi mảng (trang rỗng không có khoá mảng là bình thường)", () => {
    const kq = lamPhang(`{"code":0,"data":{"total_count":0},"message":"Success"}`);
    expect(kq).toEqual({ payload: null, totalCount: 0, nextPageToken: "", soDonKhongSku: 0 });
  });

  it("'product_id' thành SỐ ⇒ THROW (id > 2^53 trong fixture thật — cổng phải phủ đủ, không chỉ id/sku_id)", () => {
    const xau = `{"code":0,"data":{"orders":[{"create_time":1776497985,"id":"583585276075082966","skus":[
      {"sku_id":"1731910824361625259","product_id":1731910711337911979}]}],"total_count":1},"message":"Success"}`;
    expect(() => lamPhang(xau)).toThrow(/'product_id' không còn là CHUỖI/);
  });

  it("'content_id' thành SỐ ⇒ THROW", () => {
    const xau = `{"code":0,"data":{"orders":[{"create_time":1776497985,"id":"583585276075082966","skus":[
      {"sku_id":"1731910824361625259","content_id":7629572620026924306}]}],"total_count":1},"message":"Success"}`;
    expect(() => lamPhang(xau)).toThrow(/'content_id' không còn là CHUỖI/);
  });

  it("create_time null ⇒ THROW (null*1000 = 0 ⇒ 1970-01-01 sẽ đi vòng qua mọi lưới ngày của landRaw)", () => {
    const xau = `{"code":0,"data":{"orders":[{"create_time":null,"id":"583585276075082966","skus":[
      {"sku_id":"1731910824361625259"}]}],"total_count":1},"message":"Success"}`;
    expect(() => lamPhang(xau)).toThrow(/không phải epoch giây hợp lệ/);
  });

  it("create_time là CHUỖI ⇒ THROW cùng cổng (không rơi vào RangeError vô nghĩa)", () => {
    const xau = `{"code":0,"data":{"orders":[{"create_time":"2026-04-18","id":"583585276075082966","skus":[
      {"sku_id":"1731910824361625259"}]}],"total_count":1},"message":"Success"}`;
    expect(() => lamPhang(xau)).toThrow(/không phải epoch giây hợp lệ/);
  });

  it.each([
    ["2020 — trước cận dưới 2024-01-01", 1577836800],
    ["tương lai xa — sau 'ngày mai giờ VN'", Math.floor(Date.now() / 1000) + 10 * 86_400],
  ])("_ngay ngoài cửa sổ hợp lý (%s) ⇒ THROW — cùng luật NGAY_SOM_NHAT/ngayMaiGioVn của landRaw", (_ten, epoch) => {
    const xau = `{"code":0,"data":{"orders":[{"create_time":${epoch},"id":"583585276075082966","skus":[
      {"sku_id":"1731910824361625259"}]}],"total_count":1},"message":"Success"}`;
    expect(() => lamPhang(xau)).toThrow(/ngoài cửa sổ hợp lý/);
  });
});

describe("keoLuotAffiliate — chạy CODE THẬT cắt từ jsCode", () => {
  it("trang khoẻ: body ký đúng epoch giờ VN (số probe 28/08 đã chạy thật), land qua landRaw THẬT, cổng đếm ĐẠT", async () => {
    const goiPostRaw = vi.fn(
      async (_path: string, _qs: Record<string, unknown>, _bodyText: string) => trangKhoe()
    );
    const sk = dungSanKhau(JS_WORKFLOW, goiPostRaw, landThat);

    // Cửa sổ 01/03 → hết 30/04 = đúng body probe 28/08 (create_time_lt là biên MỞ 01/05 00:00 VN).
    const kq = await sk.keoLuot("2026-03-01", "2026-04-30");

    expect(kq).toEqual({ dongSku: 4, rong: false });
    expect(await prisma.rawTiktokShopAffiliateOrder.count()).toBe(4);
    expect(goiPostRaw).toHaveBeenCalledTimes(1);
    expect(goiPostRaw.mock.calls[0][0]).toBe("/affiliate_seller/202410/orders/search");
    expect(goiPostRaw.mock.calls[0][1]).toEqual({ page_size: 20 });
    expect(goiPostRaw.mock.calls[0][2]).toBe(
      '{"create_time_ge":1772298000,"create_time_lt":1777568400}'
    );
  });

  it("ĐỎ-TRÊN-MÃ-SAI: đếm theo ĐƠN (3) thay vì DÒNG SKU (4) ⇒ cổng total_count PHẢI nổ", async () => {
    // total_count của TikTok đếm DÒNG SKU. Ai đó "sửa" cổng sang đếm đơn thì trên chính trang khoẻ
    // này tổng thành 3 ≠ 4 — cổng phải đỏ để lỗi đếm không sống qua review.
    const sk = dungSanKhau(
      JS_WORKFLOW,
      async () => trangKhoe(),
      async () => ({ seen: 3, skippedNoId: 0 })
    );

    await expect(sk.keoLuot("2026-03-01", "2026-04-30")).rejects.toThrow(
      /app nhận 3 dòng SKU nhưng sàn báo total_count=4/
    );
  });

  it("fixture giữ total_count THẬT trang 1 (253) ⇒ cổng đếm nổ — cổng đọc envelope, không tự khớp", async () => {
    const motTrang = FIXTURE.replace(/"next_page_token": "[^"]*"/, '"next_page_token": ""');
    const sk = dungSanKhau(
      JS_WORKFLOW,
      async () => motTrang,
      async () => ({ seen: 4, skippedNoId: 0 })
    );

    await expect(sk.keoLuot("2026-03-01", "2026-04-30")).rejects.toThrow(/total_count=253/);
  });

  it("next_page_token lặp không đổi ⇒ THROW PHÂN TRANG KẸT (fixture gốc giữ token thật trang 1)", async () => {
    const sk = dungSanKhau(
      JS_WORKFLOW,
      async () => FIXTURE,
      async () => ({ seen: 4, skippedNoId: 0 })
    );

    await expect(sk.keoLuot("2026-03-01", "2026-04-30")).rejects.toThrow(/PHÂN TRANG KẸT/);
  });

  it("total_count VẮNG hoặc đổi kiểu ⇒ THROW ngay trang 1 (cổng đếm là lưới DUY NHẤT, không được tự tắt câm)", async () => {
    // Dựng bằng parse/sửa/stringify (xoá bằng regex để lại dấu phẩy treo — JSON hỏng, throw sai lý do).
    type EnvData = { data: { total_count?: number | string; next_page_token: string } };
    const vang = JSON.parse(FIXTURE) as EnvData;
    delete vang.data.total_count;
    vang.data.next_page_token = "";
    const sk1 = dungSanKhau(
      JS_WORKFLOW,
      async () => JSON.stringify(vang),
      async () => ({ seen: 4, skippedNoId: 0 })
    );
    await expect(sk1.keoLuot("2026-03-01", "2026-04-30")).rejects.toThrow(/không đọc được 'total_count'/);

    // Đổi kiểu sang CHUỖI (khuôn phổ biến của chính TikTok cho số lớn):
    const chuoi = JSON.parse(FIXTURE) as EnvData;
    chuoi.data.total_count = "253";
    chuoi.data.next_page_token = "";
    const sk2 = dungSanKhau(
      JS_WORKFLOW,
      async () => JSON.stringify(chuoi),
      async () => ({ seen: 4, skippedNoId: 0 })
    );
    await expect(sk2.keoLuot("2026-03-01", "2026-04-30")).rejects.toThrow(/không đọc được 'total_count'/);
  });

  it("total_count=0 xuất hiện Ở TRANG SAU ⇒ THROW lý do ĐÚNG (không rơi xuống land(null) → 400 sai hướng)", async () => {
    const trang1 = FIXTURE.replace('"total_count": 253', '"total_count": 8').replace(
      /"next_page_token": "[^"]*"/,
      '"next_page_token": "TOK-TRANG-2"'
    );
    const trang2 = `{"code":0,"data":{"total_count":0},"message":"Success"}`;
    let luot = 0;
    const goiLand = vi.fn(async () => ({ seen: 4, skippedNoId: 0 }));
    const sk = dungSanKhau(JS_WORKFLOW, async () => (luot++ === 0 ? trang1 : trang2), goiLand);

    await expect(sk.keoLuot("2026-03-01", "2026-04-30")).rejects.toThrow(/Ở TRANG 2 giữa chừng phân trang/);
    expect(goiLand).toHaveBeenCalledTimes(1); // chỉ trang 1 được land, trang rỗng giữa chừng thì không
  });

  it("đơn KHÔNG có dòng SKU ⇒ vẫn land đủ dòng còn lại + để lại VẾT trong logs (không nuốt im lặng)", async () => {
    const env = JSON.parse(trangKhoe()) as {
      data: { orders: unknown[]; total_count: number };
    };
    env.data.orders.push({ id: "583999000011112222", create_time: 1776497985, skus: [] });
    // total_count giữ 4 (đếm DÒNG SKU — đơn 0 dòng đóng góp 0) ⇒ cổng đếm vẫn ĐẠT.
    const sk = dungSanKhau(JS_WORKFLOW, async () => JSON.stringify(env), landThat);

    const kq = await sk.keoLuot("2026-03-01", "2026-04-30");

    expect(kq).toEqual({ dongSku: 4, rong: false });
    expect(sk.logs.map((l) => l.message).join("\n")).toContain("KHÔNG có dòng SKU");
  });

  it("total_count = 0 ⇒ KHÔNG land, log nói rõ lý do (kỳ không có đơn affiliate là bình thường)", async () => {
    const goiLand = vi.fn(async () => ({ seen: 0, skippedNoId: 0 }));
    const sk = dungSanKhau(
      JS_WORKFLOW,
      async () => `{"code":0,"data":{"total_count":0},"message":"Success"}`,
      goiLand
    );

    const kq = await sk.keoLuot("2026-07-01", "2026-07-03");

    expect(kq).toEqual({ dongSku: 0, rong: true });
    expect(goiLand, "land vào trang rỗng = nightly đỏ với lý do SAI").not.toHaveBeenCalled();
    expect(sk.logs.map((l) => l.message).join("\n")).toContain("total_count=0");
  });
});
