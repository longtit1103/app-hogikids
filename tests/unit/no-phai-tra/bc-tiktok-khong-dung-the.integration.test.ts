import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));

import { POST as postDauLuot } from "@/app/api/ingest/luot-hoa-don-tiktok/route";
import { POST as postRaw } from "@/app/api/ingest/raw/route";
import { boDanhDauBcTiktokKhongDung, danhDauBcTiktokKhongDung } from "@/lib/actions/bc-tiktok-hoa-don";
import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { docDanhSachBcTiktok } from "@/lib/no-phai-tra/bc-tiktok-hoa-don";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { lyDoHoaDonTiktokChuaDu } from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";
import { prisma } from "@/lib/prisma";
import { DANH_MUC_QUYEN } from "@/lib/quyen/danh-muc-quyen";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { phamViLui } from "../../helpers/pham-vi-dau-luot";

/**
 * Chủ shop xác nhận Business Center TikTok "không dùng thẻ" (`danhDauBcTiktokKhongDung` / `boDanhDauBcTiktokKhongDung`)
 * trên DB thật, dấu lượt + trang hoá đơn qua route THẬT, hỏi cổng chốt sao kê THẬT. BC A đọc được hoá đơn (lượt đủ),
 * BC B TikTok báo thiếu quyền finance và chưa từng đọc được ⇒ cổng CHẶN "chưa xác nhận" tới khi chủ shop đánh dấu B.
 */

const BC_A = "7129545797879726081";
const BC_B = "7200000000000000002";
const BC_KHO_THO = "7300000000000000003";
const ADV = "7129548444015902722";
const NGAY_MS = 24 * 3600 * 1000;
const CHU = nguoiDungGia({ id: "chu-1", email: "chu@hogikids.test" });
const PHU_DU_QUYEN = nguoiDungGia({ id: "phu-1", email: "phu@hogikids.test", role: "STAFF", quyen: new Set(DANH_MUC_QUYEN) });
const MA_NHAT_KY = ["BC_TIKTOK_DANH_DAU_KHONG_DUNG", "BC_TIKTOK_BO_DANH_DAU_KHONG_DUNG", "TU_CHOI_QUYEN"];

/** Hoá đơn tạo 2 ngày trước (giờ VN) — luôn nằm trong 30 ngày gần nhất, bất kể ngày chạy test. */
const TAO_LUC = `${khoaNgayVn(new Date(Date.now() - 2 * NGAY_MS))} 15:38:00`;
const BC_CHI_NHAT_KY = "7400000000000000004";
const TRANG_LOI = `{"code":40100,"message":"rate limit","data":{}}`;
let soHoaDon = 0;
const trang = (bc: string) => {
  soHoaDon += 1;
  return (
    `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"TXK-${soHoaDon}","transaction_type":` +
    `"BILL_PAYMENT","billing_type":"CASH","amount_type":"POSITIVE","account_id":"${ADV}","bc_id":"${bc}",` +
    `"subtotal":130000,"tax_amount":13000,"amount":143000,"currency":"VND","create_time":"${TAO_LUC}",` +
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
const guiDau = (body: unknown) => goi(postDauLuot, "http://localhost/api/ingest/luot-hoa-don-tiktok", body);
const guiTrang = (luotId: string, bc: string, payload = trang(bc)) =>
  goi(postRaw, "http://localhost/api/ingest/raw", { stream: "tiktokbusiness/invoice", shopId: bc, payload, luotId });

async function luotDu(luotId: string, bcId: string): Promise<void> {
  expect((await guiDau({ luotId, bcId, giaiDoan: "bat-dau", phamVi: phamViLui() })).status).toBe(200);
  expect((await guiTrang(luotId, bcId)).status).toBe(200);
  const soLieu = {
    tongTrangNguon: 1, tongHoaDonNguon: 1, soTrangDaGet: 1, soTrangLand: 1, soTrangRong: 0, soTrangLoi: 0,
    soHoaDon: 1, hoanTat: true, ketQua: "xong", loi: [],
  };
  expect((await guiDau({ luotId, bcId, giaiDoan: "ket-thuc", phamVi: phamViLui(), ...soLieu })).status).toBe(200);
}
async function luotKhongQuyen(luotId: string, bcId: string): Promise<void> {
  expect((await guiDau({ luotId, bcId, giaiDoan: "bat-dau", phamVi: phamViLui() })).status).toBe(200);
  const soLieu = {
    tongTrangNguon: null, tongHoaDonNguon: null, soTrangDaGet: 0, soTrangLand: 0, soTrangRong: 0, soTrangLoi: 0,
    soHoaDon: 0, hoanTat: false, ketQua: "khong-quyen-finance", loi: ["TIKTOK_ADS lỗi: code 40002 — No access to finance of this bc"],
  };
  expect((await guiDau({ luotId, bcId, giaiDoan: "ket-thuc", phamVi: phamViLui(), ...soLieu })).status).toBe(200);
}

const cong = () => lyDoHoaDonTiktokChuaDu(prisma, khoaNgayVn(new Date(Date.now() - 5 * NGAY_MS)), khoaNgayVn(new Date()));
const nhatKy = () =>
  prisma.auditLog.findMany({ where: { hanhDong: { in: MA_NHAT_KY } }, orderBy: { thoiDiem: "asc" } });

async function cleanup(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.tiktokBcHoaDon.deleteMany();
  await prisma.tiktokAdsHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await prisma.auditLog.deleteMany({ where: { hanhDong: { in: MA_NHAT_KY } } });
  await clearBronzeBacklog();
}

beforeEach(async () => {
  await cleanup();
  vi.mocked(docNguoiDungPhien).mockReset().mockResolvedValue(CHU);
  await luotDu("1001", BC_A);
  await luotKhongQuyen("1001", BC_B);
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("đánh dấu BC không dùng thẻ — chỉ chủ shop", () => {
  it("tài khoản phụ đủ mọi quyền cấp được ⇒ KHONG_CO_QUYEN, không ghi bảng, nhật ký từ chối", async () => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(PHU_DU_QUYEN);

    expect(await danhDauBcTiktokKhongDung({ bcId: BC_B })).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await boDanhDauBcTiktokKhongDung(BC_B)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });

    expect((await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC_B } })).khongDungTu).toBeNull();
    const nk = await nhatKy();
    expect(nk.map((d) => [d.hanhDong, d.ketQua, d.actorId])).toEqual([
      ["TU_CHOI_QUYEN", "LOI", "phu-1"],
      ["TU_CHOI_QUYEN", "LOI", "phu-1"],
    ]);
    expect(await cong()).toContain(`CHƯA XÁC NHẬN (BC ${BC_B})`);
  });

  it("chủ shop đánh dấu ⇒ ghi mốc + người xác nhận + nhật ký, cổng MỞ; đánh dấu lại ⇒ không đổi gì (idempotent)", async () => {
    expect(await cong()).toContain(`CHƯA XÁC NHẬN (BC ${BC_B})`);

    const r = await danhDauBcTiktokKhongDung({ bcId: BC_B, ghiChu: "BC cũ của agency" });
    expect(r).toEqual({ ok: true, data: { daDoi: true } });
    const d = await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC_B } });
    expect(d.khongDungTu).not.toBeNull();
    expect(d.khongDungBoi).toBe("chu@hogikids.test");
    expect(d.khongDungGhiChu).toBe("BC cũ của agency");
    expect(d.lanDauCoDau).not.toBeNull();
    expect(await cong()).toBeNull();

    const lai = await danhDauBcTiktokKhongDung({ bcId: BC_B, ghiChu: "ghi chú khác" });
    expect(lai).toEqual({ ok: true, data: { daDoi: false } });
    const d2 = await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC_B } });
    expect(d2.khongDungTu).toEqual(d.khongDungTu);
    expect(d2.khongDungGhiChu).toBe("BC cũ của agency");

    const nk = await nhatKy();
    expect(nk).toHaveLength(1);
    expect(nk[0]).toMatchObject({
      hanhDong: "BC_TIKTOK_DANH_DAU_KHONG_DUNG",
      ketQua: "OK",
      actorId: "chu-1",
      doiTuongLoai: "TiktokBcHoaDon",
      doiTuongId: BC_B,
    });
  });

  it("bỏ đánh dấu ⇒ cổng CHẶN lại + nhật ký; bỏ lần nữa ⇒ không đổi gì", async () => {
    await danhDauBcTiktokKhongDung({ bcId: BC_B });
    expect(await cong()).toBeNull();

    expect(await boDanhDauBcTiktokKhongDung(BC_B)).toEqual({ ok: true, data: { daDoi: true } });
    const d = await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC_B } });
    expect([d.khongDungTu, d.khongDungBoi, d.khongDungGhiChu]).toEqual([null, null, null]);
    expect(await cong()).toContain(`CHƯA XÁC NHẬN (BC ${BC_B})`);

    expect(await boDanhDauBcTiktokKhongDung(BC_B)).toEqual({ ok: true, data: { daDoi: false } });
    expect((await nhatKy()).map((n) => n.hanhDong)).toEqual([
      "BC_TIKTOK_DANH_DAU_KHONG_DUNG",
      "BC_TIKTOK_BO_DANH_DAU_KHONG_DUNG",
    ]);
  });

  it("BC chỉ có hoá đơn trong kho thô (chưa có dòng bảng bền) đánh dấu được — dòng được tạo", async () => {
    expect((await guiTrang("1002", BC_KHO_THO)).status).toBe(200);
    expect(await prisma.tiktokBcHoaDon.findUnique({ where: { bcId: BC_KHO_THO } })).toBeNull();

    expect(await danhDauBcTiktokKhongDung({ bcId: BC_KHO_THO })).toEqual({ ok: true, data: { daDoi: true } });
    const d = await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC_KHO_THO } });
    expect(d.khongDungTu).not.toBeNull();
    expect(d.lanDauCoDau).toBeNull();
  });

  it("đã bật nợ phải trả, BC có hoá đơn tính vào dư nợ thẻ trong 30 ngày ⇒ TỪ CHỐI (mã rõ), không ghi, không nhật ký", async () => {
    await prisma.setting.create({
      data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: khoaNgayVn(new Date(Date.now() - 40 * NGAY_MS)) },
    });
    expect(await prisma.tiktokAdsHoaDon.count({ where: { bcId: BC_A } })).toBe(1);

    const r = await danhDauBcTiktokKhongDung({ bcId: BC_A });
    expect(r).toMatchObject({ ok: false, code: "BC_CO_HOA_DON_TRU_THE", field: "bcId" });
    expect(r.ok ? "" : r.error).toContain(`BC ${BC_A} có 1 hoá đơn TikTok trừ tiền`);
    expect((await prisma.tiktokBcHoaDon.findUniqueOrThrow({ where: { bcId: BC_A } })).khongDungTu).toBeNull();
    expect(await nhatKy()).toHaveLength(0);

    // BC không có hoá đơn nào (thiếu quyền finance) vẫn đánh dấu được.
    expect(await danhDauBcTiktokKhongDung({ bcId: BC_B })).toEqual({ ok: true, data: { daDoi: true } });
  });

  it("BC chỉ thấy qua nhật ký đồng bộ (trang lỗi, không kho thô, không dòng bảng bền) ⇒ hiện trong danh sách + đánh dấu được", async () => {
    expect((await guiTrang("1003", BC_CHI_NHAT_KY, TRANG_LOI)).status).toBe(500);
    expect(await prisma.rawTiktokBusinessInvoice.count({ where: { shopId: BC_CHI_NHAT_KY } })).toBe(0);
    expect(await prisma.tiktokBcHoaDon.findUnique({ where: { bcId: BC_CHI_NHAT_KY } })).toBeNull();
    expect((await docDanhSachBcTiktok(prisma)).map((b) => b.bcId)).toContain(BC_CHI_NHAT_KY);

    expect(await danhDauBcTiktokKhongDung({ bcId: BC_CHI_NHAT_KY })).toEqual({ ok: true, data: { daDoi: true } });
  });

  it.each<[string, unknown]>([
    ["mã BC sai khuôn", { bcId: "bc-abc" }],
    ["BC app chưa biết", { bcId: "7999999999999999999" }],
    ["ghi chú quá 500 ký tự", { bcId: BC_B, ghiChu: "x".repeat(501) }],
  ])("%s ⇒ từ chối, không ghi", async (_ten, input) => {
    const r = await danhDauBcTiktokKhongDung(input);

    expect(r.ok).toBe(false);
    expect(await prisma.tiktokBcHoaDon.count({ where: { khongDungTu: { not: null } } })).toBe(0);
    expect(await nhatKy()).toHaveLength(0);
  });
});
