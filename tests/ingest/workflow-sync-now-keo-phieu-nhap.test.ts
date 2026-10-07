import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BRONZE_STREAMS } from "@/lib/bronze/streams";

/**
 * Nút "Đồng bộ ngay" (workflow `pancake-sync-now`) PHẢI kéo phiếu nhập (`purchases` shop kho) rồi
 * mới gọi bước đếm nhắc việc — chủ shop chốt 07/10: lập phiếu nhập trên Pancake xong bấm nút là
 * phải thấy phiếu ở màn duyệt + dải "phiếu nhập chờ ghi", không đợi 03:00 hôm sau.
 *
 * Vì sao khoá bằng test: workflow là FILE JSON, không có type nào bắt. Gỡ `purchases`, bỏ qua nó
 * trong vòng lặp, hay đảo bước đếm lên trước vòng kéo đều chạy XANH trong n8n — chỉ là phiếu không
 * về / dải nhắc việc đứng số đêm trước, đúng loại "hỏng lặng" mà tính năng sinh ra để chống.
 *
 * Hai tầng:
 *  1. Literal `STREAMS` rút nguyên văn từ jsCode rồi chạy (`new Function`) — khoá CẤU HÌNH (shop,
 *     không cửa sổ ngày, thứ tự, giống nightly).
 *  2. Chạy NGUYÊN jsCode với `this.helpers.httpRequest` GIẢ ghi lại từng lời gọi — khoá HÀNH VI: GET
 *     purchases shop kho thật sự được bắn, ĐẦU TIÊN; text thô được POST sang `/api/ingest/raw`; bước
 *     đếm `/api/ingest/dem-gia-von` là lời gọi CUỐI CÙNG (mốc kết thúc mà nút bấm chờ).
 */

type NodeN8n = { type: string; parameters?: { jsCode?: string } };
type StreamCfg = { name: string; shops: string[]; dated?: boolean };

function jsCodeCua(file: string): string {
  const raw = readFileSync(path.join(process.cwd(), "n8n", file), "utf8");
  const codes = (JSON.parse(raw) as { nodes: NodeN8n[] }).nodes.filter(
    (n) => n.type === "n8n-nodes-base.code",
  );
  expect(codes, `${file}: phải có đúng 1 node Code`).toHaveLength(1);
  return codes[0].parameters?.jsCode ?? "";
}

/** Bỏ chú thích để chỉ soi CODE CHẠY THẬT — ghi chú đầu file có nhắc tên endpoint/stream. */
function boChuThich(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((dong) => !dong.trim().startsWith("//"))
    .join("\n");
}

/** Rút literal `const STREAMS = [ ... ];` rồi chạy để lấy giá trị thật. */
function streamsCua(js: string): StreamCfg[] {
  const m = boChuThich(js).match(/const STREAMS = (\[[\s\S]*?\n\]);/);
  expect(m, "không tìm thấy khai báo `const STREAMS = [...]`").not.toBeNull();
  return new Function(`return ${m![1]};`)() as StreamCfg[];
}

const SYNC_NOW = jsCodeCua("pancake-sync-now.json");
const NIGHTLY = jsCodeCua("pancake-nightly.json");

describe("pancake-sync-now kéo phiếu nhập — cấu hình STREAMS", () => {
  const streams = streamsCua(SYNC_NOW);

  it("STREAMS có `purchases` CHỈ shop kho", () => {
    const purchases = streams.filter((s) => s.name === "purchases");
    expect(purchases, "nút Đồng bộ ngay phải kéo phiếu nhập").toHaveLength(1);
    expect(purchases[0].shops).toEqual(["kho"]);
  });

  it("shop kéo `purchases` khớp registry Bronze (shop khác bị route từ chối ⇒ lượt đỏ oan)", () => {
    const purchases = streams.find((s) => s.name === "purchases");
    expect(purchases?.shops).toEqual([...(BRONZE_STREAMS.purchases.shops ?? [])]);
  });

  it("kéo `purchases` Y HỆT nightly — trọn, không cửa sổ ngày", () => {
    const sn = streams.find((s) => s.name === "purchases");
    const nt = streamsCua(NIGHTLY).find((s) => s.name === "purchases");
    expect(nt, "nightly vẫn phải kéo purchases").toBeDefined();
    // `dated` bật là kéo theo cửa sổ 40 phút `inserted_at` ⇒ phiếu lập trước đó mà vừa đổi
    // (huỷ, sửa tiền) không bao giờ lọt — hậu kiểm mù. Nightly kéo trọn thì đây cũng phải trọn.
    expect(sn?.dated).toBeFalsy();
    expect(sn).toEqual(nt);
  });

  it("`purchases` đứng ĐẦU (phiếu về trong vài giây đầu); products vẫn TRƯỚC orders (COGS cần Variant)", () => {
    const ten = streams.map((s) => s.name);
    expect(ten[0]).toBe("purchases");
    expect(ten.indexOf("products")).toBeGreaterThanOrEqual(0);
    expect(ten.indexOf("products")).toBeLessThan(ten.indexOf("orders"));
  });

  it("KHÔNG gọi resync-products (vá tồn toàn bộ chỉ thuộc lượt đêm)", () => {
    expect(boChuThich(SYNC_NOW)).not.toContain("/api/ingest/resync-products");
  });
});

// ---------------------------------------------------------------------------------------------
// Chạy THẬT jsCode với httpRequest giả
// ---------------------------------------------------------------------------------------------

type LoiGoi = {
  method: string;
  url: string;
  /** POST raw: `{stream, shopId, payload}`; POST dem-gia-von: `{soLoiKeo, loiKeo}`. */
  body?: { stream?: string; shopId?: string; payload?: unknown; soLoiKeo?: number; loiKeo?: unknown };
};

const KHOA = {
  n8nAppUrl: "http://app.test",
  n8nIngestSecret: "bi-mat-gia",
  pancakeApiKeyKho: "k-kho",
  pancakeApiKeyShopee: "k-shopee",
  pancakeApiKeyTiktok: "k-tiktok",
  pancakeShopIdKho: "111",
  pancakeShopIdShopee: "222",
  pancakeShopIdTiktok: "333",
};

/**
 * Chạy nguyên node Code như n8n: `$input` = dòng bảng Setting, `this.helpers.httpRequest` giả.
 * `loiChoGet(url)` trả một Error ⇒ lời GET đó NÉM (giả 429/5xx phía Pancake).
 */
async function chayWorkflow(
  js: string,
  loiChoGet: (url: string) => Error | null = () => null,
): Promise<{ goi: LoiGoi[]; ketQua: unknown; loi: unknown }> {
  const goi: LoiGoi[] = [];
  const httpRequest = async (opts: LoiGoi & { body?: LoiGoi["body"] }) => {
    goi.push({ method: opts.method, url: opts.url, body: opts.body });
    if (opts.method === "GET") {
      const loi = loiChoGet(opts.url);
      if (loi) throw loi;
      return '{"success":true,"data":[],"total_pages":1}'; // TEXT thô, 1 trang
    }
    return { stats: { landed: 0, mode: "land+transform" } };
  };
  const $input = { all: () => Object.entries(KHOA).map(([key, value]) => ({ json: { key, value } })) };
  // `setTimeout` là THAM SỐ để che bản toàn cục: `sleep()` của workflow tra tên này theo phạm vi từ
  // vựng ⇒ chờ 0ms thay vì 300ms/trang + 2s thử lại. Không đổi luồng điều khiển nào khác.
  const ngayLapTuc = (fn: () => void) => fn();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...a: unknown[]) => Promise<unknown>;
  const chay = new AsyncFunction("$input", "setTimeout", js);
  // Lỗi NẶNG (vd cả stream bị bỏ) ⇒ workflow cố ý NÉM ở cuối để lượt n8n đỏ — bắt lại để soi `goi`.
  let ketQua: unknown = null;
  let loi: unknown = null;
  try {
    ketQua = await chay.call({ helpers: { httpRequest } }, $input, ngayLapTuc);
  } catch (e) {
    loi = e;
  }
  return { goi, ketQua, loi };
}

describe("pancake-sync-now kéo phiếu nhập — hành vi khi chạy thật", () => {
  it("GET purchases shop kho là lời gọi ĐẦU TIÊN, text thô được land qua /api/ingest/raw", async () => {
    const { goi } = await chayWorkflow(SYNC_NOW);

    expect(goi[0]).toMatchObject({ method: "GET", url: `https://pos.pages.fm/api/v1/shops/${KHOA.pancakeShopIdKho}/purchases` });
    const landPurchases = goi.filter((g) => g.method === "POST" && g.body?.stream === "purchases");
    expect(landPurchases).toHaveLength(1);
    expect(landPurchases[0].url).toBe(`${KHOA.n8nAppUrl}/api/ingest/raw`);
    expect(landPurchases[0].body).toMatchObject({ shopId: KHOA.pancakeShopIdKho });
    expect(typeof landPurchases[0].body?.payload).toBe("string");
    // Chỉ shop kho — shop sàn không có phiếu nhập, gọi là bị route từ chối.
    expect(goi.filter((g) => g.method === "GET" && g.url.endsWith("/purchases"))).toHaveLength(1);
  });

  it("bước đếm /api/ingest/dem-gia-von là lời gọi CUỐI CÙNG, đúng một lần", async () => {
    const { goi, ketQua } = await chayWorkflow(SYNC_NOW);

    const dem = goi.filter((g) => g.url.endsWith("/api/ingest/dem-gia-von"));
    expect(dem).toHaveLength(1);
    expect(goi.at(-1)?.url).toBe(`${KHOA.n8nAppUrl}/api/ingest/dem-gia-von`);
    expect(goi.some((g) => g.url.includes("resync-products"))).toBe(false);
    expect(ketQua).toMatchObject([{ json: { errors: [] } }]);
    // Lượt sạch ⇒ báo 0 lỗi kéo (route coi như workflow cũ, dòng bước cuối OK).
    expect(dem[0].body).toEqual({ soLoiKeo: 0, loiKeo: [] });
  });

  it("GET purchases bị 429 (2 lần) ⇒ lời gọi dem-gia-von MANG lỗi đó; lượt n8n vẫn đỏ ở cuối", async () => {
    const loi429 = Object.assign(new Error("Request failed with status code 429"), { httpCode: "429" });
    const { goi, loi } = await chayWorkflow(SYNC_NOW, (url) => (url.endsWith("/purchases") ? loi429 : null));

    // Không có POST raw nào cho purchases (GET hỏng trước khi land) — đúng cái điểm mù mà body phải lấp.
    expect(goi.filter((g) => g.method === "POST" && g.body?.stream === "purchases")).toHaveLength(0);
    const dem = goi.filter((g) => g.url.endsWith("/api/ingest/dem-gia-von"));
    expect(dem).toHaveLength(1);
    expect(dem[0].body?.soLoiKeo).toBe(1);
    expect(dem[0].body?.loiKeo).toEqual([
      expect.objectContaining({ scope: "CA_STREAM_BI_BO", stream: "purchases", shop: "kho" }),
    ]);
    expect(String((dem[0].body?.loiKeo as { lyDo: string }[])[0].lyDo)).toContain("429");
    // Lời gọi đếm vẫn là lời gọi app CUỐI; sau đó workflow ném để lượt n8n đỏ (luật chặn nuốt lỗi).
    expect(goi.at(-1)?.url).toBe(`${KHOA.n8nAppUrl}/api/ingest/dem-gia-von`);
    expect(String(loi)).toContain("BỊ BỎ");
  });
});
