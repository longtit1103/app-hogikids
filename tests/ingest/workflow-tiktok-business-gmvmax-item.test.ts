import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * `tiktok-business-nightly` — nhánh BREAKDOWN GMV Max cấp SẢN PHẨM (thêm 2026-08-25).
 *
 * File workflow này đang CHẠY PROD và giữ đường ghi CHI PHÍ vào `Expense` (⇒ vào P&L). Suite này
 * khoá đúng những bất biến mà một lượt chạy đêm KHÔNG tự bộc lộ:
 *
 *  1. **Item-level TUYỆT ĐỐI không đi `/api/ingest/ads`.** Dòng cấp item có ĐỦ `campaign_id` +
 *     `stat_time_day` và KHÔNG có `metrics.spend` ⇒ nếu land chung stream cũ thì `externalId` TRÙNG
 *     KHÍT dòng campaign-level, `DISTINCT ON` khi dựng lại chi phí từ kho thô **chọn 1 vứt 1** ⇒ ra
 *     SỐ SAI. Và tổng cấp item THIẾU 0,60% (825đ/137.180đ, đo 25/08) ⇒ ghi vào sổ là sai tiền.
 *
 *  2. **Bộ metric của auction KHÔNG ĐỔI.** `ads-report-mapping.ts` nhận diện loại chiến dịch bằng
 *     việc dòng có `spend` hay có `cost`; dòng có CẢ HAI bị TỪ CHỐI. Thêm `cost` vào bộ metric
 *     auction = cả lượt chi phí đêm đó bị chặn.
 *
 *  3. **`filtering.campaign_ids` ≥ 1 và chia lô ≤ 40.** API bắt buộc ≥1 id (40002 "Item level report
 *     must have at least 1 campaign ID") và chặn ở 100 (checkpoint P2 25/08: N=100 OK, N=101 gãy).
 *     Shop có 162 campaign ⇒ chia lô là BẮT BUỘC, không phải tối ưu.
 *
 *  4. **Bước item-level đứng SAU `rows.push`.** Lỗi ở nhánh tham khảo này rơi vào `catch` của vòng
 *     advertiser, `postRows` phía dưới VẪN ghi Expense rồi execution mới đỏ — chi phí không bao giờ
 *     mất vì một bảng breakdown.
 *
 * VÌ SAO CHẠY THẬT CHỨ KHÔNG DÒ CHUỖI: dò chuỗi vẫn xanh khi ai đó dời cổng xuống SAU lời gọi land,
 * hay đổi `ITEM_CHUNK` thành 400. Suite cắt nguyên văn `keoItemGmvMax` (+ `chiaLat`, `docJson`, các
 * hằng) ra khỏi jsCode rồi chạy nó với `tiktokGetText`/`landRaw` giả, và có ca ĐỘT BIẾN xoá cổng để
 * chứng minh cổng đang gánh việc.
 */

const N8N_DIR = path.resolve(process.cwd(), "n8n");
const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/tiktokbusiness/gmvmax-item.json");

type NodeN8n = { name: string; type: string; parameters?: { jsCode?: string } };
type WorkflowN8n = { name: string; nodes: NodeN8n[] };

const WF = JSON.parse(
  readFileSync(path.join(N8N_DIR, "tiktok-business-nightly.json"), "utf8")
) as WorkflowN8n;

function nodeCode(): string {
  const codes = WF.nodes.filter((n) => n.type === "n8n-nodes-base.code");
  expect(codes, "workflow phải có đúng 1 node Code").toHaveLength(1);
  return codes[0].parameters?.jsCode ?? "";
}

/** Bỏ chú thích để chỉ soi CODE CHẠY THẬT — docblock CỐ Ý nhắc `/api/ingest/ads` để cảnh báo. */
function boChuThich(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((dong) => !dong.trim().startsWith("//"))
    .join("\n");
}

/**
 * Cắt nguyên văn một khai báo hàm (kể cả `async function`) khỏi jsCode bằng cách đếm ngoặc.
 * Cắt sai KHÔNG cho test xanh oan: đoạn cắt được `new Function` biên dịch ngay — thiếu ⇒ SyntaxError.
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

/** Hằng số top-level (`const TEN = …;`) — lấy NGUYÊN VĂN để test chạy trên đúng số đang ship. */
function catHang(js: string, ten: string): string {
  const m = new RegExp(`^const ${ten} = [^;\\n]+;`, "m").exec(js);
  expect(m, `jsCode phải khai báo hằng ${ten}`).not.toBeNull();
  return (m as RegExpExecArray)[0];
}

/** Thân hàm `keoItemGmvMax` — dùng để chứng minh nhánh này KHÔNG chạm đường ghi Expense. */
function thanKeoItem(js = nodeCode()): string {
  return catHam(js, "keoItemGmvMax");
}

/** Thân hàm `keoReport` — nhánh CŨ (auction + GMV Max cấp campaign), nguồn chi phí THẬT của P&L. */
function thanKeoReport(js = nodeCode()): string {
  return catHam(js, "keoReport");
}

/**
 * Cắt khối `try { … } catch (e) { … }` đầu tiên sau `moc`. Dùng để CHẠY THẬT phần bọc lỗi ở call
 * site — nó nằm trong thân vòng lặp top-level nên không có hàm nào để cắt.
 */
function catTryCatch(js: string, moc: string): string {
  const viTriMoc = js.indexOf(moc);
  expect(viTriMoc, `không tìm thấy mốc "${moc}"`).toBeGreaterThanOrEqual(0);
  const dau = js.indexOf("try {", viTriMoc);
  expect(dau, "không tìm thấy khối try sau mốc").toBeGreaterThan(viTriMoc);
  let sau = 0;
  for (let i = js.indexOf("{", dau); i < js.length; i++) {
    if (js[i] === "{") sau++;
    else if (js[i] === "}") {
      sau--;
      if (sau === 0) {
        // Đã đóng `try` — đi tiếp qua `catch (…) { … }` để lấy trọn khối.
        const dauCatch = js.indexOf("{", js.indexOf("catch", i));
        let sauCatch = 0;
        for (let j = dauCatch; j < js.length; j++) {
          if (js[j] === "{") sauCatch++;
          else if (js[j] === "}") {
            sauCatch--;
            if (sauCatch === 0) return js.slice(dau, j + 1);
          }
        }
      }
    }
  }
  throw new Error("khối try/catch thiếu ngoặc đóng");
}

/**
 * Cổng "lô/lát 0 dòng ⇒ KHÔNG land" — cùng một khuôn `if (list.length) { … }` bọc quanh lời gọi
 * land + parse ở CẢ HAI hàm kéo, nhưng thụt khác nhau vì độ sâu lồng `for` khác nhau (khớp NGUYÊN
 * VĂN nodeCode() nên phải giữ đúng số khoảng trắng). Từ 25/08: cổng KHÔNG còn `break` ngay khi
 * trang rỗng (bẫy "trang rỗng GIỮA CHỪNG" — total_page còn lớn hơn trang hiện tại thì các trang
 * sau bị bỏ sót, cắt cụt chi tiêu trong im lặng) — trang rỗng chỉ SKIP land/parse, vòng lặp vẫn đi
 * tiếp và dừng DUY NHẤT theo `total_page`.
 */
const CONG_RONG_REPORT = "    if (list.length) {"; // keoReport: for(lat){ for(page){ if(...) } }
const CONG_RONG_ITEM = "        if (list.length) {"; // keoItemGmvMax: thêm 1 lớp for(lô)

/**
 * Vô hiệu ĐÚNG MỘT cổng bằng cách ép điều kiện luôn đúng (`list.length` → `true`) — land bị gọi
 * kể cả khi `list` rỗng, mà KHÔNG phá cặp ngoặc (xoá nguyên dòng `if (...) {` để lại `}` mồ côi ⇒
 * `new Function` ném SyntaxError, ca đột biến vô nghĩa thay vì chứng minh được gì).
 */
function xoaCongVoi(nguon: string, cong: string): string {
  expect(
    nguon.split(cong).length - 1,
    "nguồn đem đột biến phải chứa ĐÚNG 1 cổng (cắt nhầm phạm vi thì test vô nghĩa)"
  ).toBe(1);
  return nguon.replace(cong, cong.replace("list.length", "true"));
}
const xoaCongItem = (nguon: string) => xoaCongVoi(nguon, CONG_RONG_ITEM);
const xoaCongReport = (nguon: string) => xoaCongVoi(nguon, CONG_RONG_REPORT);

// ---------------------------------------------------------------------------------------------
// 1. Lưới máy: đường ghi tiền không bị nhánh tham khảo chạm vào
// ---------------------------------------------------------------------------------------------

describe("GMV Max cấp sản phẩm: KHÔNG chạm đường ghi Expense", () => {
  it.each([
    ["/api/ingest/ads", "endpoint ghi Expense — số cấp item thiếu 0,60% ⇒ vào sổ là sai tiền"],
    ["postRows(", "hàm POST sang /api/ingest/ads"],
    ["rows.push", "mảng dòng sẽ được gửi vào Expense"],
    ["spendExVat", "trường của hợp đồng ghi Expense"],
  ])("thân keoItemGmvMax KHÔNG chứa %s", (cam, vi_do) => {
    expect(thanKeoItem(), `Nhánh breakdown chỉ được land Bronze. ${vi_do}.`).not.toContain(cam);
  });

  it("land ĐÚNG stream riêng `tiktokbusiness/gmvmax_item` (bảng Bronze RIÊNG)", () => {
    const than = thanKeoItem();
    expect(than).toContain('landRaw("tiktokbusiness/gmvmax_item"');
    expect(
      than,
      "land chung `tiktokbusiness/report` ⇒ externalId trùng khít dòng campaign-level ⇒ dựng lại chi phí ra số SAI"
    ).not.toContain('landRaw("tiktokbusiness/report"');
  });

  it("cả node chỉ có ĐÚNG MỘT lời gọi postRows (đường ghi Expense không nhân đôi)", () => {
    const chay = boChuThich(nodeCode());
    // Đếm LỜI GỌI, không đếm khai báo `async function postRows(...)`.
    expect([...chay.matchAll(/(?<!function )postRows\(/g)].map((m) => m[0])).toHaveLength(1);
    expect(chay).toContain('postRows("TIKTOK_ADS", rowsGui)');
  });

  it("bộ metric AUCTION không đổi — thêm `cost` vào đây là ads-report-mapping TỪ CHỐI cả lô", () => {
    const chay = boChuThich(nodeCode());
    const boMetric = [...chay.matchAll(/metrics: JSON\.stringify\((\[[^\]]*\])\)/g)].map((m) => m[1]);
    expect(boMetric).toEqual([
      // (a) item-level MỚI — 5 metric tiền, KHÔNG `campaign_name` (cấp item trả 40002 cho nó)
      '["cost", "orders", "cost_per_order", "gross_revenue", "roi"]',
      // (b) auction — GIỮ NGUYÊN
      '["campaign_name", "spend"]',
      // (c) GMV Max campaign-level — GIỮ NGUYÊN (nguồn chi phí THẬT của P&L)
      '["campaign_name", "cost", "orders", "gross_revenue", "roi"]',
    ]);
  });

  it("bước item-level đứng SAU `rows.push` (lỗi tham khảo không được làm mất chi phí đã thu)", () => {
    const js = nodeCode();
    const viTriPush = js.indexOf("rows.push(...auction, ...gmvMax);");
    const viTriGoi = js.indexOf("await keoItemGmvMax(adv,");
    expect(viTriPush).toBeGreaterThan(0);
    expect(viTriGoi).toBeGreaterThan(0);
    expect(
      viTriGoi,
      "gọi TRƯỚC rows.push ⇒ một lỗi ở breakdown làm rơi cả chi phí advertiser đó vào catch"
    ).toBeGreaterThan(viTriPush);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Chọn campaign gửi kèm: chỉ campaign CÓ CHI, và không trùng
// ---------------------------------------------------------------------------------------------

describe("chọn campaign gửi vào filtering.campaign_ids", () => {
  /** Biểu thức thật ở call site, chạy trên dữ liệu giả để chứng minh lọc + khử trùng. */
  function chonCampaign(gmvMax: { campaignId: string; spend: number }[]): string[] {
    const js = boChuThich(nodeCode());
    const m = /const cdCoChi = (.+);/.exec(js);
    expect(m, "không tìm thấy biểu thức chọn campaign ở call site").not.toBeNull();
    return (
      new Function("gmvMax", `"use strict"; return ${(m as RegExpExecArray)[1]};`) as (
        g: unknown
      ) => string[]
    )(gmvMax);
  }

  it("bỏ campaign 0đ, khử id trùng (nhiều ngày ⇒ nhiều dòng cùng campaign)", () => {
    expect(
      chonCampaign([
        { campaignId: "A", spend: 592 },
        { campaignId: "A", spend: 25 },
        { campaignId: "B", spend: 0 },
        { campaignId: "C", spend: 14 },
        { campaignId: "B", spend: 0 },
      ])
    ).toEqual(["A", "C"]);
  });

  it("không campaign nào có chi ⇒ danh sách RỖNG (không gửi filtering rỗng lên API)", () => {
    expect(chonCampaign([{ campaignId: "B", spend: 0 }])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Chạy THẬT `keoItemGmvMax` cắt ra từ jsCode
// ---------------------------------------------------------------------------------------------

const FIXTURE_LIST = (
  JSON.parse(readFileSync(FIXTURE, "utf8")) as { data: { list: unknown[] } }
).data.list;

/** Envelope THẬT của `/gmv_max/report/get/` (shape lấy từ fixture prod). */
function trang(soDong: number, totalPage = 1): string {
  const list = Array.from({ length: soDong }, (_, i) => FIXTURE_LIST[i % FIXTURE_LIST.length]);
  return JSON.stringify({
    code: 0,
    message: "OK",
    data: { list, page_info: { page: 1, page_size: 1000, total_number: soDong, total_page: totalPage } },
  });
}

/**
 * Trang 0 record: TikTok BỎ HẲN khoá mảng chứ không trả `list: []` (đo checkpoint P2 25/08).
 * Đây chính là ca làm `landRaw` ném lỗi đổ oan token/rate-limit. `totalPage` cho phép dựng ca
 * trang rỗng GIỮA CHỪNG (`totalPage` > trang hiện tại) — bẫy đã vá 25/08: `break` ngay khi rỗng
 * bỏ sót các trang sau, cắt cụt chi tiêu trong im lặng.
 */
const trangRong = (totalPage = 1): string =>
  JSON.stringify({
    code: 0,
    message: "OK",
    data: { page_info: { page: 1, page_size: 1000, total_number: 0, total_page: totalPage } },
  });
const TRANG_RONG = trangRong();

/** Đúng lỗi `landRaw` ném ra khi envelope không có mảng (src/lib/bronze/land-raw.ts). */
const LOI_LAND_RAW = new Error(
  `Envelope stream "tiktokbusiness/gmvmax_item" không có mảng tại 'data.list' (jsonb_typeof=null) — ` +
    `nhiều khả năng API trả lỗi (hết hạn key / token / rate-limit). Không land trang này.`
);

type Qs = Record<string, string | number>;
type SanKhau = {
  keoItem: (adv: { id: string; name: string }, ids: string[]) => Promise<number>;
  getText: ReturnType<typeof vi.fn>;
  land: ReturnType<typeof vi.fn>;
};

/**
 * Sân khấu tối thiểu: `CONFIG`/`since`/`until` + hai cửa ra ngoài (`tiktokGetText` mạng, `landRaw`
 * app) thay bằng spy. `chiaLat`, `docJson`, `ITEM_CHUNK` và chính `keoItemGmvMax` là CODE THẬT.
 */
function dungSanKhau(
  js: string,
  since: string,
  until: string,
  traTrang: (luot: number) => string,
  landTraVe: (luot: number) => number | Error = () => 3,
  bienDoi: (nguon: string) => string = (n) => n
): SanKhau {
  const nguon = bienDoi(
    [
      catHang(js, "DAY"),
      catHang(js, "MAX_SPAN_DAYS"),
      catHang(js, "ITEM_CHUNK"),
      catHam(js, "chiaLat"),
      catHam(js, "docJson"),
      catHam(js, "keoItemGmvMax"),
    ].join("\n\n")
  );

  let luotGet = 0;
  const getText = vi.fn(async (_path: string, _qs: Qs) => traTrang(luotGet++));
  let luotLand = 0;
  const land = vi.fn(async () => {
    const kq = landTraVe(luotLand++);
    if (kq instanceof Error) throw kq;
    return kq;
  });

  const tao = new Function(
    "CONFIG",
    "since",
    "until",
    "tiktokGetText",
    "landRaw",
    "tokenErr",
    "log",
    `"use strict";\n${nguon}\nreturn keoItemGmvMax;`
  ) as (...a: unknown[]) => SanKhau["keoItem"];

  const keoItem = tao(
    { tiktok: { storeId: "7495000000000000000" } },
    since,
    until,
    getText,
    land,
    (s: string, d: string) => new Error(`TOKEN ${s} ${d}`),
    () => undefined
  );
  return { keoItem, getText, land };
}

const qsCua = (sk: SanKhau, luot: number) => sk.getText.mock.calls[luot][1] as Qs;

describe("keoItemGmvMax: chia lô + chia lát chạy trên hợp đồng API thật", () => {
  it("162 campaign × cửa sổ 45 ngày ⇒ 2 lát × 5 lô, MỌI lô có 1..40 id", async () => {
    const ids = Array.from({ length: 162 }, (_, i) => `cd${i}`);
    const sk = dungSanKhau(nodeCode(), "2026-07-11", "2026-08-24", () => trang(2));

    await sk.keoItem({ id: "7129548444015902722", name: "Hogikids" }, ids);

    // 45 ngày ⇒ 2 lát (30 + 15); 162 id ⇒ ceil(162/40) = 5 lô ⇒ 10 request.
    expect(sk.getText).toHaveBeenCalledTimes(10);
    const loMoiLat: string[][] = [];
    for (let i = 0; i < 10; i++) {
      const qs = qsCua(sk, i);
      const lo = (JSON.parse(String(qs.filtering)) as { campaign_ids: string[] }).campaign_ids;
      expect(lo.length, "lô rỗng ⇒ API trả 40002 'must have at least 1 campaign ID'").toBeGreaterThan(0);
      expect(lo.length, "trần THẬT của API là 100; ta chia 40 để chừa biên").toBeLessThanOrEqual(40);
      loMoiLat.push(lo);
    }
    // Mỗi lát phủ ĐỦ 162 id, không sót không trùng.
    expect(loMoiLat.slice(0, 5).flat()).toEqual(ids);
    expect(loMoiLat.slice(5).flat()).toEqual(ids);
  });

  it("mỗi lát ≤ 30 ngày (TikTok chặn cứng khi dimensions có stat_time_day)", async () => {
    const sk = dungSanKhau(nodeCode(), "2026-06-26", "2026-08-24", () => trang(1));
    await sk.keoItem({ id: "7129548444015902722", name: "Hogikids" }, ["cd0"]);

    const lat = sk.getText.mock.calls.map((c) => {
      const qs = c[1] as Qs;
      return [String(qs.start_date), String(qs.end_date)];
    });
    expect(lat).toEqual([
      ["2026-06-26", "2026-07-25"],
      ["2026-07-26", "2026-08-24"],
    ]);
    for (const [s, e] of lat) {
      const soNgay = (Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86_400_000 + 1;
      expect(soNgay).toBeLessThanOrEqual(30);
    }
  });

  it("tham số truy vấn đúng hợp đồng cấp item (dimensions/metrics/store_ids/report_type)", async () => {
    const sk = dungSanKhau(nodeCode(), "2026-08-24", "2026-08-24", () => trang(3));
    await sk.keoItem({ id: "7129548444015902722", name: "Hogikids" }, ["cd0"]);

    expect(sk.getText.mock.calls[0][0]).toBe("/gmv_max/report/get/");
    const qs = qsCua(sk, 0);
    expect(qs.advertiser_id).toBe("7129548444015902722");
    expect(qs.report_type).toBe("BASIC");
    expect(
      qs.page_size,
      "50 = số ĐÃ ĐO ở P0 cấp item; 1000 (cấp campaign) chỉ là suy luận cùng-endpoint"
    ).toBe(50);
    expect(JSON.parse(String(qs.store_ids))).toEqual(["7495000000000000000"]);
    expect(JSON.parse(String(qs.dimensions))).toEqual([
      "campaign_id",
      "item_group_id",
      "stat_time_day",
    ]);
    expect(
      JSON.parse(String(qs.metrics)),
      "xin thêm impressions/clicks/campaign_name ⇒ 40002 cho CẢ lô"
    ).toEqual(["cost", "orders", "cost_per_order", "gross_revenue", "roi"]);
  });

  it("land ĐÚNG chuỗi thô + ĐÚNG shopId = advertiser_id, và cộng dồn số dòng", async () => {
    const noiDung = trang(3);
    const sk = dungSanKhau(nodeCode(), "2026-08-24", "2026-08-24", () => noiDung, () => 3);

    const landed = await sk.keoItem({ id: "7129548444015902722", name: "Hogikids" }, ["cd0", "cd1"]);

    expect(sk.land).toHaveBeenCalledTimes(1); // 1 lát × 1 lô (2 id < 40)
    expect(sk.land.mock.calls[0]).toEqual([
      "tiktokbusiness/gmvmax_item",
      "7129548444015902722",
      noiDung,
    ]);
    expect(landed).toBe(3);
  });

  it("land hỏng (trả −1) KHÔNG cộng vào tổng và KHÔNG giết lượt", async () => {
    const sk = dungSanKhau(nodeCode(), "2026-08-24", "2026-08-24", () => trang(2), () => -1);
    await expect(sk.keoItem({ id: "7129548444015902722", name: "H" }, ["cd0"])).resolves.toBe(0);
  });

  it("phân trang: đi tiếp tới hết total_page rồi dừng", async () => {
    const sk = dungSanKhau(nodeCode(), "2026-08-24", "2026-08-24", () => trang(2, 3));
    await sk.keoItem({ id: "7129548444015902722", name: "H" }, ["cd0"]);

    expect(sk.getText).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => qsCua(sk, i).page)).toEqual([1, 2, 3]);
  });

  it("danh sách campaign RỖNG ⇒ 0 request (không bao giờ gửi filtering rỗng lên API)", async () => {
    const sk = dungSanKhau(nodeCode(), "2026-07-11", "2026-08-24", () => trang(2));
    await expect(sk.keoItem({ id: "7129548444015902722", name: "H" }, [])).resolves.toBe(0);
    expect(sk.getText).not.toHaveBeenCalled();
    expect(sk.land).not.toHaveBeenCalled();
  });

  it("body lỗi (code ≠ 0) ⇒ THROW TRƯỚC khi land (không land body lỗi vào Bronze)", async () => {
    const sk = dungSanKhau(nodeCode(), "2026-08-24", "2026-08-24", () =>
      JSON.stringify({ code: 40002, message: "filtering: campaign_ids: maximum number of items is 100" })
    );
    await expect(sk.keoItem({ id: "7129548444015902722", name: "H" }, ["cd0"])).rejects.toThrow(
      "code 40002"
    );
    expect(sk.land).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Cổng "lô/lát 0 dòng ⇒ KHÔNG land" — CẢ HAI nhánh kéo, kèm ca đột biến
// ---------------------------------------------------------------------------------------------

describe("cổng 0 dòng ⇒ KHÔNG land — nhánh item-level", () => {
  it("cổng nằm TRƯỚC lời gọi land (đứng sau là vô nghĩa)", () => {
    const than = thanKeoItem();
    expect(than.indexOf(CONG_RONG_ITEM), "không tìm thấy cổng trong keoItemGmvMax").toBeGreaterThan(0);
    expect(than.indexOf(CONG_RONG_ITEM)).toBeLessThan(
      than.indexOf('await landRaw("tiktokbusiness/gmvmax_item"')
    );
  });

  it("lô không có dòng nào: land KHÔNG được gọi, hàm trả 0", async () => {
    const sk = dungSanKhau(nodeCode(), "2026-08-24", "2026-08-24", () => TRANG_RONG, () => LOI_LAND_RAW);

    await expect(sk.keoItem({ id: "7129548444015902722", name: "H" }, ["cd0"])).resolves.toBe(0);
    expect(sk.getText).toHaveBeenCalledTimes(1);
    expect(sk.land, "land vào trang rỗng = cảnh báo đổ oan token/rate-limit mỗi đêm").not.toHaveBeenCalled();
  });

  it("ĐỘT BIẾN — vô hiệu cổng thì land BỊ GỌI và nổ đúng thông điệp đổ oan", async () => {
    const sk = dungSanKhau(
      nodeCode(),
      "2026-08-24",
      "2026-08-24",
      () => TRANG_RONG,
      () => LOI_LAND_RAW,
      xoaCongItem
    );

    // `landRaw` thật NUỐT lỗi (trả −1) nên ở prod chỉ thành cảnh báo — nhưng là cảnh báo SAI HƯỚNG,
    // và đây là bằng chứng cổng thật sự chặn lời gọi chứ không phải chú thích.
    await expect(sk.keoItem({ id: "7129548444015902722", name: "H" }, ["cd0"])).rejects.toThrow(
      "hết hạn key / token / rate-limit"
    );
    expect(sk.land).toHaveBeenCalledTimes(1);
  });

  // Bẫy vá 25/08 (khác họ với "0 dòng ⇒ KHÔNG land" ở trên): `break` ngay khi trang rỗng bỏ sót
  // MỌI trang sau, kể cả khi chúng có dữ liệu — cắt cụt chi tiêu quảng cáo trong im lặng, không
  // một cảnh báo nào. Cổng đúng chỉ được SKIP land ở trang rỗng, KHÔNG được dừng lô.
  it("trang GIỮA CHỪNG rỗng (total_page còn lớn hơn) — vẫn đi tiếp, không bỏ sót trang sau", async () => {
    const traTheoTrang = [trang(2, 3), trangRong(3), trang(2, 3)];
    const sk = dungSanKhau(nodeCode(), "2026-08-24", "2026-08-24", (luot) => traTheoTrang[luot]);

    const landed = await sk.keoItem({ id: "7129548444015902722", name: "H" }, ["cd0"]);

    expect(sk.getText, "trang 2 rỗng KHÔNG được làm dừng lô ở giữa").toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => qsCua(sk, i).page)).toEqual([1, 2, 3]);
    expect(sk.land, "chỉ trang 1 và 3 có dữ liệu để land").toHaveBeenCalledTimes(2);
    expect(landed).toBe(6); // 2 lượt land × 3 dòng (landTraVe mặc định)
  });
});

// --- nhánh CŨ `keoReport` (auction + GMV Max cấp campaign) — bug đã sống ở prod từ trước P2 -----

const dongRpt = (campaignId: string, ngay: string, spend: number) =>
  `{"dimensions":{"campaign_id":"${campaignId}","stat_time_day":"${ngay} 00:00:00"},` +
  `"metrics":{"campaign_name":"CD ${campaignId}","spend":${spend}}}`;
const rpt = (dong: string[], totalPage = 1) =>
  `{"code":0,"message":"OK","data":{"list":[${dong.join(",")}],"page_info":{"total_page":${totalPage}}}}`;
/** Lát/advertiser không có campaign nào: sàn BỎ HẲN khoá `list`, `code` vẫn là 0. */
const rptRong = (totalPage = 1) => `{"code":0,"message":"OK","data":{"page_info":{"total_page":${totalPage}}}}`;
const RPT_RONG = rptRong();

const LOI_LAND_REPORT = new Error(
  `Envelope stream "tiktokbusiness/report" không có mảng tại 'data.list' (jsonb_typeof=null) — ` +
    `nhiều khả năng API trả lỗi (hết hạn key / token / rate-limit). Không land trang này.`
);

type DongChi = { date: string; campaignId: string; campaignName: string; adType: string; spend: number };
type SanKhauReport = {
  keoReport: (
    adv: { id: string; name: string },
    path: string,
    extra: Record<string, unknown>,
    tenMetric: string,
    adType: string
  ) => Promise<DongChi[]>;
  getText: ReturnType<typeof vi.fn>;
  land: ReturnType<typeof vi.fn>;
};

function dungSanKhauReport(
  js: string,
  traTrang: (luot: number) => string,
  landTraVe: (luot: number) => number | Error = () => 1,
  bienDoi: (nguon: string) => string = (n) => n
): SanKhauReport {
  const nguon = bienDoi(
    [
      catHang(js, "DAY"),
      catHang(js, "MAX_SPAN_DAYS"),
      catHam(js, "chiaLat"),
      catHam(js, "docJson"),
      catHam(js, "keoReport"),
    ].join("\n\n")
  );
  let luotGet = 0;
  const getText = vi.fn(async () => traTrang(luotGet++));
  let luotLand = 0;
  const land = vi.fn(async () => {
    const kq = landTraVe(luotLand++);
    if (kq instanceof Error) throw kq;
    return kq;
  });
  const tao = new Function(
    "since",
    "until",
    "tiktokGetText",
    "landRaw",
    "tokenErr",
    "log",
    `"use strict";\n${nguon}\nreturn keoReport;`
  ) as (...a: unknown[]) => SanKhauReport["keoReport"];
  const keoReport = tao(
    "2026-08-24",
    "2026-08-24",
    getText,
    land,
    (s: string, d: string) => new Error(`TOKEN ${s} ${d}`),
    () => undefined
  );
  return { keoReport, getText, land };
}

const goiReport = (sk: SanKhauReport) =>
  sk.keoReport(
    { id: "7129548444015902722", name: "Hogikids" },
    "/report/integrated/get/",
    { data_level: "AUCTION_CAMPAIGN" },
    "spend",
    "auction"
  );

describe("cổng 0 dòng ⇒ KHÔNG land — nhánh CŨ keoReport (auction + GMV Max cấp campaign)", () => {
  it("cổng nằm TRƯỚC lời gọi land", () => {
    const than = thanKeoReport();
    expect(than.indexOf(CONG_RONG_REPORT), "không tìm thấy cổng trong keoReport").toBeGreaterThan(0);
    expect(than.indexOf(CONG_RONG_REPORT)).toBeLessThan(
      than.indexOf('await landRaw("tiktokbusiness/report"')
    );
  });

  it("lát không có campaign nào: land KHÔNG được gọi, trả 0 dòng chi phí", async () => {
    const sk = dungSanKhauReport(nodeCode(), () => RPT_RONG, () => LOI_LAND_REPORT);

    await expect(goiReport(sk)).resolves.toEqual([]);
    expect(sk.getText).toHaveBeenCalledTimes(1);
    expect(sk.land).not.toHaveBeenCalled();
  });

  it("ĐỘT BIẾN — vô hiệu cổng thì land BỊ GỌI và nổ (cổng đang gánh việc thật)", async () => {
    const sk = dungSanKhauReport(nodeCode(), () => RPT_RONG, () => LOI_LAND_REPORT, xoaCongReport);

    await expect(goiReport(sk)).rejects.toThrow("hết hạn key / token / rate-limit");
    expect(sk.land).toHaveBeenCalledTimes(1);
  });

  // Bẫy vá 25/08: `break` ngay khi trang rỗng bỏ sót MỌI trang sau, kể cả trang có chi tiêu thật
  // ở cuối lát ⇒ Expense thiếu tiền trong im lặng, không một cảnh báo nào.
  it("trang GIỮA CHỪNG rỗng (total_page còn lớn hơn) — vẫn đi tiếp, không bỏ sót chi tiêu trang sau", async () => {
    const traTheoTrang = [
      rpt([dongRpt("A", "2026-08-24", 100)], 3),
      rptRong(3),
      rpt([dongRpt("B", "2026-08-24", 200)], 3),
    ];
    const sk = dungSanKhauReport(nodeCode(), (luot) => traTheoTrang[luot]);

    const rows = await goiReport(sk);

    expect(sk.getText, "trang giữa rỗng KHÔNG được làm dừng lát ở giữa").toHaveBeenCalledTimes(3);
    expect(sk.land, "chỉ trang 1 và 3 có dữ liệu để land").toHaveBeenCalledTimes(2);
    expect(rows).toEqual([
      { date: "2026-08-24", campaignId: "A", campaignName: "CD A", adType: "auction", spend: 100 },
      { date: "2026-08-24", campaignId: "B", campaignName: "CD B", adType: "auction", spend: 200 },
    ]);
  });

  it("trang CÓ dòng: vẫn land và map đúng dòng chi phí (cổng không ăn nhầm ca thường)", async () => {
    const noiDung = rpt([dongRpt("186431", "2026-08-24", 81617)]);
    const sk = dungSanKhauReport(nodeCode(), () => noiDung, () => 1);

    await expect(goiReport(sk)).resolves.toEqual([
      {
        date: "2026-08-24",
        campaignId: "186431",
        campaignName: "CD 186431",
        adType: "auction",
        spend: 81617,
      },
    ]);
    expect(sk.land.mock.calls[0]).toEqual(["tiktokbusiness/report", "7129548444015902722", noiDung]);
  });

  it("guard `bad` GIỮ NGUYÊN: dòng thiếu stat_time_day vẫn THROW (không bị cổng nuốt)", async () => {
    const thieuNgay = `{"dimensions":{"campaign_id":"186431"},"metrics":{"spend":100}}`;
    const sk = dungSanKhauReport(nodeCode(), () => rpt([thieuNgay]), () => 1);

    await expect(goiReport(sk)).rejects.toThrow("thiếu stat_time_day/campaign_id");
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Lỗi nhánh tham khảo phải TỰ XƯNG — chủ shop không được lẫn nó với "hỏng chi phí"
// ---------------------------------------------------------------------------------------------

const TIEN_TO = "BREAKDOWN THAM KHẢO (không ảnh hưởng chi phí): ";

describe("tiền tố lỗi cho nhánh breakdown", () => {
  const khoiBoc = () => catTryCatch(nodeCode(), "const cdCoChi =");

  it("khối bọc lỗi CHỈ ôm nhánh item-level, KHÔNG ôm keoReport", () => {
    const khoi = khoiBoc();
    expect(khoi).toContain("keoItemGmvMax(adv, cdCoChi)");
    expect(
      khoi,
      "ôm cả keoReport ⇒ lỗi CHI PHÍ bị dán nhãn 'không ảnh hưởng chi phí' = nói dối với chủ shop"
    ).not.toContain("keoReport(");
    // Tiền tố chỉ được xuất hiện đúng một chỗ trong cả node.
    expect(boChuThich(nodeCode()).split(TIEN_TO).length - 1).toBe(1);
  });

  /** Chạy THẬT khối try/catch cắt từ jsCode (nó nằm trong vòng lặp top-level, không có hàm để cắt). */
  function chayKhoi(keoItemGmvMax: () => Promise<number>, logs: string[]) {
    const chay = new Function(
      "keoItemGmvMax",
      "adv",
      "cdCoChi",
      "log",
      `"use strict"; return (async () => {\n${khoiBoc()}\n})();`
    ) as (k: unknown, a: unknown, c: unknown, l: unknown) => Promise<void>;
    return chay(keoItemGmvMax, { name: "Hogikids" }, ["cd0"], (m: string) => logs.push(m));
  }

  it("nhánh hỏng ⇒ lỗi mang tiền tố và GIỮ NGUYÊN thông điệp gốc", async () => {
    const goc = "TIKTOK_ADS lỗi: code 40002 — filtering: campaign_ids: maximum number of items is 100";
    await expect(
      chayKhoi(async () => {
        throw new Error(goc);
      }, [])
    ).rejects.toThrow(TIEN_TO + goc);
  });

  it("nhánh chạy được ⇒ KHÔNG gắn tiền tố, log số dòng đã land", async () => {
    const logs: string[] = [];
    await expect(chayKhoi(async () => 7, logs)).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("land 7 dòng GMV Max cấp sản phẩm (1 campaign)");
  });

  it("land 0 dòng ⇒ im lặng (không đẻ log rác mỗi đêm)", async () => {
    const logs: string[] = [];
    await chayKhoi(async () => 0, logs);
    expect(logs).toEqual([]);
  });
});
