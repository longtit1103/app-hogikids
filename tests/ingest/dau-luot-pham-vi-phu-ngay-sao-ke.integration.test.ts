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
 * Cổng chốt sao kê thẻ (luật dấu lượt) chỉ nhận lượt kéo hoá đơn TikTok làm bằng chứng cho ngày sao kê D khi PHẠM VI
 * THỜI GIAN n8n đã gửi TikTok (dấu lượt `phamVi`) PHỦ trọn D. Lượt đêm chỉ kéo vài ngày gần nhất — chạy thành công hôm
 * nay không có nghĩa là còn phủ D. Route THẬT + DB thật + cổng THẬT.
 *
 * Giờ thật: D = hôm nay − 5 ⇒ D+2 đã qua.
 */

const BC = "7129545797879726081";
const ADV = "7129548444015902722";
const NGAY_MS = 24 * 3600 * 1000;
const D = khoaNgayVn(new Date(Date.now() - 5 * NGAY_MS));
const ngayLech = (n: number) => khoaNgayVn(new Date(Date.parse(`${D}T00:00:00+07:00`) + n * NGAY_MS));
const ngayNgan = (k: string) => `${k.slice(8, 10)}/${k.slice(5, 7)}`;

/** Phủ D: 40 ngày tới 00:00 hôm nay (cửa sổ kéo bù). */
const PHU_D = phamViLui(40, 0);
/** Cửa sổ đêm đã trôi qua D: bắt đầu 00:00 D+1. */
const KHONG_PHU_D = phamViLui(4, 0);

let soHoaDon = 0;
const trang = () => {
  soHoaDon += 1;
  return (
    `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"TXP-${soHoaDon}","transaction_type":` +
    `"BILL_PAYMENT","billing_type":"CASH","amount_type":"POSITIVE","account_id":"${ADV}","bc_id":"${BC}",` +
    `"subtotal":130000,"tax_amount":13000,"amount":143000,"currency":"VND","create_time":"${D} 15:38:00",` +
    `"timezone":"UTC+07:00"}],"page_info":{"total_page":1}}}`
  );
};
const goi = (handler: (req: Request) => Promise<Response>, url: string, body: unknown) =>
  handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    }),
  );
const guiDau = (body: Record<string, unknown>) => goi(postDauLuot, "http://localhost/api/ingest/luot-hoa-don-tiktok", body);
const guiTrang = (luotId: string) =>
  goi(postRaw, "http://localhost/api/ingest/raw", { stream: "tiktokbusiness/invoice", shopId: BC, payload: trang(), luotId });

const DU_1 = {
  tongTrangNguon: 1, tongHoaDonNguon: 1, soTrangDaGet: 1, soTrangLand: 1, soTrangRong: 0, soTrangLoi: 0, soHoaDon: 1,
  hoanTat: true, ketQua: "xong", loi: [],
};
const LOI_TRANG_1 = {
  tongTrangNguon: null, tongHoaDonNguon: null, soTrangDaGet: 0, soTrangLand: 0, soTrangRong: 0, soTrangLoi: 0,
  soHoaDon: 0, hoanTat: false, ketQua: "loi", loi: ["ETIMEDOUT business-api.tiktok.com"],
};
const KHONG_QUYEN = {
  ...LOI_TRANG_1,
  ketQua: "khong-quyen-finance",
  loi: ["TIKTOK_ADS lỗi: code 40002 — No access to finance of this bc"],
};
const coPhamVi = (phamVi: unknown) => (phamVi === null ? {} : { phamVi });

/** Lượt đủ 1 trang với phạm vi `phamVi` (null = dấu bản cũ không mang phạm vi). */
async function luotDu(luotId: string, phamVi: unknown, phamViKetThuc: unknown = phamVi): Promise<void> {
  expect((await guiDau({ luotId, bcId: BC, giaiDoan: "bat-dau", ...coPhamVi(phamVi) })).status).toBe(200);
  expect((await guiTrang(luotId)).status).toBe(200);
  expect((await guiDau({ luotId, bcId: BC, giaiDoan: "ket-thuc", ...coPhamVi(phamViKetThuc), ...DU_1 })).status).toBe(200);
}
/** Lượt hỏng ngay trang 1 (dấu bắt đầu gửi trước GET nên vẫn mang phạm vi). */
async function luotHong(luotId: string, phamVi: unknown): Promise<void> {
  expect((await guiDau({ luotId, bcId: BC, giaiDoan: "bat-dau", ...coPhamVi(phamVi) })).status).toBe(200);
  expect((await guiDau({ luotId, bcId: BC, giaiDoan: "ket-thuc", ...coPhamVi(phamVi), ...LOI_TRANG_1 })).status).toBe(200);
}
/** Lượt chết giữa chừng: chỉ dấu bắt đầu. */
async function luotChetGiuaChung(luotId: string, phamVi: unknown): Promise<void> {
  expect((await guiDau({ luotId, bcId: BC, giaiDoan: "bat-dau", ...coPhamVi(phamVi) })).status).toBe(200);
}

/** Dời mọi dòng của lượt về `truocMs` trước (lượt chạy hôm trước). */
async function luiLuot(luotId: string, truocMs: number): Promise<void> {
  const luc = new Date(Date.now() - truocMs);
  await prisma.syncLog.updateMany({
    where: { kind: "TIKTOK_ADS", stats: { path: ["luotId"], equals: luotId } },
    data: { startedAt: luc, finishedAt: luc },
  });
}

const cong = (ngaySaoKe = D) => lyDoHoaDonTiktokChuaDu(prisma, ngaySaoKe, khoaNgayVn(new Date()));

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

describe("bằng chứng phải PHỦ ngày sao kê D", () => {
  it("các lượt phủ D đều hỏng, lượt mới thành công nhưng phạm vi đã trôi qua D ⇒ VẪN CHẶN, câu có BC/D/hướng dẫn kéo bù; kéo bù đủ phủ D ⇒ QUA", async () => {
    await luotHong("2001", PHU_D);
    await luiLuot("2001", 3 * NGAY_MS);
    await luotChetGiuaChung("2002", PHU_D);
    await luiLuot("2002", 2 * NGAY_MS);
    await luotDu("2003", KHONG_PHU_D);

    const lyDo = await cong();
    expect(lyDo).toContain(`PHỦ ngày sao kê ${ngayNgan(D)}`);
    expect(lyDo).toContain(`BC ${BC}`);
    expect(lyDo).toContain("KÉO BÙ");
    expect(lyDo).toContain(`\`tiktokBusinessHoaDonTuNgay\` = "${ngayLech(-1)}"`);
    expect(lyDo).toContain("n8n/huong-dan-cai-dat-workflows.md");

    // Lượt kéo bù (phạm vi phủ D, đủ trang) ⇒ QUA.
    await luotDu("2004", PHU_D);
    expect(await cong()).toBeNull();
    // Đêm sau lượt thường (không còn phủ D) vẫn đủ ⇒ bằng chứng kéo bù vẫn đứng.
    await luotDu("2005", KHONG_PHU_D);
    expect(await cong()).toBeNull();
  });

  it("không lượt nào từng phủ D, lượt mới nhất đủ ⇒ CHẶN, nói phạm vi lượt gần nhất đã phủ + kéo bù", async () => {
    await luotDu("2101", KHONG_PHU_D);

    const lyDo = await cong();
    expect(lyDo).toContain(`ĐỦ nào phủ trọn ngày sao kê ${ngayNgan(D)}`);
    expect(lyDo).toContain(`lượt gần nhất chỉ phủ ${KHONG_PHU_D.startTime} → ${KHONG_PHU_D.endTime} (UTC+07:00)`);
    expect(lyDo).toContain("KÉO BÙ");
  });

  it("lượt phủ D SAU CÙNG hỏng ⇒ lượt phủ D đủ cũ hơn KHÔNG che", async () => {
    await luotDu("2201", PHU_D);
    await luiLuot("2201", 2 * NGAY_MS);
    await luotHong("2202", PHU_D);
    await luiLuot("2202", 1 * NGAY_MS);
    await luotDu("2203", KHONG_PHU_D);

    expect(await cong()).toContain(`PHỦ ngày sao kê ${ngayNgan(D)} không đủ`);
  });

  it("lượt đủ phủ D nhưng bắt đầu < D+2 ⇒ CHẶN (luật cũ D+2 giữ nguyên)", async () => {
    await luotDu("2301", PHU_D);
    await luiLuot("2301", 4 * NGAY_MS); // ≈ D+1
    expect(await cong()).toContain("Chưa có lượt kéo hoá đơn TikTok sau ngày chốt");
  });

  it("lượt đủ phủ D bắt đầu < D+2, lượt mới (≥ D+2) đủ nhưng không phủ D ⇒ CHẶN kèm kéo bù (đợi lượt đêm vô ích)", async () => {
    await luotDu("2401", PHU_D);
    await luiLuot("2401", 4 * NGAY_MS);
    await luotDu("2402", KHONG_PHU_D);
    const lyDo = await cong();
    expect(lyDo).toContain("ĐỦ nào phủ trọn");
    expect(lyDo).toContain("KÉO BÙ");
  });
});

describe("biên vị từ lỏng/chặt + câu hướng dẫn đúng thuốc", () => {
  it("lượt HỎNG start 'D 00:00:00' (chỉ phủ D nếu nguồn hiểu giờ VN) sau lượt đủ phủ chặt ⇒ CHẶN, lượt cũ không che", async () => {
    await luotDu("3001", PHU_D);
    await luiLuot("3001", 2 * NGAY_MS);
    await luotHong("3002", { ...PHU_D, startTime: `${D} 00:00:00` });
    await luiLuot("3002", 1 * NGAY_MS);
    await luotDu("3003", KHONG_PHU_D);

    expect(await cong()).toContain(`PHỦ ngày sao kê ${ngayNgan(D)} không đủ`);
  });

  it("lượt phủ D sau cùng bị từ chối vì thiếu quyền finance ⇒ CHẶN, hướng dẫn cấp quyền finance TRƯỚC (không chỉ kéo bù)", async () => {
    expect((await guiDau({ luotId: "3101", bcId: BC, giaiDoan: "bat-dau", phamVi: PHU_D })).status).toBe(200);
    expect((await guiDau({ luotId: "3101", bcId: BC, giaiDoan: "ket-thuc", phamVi: PHU_D, ...KHONG_QUYEN })).status).toBe(200);
    await luiLuot("3101", 1 * NGAY_MS);
    await luotDu("3102", KHONG_PHU_D);

    const lyDo = await cong();
    expect(lyDo).toContain("THIẾU QUYỀN finance");
    expect(lyDo).toContain("TRƯỚC HẾT cấp (hoặc kiểm lại) vai trò finance");
    expect(lyDo).toContain('"không dùng thẻ"');
  });

  it("D − 1 quá trần kéo bù 60 ngày ⇒ CHẶN, nói chốt bằng form tay, KHÔNG khuyên đặt khoá kéo bù", async () => {
    await luotDu("3201", KHONG_PHU_D);
    const xa = khoaNgayVn(new Date(Date.now() - 70 * NGAY_MS));
    const lyDo = await cong(xa);
    expect(lyDo).toContain("quá trần kéo bù 60 ngày");
    expect(lyDo).toContain("form chốt tay");
    expect(lyDo).not.toContain("tiktokBusinessHoaDonTuNgay");
  });

  it("D − 1 đúng 60 ngày trước hôm nay ⇒ vẫn khuyên kéo bù (biên trần)", async () => {
    await luotDu("3301", KHONG_PHU_D);
    const bien = khoaNgayVn(new Date(Date.now() - 59 * NGAY_MS));
    const lyDo = await cong(bien);
    expect(lyDo).toContain("KÉO BÙ");
    expect(lyDo).toContain("tiktokBusinessHoaDonTuNgay");
  });
});

describe("dấu thiếu / sai phạm vi", () => {
  it.each<[string, Record<string, unknown>]>([
    ["múi khác", { ...PHU_D, muiGio: "UTC+00:00" }],
    ["giờ sai khuôn", { ...PHU_D, endTime: "hôm nay" }],
    ["bắt đầu sau kết thúc", { ...PHU_D, startTime: PHU_D.endTime, endTime: PHU_D.startTime }],
    ["khoá lạ", { ...PHU_D, tz: "VN" }],
  ])("phamVi %s ⇒ 400, KHÔNG ghi dòng nào", async (_ca, phamVi) => {
    const res = await guiDau({ luotId: "2501", bcId: BC, giaiDoan: "bat-dau", phamVi });
    expect(res.status).toBe(400);
    expect(await prisma.syncLog.count({ where: { kind: "TIKTOK_ADS" } })).toBe(0);
  });

  it("dấu VẮNG phạm vi (workflow bản cũ) ⇒ route nhận nhưng lượt KHÔNG là bằng chứng ⇒ CHẶN", async () => {
    await luotDu("2601", null);
    const d = await prisma.syncLog.findFirstOrThrow({ where: { stats: { path: ["giaiDoan"], equals: "bat-dau" } } });
    expect(d.status).toBe("OK");
    expect(await cong()).toContain("không mang phạm vi thời gian");
  });

  it("phạm vi lưu ở cả dòng dấu bắt đầu lẫn kết thúc; kết thúc khai khác bắt đầu ⇒ CHẶN (không khớp)", async () => {
    await luotDu("2701", PHU_D);
    const dong = await prisma.syncLog.findMany({ where: { stats: { path: ["luotId"], equals: "2701" } } });
    const dau = dong.filter((x) => ["luot-bat-dau", "luot-ket-thuc"].includes(String((x.stats as { mode?: unknown }).mode)));
    expect(dau).toHaveLength(2);
    for (const x of dau) expect((x.stats as { phamVi?: unknown }).phamVi).toEqual(PHU_D);
    expect(await cong()).toBeNull();

    await cleanup();
    await luotDu("2702", PHU_D, phamViLui(39, 0));
    expect(await cong()).toContain("phạm vi thời gian dấu kết thúc khác dấu bắt đầu");
  });
});

describe("biên múi giờ (D theo giờ VN; nguồn có thể hiểu chuỗi theo UTC)", () => {
  const pv = (startTime: string, endTime: string) => ({ startTime, endTime, muiGio: "UTC+07:00" });
  it.each<[string, ReturnType<typeof pv>, boolean]>([
    ["kết thúc đúng 00:00 D+1", pv(`${ngayLech(-1)} 00:00:00`, `${ngayLech(1)} 00:00:00`), true],
    ["kết thúc D 23:59:59", pv(`${ngayLech(-1)} 00:00:00`, `${D} 23:59:59`), false],
    ["bắt đầu 00:00 D (nguồn hiểu UTC ⇒ hụt 7 tiếng đầu D)", pv(`${D} 00:00:00`, `${ngayLech(2)} 00:00:00`), false],
    ["bắt đầu 17:00 D−1 (= 00:00 D giờ VN nếu nguồn hiểu UTC)", pv(`${ngayLech(-1)} 17:00:00`, `${ngayLech(2)} 00:00:00`), true],
  ])("%s ⇒ phủ = %s", async (_ca, phamVi, phu) => {
    await luotDu("2801", phamVi);
    const lyDo = await cong();
    if (phu) expect(lyDo).toBeNull();
    else expect(lyDo).toContain("KÉO BÙ");
  });
});
