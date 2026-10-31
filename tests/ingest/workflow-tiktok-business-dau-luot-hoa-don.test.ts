import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { docThanDauLuot, lyDoKetThucChuaDu, type ThanDauLuot } from "@/lib/no-phai-tra/dau-luot-hoa-don-tiktok";
import { TRAN_NGAY_KEO_BU_HOA_DON_TIKTOK } from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";

import { catHam, dungKeoHoaDon, LOC_MAC_DINH, URL_APP } from "../helpers/chay-keo-hoa-don-n8n";

/**
 * `tiktok-business-nightly` gửi DẤU LƯỢT hoá đơn cho từng BC (`POST /api/ingest/luot-hoa-don-tiktok`): `bat-dau` TRƯỚC
 * lần GET hoá đơn đầu tiên, `ket-thuc` ở mọi đường ra kèm `ketQua` (`xong` | `loi` | `khong-quyen-finance`) + số trang
 * để app tự kiểm đủ. CHẠY THẬT khối dấu lượt cắt nguyên văn từ jsCode (`keoHoaDon`, `guiDauLuot`, `landTrangHoaDon`,
 * `soNguyenPageInfo`) cùng `docJson` / `laThieuQuyenFinance` của node, với `http` / `tiktokGetText` giả; thân dấu được
 * soi bằng CHÍNH bộ đọc khuôn của route app (`docThanDauLuot`) ⇒ hợp đồng hai phía không trôi.
 */

type NodeN8n = { type: string; parameters?: { jsCode?: string } };
const WF = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "n8n/tiktok-business-nightly.json"), "utf8"),
) as { nodes: NodeN8n[] };
const JS = WF.nodes.find((n) => n.type === "n8n-nodes-base.code")?.parameters?.jsCode ?? "";

const BC = "7129545797879726081";
/** Phạm vi dấu mang khi chạy với cửa sổ mặc định `LOC_MAC_DINH` (không kéo bù). */
const PHAM_VI_MAC_DINH = { startTime: "2026-10-21 00:00:00", endTime: "2026-10-31 00:00:00", muiGio: "UTC+07:00" };
const URL_DAU = `${URL_APP}/api/ingest/luot-hoa-don-tiktok`;

const dung = (o: Parameters<typeof dungKeoHoaDon>[1]) => dungKeoHoaDon(JS, o);

/** Trang có `soHoaDon` hoá đơn; `tong` = total_page (null ⇒ không có page_info); `tongHd` = total_number (vắng ⇒ bỏ khoá). */
const trang = (soHoaDon: number, tong: number | null, page = 1, tongHd?: number) =>
  JSON.stringify({
    code: 0,
    message: "OK",
    data: {
      transaction_list: Array.from({ length: soHoaDon }, (_, i) => ({ transaction_id: `T${page}-${i}` })),
      ...(tong === null
        ? {}
        : { page_info: { page, total_page: tong, ...(tongHd === undefined ? {} : { total_number: tongHd }) } }),
    },
  });
/**
 * Cửa sổ rỗng — hình dạng THẬT của `/bc/account/transaction/get/` (đo 30/10/2026, chỉ đọc, cửa sổ 2024-01-01→02):
 * HTTP 200, code 0, `transaction_list` CÓ mặt và rỗng, `page_info.total_page 0` + `total_number 0`.
 */
const TRANG_RONG =
  `{"code":0,"message":"OK","data":{"page_info":{"page":1,"page_size":50,"total_number":0,"total_page":0},` +
  `"transaction_list":[]}}`;
const TRANG_THIEU_QUYEN = `{"code":40002,"message":"No access to finance of this bc","data":{}}`;
const TRANG_LOI_THAM_SO = `{"code":40002,"message":"page_size: number must be most 50","data":{}}`;
/** `permission` trơn (quyền mức token/advertiser) KHÔNG phải thiếu finance. */
const TRANG_PERMISSION_TRON = `{"code":40002,"message":"Permission denied","data":{}}`;

/** Thân dấu phải qua ĐÚNG bộ đọc khuôn route app dùng — không thì app trả 400 và cổng chặn mãi. */
function quaKhuonRoute(body: Record<string, unknown>): ThanDauLuot {
  const kq = docThanDauLuot(body);
  expect(kq, JSON.stringify(kq)).toMatchObject({ ok: true });
  return (kq as { ok: true; dau: ThanDauLuot }).dau;
}

/** Lý do chưa đủ app sẽ ghi cho dấu kết thúc n8n vừa gửi (qua khuôn route, rồi đúng luật route + cổng dùng). */
function lyDoAppGhi(body: Record<string, unknown>): string[] {
  const dau = quaKhuonRoute(body);
  if (dau.giaiDoan !== "ket-thuc") throw new Error("không phải dấu kết thúc");
  return lyDoKetThucChuaDu(dau);
}

describe("tiktok-business-nightly — dấu lượt hoá đơn theo BC", () => {
  it("2 trang có hoá đơn: bắt đầu TRƯỚC GET trang 1; kết thúc sau land cuối, ketQua xong, số đủ; qua khuôn route", async () => {
    const { keoHoaDon, suKien, dau } = dung({ traTrang: (p) => trang(p === 1 ? 2 : 1, 2, p, 3) });
    expect(await keoHoaDon(BC)).toHaveLength(3);

    expect(suKien.map((e) => e.loai)).toEqual(["dau", "get", "land", "get", "land", "dau"]);
    expect(suKien.filter((e) => e.loai === "dau").map((e) => (e as { url: string }).url)).toEqual([URL_DAU, URL_DAU]);
    // Trang hoá đơn land kèm mã lượt (cổng gom trang theo luotId).
    expect(suKien.filter((e) => e.loai === "land").map((e) => (e as { body: unknown }).body)).toEqual([
      expect.objectContaining({ stream: "tiktokbusiness/invoice", shopId: BC, luotId: "104563" }),
      expect.objectContaining({ stream: "tiktokbusiness/invoice", shopId: BC, luotId: "104563" }),
    ]);
    const [batDau, ketThuc] = dau();
    expect(batDau).toEqual({ luotId: "104563", bcId: BC, giaiDoan: "bat-dau", phamVi: PHAM_VI_MAC_DINH });
    expect(ketThuc).toEqual({
      luotId: "104563",
      bcId: BC,
      giaiDoan: "ket-thuc",
      phamVi: PHAM_VI_MAC_DINH,
      tongTrangNguon: 2,
      tongHoaDonNguon: 3,
      soTrangDaGet: 2,
      soTrangLand: 2,
      soTrangRong: 0,
      soTrangLoi: 0,
      soHoaDon: 3,
      hoanTat: true,
      ketQua: "xong",
      loi: [],
    });
    quaKhuonRoute(batDau);
    expect(lyDoAppGhi(ketThuc)).toEqual([]);
  });

  it("cửa sổ rỗng (hình dạng thật: mảng rỗng có mặt, total_page 0) ⇒ GET 1 trang, land 0, ketQua xong, app coi ĐỦ", async () => {
    const { keoHoaDon, suKien, dau } = dung({ traTrang: () => TRANG_RONG });
    expect(await keoHoaDon(BC)).toEqual([]);

    expect(suKien.map((e) => e.loai)).toEqual(["dau", "get", "dau"]);
    expect(dau()[1]).toMatchObject({
      tongTrangNguon: 0,
      tongHoaDonNguon: 0,
      soTrangDaGet: 1,
      soTrangLand: 0,
      soTrangRong: 1,
      soTrangLoi: 0,
      soHoaDon: 0,
      hoanTat: true,
      ketQua: "xong",
    });
    expect(lyDoAppGhi(dau()[1])).toEqual([]);
  });

  it("GET trang 1 lỗi (timeout) ⇒ đã có dấu bắt đầu, gửi kết thúc ketQua loi (0 trang) rồi NÉM như cũ", async () => {
    const { keoHoaDon, suKien, dau, loiLandHoaDon } = dung({
      traTrang: () => {
        throw new Error("ETIMEDOUT business-api.tiktok.com");
      },
    });
    await expect(keoHoaDon(BC)).rejects.toThrow("ETIMEDOUT");

    expect(suKien.map((e) => e.loai)).toEqual(["dau", "get", "dau"]);
    const ketThuc = dau()[1];
    expect(ketThuc).toMatchObject({
      giaiDoan: "ket-thuc",
      tongTrangNguon: null,
      tongHoaDonNguon: null,
      soTrangDaGet: 0,
      soHoaDon: 0,
      hoanTat: false,
      ketQua: "loi",
      loi: [expect.stringContaining("ETIMEDOUT")],
    });
    expect(lyDoAppGhi(ketThuc)).toContain("n8n chưa đi hết phân trang (lượt đứt giữa chừng)");
    // Ném tiếp ⇒ vòng BC báo đỏ như trước; không cần thêm dòng báo đỏ ở đây (dấu tới app bình thường).
    expect(loiLandHoaDon).toEqual([]);
  });

  it.each<[string, string]>([
    ["40002 lỗi tham số (page_size)", TRANG_LOI_THAM_SO],
    ["40002 'Permission denied' trơn (không phải finance)", TRANG_PERMISSION_TRON],
  ])("GET trang 1 trả %s ⇒ ketQua loi, KHÔNG phải khong-quyen-finance", async (_ten, body) => {
    const { keoHoaDon, dau } = dung({ traTrang: () => body });
    await expect(keoHoaDon(BC)).rejects.toThrow(/40002/);
    expect(dau()[1]).toMatchObject({ ketQua: "loi", soTrangDaGet: 0, hoanTat: false });
    quaKhuonRoute(dau()[1]);
  });

  it("BC thiếu quyền finance (trang 1: 40002 'No access to finance') ⇒ bắt đầu + kết thúc khong-quyen-finance, ném để vòng BC bỏ qua", async () => {
    const { keoHoaDon, suKien, dau, loiLandHoaDon } = dung({ traTrang: () => TRANG_THIEU_QUYEN });
    await expect(keoHoaDon(BC)).rejects.toThrow(/40002/);

    expect(suKien.map((e) => e.loai)).toEqual(["dau", "get", "dau"]);
    expect(dau()[1]).toEqual({
      luotId: "104563",
      bcId: BC,
      giaiDoan: "ket-thuc",
      phamVi: PHAM_VI_MAC_DINH,
      tongTrangNguon: null,
      tongHoaDonNguon: null,
      soTrangDaGet: 0,
      soTrangLand: 0,
      soTrangRong: 0,
      soTrangLoi: 0,
      soHoaDon: 0,
      hoanTat: false,
      ketQua: "khong-quyen-finance",
      loi: [expect.stringContaining("No access to finance")],
    });
    quaKhuonRoute(dau()[1]);
    // BC chưa từng cấp quyền thì đêm nào cũng vậy — không thêm vào báo đỏ cuối lượt.
    expect(loiLandHoaDon).toEqual([]);
  });

  it("thiếu quyền finance SAU khi đã GET được trang 1 ⇒ ketQua loi (không phải BC không quyền)", async () => {
    const { keoHoaDon, dau } = dung({ traTrang: (p) => (p === 1 ? trang(1, 2, p) : TRANG_THIEU_QUYEN) });
    await expect(keoHoaDon(BC)).rejects.toThrow(/40002/);
    expect(dau()[1]).toMatchObject({ ketQua: "loi", soTrangDaGet: 1, soTrangLand: 1, hoanTat: false });
    quaKhuonRoute(dau()[1]);
  });

  it.each<[string, string]>([
    ["total_page 0", `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"T1"}],"page_info":{"page":1,"total_page":0,"total_number":1}}}`],
    ["total_number 0", `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"T1"}],"page_info":{"page":1,"total_page":1,"total_number":0}}}`],
  ])("nguồn tự mâu thuẫn (%s mà trang 1 có hoá đơn) ⇒ KHÔNG land, kết thúc ketQua loi kèm câu lỗi, ném", async (_ten, body) => {
    const { keoHoaDon, suKien, dau } = dung({ traTrang: () => body });
    await expect(keoHoaDon(BC)).rejects.toThrow("nguồn tự mâu thuẫn");

    expect(suKien.map((e) => e.loai)).toEqual(["dau", "get", "dau"]);
    expect(dau()[1]).toMatchObject({
      soTrangDaGet: 0,
      soTrangLand: 0,
      hoanTat: false,
      ketQua: "loi",
      loi: [expect.stringContaining("nguồn tự mâu thuẫn")],
    });
    expect(lyDoAppGhi(dau()[1]).length).toBeGreaterThan(0);
  });

  it("trang 2 tự mâu thuẫn (total_page 0 mà có hoá đơn) sau trang 1 hợp lệ ⇒ kết thúc loi với 1 trang đã land", async () => {
    const { keoHoaDon, dau } = dung({ traTrang: (p) => (p === 1 ? trang(1, 2, p) : trang(1, 0, p)) });
    await expect(keoHoaDon(BC)).rejects.toThrow("nguồn tự mâu thuẫn");
    expect(dau()[1]).toMatchObject({ soTrangDaGet: 1, soTrangLand: 1, tongTrangNguon: 2, ketQua: "loi" });
    quaKhuonRoute(dau()[1]);
  });

  it("nguồn báo total_page 3 mà cả 3 trang KHÔNG có mảng hoá đơn ⇒ khai 3 trang rỗng, app coi lượt CHƯA ĐỦ", async () => {
    // code 0 + page_info đủ nhưng mảng vắng (đổi tên khoá / nguồn trục trặc): n8n không land gì.
    const { keoHoaDon, suKien, dau } = dung({
      traTrang: (p) => `{"code":0,"message":"OK","data":{"page_info":{"page":${p},"total_page":3,"total_number":5}}}`,
    });
    expect(await keoHoaDon(BC)).toEqual([]);

    expect(suKien.filter((e) => e.loai === "land")).toEqual([]);
    const ketThuc = dau()[1];
    expect(ketThuc).toMatchObject({
      tongTrangNguon: 3,
      tongHoaDonNguon: 5,
      soTrangDaGet: 3,
      soTrangLand: 0,
      soTrangRong: 3,
      soHoaDon: 0,
      hoanTat: true,
      ketQua: "xong",
    });
    expect(lyDoAppGhi(ketThuc)).toEqual([
      "nguồn báo 3 trang mà 3 trang GET về rỗng (không có mảng hoá đơn)",
      "mới land 0/5 hoá đơn nguồn báo",
    ]);
  });

  it("trang 2 land hỏng (POST raw 502) ⇒ kết thúc khai soTrangLoi 1, vẫn báo đỏ cuối lượt như cũ", async () => {
    const { keoHoaDon, dau, loiLandHoaDon } = dung({ traTrang: (p) => trang(1, 2, p), land: (p) => (p === 2 ? -1 : 1) });
    await keoHoaDon(BC);

    // soHoaDon chỉ đếm hoá đơn trên trang land OK — trang 2 hỏng không cộng.
    expect(dau()[1]).toMatchObject({ soTrangDaGet: 2, soTrangLand: 1, soTrangLoi: 1, soHoaDon: 1, hoanTat: true });
    expect(loiLandHoaDon).toEqual([`bc ${BC} trang 2`]);
    quaKhuonRoute(dau()[1]);
  });

  it("GET trang 2 đứt (mạng) ⇒ gửi kết thúc DỞ (ketQua loi, hoanTat false, kèm lỗi) rồi ném tiếp như cũ", async () => {
    const { keoHoaDon, dau } = dung({
      traTrang: (p) => {
        if (p === 2) throw new Error("ETIMEDOUT business-api.tiktok.com");
        return trang(1, 3, p);
      },
    });
    await expect(keoHoaDon(BC)).rejects.toThrow("ETIMEDOUT");

    const ketThuc = dau()[1];
    expect(ketThuc).toMatchObject({ tongTrangNguon: 3, soTrangDaGet: 1, soTrangLand: 1, hoanTat: false, ketQua: "loi" });
    expect(ketThuc.loi).toEqual([expect.stringContaining("ETIMEDOUT")]);
    quaKhuonRoute(ketThuc);
  });

  it("dấu BẮT ĐẦU không tới app ⇒ vẫn kéo + land (VAT cần đủ), kết thúc mang lỗi đó, báo đỏ cuối lượt", async () => {
    const { keoHoaDon, suKien, dau, loiLandHoaDon } = dung({ traTrang: (p) => trang(1, 1, p), dauHong: "bat-dau" });
    expect(await keoHoaDon(BC)).toHaveLength(1);

    expect(suKien.map((e) => e.loai)).toEqual(["get", "land", "dau"]);
    expect(dau()[0]).toMatchObject({ giaiDoan: "ket-thuc", ketQua: "xong", loi: ["dấu bắt đầu lượt không tới app"] });
    expect(loiLandHoaDon).toEqual([`bc ${BC}: dấu BẮT ĐẦU lượt không tới app`]);
  });

  it("dấu KẾT THÚC không tới app ⇒ báo đỏ cuối lượt (cổng tự chặn vì thiếu dấu)", async () => {
    const { keoHoaDon, loiLandHoaDon } = dung({ traTrang: (p) => trang(1, 1, p), dauHong: "ket-thuc" });
    await keoHoaDon(BC);
    expect(loiLandHoaDon).toEqual([`bc ${BC}: dấu KẾT THÚC lượt không tới app`]);
  });

  it("không có id execution ⇒ không POST dấu nào (dấu bắt buộc luotId), trang land không mang luotId, báo đỏ cả hai", async () => {
    const { keoHoaDon, suKien, dau, loiLandHoaDon } = dung({ traTrang: (p) => trang(1, 1, p), executionId: undefined });
    await keoHoaDon(BC);
    expect(dau()).toEqual([]);
    const land = suKien.find((e) => e.loai === "land") as { body: Record<string, unknown> };
    expect("luotId" in land.body).toBe(false);
    expect(loiLandHoaDon).toEqual([
      `bc ${BC}: dấu BẮT ĐẦU lượt không tới app`,
      `bc ${BC}: dấu KẾT THÚC lượt không tới app`,
    ]);
  });

  it("nguồn không báo total_page ⇒ tongTrangNguon null (app chặn — không kiểm được đủ trang)", async () => {
    const { keoHoaDon, dau } = dung({ traTrang: () => trang(1, null) });
    await keoHoaDon(BC);
    expect(dau()[1]).toMatchObject({ tongTrangNguon: null, tongHoaDonNguon: null, soTrangDaGet: 1, hoanTat: true });
    expect(lyDoAppGhi(dau()[1])).toEqual(["nguồn không báo total_page — không kiểm được đủ trang"]);
  });

  it.each<[string, unknown]>([
    ["vắng", undefined],
    ["chuỗi rỗng", '""'],
    ["âm", -1],
    ["không nguyên", 2.5],
  ])("total_number %s ⇒ tongHoaDonNguon null (app bỏ phép đối số hoá đơn, vẫn đối số trang)", async (_ten, tongHd) => {
    const pageInfo = tongHd === undefined ? `{"page":1,"total_page":1}` : `{"page":1,"total_page":1,"total_number":${tongHd}}`;
    const { keoHoaDon, dau } = dung({
      traTrang: () => `{"code":0,"data":{"transaction_list":[{"transaction_id":"T1"}],"page_info":${pageInfo}}}`,
    });
    await keoHoaDon(BC);
    expect(dau()[1]).toMatchObject({ tongTrangNguon: 1, tongHoaDonNguon: null, soHoaDon: 1 });
    expect(lyDoAppGhi(dau()[1])).toEqual([]);
  });

  it("node chỉ POST dấu lượt qua đúng một hàm guiDauLuot; khối dấu lượt có đúng một cặp dòng đánh dấu bao keoHoaDon", () => {
    expect(JS.split('"/api/ingest/luot-hoa-don-tiktok"').length - 1).toBe(1);
    expect(catHam(JS, "guiDauLuot")).toContain('"/api/ingest/luot-hoa-don-tiktok"');
    const dauKhoi = "// ===== BẮT ĐẦU KHỐI DẤU LƯỢT HOÁ ĐƠN =====";
    const cuoiKhoi = "// ===== KẾT THÚC KHỐI DẤU LƯỢT HOÁ ĐƠN =====";
    expect(JS.split(dauKhoi).length - 1).toBe(1);
    expect(JS.split(cuoiKhoi).length - 1).toBe(1);
    const khoi = JS.slice(JS.indexOf(dauKhoi), JS.indexOf(cuoiKhoi));
    for (const ten of ["const LUOT_ID_HOA_DON =", "async function guiDauLuot(", "function soNguyenPageInfo(", "async function landTrangHoaDon(", "async function keoHoaDon("]) {
      expect(khoi, ten).toContain(ten);
    }
  });
});

describe("tiktok-business-nightly — phạm vi thời gian trên dấu lượt + kéo bù", () => {
  const filteringGet = (g: { filtering: unknown }) => JSON.parse(String(g.filtering)) as { start_time: string; end_time: string };

  it("dấu bắt đầu + kết thúc mang ĐÚNG start_time/end_time đã gửi trong filtering của MỌI trang GET", async () => {
    const { keoHoaDon, dau, get } = dung({ traTrang: (p) => trang(1, 2, p, 2) });
    await keoHoaDon(BC);

    expect(get()).toHaveLength(2);
    for (const g of get()) {
      const f = filteringGet(g);
      for (const d of dau()) {
        expect(d.phamVi).toEqual({ startTime: f.start_time, endTime: f.end_time, muiGio: "UTC+07:00" });
      }
    }
    expect(filteringGet(get()[0])).toEqual(JSON.parse(LOC_MAC_DINH));
    for (const d of dau()) quaKhuonRoute(d);
  });

  it("kéo bù (khoá tiktokBusinessHoaDonTuNgay) ⇒ GET lùi mốc đầu về 00:00 ngày đó, mốc cuối giữ; dấu mang đúng phạm vi đó", async () => {
    const { keoHoaDon, dau, get, loiLandHoaDon } = dung({
      traTrang: () => trang(1, 1, 1, 1),
      khoa: { tiktokBusinessHoaDonTuNgay: "2026-09-14" },
    });
    await keoHoaDon(BC);

    expect(get().map(filteringGet)).toEqual([{ start_time: "2026-09-14 00:00:00", end_time: "2026-10-31 00:00:00" }]);
    expect(dau().map((d) => d.giaiDoan)).toEqual(["bat-dau", "ket-thuc"]);
    for (const d of dau()) {
      expect(d.phamVi).toEqual({ startTime: "2026-09-14 00:00:00", endTime: "2026-10-31 00:00:00", muiGio: "UTC+07:00" });
      quaKhuonRoute(d);
    }
    expect(dau()[1]).toMatchObject({ ketQua: "xong" });
    expect(loiLandHoaDon).toEqual([]);
  });

  it("kéo bù với ngày MUỘN hơn mốc mặc định ⇒ không thu hẹp (giữ cửa sổ mặc định), không báo lỗi", async () => {
    const { keoHoaDon, get, loiLandHoaDon } = dung({
      traTrang: () => TRANG_RONG,
      khoa: { tiktokBusinessHoaDonTuNgay: "2026-10-25" },
    });
    await keoHoaDon(BC);
    expect(get().map(filteringGet)).toEqual([JSON.parse(LOC_MAC_DINH)]);
    expect(loiLandHoaDon).toEqual([]);
  });

  it.each([
    ["sai khuôn", "14/09/2026"],
    ["ngày không có thật", "2026-02-30"],
    ["hôm nay (không trước hôm nay)", "2026-10-31"],
    ["tương lai", "2026-11-05"],
    ["lùi quá 60 ngày", "2026-08-31"],
  ])("kéo bù %s ⇒ BỎ QUA (cửa sổ mặc định), câu lỗi vào báo đỏ cuối lượt, dấu mang phạm vi mặc định", async (_ca, giaTri) => {
    const { keoHoaDon, dau, get, loiLandHoaDon } = dung({
      traTrang: () => TRANG_RONG,
      khoa: { tiktokBusinessHoaDonTuNgay: giaTri },
    });
    await keoHoaDon(BC);
    expect(get().map(filteringGet)).toEqual([JSON.parse(LOC_MAC_DINH)]);
    expect(dau()[0].phamVi).toEqual(PHAM_VI_MAC_DINH);
    expect(loiLandHoaDon).toEqual([expect.stringContaining("KÉO BÙ hoá đơn BỎ QUA")]);
  });

  it("kéo bù đúng biên 60 ngày ⇒ nhận", async () => {
    const { keoHoaDon, get } = dung({ traTrang: () => TRANG_RONG, khoa: { tiktokBusinessHoaDonTuNgay: "2026-09-01" } });
    await keoHoaDon(BC);
    expect(filteringGet(get()[0]).start_time).toBe("2026-09-01 00:00:00");
  });

  it("cửa sổ mặc định sai khuôn ⇒ GET dùng nguyên chuỗi, dấu KHÔNG mang phạm vi (app không nhận làm bằng chứng), báo đỏ", async () => {
    const loc = JSON.stringify({ start_date: "2026-10-21", end_date: "2026-10-31" });
    const { keoHoaDon, dau, get, loiLandHoaDon } = dung({ traTrang: () => TRANG_RONG, hoaDonLocThoiGian: loc });
    await keoHoaDon(BC);
    expect(get()[0].filtering).toBe(loc);
    for (const d of dau()) {
      expect(d).not.toHaveProperty("phamVi");
      quaKhuonRoute(d);
    }
    expect(loiLandHoaDon).toEqual([expect.stringContaining("phạm vi hoá đơn")]);
  });

  it("trần kéo bù n8n TRÙNG trần cổng dùng để quyết khuyên kéo bù hay form tay", () => {
    expect(JS).toContain(`const KEO_BU_HOA_DON_TRAN_NGAY = ${TRAN_NGAY_KEO_BU_HOA_DON_TIKTOK};`);
  });

  it("câu SQL lấy khoá kéo bù từ bảng Setting (KHOA.tiktokBusinessHoaDonTuNgay không bao giờ câm)", () => {
    const sql = (WF.nodes as { type: string; parameters?: { query?: string } }[])
      .map((n) => n.parameters?.query ?? "")
      .join("\n");
    expect(sql).toContain("'tiktokBusinessHoaDonTuNgay'");
    expect(JS).toContain("KHOA.tiktokBusinessHoaDonTuNgay");
  });
});
