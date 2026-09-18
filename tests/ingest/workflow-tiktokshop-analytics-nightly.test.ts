import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * Workflow n8n thứ 10 — `tiktokshop-analytics-nightly` (02:30 giờ VN). Suite này khoá HAI bất biến
 * mà một lượt chạy đêm KHÔNG tự bộc lộ được:
 *
 *  1. **CHỈ ĐỌC token, KHÔNG refresh.** TikTok XOAY VÒNG refresh_token: refresh thành công là bản cũ
 *     chết ngay ⇒ chỉ được DUY NHẤT MỘT hệ refresh, và hệ đó là `tiktokshop-nightly` 02:00 — lượt
 *     đang giữ chuỗi ĐỐI SOÁT TIỀN đang LIVE. Nếu lượt 02:30 này cũng refresh thì hai lượt đốt token
 *     của nhau: mất dữ liệu tiền để đổi lấy vài chỉ số marketing, và không tự phục hồi được (phải
 *     cấp quyền lại bằng tay). Đây là LƯỚI MÁY cho bất biến đó — đừng gỡ khi sửa workflow.
 *
 *  2. **Cổng `total_count === 0` ⇒ KHÔNG land** (đo thật checkpoint P2, 25/08). Trang 0 record thì
 *     TikTok BỎ HẲN khoá mảng dù `code=0`, mà `landRaw` THROW đúng ca đó với thông điệp đổ oan
 *     "hết hạn key / token / rate-limit" — TRÙNG cơ chế workflow dùng để bắt lỗi scope 105005 ⇒ hai
 *     ca không phân biệt được, nightly đỏ và người đọc đi sai hướng cả đêm. Ngày không có record là
 *     chuyện BÌNH THƯỜNG (ngày ế), không phải sự cố.
 *
 * VÌ SAO CHẠY THẬT CHỨ KHÔNG DÒ CHUỖI: dò chuỗi thì test vẫn xanh khi ai đó dời cổng xuống SAU
 * `land`. Suite cắt nguyên văn `keoLuot` (+ `docChuoi`/`docSo`) ra khỏi jsCode rồi chạy nó với
 * `getRaw`/`land` giả — và có thêm một ca ĐỘT BIẾN: xoá đúng khối lệnh cổng khỏi bản sao nguồn rồi
 * chạy lại, phải THẤY `land` bị gọi và nổ. Cổng nào không chứng minh được là mình đang gánh việc thì
 * chỉ là chú thích.
 */

const N8N_DIR = path.resolve(process.cwd(), "n8n");
const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/tiktokshop/analytics");

type NodeN8n = {
  name: string;
  type: string;
  parameters?: { jsCode?: string; query?: string; rule?: unknown };
  credentials?: Record<string, { id: string; name: string }>;
};
type WorkflowN8n = { name: string; nodes: NodeN8n[]; settings?: Record<string, unknown> };

const WF = JSON.parse(
  readFileSync(path.join(N8N_DIR, "tiktokshop-analytics-nightly.json"), "utf8")
) as WorkflowN8n;

function nodeCode(): string {
  const codes = WF.nodes.filter((n) => n.type === "n8n-nodes-base.code");
  expect(codes, "workflow phải có đúng 1 node Code").toHaveLength(1);
  return codes[0].parameters?.jsCode ?? "";
}

/** Bỏ chú thích để chỉ soi CODE CHẠY THẬT — docblock ở đây CỐ Ý nhắc tới `refresh` để cảnh báo. */
function boChuThich(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((dong) => !dong.trim().startsWith("//"))
    .join("\n");
}

const fixture = (ten: string) => readFileSync(path.join(FIXTURE_DIR, ten), "utf8");

// ---------------------------------------------------------------------------------------------
// 1. Lưới máy: KHÔNG một đường refresh token nào được lọt vào workflow này
// ---------------------------------------------------------------------------------------------

describe("tiktokshop-analytics-nightly: CHỈ ĐỌC token", () => {
  it.each([
    ["token/refresh", "đường gọi API gia hạn token của TikTok"],
    ["persistToken", "hàm ghi token mới về kho token của app"],
    ["refreshAccessToken", "hàm gia hạn của `tiktokshop-nightly`"],
  ])("jsCode KHÔNG chứa %s", (cam) => {
    expect(
      nodeCode(),
      `Workflow analytics KHÔNG được gia hạn token: TikTok xoay vòng refresh_token nên chỉ ` +
        `\`tiktokshop-nightly\` 02:00 được refresh. Thấy "${cam}" ở đây = hai lượt đốt token của ` +
        `nhau ⇒ đứt chuỗi đối soát tiền đang LIVE, phải cấp quyền lại bằng tay.`
    ).not.toContain(cam);
  });

  it("chỉ có ĐÚNG MỘT lời gọi kho token và nó là GET", () => {
    const chay = boChuThich(nodeCode());
    // Đếm lời gọi THẬT (`url:` của một request), không đếm chuỗi trong thông báo lỗi — thông báo
    // "cấp lại rồi nạp qua POST /api/ingest/tiktok-token" là HƯỚNG DẪN CHO NGƯỜI, không phải đường ghi.
    const luotGoi = [...chay.matchAll(/url:\s*CONFIG\.appUrl \+ "\/api\/ingest\/tiktok-token"/g)];
    expect(luotGoi, "kho token chỉ được chạm đúng 1 lần (đọc token đầu lượt)").toHaveLength(1);
    expect(chay).toMatch(/method:\s*"GET",\s*\n\s*url:\s*CONFIG\.appUrl \+ "\/api\/ingest\/tiktok-token"/);
  });

  it("token hết hạn ⇒ thông điệp chỉ đúng lượt 02:00 (không để người đọc đi sai hướng)", () => {
    const chay = nodeCode();
    expect(chay).toContain("ACCESS TOKEN ĐÃ HẾT HẠN");
    expect(chay, "phải nêu rõ lượt nào gia hạn để người đọc log giữa đêm biết kiểm ở đâu").toContain(
      "`tiktokshop-nightly` 02:00 gia "
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Khung workflow: lịch, múi giờ, node, credential
// ---------------------------------------------------------------------------------------------

describe("tiktokshop-analytics-nightly: khung workflow", () => {
  it("cron 02:30 + timezone VN (mất timezone là cron sai giờ — lớp lỗi 01/08)", () => {
    const trigger = WF.nodes.find((n) => n.type === "n8n-nodes-base.scheduleTrigger");
    expect((trigger?.parameters?.rule as { interval: { expression: string }[] }).interval[0].expression).toBe(
      "30 2 * * *"
    );
    expect(WF.settings?.timezone).toBe("Asia/Ho_Chi_Minh");
  });

  it("đủ 4 node (lịch + chạy tay + lấy khoá + Code), node Postgres có credential", () => {
    expect(WF.nodes.map((n) => n.type).sort()).toEqual([
      "n8n-nodes-base.code",
      "n8n-nodes-base.manualTrigger",
      "n8n-nodes-base.postgres",
      "n8n-nodes-base.scheduleTrigger",
    ]);
    const pg = WF.nodes.find((n) => n.type === "n8n-nodes-base.postgres");
    expect(pg?.credentials?.postgres?.id, "thiếu credential ⇒ node lấy khoá chết câm").toBeTruthy();
  });

  it("lưới cho shop/performance: soi khoá mảng và phải đứng TRƯỚC land", () => {
    // Cổng `total_count` không phủ được endpoint này (envelope không có trường đó) — nếu bỏ lưới thì
    // ngày sàn trả envelope thiếu `intervals` sẽ rơi vào đúng thông điệp đổ oan token/rate-limit.
    //
    // Đo bằng CHỈ SỐ KÝ TỰ chứ không `toContain`: lưới còn nguyên mà bị DỜI XUỐNG SAU `land` thì nó
    // đã hết tác dụng, trong khi phép kiểm mềm vẫn xanh — đúng lớp lỗi mà docblock đầu suite phê phán.
    const js = nodeCode();
    const cong = catKhoiIf(js, '!/"intervals"\\s*:\\s*\\[/.test(textShop)');
    const goiLand = 'await land("tiktok/analytics_shop", textShop);';
    expect(js.indexOf(goiLand), "không tìm thấy lời gọi land của shop/performance").toBeGreaterThan(0);
    expect(
      js.indexOf(cong),
      "lưới 'intervals' phải đứng TRƯỚC land — đứng sau thì trang thiếu mảng vẫn đi vào landRaw"
    ).toBeLessThan(js.indexOf(goiLand));
  });

  it("hai stream kéo CẢ CỬA SỔ có cảnh báo vượt mốc sẵn sàng (cổng ngayBom không chạm tới)", () => {
    // `shop/performance` và `shop_lives` land một lượt cho cả dải ngày ⇒ `keoLuot` nhận `ngayBom = null`
    // nên nhánh `ngayBom > lad` KHÔNG BAO GIỜ chạy. Checkpoint P2: 00:15 mốc shop = 23/08 trong khi
    // "hôm qua" = 24/08 ⇒ đêm nào cũng lệch. Không chặn (số ngoài P&L, cửa sổ lăn tự lành), nhưng phải
    // để lại dấu vết — nếu không thì không đêm nào tra được.
    const js = nodeCode();
    // Đã NỐI vào cả hai chỗ (hàm có mà không ai gọi thì vô dụng).
    expect(boChuThich(js)).toContain('canhBaoVuotMoc("tiktok/analytics_shop"');
    expect(boChuThich(js)).toContain('canhBaoVuotMoc("tiktok/analytics_lives"');

    // …và CHẠY THẬT hàm cắt từ jsCode: kêu đúng ca lệch, im đúng ca không lệch.
    const logs: LogDong[] = [];
    const tao = new Function(
      "denNgay",
      "logs",
      `"use strict";\n${catHam(js, "canhBaoVuotMoc")}\nreturn canhBaoVuotMoc;`
    ) as (den: string, l: LogDong[]) => (stream: string, lad: string | null) => void;
    const canhBao = tao("2026-08-24", logs);

    canhBao("tiktok/analytics_shop", "2026-08-24"); // mốc bằng ngày cuối ⇒ không lệch
    canhBao("tiktok/analytics_lives", null); // chưa đọc được mốc ⇒ im, không báo bừa
    expect(logs, "không lệch mà vẫn kêu = cảnh báo ma, người đọc sẽ mất phản xạ").toHaveLength(0);

    canhBao("tiktok/analytics_shop", "2026-08-23"); // mốc CHẬM 1 ngày — ca đo thật lúc 00:15
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("CANH_BAO");
    expect(logs[0].message).toContain("2026-08-24"); // ngày kéo tới
    expect(logs[0].message).toContain("2026-08-23"); // mốc sàn chốt
    expect(logs[0].message, "phải nói rõ là SỐ DỞ DANG, đừng để người đọc tưởng ngày ế").toContain("DỞ DANG");
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Chạy THẬT `keoLuot` cắt ra từ jsCode
// ---------------------------------------------------------------------------------------------

/**
 * Cắt nguyên văn một khai báo hàm (kể cả `async function`) khỏi jsCode bằng cách đếm ngoặc.
 * Cắt sai KHÔNG cho test xanh oan: đoạn cắt được `new Function` biên dịch ngay — thiếu ⇒ SyntaxError,
 * thừa ⇒ lôi theo code top-level và nổ ReferenceError.
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

/** Khối lệnh `if (<dieuKien>) { … }` — cắt ra để ĐỘT BIẾN (xoá cổng) chứng minh cổng đang gánh việc. */
function catKhoiIf(js: string, dieuKien: string): string {
  const dau = js.indexOf(`if (${dieuKien})`);
  expect(dau, `không tìm thấy cổng \`if (${dieuKien})\` trong jsCode`).toBeGreaterThanOrEqual(0);
  const moNgoac = js.indexOf("{", dau);
  let sau = 0;
  for (let i = moNgoac; i < js.length; i++) {
    if (js[i] === "{") sau++;
    else if (js[i] === "}") {
      sau--;
      if (sau === 0) return js.slice(dau, i + 1);
    }
  }
  throw new Error(`cổng \`if (${dieuKien})\` thiếu ngoặc đóng`);
}

type KetQuaLand = { landed: number; seen: number; skippedNoId: number };
type HamKeoLuot = (
  path: string,
  stream: string,
  params: Record<string, unknown>,
  ngayBom: string | null
) => Promise<{ lad: string | null; boQua: boolean; rong?: boolean }>;
type LogDong = { level: string; message: string };

type SanKhau = {
  keoLuot: HamKeoLuot;
  logs: LogDong[];
  getRaw: ReturnType<typeof vi.fn>;
  land: ReturnType<typeof vi.fn>;
};

/**
 * Dựng sân khấu tối thiểu cho `keoLuot`: `CONFIG`/`logs`/`sleep`/`MAX_PAGES` + hai cửa ra ngoài
 * (`getRaw` mạng, `land` app) thay bằng spy. Mọi thứ khác là CODE THẬT lấy từ file workflow.
 */
function dungSanKhau(
  js: string,
  trang: string[],
  landTraVe: (soLan: number) => KetQuaLand | Error
): SanKhau {
  const nguon = [catHam(js, "docChuoi"), catHam(js, "docSo"), catHam(js, "keoLuot")].join("\n\n");
  const logs: LogDong[] = [];
  let luotGetRaw = 0;
  const getRaw = vi.fn(async () => trang[Math.min(luotGetRaw++, trang.length - 1)]);
  let luotLand = 0;
  const land = vi.fn(async () => {
    const kq = landTraVe(luotLand++);
    if (kq instanceof Error) throw kq;
    return kq;
  });
  const tao = new Function(
    "CONFIG",
    "logs",
    "getRaw",
    "land",
    "sleep",
    "MAX_PAGES",
    `"use strict";\n${nguon}\nreturn keoLuot;`
  ) as (
    cfg: unknown,
    l: LogDong[],
    g: unknown,
    la: unknown,
    s: unknown,
    m: number
  ) => HamKeoLuot;
  const keoLuot = tao(
    { pageSize: 100 },
    logs,
    getRaw,
    land,
    async () => undefined,
    200
  );
  return { keoLuot, logs, getRaw, land };
}

/** Đúng lỗi `landRaw` ném ra khi envelope không có mảng — thông điệp đổ oan token/rate-limit. */
const LOI_LAND_RAW = new Error(
  `Envelope stream "tiktok/analytics_products" không có mảng tại 'data.products' (jsonb_typeof=null) — ` +
    `nhiều khả năng API trả lỗi (hết hạn key / token / rate-limit). Không land trang này.`
);

describe("cổng total_count === 0 ⇒ KHÔNG land", () => {
  const rong = () => fixture("ngay-rong.json"); // code=0, KHÔNG có khoá `data.products`, total_count=0

  it("ngày 0 record: trả về sớm, land KHÔNG hề được gọi, log nói rõ lý do", async () => {
    const sk = dungSanKhau(nodeCode(), [rong()], () => LOI_LAND_RAW);

    const kq = await sk.keoLuot(
      "/analytics/202605/shop_products/performance",
      "tiktok/analytics_products",
      { start_date_ge: "2026-08-22", end_date_lt: "2026-08-23" },
      "2026-08-22"
    );

    expect(kq.rong).toBe(true);
    expect(kq.boQua).toBe(false);
    expect(kq.lad).toBe("2026-08-22");
    expect(sk.land, "land vào trang rỗng = nightly đỏ với lý do SAI").not.toHaveBeenCalled();
    expect(sk.logs.map((l) => l.message).join("\n")).toContain("total_count=0");
  });

  it("ĐỘT BIẾN — xoá đúng cổng khỏi nguồn thì land BỊ GỌI và nổ (cổng đang gánh việc thật)", async () => {
    const js = nodeCode();
    const cong = catKhoiIf(js, "guard === 0 && tongCount === 0");
    expect(cong, "cổng phải nằm TRƯỚC land trong thân vòng lặp").toContain("rong: true");
    expect(
      js.indexOf(cong),
      "cổng phải đứng TRƯỚC lời gọi `await land(` — đứng sau là vô nghĩa"
    ).toBeLessThan(js.indexOf("const st = await land("));

    const sk = dungSanKhau(js.replace(cong, ""), [rong()], () => LOI_LAND_RAW);

    await expect(
      sk.keoLuot(
        "/analytics/202605/shop_products/performance",
        "tiktok/analytics_products",
        { start_date_ge: "2026-08-22", end_date_lt: "2026-08-23" },
        "2026-08-22"
      )
    ).rejects.toThrow("hết hạn key / token / rate-limit");
    expect(sk.land).toHaveBeenCalledTimes(1);
  });
});

describe("keoLuot: các cổng còn lại chạy trên payload thật", () => {
  it("ngày VƯỢT mốc sẵn sàng ⇒ boQua, không land (sàn trả số DỞ DANG, không phải rỗng)", async () => {
    const sk = dungSanKhau(nodeCode(), [fixture("shop-lives.json")], () => LOI_LAND_RAW);

    const kq = await sk.keoLuot("/analytics/202509/shop_lives/performance", "tiktok/analytics_lives", {}, "2026-08-24");

    expect(kq.boQua).toBe(true);
    expect(kq.lad).toBe("2026-08-23"); // latest_available_date của fixture
    expect(sk.land).not.toHaveBeenCalled();
  });

  it("trang có record ⇒ land ĐÚNG chuỗi thô + ĐÚNG ngày bơm vào khoá", async () => {
    const sk = dungSanKhau(nodeCode(), [fixture("shop-lives.json")], () => ({
      landed: 60,
      seen: 60,
      skippedNoId: 0,
    }));

    const kq = await sk.keoLuot(
      "/analytics/202509/shop_lives/performance",
      "tiktok/analytics_lives",
      {},
      "2026-08-23"
    );

    expect(kq.boQua).toBe(false);
    expect(sk.land).toHaveBeenCalledTimes(1);
    expect(sk.land.mock.calls[0][0]).toBe("tiktok/analytics_lives");
    expect(sk.land.mock.calls[0][1]).toBe(fixture("shop-lives.json")); // chuỗi THÔ, không parse
    expect(sk.land.mock.calls[0][2]).toBe("2026-08-23");
  });

  it("cổng chống cắt cụt: Σ(seen + skippedNoId) ≠ total_count ⇒ THROW", async () => {
    const sk = dungSanKhau(nodeCode(), [fixture("shop-lives.json")], () => ({
      landed: 3,
      seen: 3, // fixture khai total_count=60 (giá trị THẬT trang 1) — app chỉ nhận 3 ⇒ cắt cụt
      skippedNoId: 0,
    }));

    await expect(
      sk.keoLuot("/analytics/202509/shop_lives/performance", "tiktok/analytics_lives", {}, null)
    ).rejects.toThrow(/app nhận 3 record nhưng sàn báo total_count=60/);
  });

  it("next_page_token lặp không đổi ⇒ THROW (không kéo vô hạn, không cắt cụt lặng lẽ)", async () => {
    // `shop-products.json` có next_page_token KHÔNG rỗng; trả cùng một trang mãi = sàn kẹt phân trang.
    const sk = dungSanKhau(nodeCode(), [fixture("shop-products.json")], () => ({
      landed: 3,
      seen: 3,
      skippedNoId: 0,
    }));

    await expect(
      sk.keoLuot(
        "/analytics/202605/shop_products/performance",
        "tiktok/analytics_products",
        {},
        "2026-08-22"
      )
    ).rejects.toThrow("PHÂN TRANG KẸT");
  });
});

// ---------------------------------------------------------------------------------------------
// 4. P3 — cửa sổ RIÊNG của khối (5) affiliate: key `tiktokShopAffiliateManualDays`, trần 365
// ---------------------------------------------------------------------------------------------

/**
 * Vì sao có key riêng (28/08 chiều): key `tiktokShopAnalyticsManualDays` neo `hôm qua − (N − 1)` với trần
 * 90 ⇒ ép tối đa chỉ với tới 30/05→27/08 (đo lượt backfill đầu), trong khi 253 dòng SKU / 236 đơn
 * affiliate T3–T4/2026 nằm ngoài. Trần 90 là trần VẬT LÝ của analytics (2 request/NGÀY), còn affiliate
 * kéo theo lát 60 ngày (13 trang/lát cao điểm) — kéo 365 ngày chỉ ≈ 7 lát. Nhóm test này khoá:
 * (a) key riêng nối đúng hàm `soNgayCuaSo` với trần 365 và KHÔNG chạm trần 90 của analytics;
 * (b) cửa sổ tính THẬT (cắt hàm khỏi jsCode) phủ trọn T3–T4 khi ép 180 ngày, và với trần cũ thì không;
 * (c) chia lát liền kề, không hở, không chồng — mỗi lát một cổng đếm.
 */

const KEY_AFF = "tiktokShopAffiliateManualDays";
const TRAN_AFF = 365;

type CuaSo = { tu: string; den: string; mode: string };
type HamAffiliate = {
  soNgayCuaSo: (key: string, giaTri: unknown, tran: number) => number;
  cuaSoAffiliate: (soNgayAff: number, macDinhNgay: number, den: string) => CuaSo;
  cacLatAffiliate: (tu: string, den: string, latNgay: number) => Array<[string, string]>;
  congNgay: (d: string, n: number) => string;
};

/** Cắt 4 hàm thuần khỏi jsCode và chạy thật — `congNgay` cần hằng DAY_MS như trong node. */
function napHamAffiliate(): HamAffiliate {
  const js = nodeCode();
  const nguon = ["congNgay", "soNgayCuaSo", "cuaSoAffiliate", "cacLatAffiliate"].map((t) => catHam(js, t)).join("\n\n");
  const tao = new Function(
    `"use strict";\nconst DAY_MS = 86400000;\n${nguon}\nreturn { soNgayCuaSo, cuaSoAffiliate, cacLatAffiliate, congNgay };`
  ) as () => HamAffiliate;
  return tao();
}

function sqlLayKhoa(): string {
  const pg = WF.nodes.filter((n) => n.type === "n8n-nodes-base.postgres");
  expect(pg).toHaveLength(1);
  return pg[0].parameters?.query ?? "";
}

describe("P3 — key riêng tiktokShopAffiliateManualDays cho khối (5) affiliate", () => {
  it("SELECT có key, jsCode nối key qua soNgayCuaSo với trần 365, trần 90 của analytics NGUYÊN VẸN", () => {
    expect(sqlLayKhoa(), "thiếu key trong câu SELECT là cơ chế chết câm").toContain(KEY_AFF);
    const chay = boChuThich(nodeCode());
    expect(chay).toContain(`const MAX_AFFILIATE_MANUAL_DAYS = ${TRAN_AFF};`);
    expect(chay).toContain(`soNgayCuaSo("${KEY_AFF}", KHOA.${KEY_AFF}, MAX_AFFILIATE_MANUAL_DAYS)`);
    expect(chay, "còn đường `Number(KHOA.<key>` là còn ngả nuốt lặng giá trị rác").not.toContain(`Number(KHOA.${KEY_AFF}`);
    // Trần của 4 stream analytics không được đổi theo — 90 là trần vật lý (2 request/ngày).
    expect(chay).toContain("const MAX_MANUAL_DAYS = 90;");
    expect(chay).toContain('soNgayCuaSo("tiktokShopAnalyticsManualDays", KHOA.tiktokShopAnalyticsManualDays, MAX_MANUAL_DAYS)');
    // Lát 60 là SỐ ĐÃ ĐO (probe 28/08: cửa sổ 61 ngày HTTP 200) — nới lên là chạm vùng chưa đo của API.
    expect(chay).toContain("const LAT_NGAY_AFFILIATE = 60;");
  });

  it("key riêng KHÔNG đổi cửa sổ 4 stream analytics — chỉ khối (5) đọc soNgayEpAffiliate", () => {
    const chay = boChuThich(nodeCode());
    expect(chay).toContain("const soNgay = soNgayEp > 0 ? soNgayEp : CONFIG.nightlyDays;");
    expect(chay).toContain("const tuNgay = congNgay(denNgay, -(soNgay - 1));");
    // Đúng 4 lần: 1 khai báo + 1 đưa vào cuaSoAffiliate + 2 trong khối CANH_BAO nhắc xoá key (điều kiện +
    // thông điệp). Xuất hiện thêm ở chỗ khác = có stream analytics đang lén dùng cửa sổ 365 ngày.
    expect(chay.split("soNgayEpAffiliate").length - 1).toBe(4);
    expect(chay).not.toMatch(/const soNgay = [^\n]*soNgayEpAffiliate/);
    expect(chay).not.toMatch(/const tuNgay = [^\n]*soNgayEpAffiliate/);
    expect(chay).toContain("cuaSoAffiliate(soNgayEpAffiliate, CONFIG.nightlyDaysAffiliate, denNgay)");
    expect(chay).toContain("cacLatAffiliate(cuaSoAff.tu, cuaSoAff.den, LAT_NGAY_AFFILIATE)");
    expect(chay).toContain("keoLuotAffiliate(cacLatAff[i][0], cacLatAff[i][1])");
    // Output phải in cửa sổ + mode của khối (5) để lượt sau đọc execution biết đã ép gì.
    expect(chay).toContain("mode: cuaSoAff.mode");
    expect(chay).toContain("window: { tu: cuaSoAff.tu, den: cuaSoAff.den }");
    // Đang ép cửa sổ thì phải KÊU trong logs (tiền lệ: key tiktokShopManualDays=7 sót cả tháng không ai thấy).
    expect(chay).toContain("if (soNgayEpAffiliate > 0) {");
    expect(chay).toContain("XOÁ key tiktokShopAffiliateManualDays");
  });

  it("soNgayCuaSo với trần 365: nhận 365, chặn 366 và thông báo nêu tên key + trần", () => {
    const { soNgayCuaSo } = napHamAffiliate();
    expect(soNgayCuaSo(KEY_AFF, "365", TRAN_AFF)).toBe(365);
    expect(soNgayCuaSo(KEY_AFF, "180", TRAN_AFF)).toBe(180);
    expect(soNgayCuaSo(KEY_AFF, undefined, TRAN_AFF)).toBe(0);
    expect(() => soNgayCuaSo(KEY_AFF, "366", TRAN_AFF)).toThrow(/tiktokShopAffiliateManualDays[\s\S]*365/);
    // Với trần cũ 90 thì 180 ngày bị chặn — đây chính là lý do phải có trần riêng.
    expect(() => soNgayCuaSo(KEY_AFF, "180", 90)).toThrow(/90/);
  });

  it("cuaSoAffiliate: ép 180 ngày với hôm-qua = 2026-08-27 phủ TRỌN T3–T4/2026; trần cũ 90 thì KHÔNG", () => {
    const { cuaSoAffiliate } = napHamAffiliate();
    const ep180 = cuaSoAffiliate(180, 60, "2026-08-27");
    expect(ep180).toEqual({ tu: "2026-03-01", den: "2026-08-27", mode: expect.stringContaining(KEY_AFF) });
    expect(ep180.tu <= "2026-03-01" && ep180.den >= "2026-04-30", "T3–T4 phải nằm trọn trong cửa sổ").toBe(true);
    // Neo hôm qua, không phải hôm nay: den giữ nguyên tham số truyền vào.
    expect(cuaSoAffiliate(365, 60, "2026-08-27").tu).toBe("2025-08-28");
    // Không có key ⇒ mặc định RIÊNG 60 ngày (nightlyDaysAffiliate), KHÔNG phải 3 ngày của analytics.
    const khongKey = cuaSoAffiliate(0, 60, "2026-08-27");
    expect(khongKey).toEqual({ tu: "2026-06-29", den: "2026-08-27", mode: expect.stringContaining("nightlyDaysAffiliate") });
    // Bằng chứng khoảng trống của trần cũ: 90 ngày lùi từ 27/08 dừng ở 30/05 — sau T4.
    expect(cuaSoAffiliate(90, 60, "2026-08-27").tu).toBe("2026-05-30");
  });

  it("cacLatAffiliate: chia lát ≤60 ngày liền kề, không hở, không chồng; lát cuối được ngắn", () => {
    const { cacLatAffiliate, congNgay } = napHamAffiliate();
    expect(cacLatAffiliate("2026-03-01", "2026-08-27", 60)).toEqual([
      ["2026-03-01", "2026-04-29"],
      ["2026-04-30", "2026-06-28"],
      ["2026-06-29", "2026-08-27"],
    ]);
    // 365 ngày ⇒ 7 lát (6 × 60 + 5), phủ đúng 365 ngày, lát sau bắt đầu ngay ngày kế lát trước.
    const lat365 = cacLatAffiliate("2025-08-28", "2026-08-27", 60);
    expect(lat365).toHaveLength(7);
    expect(lat365[0][0]).toBe("2025-08-28");
    expect(lat365[6][1]).toBe("2026-08-27");
    let tongNgay = 0;
    for (let i = 0; i < lat365.length; i++) {
      const [tu, den] = lat365[i];
      const soNgay = (Date.parse(den + "T00:00:00Z") - Date.parse(tu + "T00:00:00Z")) / 86400000 + 1;
      expect(soNgay, `lát ${i} vượt 60 ngày`).toBeLessThanOrEqual(60);
      expect(soNgay).toBeGreaterThan(0);
      tongNgay += soNgay;
      if (i > 0) expect(tu, `lát ${i} phải bắt đầu ngay sau lát ${i - 1}`).toBe(congNgay(lat365[i - 1][1], 1));
    }
    expect(tongNgay).toBe(365);
    // Cửa sổ 1 ngày ⇒ đúng 1 lát 1 ngày.
    expect(cacLatAffiliate("2026-08-27", "2026-08-27", 60)).toEqual([["2026-08-27", "2026-08-27"]]);
  });

  it("HAI CỬA SỔ TÁCH BIỆT: analytics giữ nightlyDays 3, affiliate mặc định nightlyDaysAffiliate 60 = đúng 1 lát; key nào chỉ đổi cửa sổ nấy", () => {
    const chay = boChuThich(nodeCode());
    // (a) Hai mặc định khai riêng, đúng giá trị chủ shop chốt (28/08: analytics 3 giữ nguyên, affiliate 60).
    expect(chay).toContain("nightlyDays: 3,");
    expect(chay).toContain("nightlyDaysAffiliate: 60,");
    // (b) Khối (5) nhận mặc định RIÊNG, không còn nhận tuNgay của analytics; hàm cũng không có tham số analytics nào.
    expect(chay).toContain("cuaSoAffiliate(soNgayEpAffiliate, CONFIG.nightlyDaysAffiliate, denNgay)");
    expect(chay).not.toMatch(/cuaSoAffiliate\(soNgayEpAffiliate,\s*tuNgay/);
    expect(catHam(nodeCode(), "cuaSoAffiliate").startsWith("function cuaSoAffiliate(soNgayAff, macDinhNgay, den)")).toBe(true);
    // (c) nightlyDaysAffiliate xuất hiện đúng 4 lần: khai báo trong CONFIG + lời gọi ở khối (5) + chuỗi `mode` in ra
    // output + thông điệp THROW của cổng cửa sổ rỗng. Thêm lần thứ 5 = có stream analytics đang lén dùng; analytics
    // vẫn phải đi qua CONFIG.nightlyDays (hai regex dưới chặn thẳng dòng tính soNgay/tuNgay).
    expect(chay.split("nightlyDaysAffiliate").length - 1).toBe(4);
    expect(chay).toContain("const soNgay = soNgayEp > 0 ? soNgayEp : CONFIG.nightlyDays;");
    expect(chay).not.toMatch(/const soNgay = [^\n]*nightlyDaysAffiliate/);
    expect(chay).not.toMatch(/const tuNgay = [^\n]*(nightlyDaysAffiliate|soNgayEpAffiliate)/);
    // (d) Chạy thật: mặc định 60 ngày = ĐÚNG 1 lát (giữ 1 cổng Σ == total_count), lát phủ trọn 60 ngày.
    const { cuaSoAffiliate, cacLatAffiliate } = napHamAffiliate();
    const macDinh = cuaSoAffiliate(0, 60, "2026-08-27");
    expect(cacLatAffiliate(macDinh.tu, macDinh.den, 60)).toEqual([["2026-06-29", "2026-08-27"]]);
    // (e) Mặc định 60 phải ≤ LAT_NGAY_AFFILIATE (đo được API chấp nhận 61 ngày); vượt là 2 lát + vùng chưa đo.
    expect(chay).toContain("const LAT_NGAY_AFFILIATE = 60;");
    // (f) Key affiliate thắng mặc định; cửa sổ mặc định do THAM SỐ macDinhNgay quyết (đổi 60 → 3 thì ra đúng 3 ngày),
    // không do hằng analytics nào lọt vào hàm.
    expect(cuaSoAffiliate(180, 60, "2026-08-27").tu).toBe("2026-03-01");
    expect(cuaSoAffiliate(0, 3, "2026-08-27").tu).toBe("2026-08-25");
    expect(cuaSoAffiliate(0, 1, "2026-08-27").tu).toBe("2026-08-27");
    // (g) macDinhNgay ≤ 0 ⇒ cửa sổ RỖNG (tu > den) ⇒ 0 lát — khối (5) phải THROW thay vì im lặng không kéo gì.
    const rong = cuaSoAffiliate(0, 0, "2026-08-27");
    expect(rong.tu > rong.den).toBe(true);
    expect(cacLatAffiliate(rong.tu, rong.den, 60)).toEqual([]);
    expect(chay).toContain("if (cacLatAff.length === 0) {");
    expect(chay).toContain("khối affiliate: cửa sổ rỗng");
  });
});
