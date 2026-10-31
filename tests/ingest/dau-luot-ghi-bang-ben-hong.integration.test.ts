import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

/** Bật thì lần ghi bảng bền kế tiếp ném — giả lập DB lỗi giữa chừng (khoá, mất kết nối…). */
const hong = vi.hoisted(() => ({ bat: false }));
vi.mock("@/lib/no-phai-tra/bc-tiktok-hoa-don", async (goc) => {
  const that = await goc<typeof import("@/lib/no-phai-tra/bc-tiktok-hoa-don")>();
  return {
    ...that,
    ghiNhanDauBcTiktok: async (...thamSo: Parameters<typeof that.ghiNhanDauBcTiktok>) => {
      if (hong.bat) throw new Error("ghi bảng bền hỏng (giả lập)");
      return that.ghiNhanDauBcTiktok(...thamSo);
    },
  };
});

import { POST as postDauLuot } from "@/app/api/ingest/luot-hoa-don-tiktok/route";
import { POST as postRaw } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { lyDoHoaDonTiktokChuaDu } from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Route dấu lượt ghi bảng bền `TiktokBcHoaDon` HỎNG ⇒ fail-closed: HTTP 500, dòng dấu `SyncLog` ERROR (còn mang
 * stream/BC/mode nhờ `dauNhanDien`), cổng chốt sao kê CHẶN. Nuốt lỗi ghi bảng thì dấu vẫn OK, cổng mở như thường hôm
 * nay nhưng bảng bền im lặng thiếu ⇒ sau 30 ngày mất trí nhớ chế độ nghiêm / BC từng đọc được.
 */

const BC = "7129545797879726081";
const ADV = "7129548444015902722";
const NGAY_MS = 24 * 3600 * 1000;

const goi = (handler: (req: Request) => Promise<Response>, url: string, body: unknown) =>
  handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    }),
  );
const guiDau = (body: unknown) => goi(postDauLuot, "http://localhost/api/ingest/luot-hoa-don-tiktok", body);
const trang =
  `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"TXH-1","transaction_type":"BILL_PAYMENT",` +
  `"billing_type":"CASH","amount_type":"POSITIVE","account_id":"${ADV}","bc_id":"${BC}","subtotal":130000,` +
  `"tax_amount":13000,"amount":143000,"currency":"VND","create_time":"2026-10-23 15:38:00","timezone":"UTC+07:00"}],` +
  `"page_info":{"total_page":1}}}`;
const KET_THUC_DU = {
  tongTrangNguon: 1, tongHoaDonNguon: 1, soTrangDaGet: 1, soTrangLand: 1, soTrangRong: 0, soTrangLoi: 0, soHoaDon: 1,
  hoanTat: true, ketQua: "xong", loi: [],
};
const cong = () => lyDoHoaDonTiktokChuaDu(prisma, khoaNgayVn(new Date(Date.now() - 5 * NGAY_MS)), khoaNgayVn(new Date()));

async function cleanup(): Promise<void> {
  hong.bat = false;
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

describe("route dấu lượt — ghi bảng bền hỏng ⇒ fail-closed", () => {
  it("dấu bắt đầu ghi bảng hỏng ⇒ 500, dòng dấu ERROR giữ BC/mode, bảng không có dòng, cổng CHẶN dù trang + kết thúc đủ", async () => {
    hong.bat = true;
    const res = await guiDau({ luotId: "1201", bcId: BC, giaiDoan: "bat-dau" });
    hong.bat = false;

    expect(res.status).toBe(500);
    const d = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" } });
    expect(d.status).toBe("ERROR");
    expect(d.stats).toMatchObject({ stream: "tiktokbusiness/invoice", shopId: BC, mode: "luot-bat-dau", luotId: "1201" });
    expect(await prisma.tiktokBcHoaDon.count()).toBe(0);

    expect((await goi(postRaw, "http://localhost/api/ingest/raw", { stream: "tiktokbusiness/invoice", shopId: BC, payload: trang, luotId: "1201" })).status).toBe(200);
    expect((await guiDau({ luotId: "1201", bcId: BC, giaiDoan: "ket-thuc", ...KET_THUC_DU })).status).toBe(200);

    expect(await cong()).toContain("dấu bắt đầu ghi lỗi");
  });

  it("dấu kết thúc ghi bảng hỏng ⇒ 500, dòng kết thúc ERROR, cổng CHẶN", async () => {
    expect((await guiDau({ luotId: "1202", bcId: BC, giaiDoan: "bat-dau" })).status).toBe(200);
    expect((await goi(postRaw, "http://localhost/api/ingest/raw", { stream: "tiktokbusiness/invoice", shopId: BC, payload: trang, luotId: "1202" })).status).toBe(200);
    hong.bat = true;
    const res = await guiDau({ luotId: "1202", bcId: BC, giaiDoan: "ket-thuc", ...KET_THUC_DU });
    hong.bat = false;

    expect(res.status).toBe(500);
    const kt = await prisma.syncLog.findFirstOrThrow({ where: { stats: { path: ["giaiDoan"], equals: "ket-thuc" } } });
    expect(kt.status).toBe("ERROR");
    expect((await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC } })).lanCuoiDocDuoc).toBeNull();
    expect(await cong()).toContain("kết thúc với LỖI");
  });
});
