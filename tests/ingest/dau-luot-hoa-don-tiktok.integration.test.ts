import { afterAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST as postDauLuot } from "@/app/api/ingest/luot-hoa-don-tiktok/route";
import { POST as postRaw } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { lyDoHoaDonTiktokChuaDu } from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

import { phamViLui } from "../helpers/pham-vi-dau-luot";

/**
 * DẤU LƯỢT kéo hoá đơn TikTok (bắt đầu + kết thúc theo BC) đi qua route THẬT `/api/ingest/luot-hoa-don-tiktok`, trang
 * hoá đơn qua route THẬT `/api/ingest/raw` (land + transform + SyncLog), rồi hỏi cổng chốt sao kê thẻ THẬT
 * (`lyDoHoaDonTiktokChuaDu`). Không giả DB.
 *
 * Lỗ hổng cần đóng: trang bị 400/413/502/timeout TRƯỚC khi có SyncLog thì cổng cũ không thấy (n8n ghi lỗi rồi đi tiếp)
 * ⇒ lượt chỉ còn trang OK trông "sạch" ⇒ cổng MỞ dù thiếu hoá đơn ngày sao kê; lượt chạy dở cũng trông như sạch.
 *
 * Giờ thật: ngày sao kê = hôm nay − 5 ⇒ D+2 đã qua; lượt "cũ" lùi 1 ngày vẫn ≥ D+2.
 */

const BC = "7129545797879726081";
const BC_B = "7200000000000000002";
const ADV = "7129548444015902722";
const NGAY_MS = 24 * 3600 * 1000;

let soHoaDon = 0;
/** Một trang hoá đơn có MỘT hoá đơn mới (id khác nhau ⇒ land thật, không trùng hash), tạo lúc `taoLuc` (giờ VN). */
const trang = (bc = BC, taoLuc = "2026-10-23 15:38:00") => {
  soHoaDon += 1;
  return (
    `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"TX-${soHoaDon}","transaction_type":` +
    `"BILL_PAYMENT","billing_type":"CASH","amount_type":"POSITIVE","account_id":"${ADV}","bc_id":"${bc}",` +
    `"subtotal":130000,"tax_amount":13000,"amount":143000,"currency":"VND","create_time":"${taoLuc}",` +
    `"timezone":"UTC+07:00"}],"page_info":{"total_page":1}}}`
  );
};
/** Envelope lỗi (không có mảng) ⇒ land ném ⇒ route 500 + SyncLog ERROR. */
const TRANG_LOI = `{"code":40100,"message":"rate limit","data":{}}`;

const goi = (handler: (req: Request) => Promise<Response>, url: string, body: unknown) =>
  handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const guiTrang = (luotId: string, payload = trang(), bc = BC) =>
  goi(postRaw, "http://localhost/api/ingest/raw", { stream: "tiktokbusiness/invoice", shopId: bc, payload, luotId });
const guiDau = (body: unknown) => goi(postDauLuot, "http://localhost/api/ingest/luot-hoa-don-tiktok", body);
/** Phạm vi thời gian mặc định trên dấu: 40 ngày tới 00:00 hôm nay — phủ ngày sao kê D = hôm nay − 5. */
const PHU_D = phamViLui();
const batDau = (luotId: string, bcId = BC, phamVi: unknown = PHU_D) =>
  guiDau({ luotId, bcId, giaiDoan: "bat-dau", ...(phamVi === null ? {} : { phamVi }) });

type SoLieu = {
  tongTrangNguon: number | null;
  tongHoaDonNguon: number | null;
  soTrangDaGet: number;
  soTrangLand: number;
  soTrangRong: number;
  soTrangLoi: number;
  soHoaDon: number;
  hoanTat: boolean;
  ketQua: "xong" | "loi" | "khong-quyen-finance";
  loi: string[];
};
/** Số liệu kết thúc của lượt `n` trang đều land OK (mỗi trang một hoá đơn) — ghi đè từng trường theo ca. */
const du = (n: number, them: Partial<SoLieu> = {}): SoLieu => ({
  tongTrangNguon: n,
  tongHoaDonNguon: n,
  soTrangDaGet: n,
  soTrangLand: n,
  soTrangRong: 0,
  soTrangLoi: 0,
  soHoaDon: n,
  hoanTat: true,
  ketQua: "xong",
  loi: [],
  ...them,
});
/** GET trang 1 lỗi/timeout: n8n gửi kết thúc `loi` với 0 trang (dấu bắt đầu đã gửi TRƯỚC GET). */
const LOI_TRANG_1: SoLieu = du(0, {
  tongTrangNguon: null,
  tongHoaDonNguon: null,
  hoanTat: false,
  ketQua: "loi",
  loi: ["ETIMEDOUT business-api.tiktok.com"],
});
/** TikTok báo BC thiếu quyền finance ngay trang 1. */
const KHONG_QUYEN: SoLieu = du(0, {
  tongTrangNguon: null,
  tongHoaDonNguon: null,
  hoanTat: false,
  ketQua: "khong-quyen-finance",
  loi: ["TIKTOK_ADS lỗi: code 40002 — No access to finance of this bc"],
});
/** Cửa sổ rỗng hợp lệ: nguồn `total_page 0` + `total_number 0`, n8n GET 1 trang rỗng, land 0. */
const RONG_HOP_LE: SoLieu = du(0, { soTrangDaGet: 1, soTrangRong: 1 });
const ketThuc = (luotId: string, soLieu: SoLieu, bcId = BC, phamVi: unknown = PHU_D) =>
  guiDau({ luotId, bcId, giaiDoan: "ket-thuc", ...(phamVi === null ? {} : { phamVi }), ...soLieu });

/** Lượt đủ: bắt đầu → `n` trang → kết thúc khai đúng. */
async function luotDu(luotId: string, n: number, bcId = BC): Promise<void> {
  expect((await batDau(luotId, bcId)).status).toBe(200);
  for (let i = 0; i < n; i++) expect((await guiTrang(luotId, trang(bcId), bcId)).status).toBe(200);
  expect((await ketThuc(luotId, du(n), bcId)).status).toBe(200);
}

/** Lùi mọi dòng SyncLog của lượt `luotId` về `truocMs` trước — giả lập lượt chạy hôm trước. */
async function luiLuot(luotId: string, truocMs: number): Promise<void> {
  const luc = new Date(Date.now() - truocMs);
  await prisma.syncLog.updateMany({
    where: { kind: "TIKTOK_ADS", stats: { path: ["luotId"], equals: luotId } },
    data: { startedAt: luc, finishedAt: luc },
  });
}

/** Lùi CẢ hoá đơn kho thô của BC về `truocMs` trước — BC land hoá đơn lần cuối từ lâu (ngoài cửa sổ D − 30). */
async function luiHoaDonBc(bcId: string, truocMs: number): Promise<void> {
  await prisma.rawTiktokBusinessInvoice.updateMany({ where: { shopId: bcId }, data: { fetchedAt: new Date(Date.now() - truocMs) } });
}

/** Chủ shop xác nhận BC "không dùng thẻ" lúc `luc` (ghi thẳng cột — đường action có test riêng). */
const danhDauKhongDung = (bcId: string, luc = new Date()) =>
  prisma.tiktokBcHoaDon.upsert({
    where: { bcId },
    create: { bcId, khongDungTu: luc, khongDungBoi: "chu@test" },
    update: { khongDungTu: luc, khongDungBoi: "chu@test" },
  });
const boDanhDau = (bcId: string) =>
  prisma.tiktokBcHoaDon.update({ where: { bcId }, data: { khongDungTu: null, khongDungBoi: null, khongDungGhiChu: null } });

const cong = () =>
  lyDoHoaDonTiktokChuaDu(prisma, khoaNgayVn(new Date(Date.now() - 5 * NGAY_MS)), khoaNgayVn(new Date()));
const demSyncLog = () => prisma.syncLog.count({ where: { kind: "TIKTOK_ADS" } });

async function cleanup(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.tiktokBcHoaDon.deleteMany();
  await prisma.tiktokAdsHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await clearBronzeBacklog();
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("/api/ingest/luot-hoa-don-tiktok — ghi dấu thành SyncLog", () => {
  it("dấu bắt đầu ⇒ dòng OK kind TIKTOK_ADS, stats mang stream hoá đơn + BC + luotId + giai đoạn", async () => {
    const res = await batDau("501");

    expect(res.status).toBe(200);
    const d = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" } });
    expect(d.status).toBe("OK");
    expect(d.stats).toMatchObject({
      stream: "tiktokbusiness/invoice",
      shopId: BC,
      luotId: "501",
      giaiDoan: "bat-dau",
      mode: "luot-bat-dau",
    });
  });

  it("dấu kết thúc báo lỗi ⇒ dòng ERROR (bật banner đồng bộ), HTTP 200, stats giữ đủ số khai", async () => {
    const res = await ketThuc("502", du(2, { soTrangLand: 1, soTrangLoi: 1, loi: ["502 Bad Gateway"] }));

    expect(res.status).toBe(200);
    const d = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" } });
    expect(d.status).toBe("ERROR");
    expect(d.error).toContain("1 trang hoá đơn land hỏng");
    expect(d.stats).toMatchObject({ mode: "luot-ket-thuc", luotId: "502", soTrangLand: 1, soTrangLoi: 1, tongTrangNguon: 2 });
  });

  it.each<[string, unknown]>([
    ["không phải JSON", "{không phải json"],
    ["mảng", [1, 2]],
    ["thiếu luotId", { bcId: BC, giaiDoan: "bat-dau" }],
    ["luotId sai khuôn", { luotId: "exec 1", bcId: BC, giaiDoan: "bat-dau" }],
    ["bcId sai khuôn", { luotId: "1", bcId: "bc-abc", giaiDoan: "bat-dau" }],
    ["giai đoạn lạ", { luotId: "1", bcId: BC, giaiDoan: "giua-chung" }],
    ["bắt đầu kèm số liệu (khoá thừa)", { luotId: "1", bcId: BC, giaiDoan: "bat-dau", soTrangDaGet: 1 }],
    ["kết thúc thiếu trường", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", soTrangDaGet: 1 }],
    ["số trang âm", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1, { soTrangRong: -1, soTrangDaGet: 0 }) }],
    ["số trang không nguyên", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1, { soTrangLand: 1.5 }) }],
    ["cộng không khớp", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(2, { soTrangLand: 1 }) }],
    ["kết thúc kèm khoá lạ", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1), them: 1 }],
    ["thiếu tongHoaDonNguon", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1), tongHoaDonNguon: undefined }],
    ["tongHoaDonNguon âm", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1, { tongHoaDonNguon: -1 }) }],
    ["tongHoaDonNguon không nguyên", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1, { tongHoaDonNguon: 1.5 }) }],
    ["tongHoaDonNguon chuỗi", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1), tongHoaDonNguon: "5" }],
    ["thiếu ketQua", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1), ketQua: undefined }],
    ["ketQua lạ", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1), ketQua: "du" }],
    ["ketQua xong mà hoanTat false", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...du(1, { hoanTat: false }) }],
    ["ketQua loi mà hoanTat true", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...LOI_TRANG_1, hoanTat: true }],
    ["ketQua loi không kèm câu lỗi", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...LOI_TRANG_1, loi: [] }],
    [
      "khong-quyen-finance mà đã GET 1 trang",
      { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...KHONG_QUYEN, soTrangDaGet: 1, soTrangRong: 1 },
    ],
    ["khong-quyen-finance mà nguồn báo total_page", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...KHONG_QUYEN, tongTrangNguon: 0 }],
    ["khong-quyen-finance không kèm câu lỗi", { luotId: "1", bcId: BC, giaiDoan: "ket-thuc", ...KHONG_QUYEN, loi: [] }],
  ])("khuôn sai (%s) ⇒ 400, KHÔNG ghi SyncLog nào", async (_ten, body) => {
    const res = await guiDau(body);

    expect(res.status).toBe(400);
    expect(await demSyncLog()).toBe(0);
  });

  it("thiếu bearer ⇒ 401, không ghi", async () => {
    const res = await postDauLuot(
      new Request("http://localhost/api/ingest/luot-hoa-don-tiktok", {
        method: "POST",
        body: JSON.stringify({ luotId: "1", bcId: BC, giaiDoan: "bat-dau" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await demSyncLog()).toBe(0);
  });
});

describe("cổng chốt sao kê thẻ — luật dấu lượt (BC đã có dấu)", () => {
  it("lượt đủ (bắt đầu, 2 trang, kết thúc khớp) ⇒ MỞ", async () => {
    await luotDu("601", 2);
    expect(await cong()).toBeNull();
  });

  it("có dấu bắt đầu + trang OK mà CHƯA có dấu kết thúc (đang chạy / đứt) ⇒ CHẶN 'chưa hoàn tất'", async () => {
    await batDau("602");
    await guiTrang("602");

    expect(await cong()).toContain(`CHƯA HOÀN TẤT (BC ${BC})`);
  });

  it("kết thúc báo lỗi (trang 2 bị 502 trước khi có SyncLog) ⇒ CHẶN 'kết thúc với LỖI'", async () => {
    await batDau("603");
    await guiTrang("603");
    // Trang 2: n8n POST nhận 502 từ proxy — app không ghi gì; chỉ dấu kết thúc mang số trang lỗi.
    await ketThuc("603", du(2, { soTrangLand: 1, soTrangLoi: 1, loi: [] }));

    const ly = await cong();
    expect(ly).toContain("kết thúc với LỖI");
    expect(ly).toContain(`BC ${BC}: 1 trang hoá đơn land hỏng`);
  });

  it("app ghi nhận ÍT trang OK hơn số n8n khai land (trang mất trước SyncLog mà n8n không biết) ⇒ CHẶN 'thiếu trang'", async () => {
    await batDau("604");
    await guiTrang("604");
    // n8n khai land đủ 2 trang (dòng kết thúc OK), nhưng app chỉ có 1 trang OK của lượt.
    await ketThuc("604", du(2));
    expect((await prisma.syncLog.findFirstOrThrow({ where: { stats: { path: ["giaiDoan"], equals: "ket-thuc" } } })).status).toBe("OK");

    const ly = await cong();
    expect(ly).toContain("THIẾU TRANG");
    expect(ly).toContain("n8n khai land 2 trang, app ghi nhận 1 trang");
  });

  it("số trang GET < total_page nguồn báo ⇒ CHẶN, nói rõ mới GET bao nhiêu", async () => {
    await batDau("605");
    await guiTrang("605");
    await guiTrang("605");
    await ketThuc("605", du(2, { tongTrangNguon: 3 }));

    const ly = await cong();
    expect(ly).toContain("kết thúc với LỖI");
    expect(ly).toContain("mới GET 2/3 trang nguồn báo");
  });

  it("nguồn báo total_page 3 mà cả 3 trang GET về rỗng (mảng vắng / đổi tên khoá) ⇒ dòng ERROR, CHẶN", async () => {
    // n8n không land trang rỗng ⇒ app có 0 trang OK = 0 khai; chỉ luật trang rỗng bắt được. total_number cũng vắng.
    await batDau("620");
    const res = await ketThuc("620", du(3, { tongHoaDonNguon: null, soTrangLand: 0, soTrangRong: 3, soHoaDon: 0 }));

    expect(res.status).toBe(200);
    const d = await prisma.syncLog.findFirstOrThrow({ where: { stats: { path: ["giaiDoan"], equals: "ket-thuc" } } });
    expect(d.status).toBe("ERROR");
    const ly = await cong();
    expect(ly).toContain("kết thúc với LỖI");
    expect(ly).toContain("nguồn báo 3 trang mà 3 trang GET về rỗng");
  });

  it("nguồn báo total_number 5 mà mới land 3 hoá đơn (đủ trang) ⇒ CHẶN, nói rõ thiếu bao nhiêu", async () => {
    await batDau("621");
    for (let i = 0; i < 3; i++) await guiTrang("621");
    await ketThuc("621", du(3, { tongHoaDonNguon: 5 }));

    const ly = await cong();
    expect(ly).toContain("kết thúc với LỖI");
    expect(ly).toContain("mới land 3/5 hoá đơn nguồn báo");
  });

  it.each<[string, Partial<SoLieu>]>([
    ["total_page 0", { tongTrangNguon: 0 }],
    ["total_number 0", { tongHoaDonNguon: 0 }],
  ])("nguồn tự mâu thuẫn (%s mà có trang mang hoá đơn, số trang app khớp) ⇒ dòng ERROR, CHẶN", async (_ten, them) => {
    await batDau("623");
    await guiTrang("623");
    expect((await ketThuc("623", du(1, them))).status).toBe(200);

    const d = await prisma.syncLog.findFirstOrThrow({ where: { stats: { path: ["giaiDoan"], equals: "ket-thuc" } } });
    expect(d.status).toBe("ERROR");
    const ly = await cong();
    expect(ly).toContain("kết thúc với LỖI");
    expect(ly).toContain("nguồn tự mâu thuẫn");
  });

  it("nguồn không báo total_number, đủ trang ⇒ MỞ (phép đối số hoá đơn chỉ áp khi nguồn báo)", async () => {
    await batDau("622");
    await guiTrang("622");
    await ketThuc("622", du(1, { tongHoaDonNguon: null }));

    expect(await cong()).toBeNull();
  });

  it("lượt hợp lệ 0 hoá đơn (nguồn total_page 0, GET 1 trang rỗng, land 0) ⇒ HOÀN TẤT, MỞ", async () => {
    // BC chưa land hoá đơn nào trong 30 ngày — vẫn được xét nhờ dấu lượt.
    await batDau("606");
    await ketThuc("606", RONG_HOP_LE);

    expect(await cong()).toBeNull();
  });

  it("BC đã có hoá đơn, lượt mới nhất 0 hoá đơn (ngừng ads) ⇒ MỞ", async () => {
    await luotDu("607", 1);
    await luiLuot("607", NGAY_MS);
    await batDau("608");
    await ketThuc("608", RONG_HOP_LE);

    expect(await cong()).toBeNull();
  });

  it("lượt CŨ đủ nhưng lượt MỚI NHẤT hỏng (chưa kết thúc) ⇒ CHẶN — lượt cũ không che lượt mới", async () => {
    await luotDu("609", 2);
    await luiLuot("609", NGAY_MS);
    await batDau("610");
    await guiTrang("610");

    expect(await cong()).toContain(`CHƯA HOÀN TẤT (BC ${BC})`);
  });

  it("trang mang luotId MỚI mà không có dấu bắt đầu (dấu không tới app / workflow bản cũ) ⇒ CHẶN", async () => {
    await luotDu("611", 1);
    await luiLuot("611", 60 * 60 * 1000);
    await guiTrang("612");

    expect(await cong()).toContain(`KHÔNG có dấu bắt đầu lượt (BC ${BC})`);
  });

  it("lượt mới nhất có trang ERROR (500) dù dấu kết thúc khai sạch ⇒ CHẶN 'trang LỖI'", async () => {
    await batDau("613");
    expect((await guiTrang("613", TRANG_LOI)).status).toBe(500);
    await ketThuc("613", du(1, { soTrangLand: 1 }));

    expect(await cong()).toContain(`mới nhất có trang LỖI (BC ${BC})`);
  });

  it("nhiều BC độc lập: BC A đủ, BC B chưa kết thúc ⇒ CHẶN vì B (không nêu A); B kéo lại đủ ⇒ MỞ", async () => {
    await luotDu("614", 1, BC);
    await batDau("614", BC_B);
    await guiTrang("614", trang(BC_B), BC_B);

    const ly = await cong();
    expect(ly).toContain(`CHƯA HOÀN TẤT (BC ${BC_B})`);
    expect(ly).not.toContain(BC);

    await luotDu("615", 1, BC_B);
    expect(await cong()).toBeNull();
  });
});

describe("cổng — dấu bắt đầu TRƯỚC GET: lượt sạch cũ không che lượt mới hỏng sớm", () => {
  /** Lượt đủ hôm qua (BC đã có hoá đơn + dấu) — nền của mọi ca dưới. */
  async function coLuotSachHomQua(bcId = BC): Promise<void> {
    await luotDu("801", 1, bcId);
    await luiLuot("801", NGAY_MS);
    expect(await cong()).toBeNull();
  }

  it("lượt mới CHỈ có dấu bắt đầu (GET trang 1 treo / n8n chết trước khi kết thúc) ⇒ CHẶN 'chưa hoàn tất'", async () => {
    await coLuotSachHomQua();
    await batDau("802");

    expect(await cong()).toContain(`CHƯA HOÀN TẤT (BC ${BC})`);
  });

  it("lượt mới có trang OK rồi chết giữa chừng (không dấu kết thúc) ⇒ CHẶN 'chưa hoàn tất'", async () => {
    await coLuotSachHomQua();
    await batDau("803");
    await guiTrang("803");

    expect(await cong()).toContain(`CHƯA HOÀN TẤT (BC ${BC})`);
  });

  it("lượt mới GET trang 1 lỗi ⇒ kết thúc ketQua loi (0 trang): dòng ERROR, CHẶN 'kết thúc với LỖI'", async () => {
    await coLuotSachHomQua();
    await batDau("804");
    expect((await ketThuc("804", LOI_TRANG_1)).status).toBe(200);

    const d = await prisma.syncLog.findFirstOrThrow({
      where: { stats: { path: ["luotId"], equals: "804" }, AND: { stats: { path: ["giaiDoan"], equals: "ket-thuc" } } },
    });
    expect(d.status).toBe("ERROR");
    const ly = await cong();
    expect(ly).toContain("kết thúc với LỖI");
    expect(ly).toContain("ETIMEDOUT");
  });

  it("lượt mới đứt giữa chừng, kết thúc hoanTat false ⇒ CHẶN", async () => {
    await coLuotSachHomQua();
    await batDau("805");
    await guiTrang("805");
    await ketThuc("805", du(1, { tongTrangNguon: 3, hoanTat: false, ketQua: "loi", loi: ["ETIMEDOUT trang 2"] }));

    expect(await cong()).toContain("n8n chưa đi hết phân trang");
  });
});

describe("cổng — BC thiếu quyền finance (ketQua khong-quyen-finance)", () => {
  it("dấu kết thúc thiếu quyền ⇒ dòng OK (không banner đỏ mỗi đêm), stats giữ ketQua", async () => {
    await batDau("901", BC_B);
    expect((await ketThuc("901", KHONG_QUYEN, BC_B)).status).toBe(200);

    const d = await prisma.syncLog.findFirstOrThrow({ where: { stats: { path: ["giaiDoan"], equals: "ket-thuc" } } });
    expect(d.status).toBe("OK");
    expect(d.stats).toMatchObject({ ketQua: "khong-quyen-finance", shopId: BC_B });
  });

  it("BC thiếu quyền CHƯA TỪNG đọc được ⇒ CHẶN 'chưa xác nhận' (BC kia đủ); đánh dấu không dùng ⇒ MỞ; bỏ đánh dấu ⇒ CHẶN lại", async () => {
    await luotDu("902", 1, BC);
    await batDau("902", BC_B);
    await ketThuc("902", KHONG_QUYEN, BC_B);

    const ly = await cong();
    expect(ly).toContain(`CHƯA XÁC NHẬN (BC ${BC_B})`);
    expect(ly).toContain("No access to finance");
    expect(ly).toContain("không dùng thẻ");
    expect(ly).not.toContain(BC);

    await danhDauKhongDung(BC_B);
    expect(await cong()).toBeNull();

    await boDanhDau(BC_B);
    expect(await cong()).toContain(`CHƯA XÁC NHẬN (BC ${BC_B})`);
  });

  it("MỌI BC đều thiếu quyền và chưa từng đọc được ⇒ CHẶN 'chưa xác nhận'; đánh dấu hết ⇒ vẫn CHẶN (không BC nào được kiểm)", async () => {
    await batDau("903", BC_B);
    await ketThuc("903", KHONG_QUYEN, BC_B);

    expect(await cong()).toContain(`CHƯA XÁC NHẬN (BC ${BC_B})`);

    await danhDauKhongDung(BC_B);
    expect(await cong()).toContain(`Mọi Business Center TikTok (BC ${BC_B}) đều được đánh dấu "không dùng thẻ"`);
  });

  it("BC từng đọc được (lượt đủ cách 40 ngày) nay chỉ còn dấu thiếu quyền mỗi đêm trong cửa sổ, BC kia đủ ⇒ CHẶN 'mất quyền'", async () => {
    await luotDu("920", 1, BC);
    await luiLuot("920", 40 * NGAY_MS);
    await luiHoaDonBc(BC, 40 * NGAY_MS);
    for (const [i, luot] of ["921", "922", "923"].entries()) {
      await batDau(luot, BC);
      await ketThuc(luot, KHONG_QUYEN, BC);
      await luiLuot(luot, (3 - i) * NGAY_MS);
    }
    await luotDu("924", 1, BC_B);

    const ly = await cong();
    expect(ly).toContain(`MẤT QUYỀN finance (BC ${BC})`);
    expect(ly).not.toContain(BC_B);
  });

  it("BC chỉ từng có lượt đủ 0 hoá đơn (không kho thô) cách 40 ngày, nay thiếu quyền ⇒ CHẶN 'mất quyền' (nhớ bền, không cần kho thô)", async () => {
    await batDau("925", BC);
    await ketThuc("925", RONG_HOP_LE, BC);
    await luiLuot("925", 40 * NGAY_MS);
    await batDau("926", BC);
    await ketThuc("926", KHONG_QUYEN, BC);
    await luotDu("927", 1, BC_B);
    expect(await prisma.rawTiktokBusinessInvoice.count({ where: { shopId: BC } })).toBe(0);

    expect(await cong()).toContain(`MẤT QUYỀN finance (BC ${BC})`);
  });

  it("BC từng đọc được rồi BIẾN MẤT (không còn dòng nào trong cửa sổ), BC kia đủ ⇒ CHẶN 'chưa có lượt'; đánh dấu không dùng ⇒ MỞ", async () => {
    await luotDu("930", 1, BC);
    await luiLuot("930", 40 * NGAY_MS);
    await luiHoaDonBc(BC, 40 * NGAY_MS);
    await luotDu("931", 1, BC_B);

    const ly = await cong();
    expect(ly).toContain(`BC ${BC} (chưa có lượt nào)`);
    expect(ly).toContain("đã từng đọc được hoá đơn");
    expect(ly).not.toContain(`BC ${BC_B}`);

    await danhDauKhongDung(BC);
    expect(await cong()).toBeNull();
  });

  it("BC có hoá đơn kho thô từ TRƯỚC khi có bảng bền (không dòng bảng, không SyncLog) biến mất ⇒ vẫn CHẶN — kho thô thay backfill", async () => {
    await luotDu("932", 1, BC);
    await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS", stats: { path: ["shopId"], equals: BC } } });
    await prisma.tiktokBcHoaDon.deleteMany({ where: { bcId: BC } });
    await luiHoaDonBc(BC, 40 * NGAY_MS);
    await luotDu("933", 1, BC_B);

    expect(await cong()).toContain(`BC ${BC} (chưa có lượt nào)`);
  });

  it("BC ĐÃ land hoá đơn nay thiếu quyền ⇒ CHẶN 'mất quyền finance'", async () => {
    await luotDu("904", 1, BC);
    await luiLuot("904", NGAY_MS);
    await batDau("905", BC);
    await ketThuc("905", KHONG_QUYEN, BC);

    const ly = await cong();
    expect(ly).toContain(`MẤT QUYỀN finance (BC ${BC})`);
    expect(ly).toContain("No access to finance");
  });

  it("BC từng có lượt đủ 0 hoá đơn (không land hoá đơn nào) nay thiếu quyền ⇒ vẫn CHẶN 'mất quyền finance'", async () => {
    await batDau("906", BC);
    await ketThuc("906", RONG_HOP_LE, BC);
    await luiLuot("906", NGAY_MS);
    await batDau("907", BC);
    await ketThuc("907", KHONG_QUYEN, BC);

    expect(await cong()).toContain(`MẤT QUYỀN finance (BC ${BC})`);
  });

  it("BC từng LAND hoá đơn trong cửa sổ nhưng KHÔNG có lượt đủ / sạch nào, nay thiếu quyền ⇒ vẫn CHẶN 'mất quyền' (BC kia đủ)", async () => {
    // Lượt hôm qua của BC: land được 1 trang hoá đơn rồi trang 2 lỗi 500 ⇒ không đủ, không sạch — chỉ còn dấu vết ở kho thô.
    await batDau("912", BC);
    expect((await guiTrang("912")).status).toBe(200);
    expect((await guiTrang("912", TRANG_LOI)).status).toBe(500);
    await ketThuc("912", du(2, { soTrangLand: 1, soTrangLoi: 1, soHoaDon: 1, hoanTat: false, ketQua: "loi", loi: ["500"] }));
    await luiLuot("912", NGAY_MS);
    expect(await prisma.rawTiktokBusinessInvoice.count({ where: { shopId: BC } })).toBeGreaterThan(0);
    await luotDu("913", 1, BC_B);
    await batDau("914", BC);
    await ketThuc("914", KHONG_QUYEN, BC);

    const ly = await cong();
    expect(ly).toContain(`MẤT QUYỀN finance (BC ${BC})`);
    expect(ly).not.toContain(BC_B);
  });

  it("mất quyền rồi cấp lại: lượt mới đủ ⇒ MỞ", async () => {
    await luotDu("908", 1, BC);
    await luiLuot("908", 2 * NGAY_MS);
    await batDau("909", BC);
    await ketThuc("909", KHONG_QUYEN, BC);
    await luiLuot("909", NGAY_MS);
    expect(await cong()).toContain("MẤT QUYỀN finance");

    await luotDu("910", 1, BC);
    expect(await cong()).toBeNull();
  });

  it("n8n khai thiếu quyền mà app có trang hoá đơn của chính lượt đó ⇒ CHẶN 'thiếu trang' (không khớp)", async () => {
    await batDau("911", BC);
    await guiTrang("911");
    await ketThuc("911", KHONG_QUYEN, BC);

    expect(await cong()).toContain("n8n khai thiếu quyền finance mà app có 1 trang hoá đơn của lượt");
  });
});

describe("cổng — chuyển tiếp: BC chưa có dấu lượt nào ⇒ luật cũ", () => {
  it("BC chưa có dấu: trang mang luotId, không dấu, lượt sạch ⇒ MỞ như trước (app lên trước workflow)", async () => {
    expect((await guiTrang("701")).status).toBe(200);
    expect(await cong()).toBeNull();
  });

  it("app đã nhận dấu (BC A đủ) ⇒ chế độ nghiêm cho MỌI BC: BC B chỉ có trang sạch, không dấu ⇒ CHẶN 'không có dấu bắt đầu'", async () => {
    await luotDu("702", 1, BC);
    expect((await guiTrang("703", trang(BC_B), BC_B)).status).toBe(200);

    const ly = await cong();
    expect(ly).toContain(`KHÔNG có dấu bắt đầu lượt (BC ${BC_B})`);
    expect(ly).not.toContain(`BC ${BC},`);
  });
});

describe("cổng — chế độ dấu lượt BỀN (không quay về luật cũ)", () => {
  it("app đã nhận dấu rồi SyncLog cũ bị dọn sạch; lượt mới chỉ có trang (luật cũ coi là sạch) ⇒ vẫn CHẶN 'không có dấu bắt đầu'", async () => {
    await luotDu("710", 1, BC);
    await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
    expect((await guiTrang("711")).status).toBe(200);

    expect(await cong()).toContain(`KHÔNG có dấu bắt đầu lượt (BC ${BC})`);
  });

  it("dấu cuối cùng cách > 30 ngày (rơi khỏi cửa sổ) ⇒ vẫn luật dấu lượt", async () => {
    await luotDu("712", 1, BC);
    await luiLuot("712", 40 * NGAY_MS);
    expect((await guiTrang("713")).status).toBe(200);

    expect(await cong()).toContain(`KHÔNG có dấu bắt đầu lượt (BC ${BC})`);
  });

  it("BC thiếu quyền CHƯA TỪNG đọc được, SyncLog cũ bị xoá hết (chỉ còn lanDauCoDau), BC kia đủ ⇒ CHẶN 'chưa xác nhận'", async () => {
    await batDau("715", BC_B);
    await ketThuc("715", KHONG_QUYEN, BC_B);
    await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
    await luotDu("716", 1, BC);

    const ly = await cong();
    expect(ly).toContain(`BC ${BC_B} (chưa có lượt nào — CHƯA XÁC NHẬN`);
    expect(ly).toContain("cấp vai trò finance");
    expect(ly).not.toContain(`BC ${BC} (`);

    await danhDauKhongDung(BC_B);
    expect(await cong()).toBeNull();
  });

  it("nghiêm mà cửa sổ không còn BC nào (chỉ dòng lạ không bc_id sạch) ⇒ CHẶN, KHÔNG rơi về luật cũ", async () => {
    await batDau("717", BC_B);
    await ketThuc("717", KHONG_QUYEN, BC_B);
    await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
    // Trang sạch đã dựng Silver nhưng KHÔNG mang bc_id (dòng ghi tay / dòng lạ) — luật cũ gom chung sẽ coi là sạch.
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_ADS",
        status: "OK",
        finishedAt: new Date(),
        stats: { stream: "tiktokbusiness/invoice", mode: "land+transform" },
      },
    });

    const ly = await cong();
    expect(ly).not.toBeNull();
    expect(ly).toContain(BC_B);
  });

  it("TRƯỚC dấu đầu tiên (bảng bền rỗng, không dấu trong cửa sổ) ⇒ luật cũ: trang sạch ⇒ MỞ", async () => {
    expect(await prisma.tiktokBcHoaDon.count()).toBe(0);
    expect((await guiTrang("714")).status).toBe(200);

    expect(await cong()).toBeNull();
  });
});

describe("/api/ingest/luot-hoa-don-tiktok — ghi nhận BC vào bảng bền", () => {
  it("bắt đầu ⇒ lanDauCoDau; kết thúc đọc được ⇒ lanCuoiDocDuoc; gửi lại cùng dấu giữ mốc đầu, một dòng, cổng không đổi", async () => {
    expect((await batDau("740")).status).toBe(200);
    const sauBatDau = await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC } });
    expect(sauBatDau.lanDauCoDau).not.toBeNull();
    expect(sauBatDau.lanCuoiDocDuoc).toBeNull();

    await guiTrang("740");
    expect((await ketThuc("740", du(1))).status).toBe(200);
    const sauKetThuc = await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC } });
    expect(sauKetThuc.lanDauCoDau).toEqual(sauBatDau.lanDauCoDau);
    expect(sauKetThuc.lanCuoiDocDuoc).not.toBeNull();
    expect(await cong()).toBeNull();

    // n8n thử lại đúng dấu kết thúc (timeout phía n8n sau khi app đã ghi) — bảng không đổi nghĩa.
    expect((await ketThuc("740", du(1))).status).toBe(200);
    const sauGuiLai = await prisma.tiktokBcHoaDon.findMany();
    expect(sauGuiLai).toHaveLength(1);
    expect(sauGuiLai[0].lanDauCoDau).toEqual(sauBatDau.lanDauCoDau);
    expect(sauGuiLai[0].lanCuoiDocDuoc).not.toBeNull();
    expect(sauGuiLai[0].lanCuoiDocDuoc!.getTime()).toBeGreaterThanOrEqual(sauKetThuc.lanCuoiDocDuoc!.getTime());
  });

  it("kết thúc thiếu quyền finance ⇒ có lanDauCoDau, KHÔNG lanCuoiDocDuoc; dấu không đụng xác nhận 'không dùng thẻ' của chủ shop", async () => {
    await danhDauKhongDung(BC_B);
    await batDau("741", BC_B);
    await ketThuc("741", KHONG_QUYEN, BC_B);

    const d = await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC_B } });
    expect(d.lanDauCoDau).not.toBeNull();
    expect(d.lanCuoiDocDuoc).toBeNull();
    expect(d.khongDungTu).not.toBeNull();
    expect(d.khongDungBoi).toBe("chu@test");
  });

  it("khuôn sai ⇒ 400, KHÔNG ghi bảng bền", async () => {
    expect((await guiDau({ luotId: "1", bcId: BC, giaiDoan: "giua-chung" })).status).toBe(400);
    expect(await prisma.tiktokBcHoaDon.count()).toBe(0);
  });
});

describe("cổng — BC đã đánh dấu 'không dùng thẻ' mà có hoá đơn tính vào dư nợ thẻ", () => {
  /** Ngày sao kê D (= hôm nay − 5, như `cong()`) lùi `n` ngày, dạng `create_time` TikTok (giờ VN). */
  const taoLucTruocD = (n: number) => `${khoaNgayVn(new Date(Date.now() - (5 + n) * NGAY_MS))} 15:38:00`;
  const batNoPhaiTra = () =>
    prisma.setting.create({
      data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: khoaNgayVn(new Date(Date.now() - 40 * NGAY_MS)) },
    });

  /** BC A đủ; BC B land 1 hoá đơn tạo ngày D − 1 rồi lượt mới nhất của B đứt (kết thúc `loi`). */
  async function bcBCoHoaDonVaLuotHong(): Promise<void> {
    await luotDu("950", 1, BC);
    await batDau("951", BC_B);
    expect((await guiTrang("951", trang(BC_B, taoLucTruocD(1)), BC_B)).status).toBe(200);
    await ketThuc("951", du(2, { soTrangLand: 1, soTrangLoi: 1, soHoaDon: 1, hoanTat: false, ketQua: "loi", loi: ["502"] }), BC_B);
    expect(await prisma.tiktokAdsHoaDon.count({ where: { bcId: BC_B } })).toBe(1);
  }

  it("BC B đánh dấu từ 20 ngày trước, có hoá đơn trừ tiền SAU mốc đó tới ngày chốt, lượt B hỏng ⇒ CHẶN, nêu BC B", async () => {
    await batNoPhaiTra();
    await bcBCoHoaDonVaLuotHong();
    await danhDauKhongDung(BC_B, new Date(Date.now() - 20 * NGAY_MS));

    const ly = await cong();
    expect(ly).toContain('đã đánh dấu "không dùng thẻ" nhưng có hoá đơn TikTok trừ tiền');
    expect(ly).toContain(`BC ${BC_B}: 1 hoá đơn`);
    expect(ly).toContain("bỏ đánh dấu");

    // Bỏ đánh dấu ⇒ cổng xét lại B ⇒ chặn vì lượt B hỏng.
    await boDanhDau(BC_B);
    expect(await cong()).toContain("kết thúc với LỖI");
  });

  it("hoá đơn của B tạo TRƯỚC mốc đánh dấu ⇒ không tính, B bỏ khỏi tập xét ⇒ MỞ", async () => {
    await batNoPhaiTra();
    await bcBCoHoaDonVaLuotHong();
    await danhDauKhongDung(BC_B);

    expect(await cong()).toBeNull();
  });
});
