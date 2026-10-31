import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

// Công tắc cho transform CHẾT ở mức batch (vd DB chập giữa chừng) — không bật thì chạy bản THẬT.
const dieuKhien = vi.hoisted(() => ({ loiLanToi: null as Error | null }));

vi.mock("@/lib/bronze/transform-from-raw", async (importOriginal) => {
  const goc = await importOriginal<typeof import("@/lib/bronze/transform-from-raw")>();
  const transformFromRaw: typeof goc.transformFromRaw = async (...args) => {
    if (dieuKhien.loiLanToi) {
      const err = dieuKhien.loiLanToi;
      dieuKhien.loiLanToi = null; // chỉ chết một lần
      throw err;
    }
    return goc.transformFromRaw(...args);
  };
  return { ...goc, transformFromRaw };
});

import { POST } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { lyDoHoaDonTiktokChuaDu } from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Trang hoá đơn TikTok Business làm route `/api/ingest/raw` ném 500 (land hoặc transform hỏng) PHẢI để lại dòng
 * SyncLog ERROR mang `stats.stream` + `stats.shopId` (bc_id) + `stats.mode` — cổng chốt sao kê thẻ
 * (`lyDoHoaDonTiktokChuaDu`) lọc trang hoá đơn theo `stats.stream` rồi quy về BC theo `stats.shopId`. Dòng 500 thiếu
 * dấu thì cổng không thấy trang hỏng: hoá đơn của BC đó có thể thiếu mà sao kê vẫn chốt được (đòi trả thiếu).
 *
 * Mốc thời gian dùng giờ THẬT (dòng SyncLog do route tạo mang giờ thật): ngày sao kê = hôm nay − 5 ⇒ D+2 đã qua.
 */

const BC = "7129545797879726081";
const BC_HAI = "7200000000000000002";
const ADV = "7129548444015902722";
const STREAM = "tiktokbusiness/invoice";
const NGAY_MS = 24 * 3600 * 1000;

const trang = (id: string, bcId = BC) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"${id}","transaction_type":"BILL_PAYMENT",` +
  `"billing_type":"CASH","amount_type":"POSITIVE","account_id":"${ADV}","bc_id":"${bcId}","subtotal":130000,` +
  `"tax_amount":13000,"amount":143000,"currency":"VND","create_time":"2026-10-23 15:38:00","timezone":"UTC+07:00"}],` +
  `"page_info":{"total_page":1}}}`;

const post = (shopId: string, payload: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: STREAM, shopId, payload }),
    }),
  );

const dongLoiMoiNhat = () =>
  prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS", status: "ERROR" }, orderBy: { startedAt: "desc" } });

/** Ngày sao kê + hôm nay cho cổng: D = hôm nay − 5 (giờ VN) ⇒ điều kiện "hôm nay ≥ D+2" đã thoả. */
const ngayCong = () => ({ ngaySaoKe: khoaNgayVn(new Date(Date.now() - 5 * NGAY_MS)), homNay: khoaNgayVn(new Date()) });

const GIO_MS = 3600 * 1000;

/**
 * BC đã land hoá đơn hôm qua + có một trang OK `land+transform` `truocMs` trước (vẫn sau D+2) ⇒ cổng mở cho BC đó.
 * Cổng gom trang thành lượt kéo (cách nhau < 30' = cùng lượt): muốn trang sau thuộc lượt KHÁC thì đặt lượt OK lùi xa.
 */
async function bcCoLuotOk(bcId: string, truocMs = 60_000): Promise<void> {
  await prisma.rawTiktokBusinessInvoice.create({
    data: {
      shopId: bcId,
      externalId: `tx-${bcId}`,
      payloadHash: `h-${bcId}`,
      payload: { transaction_id: `tx-${bcId}` },
      fetchedAt: new Date(Date.now() - NGAY_MS),
    },
  });
  const luc = new Date(Date.now() - truocMs);
  await prisma.syncLog.create({
    data: {
      kind: "TIKTOK_ADS",
      status: "OK",
      startedAt: luc,
      finishedAt: luc,
      stats: { stream: STREAM, shopId: bcId, landed: 0, mode: "land+transform", warnings: [] },
    },
  });
}

async function cleanup(): Promise<void> {
  dieuKhien.loiLanToi = null;
  // Bảng bền trạng thái BC (chế độ dấu lượt, BC từng đọc được) — sót lại từ file test khác là đổi luật cổng.
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

describe("/api/ingest/raw — nhánh 500 giữ dấu stream/BC trên SyncLog ERROR", () => {
  it("transform hoá đơn ném giữa chừng ⇒ 500, dòng ERROR mang stream + shopId (bc_id) + mode loi-transform", async () => {
    dieuKhien.loiLanToi = new Error("DB chập giữa transform");
    const res = await post(BC, trang("TX-500"));

    expect(res.status).toBe(500);
    const log = await dongLoiMoiNhat();
    expect(log.error).toBe("DB chập giữa transform");
    expect(log.stats).toMatchObject({ stream: STREAM, shopId: BC, mode: "loi-transform" });
  });

  it("land hoá đơn ném (envelope lỗi, không có mảng) ⇒ 500, dòng ERROR mang stream + shopId + mode loi-land", async () => {
    const res = await post(BC, `{"code":40100,"message":"rate limit","data":{}}`);

    expect(res.status).toBe(500);
    const log = await dongLoiMoiNhat();
    expect(log.error).toMatch(/không có mảng/);
    expect(log.stats).toMatchObject({ stream: STREAM, shopId: BC, mode: "loi-land" });
  });

  it("trang OK thì mode của kết quả đè dấu 'dang-xu-ly' của dòng RUNNING (đối chứng)", async () => {
    const res = await post(BC, trang("TX-OK"));

    expect(res.status).toBe(200);
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("OK");
    expect(log.stats).toMatchObject({ stream: STREAM, shopId: BC, mode: "land+transform" });
  });
});

describe("cổng chốt sao kê thẻ thấy trang hoá đơn ném 500 — theo đúng BC", () => {
  it("2 BC kéo OK, rồi trang hoá đơn của BC này ném 500 ⇒ CHẶN, câu lý do nêu đúng BC này (không nêu BC kia)", async () => {
    await bcCoLuotOk(BC, 3 * GIO_MS);
    await bcCoLuotOk(BC_HAI, 3 * GIO_MS);
    const { ngaySaoKe, homNay } = ngayCong();
    expect(await lyDoHoaDonTiktokChuaDu(prisma, ngaySaoKe, homNay)).toBeNull();

    // Lỗi land: KHÔNG bật cờ backlog ⇒ chỉ dòng ERROR mới cho cổng biết trang này hỏng.
    const res = await post(BC, `{"code":40100,"message":"rate limit","data":{}}`);
    expect(res.status).toBe(500);
    // Lượt chứa trang lỗi coi như chạy 2 giờ trước ⇒ lần kéo lại ngay dưới đây là một lượt MỚI.
    const loi = await dongLoiMoiNhat();
    await prisma.syncLog.update({ where: { id: loi.id }, data: { startedAt: new Date(Date.now() - 2 * GIO_MS) } });

    const lyDo = await lyDoHoaDonTiktokChuaDu(prisma, ngaySaoKe, homNay);
    expect(lyDo).toContain(`mới nhất có trang LỖI (BC ${BC})`);
    expect(lyDo).not.toContain(BC_HAI);

    // Lượt kéo lại chạy hết không lỗi ⇒ mở.
    expect((await post(BC, trang("TX-KEO-LAI"))).status).toBe(200);
    expect(await lyDoHoaDonTiktokChuaDu(prisma, ngaySaoKe, homNay)).toBeNull();
  });

  it("trang hoá đơn LỖI không quy được BC (thiếu shopId) ⇒ CHẶN toàn cục, nói rõ không xác định được BC", async () => {
    await bcCoLuotOk(BC, 3 * GIO_MS);
    await bcCoLuotOk(BC_HAI, 3 * GIO_MS);
    const { ngaySaoKe, homNay } = ngayCong();
    const luc = new Date(Date.now() - 2 * GIO_MS);
    await prisma.syncLog.create({
      data: { kind: "TIKTOK_ADS", status: "ERROR", startedAt: luc, finishedAt: luc, stats: { stream: STREAM, mode: "loi-land" } },
    });

    expect(await lyDoHoaDonTiktokChuaDu(prisma, ngaySaoKe, homNay)).toContain("không xác định được BC");

    // Một BC kéo OK sau trang lỗi chưa đủ (trang lỗi có thể là của BC kia) ⇒ vẫn chặn.
    expect((await post(BC, trang("TX-BC1"))).status).toBe(200);
    expect(await lyDoHoaDonTiktokChuaDu(prisma, ngaySaoKe, homNay)).toContain("không xác định được BC");

    // Mọi BC đều có lượt sạch bắt đầu sau trang lỗi ⇒ mở.
    expect((await post(BC_HAI, trang("TX-BC2", BC_HAI))).status).toBe(200);
    expect(await lyDoHoaDonTiktokChuaDu(prisma, ngaySaoKe, homNay)).toBeNull();
  });

  it("trang hoá đơn RUNNING (tiến trình chết giữa chừng, chưa được dọn thành ERROR) sau lượt OK ⇒ CHẶN", async () => {
    await bcCoLuotOk(BC);
    const { ngaySaoKe, homNay } = ngayCong();
    await prisma.syncLog.create({
      data: { kind: "TIKTOK_ADS", status: "RUNNING", stats: { stream: STREAM, shopId: BC, mode: "dang-xu-ly" } },
    });

    expect(await lyDoHoaDonTiktokChuaDu(prisma, ngaySaoKe, homNay)).toContain(`mới nhất có trang CHƯA XONG (BC ${BC})`);
  });
});
