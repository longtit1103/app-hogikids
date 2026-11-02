import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { docChupLuc } from "@/lib/bronze/land-raw";

/**
 * n8n gửi `chupLuc` (mốc nguồn CHỤP) kèm MỖI TRANG land vào `/api/ingest/raw` — 5 workflow land 3 stream có cột lần thấy
 * (sản phẩm Pancake qua `fetchAndLand` chung của 3 workflow Pancake, `meta/report`, `tiktokbusiness/report`).
 *
 * Hợp đồng soi bằng CHẠY THẬT hàm cắt nguyên văn từ jsCode, với `http` giả và đồng hồ giả (`Date` bị che bằng tham số):
 *  - mốc lấy TRƯỚC lời GET của CHÍNH trang đó — đồng hồ giả chỉ nhích khi có lời gọi mạng, nên lấy sau GET thì lệch
 *    đúng một nhịp ⇒ đỏ; lấy một lần đầu lượt thì trang 2 mang mốc trang 1 ⇒ đỏ;
 *  - mốc đi trong thân POST (bỏ khỏi body ⇒ đỏ) và qua được bộ đọc thật của route (`docChupLuc`).
 * Workflow trong repo là bản NGUỒN — import lên n8n prod là bước vận hành riêng (`n8n/huong-dan-cai-dat-workflows.md`).
 */

const N8N_DIR = path.resolve(process.cwd(), "n8n");
type NodeN8n = { name: string; parameters?: { jsCode?: string } };

function nodeCode(file: string, tenNode: string): string {
  const wf = JSON.parse(readFileSync(path.join(N8N_DIR, file), "utf8")) as { nodes: NodeN8n[] };
  const nodes = wf.nodes.filter((n) => n.name === tenNode);
  expect(nodes, `${file}: node "${tenNode}"`).toHaveLength(1);
  return nodes[0].parameters?.jsCode ?? "";
}

/** Cắt nguyên văn một khai báo hàm bằng đếm ngoặc; cắt sai ⇒ `new Function` ném SyntaxError (không xanh oan). */
function catHam(js: string, ten: string): string {
  const viTri = js.indexOf(`function ${ten}(`);
  expect(viTri, `jsCode phải khai báo function ${ten}`).toBeGreaterThanOrEqual(0);
  const dau = js.slice(0, viTri).endsWith("async ") ? viTri - "async ".length : viTri;
  let sau = 0;
  for (let i = js.indexOf("{", viTri); i < js.length; i++) {
    if (js[i] === "{") sau++;
    else if (js[i] === "}" && --sau === 0) return js.slice(dau, i + 1);
  }
  throw new Error(`function ${ten} thiếu ngoặc đóng`);
}

function catHang(js: string, ten: string): string {
  const m = new RegExp(`^const ${ten} = [^;\\n]+;`, "m").exec(js);
  expect(m, `jsCode phải khai báo hằng ${ten}`).not.toBeNull();
  return (m as RegExpExecArray)[0];
}

/** Bỏ chú thích để chỉ soi code chạy thật. */
function boChuThich(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((d) => !d.trim().startsWith("//"))
    .join("\n");
}

/** Đồng hồ giả: `new Date()` không đối số trả mốc giả; chỉ nhích khi lời gọi mạng giả gọi `tien`. */
function dongHoGia(batDau: number) {
  let t = batDau;
  class DateGia extends Date {
    constructor(...a: (number | string)[]) {
      super(a[0] ?? t);
    }
  }
  return { DateGia, tien: (ms: number) => void (t += ms), bayGio: () => t };
}

type LoiGoi = { method: string; url: string; body?: Record<string, unknown>; luc: number };
const BAT_DAU = Date.parse("2026-10-29T02:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** `http` giả: ghi lời gọi kèm mốc đồng hồ giả lúc BẮT ĐẦU gọi, rồi nhích đồng hồ 1s (độ trễ mạng). */
function httpGia(dh: ReturnType<typeof dongHoGia>, traGet: string, goi: LoiGoi[]) {
  return async (o: { method: string; url: string; body?: Record<string, unknown> }) => {
    goi.push({ method: o.method, url: o.url, body: o.body, luc: dh.bayGio() });
    dh.tien(1000);
    return o.method === "GET" ? traGet : { stats: { landed: 1 } };
  };
}

function kiemMocTheoTrang(goi: LoiGoi[], urlLand: string) {
  const get = goi.filter((g) => g.method === "GET");
  const land = goi.filter((g) => g.method === "POST" && g.url === urlLand);
  expect(land).toHaveLength(get.length);
  // Mốc của trang i = đúng lúc BẮT ĐẦU GET trang i.
  expect(land.map((p) => p.body?.chupLuc)).toEqual(get.map((g) => iso(g.luc)));
  for (const p of land) {
    expect(docChupLuc(p.body?.chupLuc, p.luc), "route phải nhận mốc này").toMatchObject({ ok: true });
  }
}

const CONFIG = {
  base: "https://pos.pages.fm/api/v1",
  appUrl: "http://app:3000",
  ingestSecret: "s",
  shops: { kho: { id: "714995134", key: "k" } },
};

describe.each([
  ["pancake-nightly.json", "Re-sync 45 ngày + stream nặng → app"],
  ["pancake-sync-now.json", "Kéo Pancake → app"],
  ["history-import.json", "Kéo lịch sử → app"],
])("%s — fetchAndLand", (file, tenNode) => {
  it("mỗi trang mang chupLuc = lúc BẮT ĐẦU GET của chính trang đó", async () => {
    const js = nodeCode(file, tenNode);
    const dh = dongHoGia(BAT_DAU);
    const goi: LoiGoi[] = [];
    const http = httpGia(dh, '{"success":true,"data":[],"total_pages":2}', goi);
    const tao = new Function(
      "CONFIG",
      "http",
      "results",
      "Date",
      `"use strict";\n${catHam(js, "totalPagesOf")}\n${catHam(js, "fetchAndLand")}\nreturn fetchAndLand;`,
    ) as (...a: unknown[]) => (s: string, k: string, w: null, p: number) => Promise<number>;
    const fetchAndLand = tao(CONFIG, http, [], dh.DateGia);

    await fetchAndLand("products", "kho", null, 1);
    await fetchAndLand("products", "kho", null, 2);

    expect(goi.filter((g) => g.method === "GET")).toHaveLength(2);
    kiemMocTheoTrang(goi, `${CONFIG.appUrl}/api/ingest/raw`);
  });
});

describe("meta-ads-nightly — getInsights + landRaw", () => {
  const js = nodeCode("meta-ads-nightly.json", "Kéo spend Meta");

  it("trang insights mang chupLuc = lúc BẮT ĐẦU GET, landRaw đưa vào body", async () => {
    const dh = dongHoGia(BAT_DAU);
    const goi: LoiGoi[] = [];
    const http = httpGia(dh, '{"data":[],"paging":{}}', goi);
    const tao = new Function(
      "CONFIG",
      "GRAPH",
      "token",
      "http",
      "log",
      "Date",
      `"use strict";\n${catHam(js, "laLoiToken")}\n${catHam(js, "getInsights")}\n${catHam(js, "landRaw")}\n` +
        "return { getInsights, landRaw };",
    ) as (...a: unknown[]) => {
      getInsights: (lat: { start: string; end: string }, after: string) => Promise<{ text: string; chupLuc: string }>;
      landRaw: (text: string, chupLuc: string) => Promise<number>;
    };
    const { getInsights, landRaw } = tao(
      { appUrl: "http://app:3000", ingestSecret: "s", account: "act_1" },
      "https://graph.facebook.com/v25.0",
      { accessToken: "t" },
      http,
      () => undefined,
      dh.DateGia,
    );

    for (const lat of [{ start: "2026-10-20", end: "2026-10-21" }, { start: "2026-10-22", end: "2026-10-23" }]) {
      const res = await getInsights(lat, "");
      await landRaw(res.text, res.chupLuc);
    }

    kiemMocTheoTrang(goi, "http://app:3000/api/ingest/raw");
  });

  it("vòng chính truyền mốc của CHÍNH trang vừa GET vào landRaw", () => {
    expect(boChuThich(js)).toContain("landRaw(res.text, res.chupLuc)");
  });
});

describe("tiktok-business-nightly — keoReport + landRaw", () => {
  const js = nodeCode("tiktok-business-nightly.json", "Kéo spend TikTok (auction + GMV Max)");
  const trang = (totalPage: number) =>
    `{"code":0,"message":"OK","data":{"list":[{"dimensions":{"campaign_id":"1","stat_time_day":"2026-08-24 00:00:00"},` +
    `"metrics":{"spend":"10","campaign_name":"A"}}],"page_info":{"total_page":${totalPage}}}}`;

  it("mỗi trang báo cáo gọi landRaw với chupLuc = lúc BẮT ĐẦU GET trang đó", async () => {
    const dh = dongHoGia(BAT_DAU);
    const lucGet: number[] = [];
    const goiLand: unknown[][] = [];
    const tiktokGetText = async () => {
      lucGet.push(dh.bayGio());
      dh.tien(1000);
      return trang(2);
    };
    const landRaw = async (...a: unknown[]) => {
      goiLand.push(a);
      dh.tien(1000);
      return 1;
    };
    const nguon = [
      catHang(js, "DAY"),
      catHang(js, "MAX_SPAN_DAYS"),
      catHam(js, "chiaLat"),
      catHam(js, "docJson"),
      catHam(js, "keoReport"),
    ].join("\n\n");
    const tao = new Function(
      "since",
      "until",
      "tiktokGetText",
      "landRaw",
      "tokenErr",
      "log",
      "Date",
      `"use strict";\n${nguon}\nreturn keoReport;`,
    ) as (...a: unknown[]) => (...a: unknown[]) => Promise<unknown[]>;
    const keoReport = tao("2026-08-24", "2026-08-24", tiktokGetText, landRaw, (s: string) => new Error(s), () => undefined, dh.DateGia);

    await keoReport({ id: "7129548444015902722", name: "Hogikids" }, "/report/integrated/get/", {}, "spend", "auction");

    expect(lucGet).toHaveLength(2);
    expect(goiLand.map((a) => a[0])).toEqual(["tiktokbusiness/report", "tiktokbusiness/report"]);
    expect(goiLand.map((a) => a[4])).toEqual(lucGet.map(iso));
    for (const a of goiLand) expect(docChupLuc(a[4], BAT_DAU + 10_000)).toMatchObject({ ok: true });
  });

  it("landRaw đưa chupLuc vào body khi có; không có thì khoá vắng hẳn (stream hoá đơn / ảnh chụp chi phí giữ hợp đồng cũ)", async () => {
    const dh = dongHoGia(BAT_DAU);
    const goi: LoiGoi[] = [];
    // `landRaw` đọc hằng top-level `LUOT_ID` (mã lượt kéo = id execution) ⇒ dựng kèm, `$execution` giả.
    const khaiLuotId = /^const LUOT_ID = [^\n]+;$/m.exec(js)?.[0] ?? "";
    const tao = new Function(
      "CONFIG",
      "http",
      "log",
      "$execution",
      `"use strict";\n${khaiLuotId}\n${catHam(js, "landRaw")}\nreturn landRaw;`,
    ) as (...a: unknown[]) => (...a: unknown[]) => Promise<number>;
    const landRaw = tao({ appUrl: "http://app:3000", ingestSecret: "s" }, httpGia(dh, "", goi), () => undefined, { id: "1" });

    await landRaw("tiktokbusiness/report", "7129548444015902722", "{}", undefined, "2026-10-29T02:00:00.000Z");
    await landRaw("tiktokbusiness/cost", "7129548444015902722", "{}", "2026-10-28");

    expect(goi[0].body).toMatchObject({ stream: "tiktokbusiness/report", chupLuc: "2026-10-29T02:00:00.000Z" });
    expect(goi[0].body).not.toHaveProperty("ngay");
    expect(goi[1].body).toMatchObject({ stream: "tiktokbusiness/cost", ngay: "2026-10-28" });
    expect(goi[1].body).not.toHaveProperty("chupLuc");
  });
});
