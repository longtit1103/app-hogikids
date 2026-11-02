import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BRONZE_STREAMS } from "@/lib/bronze/streams";
import { bocAnhChupChiPhiTiktok, KHOA_MANG_ANH_CHUP } from "@/lib/ingest/tiktok-ads-tin-dung-mapping";

/**
 * `tiktok-business-nightly` — nhánh TÍN DỤNG TIKTOK TẶNG (`/bc/account/cost/get/`) + nhánh HOÁ ĐƠN
 * (`/bc/account/transaction/get/`). CHẠY THẬT các hàm cắt nguyên văn từ jsCode với `tiktokGetText`/`landRaw` giả:
 *
 *  1. `page_size` = 50 (đo 24/10: 100 ⇒ code 40002 "page_size: number must be most 50") và lặp tới `total_page`;
 *     mọi trang của một ngày land thành MỘT ảnh chụp, đúng chuỗi app `bocAnhChupChiPhiTiktok` dựng (soi gương).
 *  2. 40002 là LỖI THAM SỐ chung ⇒ chỉ bỏ qua BC khi THÔNG ĐIỆP nói thiếu quyền; lỗi tham số phải ném (đỏ).
 *  3. Hoá đơn kéo theo CỬA SỔ thời gian (≥ 10 ngày, phủ cửa sổ VAT), trang rỗng không land, land hỏng gom lại.
 */

type NodeN8n = { type: string; parameters?: { jsCode?: string } };
const WF = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "n8n/tiktok-business-nightly.json"), "utf8"),
) as { nodes: NodeN8n[] };
const JS = WF.nodes.find((n) => n.type === "n8n-nodes-base.code")?.parameters?.jsCode ?? "";

/** Cắt nguyên văn một khai báo hàm (kể cả `async function`) bằng cách đếm ngoặc — cùng cách suite GMV Max. */
function catHam(ten: string): string {
  const viTri = JS.indexOf(`function ${ten}(`);
  expect(viTri, `jsCode phải khai báo function ${ten}`).toBeGreaterThanOrEqual(0);
  const dau = JS.slice(0, viTri).endsWith("async ") ? viTri - "async ".length : viTri;
  const moNgoac = JS.indexOf("{", viTri);
  let sau = 0;
  for (let i = moNgoac; i < JS.length; i++) {
    if (JS[i] === "{") sau++;
    else if (JS[i] === "}") {
      sau--;
      if (sau === 0) return JS.slice(dau, i + 1);
    }
  }
  throw new Error(`function ${ten} thiếu ngoặc đóng`);
}

/** Hằng top-level một dòng (`const TEN = …;`). */
function catHang(ten: string): string {
  const m = new RegExp(`^const ${ten} = [^\\n]+;$`, "m").exec(JS);
  expect(m, `jsCode phải khai báo hằng ${ten}`).not.toBeNull();
  return (m as RegExpExecArray)[0];
}

const tokenErr = (s: string, d: string) => new Error(`TOKEN ${s} ${d}`);
const vnDate = (ms: number) => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);

/** Envelope một trang `/bc/account/cost/get/` — tiền số âm như API thật. */
const trangChiPhi = (page: number, tongTrang: number, adv = "7129548444015902722") =>
  `{"code":0,"message":"OK","request_id":"r${page}","data":{"cost_list":[{"advertiser_id":"${adv}",` +
  `"amount":-995050,"cash_amount":-750294,"grant_amount":-244756,"currency":"VND"}],` +
  `"page_info":{"page":${page},"page_size":50,"total_number":${tongTrang},"total_page":${tongTrang}}}}`;

type Qs = Record<string, unknown>;

function dungTinDung(traTrang: (luot: number, qs: Qs) => string) {
  let luot = 0;
  const getText = vi.fn(async (_p: string, qs: Qs) => traTrang(luot++, qs));
  const land = vi.fn(async (..._a: unknown[]) => 1);
  const nguon = [
    catHang("DAY"),
    catHang("CHI_PHI_PAGE_SIZE"),
    catHam("docJson"),
    catHam("bocAnhChup"),
    catHam("danhSachNgay"),
    catHam("soTrangChiPhi"),
    catHam("keoTinDung"),
  ].join("\n\n");
  const keoTinDung = new Function(
    "since",
    "until",
    "tiktokGetText",
    "landRaw",
    "tokenErr",
    `"use strict";\n${nguon}\nreturn keoTinDung;`,
  )("2026-10-20", "2026-10-20", getText, land, tokenErr) as (bc: string) => Promise<number>;
  return { keoTinDung, getText, land };
}

const laThieuQuyenFinance = new Function(
  `"use strict";\n${catHang("THIEU_QUYEN_FINANCE")}\n${catHam("laThieuQuyenFinance")}\nreturn laThieuQuyenFinance;`,
)() as (e: unknown) => boolean;
const docJson = new Function("tokenErr", `"use strict";\n${catHam("docJson")}\nreturn docJson;`)(tokenErr) as (
  p: string,
  t: string,
) => unknown;

/** Lỗi docJson ném cho một body lỗi TikTok. */
function loiCua(body: string): unknown {
  try {
    docJson("/bc/account/cost/get/", body);
  } catch (e) {
    return e;
  }
  throw new Error("docJson không ném");
}

describe("nhánh tín dụng — page_size 50, lặp tới total_page, MỘT ảnh chụp/ngày", () => {
  it("2 trang ⇒ gọi page 1 rồi 2 với page_size 50, land đúng chuỗi app dựng cho 2 trang", async () => {
    const { keoTinDung, getText, land } = dungTinDung((luot) => trangChiPhi(luot + 1, 2));
    expect(await keoTinDung("7129545797879726081")).toBe(1);

    expect(getText.mock.calls.map(([, qs]) => [qs.page, qs.page_size])).toEqual([
      [1, 50],
      [2, 50],
    ]);
    expect(JSON.parse(String(getText.mock.calls[0][1].filtering))).toEqual({
      start_date: "2026-10-20",
      end_date: "2026-10-20",
    });
    expect(land).toHaveBeenCalledTimes(1);
    const [stream, bc, payload, ngay] = land.mock.calls[0];
    expect([stream, bc, ngay]).toEqual(["tiktokbusiness/cost", "7129545797879726081", "2026-10-20"]);
    expect(payload).toBe(bocAnhChupChiPhiTiktok([trangChiPhi(1, 2), trangChiPhi(2, 2)]));
  });

  it("1 trang ⇒ một lần gọi, chuỗi land khớp app (soi gương bọc ảnh chụp)", async () => {
    const { keoTinDung, getText, land } = dungTinDung(() => trangChiPhi(1, 1));
    await keoTinDung("7129545797879726081");
    expect(getText).toHaveBeenCalledTimes(1);
    expect(land.mock.calls[0][2]).toBe(bocAnhChupChiPhiTiktok(trangChiPhi(1, 1)));
  });

  it("ngày không chi tiêu: body THẬT total_page 0 + cost_list [] ⇒ một lần gọi, land đúng chuỗi app dựng", async () => {
    const rong =
      `{"code":0,"message":"OK","request_id":"rong","data":{"cost_list":[],` +
      `"page_info":{"page":1,"page_size":50,"total_number":0,"total_page":0}}}`;
    const { keoTinDung, getText, land } = dungTinDung(() => rong);
    expect(await keoTinDung("7129545797879726081")).toBe(1);
    expect(getText).toHaveBeenCalledTimes(1);
    expect(land).toHaveBeenCalledTimes(1);
    expect(land.mock.calls[0][2]).toBe(bocAnhChupChiPhiTiktok(rong));
    expect(land.mock.calls[0][2]).toBe(`{"${KHOA_MANG_ANH_CHUP}":[{"trang":[${rong}]}]}`);
  });

  it("total_page 0 mà cost_list CÓ dòng ⇒ ném, KHÔNG land", async () => {
    const mauThuan =
      `{"code":0,"message":"OK","request_id":"x","data":{"cost_list":[{"advertiser_id":"1","amount":-1}],` +
      `"page_info":{"page":1,"page_size":50,"total_number":1,"total_page":0}}}`;
    const { keoTinDung, land } = dungTinDung(() => mauThuan);
    await expect(keoTinDung("bc")).rejects.toThrow(/total_page 0 mà trang 1 có 1 dòng/);
    expect(land).not.toHaveBeenCalled();
  });

  it("40002 lỗi THAM SỐ (page_size) ⇒ ném, KHÔNG land, KHÔNG được coi là thiếu quyền", async () => {
    const loiThamSo = `{"code":40002,"message":"page_size: number must be most 50","request_id":"x","data":{}}`;
    const { keoTinDung, land } = dungTinDung(() => loiThamSo);
    const loi = await keoTinDung("bc").catch((e: unknown) => e);
    expect(loi).toBeInstanceOf(Error);
    expect(land).not.toHaveBeenCalled();
    expect(laThieuQuyenFinance(loi)).toBe(false);
  });

  it("app khai cùng khoá mảng bọc ảnh chụp với n8n", () => {
    expect(BRONZE_STREAMS["tiktokbusiness/cost"].arrayPath).toEqual([KHOA_MANG_ANH_CHUP]);
  });
});

describe("phân loại thiếu quyền finance — theo THÔNG ĐIỆP gốc, không theo mã", () => {
  it.each([
    ["No finance permission for this business center", true],
    ["Not authorized to access this resource", true],
    ["You have no access to the BC", true],
    // `permission` trơn (quyền mức token/advertiser) KHÔNG phải thiếu finance ⇒ phải đỏ, không "bỏ BC".
    ["Permission denied", false],
    ["No permission to operate advertiser", false],
    ["page_size: number must be most 50", false],
    ["bc_id: value is required but missing", false],
  ])("40002 '%s' ⇒ %s", (thongDiep, mong) => {
    expect(laThieuQuyenFinance(loiCua(`{"code":40002,"message":"${thongDiep}","data":{}}`))).toBe(mong);
  });

  it("lỗi không mang thông điệp TikTok (mạng, JSON hỏng) ⇒ không phải thiếu quyền", () => {
    expect(laThieuQuyenFinance(new Error("finance permission"))).toBe(false);
    expect(laThieuQuyenFinance(loiCua("not json"))).toBe(false);
  });
});

describe("nhánh hoá đơn — cửa sổ thời gian, trang rỗng, land hỏng", () => {
  const LOC = JSON.stringify({ start_time: "2026-10-15 00:00:00", end_time: "2026-10-25 00:00:00" });

  function dungHoaDon(traTrang: (luot: number) => string, landTraVe: number) {
    let luot = 0;
    const getText = vi.fn(async (_p: string, _qs: Qs) => traTrang(luot++));
    const land = vi.fn(async (..._a: unknown[]) => landTraVe);
    const loiLand: string[] = [];
    // Dấu lượt hoá đơn (bắt đầu/kết thúc) có suite riêng — ở đây app luôn nhận dấu.
    const guiDauLuot = vi.fn(async () => true);
    // Trang hoá đơn land qua `landTrangHoaDon` của khối dấu lượt (kèm luotId) — giả ở đây, suite dấu lượt chạy thật.
    const keoHoaDon = new Function(
      "tiktokGetText",
      "landTrangHoaDon",
      "tokenErr",
      "PHAM_VI_HOA_DON",
      "loiLandHoaDon",
      "guiDauLuot",
      "laThieuQuyenFinance",
      "log",
      `"use strict";\n${catHam("docJson")}\n${catHam("soNguyenPageInfo")}\n${catHam("keoHoaDon")}\nreturn keoHoaDon;`,
    )(getText, land, tokenErr, { loc: LOC, phamVi: null, keoBu: null }, loiLand, guiDauLuot, laThieuQuyenFinance, () => {}) as (
      bc: string,
    ) => Promise<unknown[]>;
    return { keoHoaDon, getText, land, loiLand };
  }

  const trangHd = (n: number, tong: number) =>
    `{"code":0,"data":{"transaction_list":[${Array.from({ length: n }, (_, i) => `{"transaction_id":"T${i}"}`).join(",")}],` +
    `"page_info":{"page":1,"total_page":${tong}}}}`;

  it("gửi filtering cửa sổ + page_size 50; trang rỗng (bỏ khoá mảng) KHÔNG land nhưng vẫn đi tiếp trang sau", async () => {
    const { keoHoaDon, getText, land } = dungHoaDon(
      (luot) => (luot === 0 ? `{"code":0,"data":{"page_info":{"total_page":2}}}` : trangHd(2, 2)),
      2,
    );
    expect(await keoHoaDon("bc")).toHaveLength(2);
    expect(getText.mock.calls.map(([, qs]) => [qs.filtering, qs.page_size, qs.page])).toEqual([
      [LOC, 50, 1],
      [LOC, 50, 2],
    ]);
    expect(land).toHaveBeenCalledTimes(1);
  });

  it("land hỏng (−1) ⇒ gom vào danh sách báo đỏ cuối lượt", async () => {
    const { keoHoaDon, loiLand } = dungHoaDon(() => trangHd(1, 1), -1);
    await keoHoaDon("bc-9");
    expect(loiLand).toEqual(["bc bc-9 trang 1"]);
  });

  it("cửa sổ hoá đơn ≥ 10 ngày và luôn phủ cửa sổ VAT [since, until] (+1 ngày đệm)", () => {
    const m = /const hoaDonTuNgay = [\s\S]*?\n\}\);/.exec(JS);
    expect(m, "jsCode phải khai báo hoaDonTuNgay + hoaDonLocThoiGian").not.toBeNull();
    const tinh = (now: number, since: string) =>
      JSON.parse(
        new Function(
          "now",
          "since",
          "vnDate",
          `"use strict";\n${catHang("DAY")}\n${catHang("HOA_DON_CUA_SO_NGAY")}\n${(m as RegExpExecArray)[0]}\nreturn hoaDonLocThoiGian;`,
        )(now, since, vnDate) as string,
      ) as { start_time: string; end_time: string };

    // 01:15 VN 25/10, cửa sổ chi tiêu mặc định 7 ngày (since 18/10).
    const now = Date.parse("2026-10-24T18:15:00Z");
    expect(tinh(now, "2026-10-18")).toEqual({ start_time: "2026-10-15 00:00:00", end_time: "2026-10-25 00:00:00" });
    // Ép cửa sổ 60 ngày ⇒ hoá đơn phủ từ since − 1.
    expect(tinh(now, "2026-08-26").start_time).toBe("2026-08-25 00:00:00");
  });
});
