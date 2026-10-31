import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { docThanDauLuot } from "@/lib/no-phai-tra/dau-luot-hoa-don-tiktok";

import {
  DONG_CUOI_KHOI,
  DONG_DAU_KHOI,
  dungBanLuiGiuDauLuot,
} from "../../scripts/n8n-dung-ban-lui-giu-dau-luot";
import { dungKeoHoaDon } from "../helpers/chay-keo-hoa-don-n8n";

/**
 * Đường lùi workflow `tiktok-business-nightly` GIỮ hợp đồng dấu lượt: `scripts/n8n-dung-ban-lui-giu-dau-luot.ts` ghép
 * nguyên KHỐI DẤU LƯỢT HOÁ ĐƠN của bản hiện hành vào một bản cũ (thay `keoHoaDon`). Bản cũ dùng ở đây là bản trên
 * `main` trước khi có dấu lượt (`git show main:n8n/tiktok-business-nightly.json`, chép thành fixture để test không phụ
 * thuộc lịch sử git của bản checkout). Chứng minh: phần còn lại của bản cũ giữ nguyên từng ký tự, và `keoHoaDon` của
 * bản lùi — chạy thật với `http` giả — gửi dấu đúng khuôn route app.
 */

type Wf = { nodes: { type: string; parameters: { jsCode?: string } }[] } & Record<string, unknown>;
const doc = (p: string): Wf => JSON.parse(readFileSync(path.resolve(process.cwd(), p), "utf8")) as Wf;
const FIXTURE_CU = "tests/fixtures/n8n/tiktok-business-nightly-ban-chua-dau-luot.json";
const BAN_HIEN_HANH = "n8n/tiktok-business-nightly.json";
const banCu = doc(FIXTURE_CU);
const banCoKhoi = doc(BAN_HIEN_HANH);
const jsCua = (wf: Wf) => wf.nodes.find((n) => n.type === "n8n-nodes-base.code")?.parameters.jsCode ?? "";

const BC = "7129545797879726081";
const trang = (n: number, tong: number) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[${Array.from({ length: n }, (_, i) => `{"transaction_id":"T${i}"}`).join(",")}],` +
  `"page_info":{"page":1,"total_page":${tong},"total_number":${n}}}}`;

const kq = dungBanLuiGiuDauLuot(banCu, banCoKhoi);
if (!kq.ok) throw new Error(`dựng bản lùi từ fixture main thất bại: ${kq.loi}`);
const banLui = kq;

describe("dựng bản lùi từ bản main chưa có dấu lượt", () => {
  it("fixture đúng là bản chưa gửi dấu lượt (mốc so sánh còn nghĩa)", () => {
    const cu = jsCua(banCu);
    expect(cu).toContain("async function keoHoaDon(");
    expect(cu).not.toContain("luot-hoa-don-tiktok");
    expect(cu).not.toContain(DONG_DAU_KHOI);
  });

  it("chỉ vùng keoHoaDon (kèm JSDoc liền trước) bị thay bằng nguyên khối; phần còn lại của jsCode giữ nguyên từng ký tự", () => {
    const cu = jsCua(banCu);
    const { tu, den } = banLui.vungCu;
    const vungCu = cu.slice(tu, den);
    expect(vungCu.startsWith("/** Kéo hoá đơn quảng cáo TRONG CỬA SỔ")).toBe(true);
    expect(vungCu).toContain("async function keoHoaDon(bcId) {");
    expect(vungCu.endsWith("return hoaDon;\n}")).toBe(true);

    expect(banLui.jsCode).toBe(cu.slice(0, tu) + banLui.khoi + cu.slice(den));
    // Khối = đúng đoạn giữa hai dòng đánh dấu của bản hiện hành.
    const hienHanh = jsCua(banCoKhoi);
    expect(banLui.khoi).toBe(
      hienHanh.slice(hienHanh.indexOf(DONG_DAU_KHOI), hienHanh.indexOf(DONG_CUOI_KHOI) + DONG_CUOI_KHOI.length),
    );
  });

  it("workflow ra = bản cũ, chỉ khác jsCode của node Code (node khác, connections, tên… giữ nguyên)", () => {
    const ra = banLui.workflow as Wf;
    const boJs = (wf: Wf) => ({
      ...wf,
      nodes: wf.nodes.map((n) => (n.parameters.jsCode === undefined ? n : { ...n, parameters: { ...n.parameters, jsCode: "<js>" } })),
    });
    expect(boJs(ra)).toEqual(boJs(banCu));
    expect(jsCua(ra)).toBe(banLui.jsCode);
    // Bản cũ không bị sửa tại chỗ.
    expect(jsCua(banCu)).not.toContain(DONG_DAU_KHOI);
  });
});

/**
 * Bản cần kiểm hợp đồng dấu: luôn có bản lùi dựng từ fixture `main`; đặt `N8N_BAN_LUI=<file --ra>` thì kiểm THÊM chính
 * file bản lùi sắp import (runbook lùi workflow, bước kiểm) — cùng các ca dưới, trên jsCode của file đó.
 */
const FILE_BAN_LUI = process.env.N8N_BAN_LUI;
const CAC_BAN: [string, string][] = [
  ["bản lùi dựng từ fixture main", banLui.jsCode],
  ...(FILE_BAN_LUI ? ([[`file ${FILE_BAN_LUI}`, jsCua(doc(FILE_BAN_LUI))]] as [string, string][]) : []),
];

describe.each(CAC_BAN)("hợp đồng dấu lượt của %s", (_ten, js) => {
  it("có đúng một khối dấu lượt, TRÙNG từng ký tự với khối của bản hiện hành; jsCode biên dịch được", () => {
    expect(js.split(DONG_DAU_KHOI).length - 1).toBe(1);
    expect(js.split(DONG_CUOI_KHOI).length - 1).toBe(1);
    expect(js.slice(js.indexOf(DONG_DAU_KHOI), js.indexOf(DONG_CUOI_KHOI) + DONG_CUOI_KHOI.length)).toBe(banLui.khoi);
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => unknown;
    expect(() => new AsyncFunction("$input", "$execution", js)).not.toThrow();
  });

  it("keoHoaDon: dấu bắt đầu TRƯỚC GET, trang land kèm luotId, kết thúc ketQua xong — đúng khuôn route", async () => {
    const { keoHoaDon, suKien, dau } = dungKeoHoaDon(js, { traTrang: () => trang(2, 1) });
    expect(await keoHoaDon(BC)).toHaveLength(2);

    expect(suKien.map((e) => e.loai)).toEqual(["dau", "get", "land", "dau"]);
    expect(suKien[2]).toMatchObject({ body: { stream: "tiktokbusiness/invoice", shopId: BC, luotId: "104563" } });
    for (const d of dau()) expect(docThanDauLuot(d), JSON.stringify(d)).toMatchObject({ ok: true });
    expect(dau()[1]).toMatchObject({ ketQua: "xong", soTrangDaGet: 1, soTrangLand: 1, soHoaDon: 2, hoanTat: true });
  });

  it("keoHoaDon: cả hai dấu mang phạm vi = ĐÚNG filtering đã gửi GET (kể cả khi kéo bù)", async () => {
    for (const khoa of [{}, { tiktokBusinessHoaDonTuNgay: "2026-09-20" }]) {
      const { keoHoaDon, dau, get } = dungKeoHoaDon(js, { traTrang: () => trang(1, 1), khoa });
      await keoHoaDon(BC);
      const f = JSON.parse(String(get()[0].filtering)) as { start_time: string; end_time: string };
      expect(dau()).toHaveLength(2);
      for (const d of dau()) expect(d.phamVi).toEqual({ startTime: f.start_time, endTime: f.end_time, muiGio: "UTC+07:00" });
    }
  });

  it("keoHoaDon: BC thiếu quyền finance ⇒ kết thúc khong-quyen-finance đúng khuôn, ném để vòng BC bỏ qua", async () => {
    const { keoHoaDon, dau } = dungKeoHoaDon(js, {
      traTrang: () => `{"code":40002,"message":"No access to finance of this bc","data":{}}`,
    });
    await expect(keoHoaDon(BC)).rejects.toThrow(/40002/);
    expect(dau().map((d) => d.giaiDoan)).toEqual(["bat-dau", "ket-thuc"]);
    expect(dau()[1]).toMatchObject({ ketQua: "khong-quyen-finance" });
    expect(docThanDauLuot(dau()[1])).toMatchObject({ ok: true });
  });

  it("keoHoaDon: GET trang 1 lỗi ⇒ kết thúc ketQua loi đúng khuôn, ném", async () => {
    const { keoHoaDon, dau } = dungKeoHoaDon(js, {
      traTrang: () => {
        throw new Error("ETIMEDOUT business-api.tiktok.com");
      },
    });
    await expect(keoHoaDon(BC)).rejects.toThrow("ETIMEDOUT");
    expect(dau()[1]).toMatchObject({ ketQua: "loi", soTrangDaGet: 0 });
    expect(docThanDauLuot(dau()[1])).toMatchObject({ ok: true });
  });

  it("vòng BC vẫn bỏ qua đúng lỗi thiếu quyền (khối ném lại nguyên lỗi docJson)", () => {
    expect(js).toMatch(/if \(laThieuQuyenFinance\(e\)\) \{\s*bcBoQua\.push\(bcId\);/);
  });
});

describe("từ chối khi không có điểm ghép an toàn", () => {
  it("bản vào đã có khối dấu lượt ⇒ từ chối", () => {
    expect(dungBanLuiGiuDauLuot(banCoKhoi, banCoKhoi)).toMatchObject({ ok: false, loi: expect.stringContaining("đã có khối") });
  });

  it("bản vào không có keoHoaDon (workflow khác) ⇒ từ chối", () => {
    expect(dungBanLuiGiuDauLuot(doc("n8n/meta-ads-nightly.json"), banCoKhoi)).toMatchObject({ ok: false });
  });

  it("bản vào đã khai trùng tên khối (vd guiDauLuot) ⇒ từ chối, không khai đôi", () => {
    const wf = structuredClone(banCu);
    const node = wf.nodes.find((n) => n.type === "n8n-nodes-base.code");
    if (!node) throw new Error("fixture thiếu node Code");
    node.parameters.jsCode = `${node.parameters.jsCode}\nfunction guiDauLuot() {}\n`;
    expect(dungBanLuiGiuDauLuot(wf, banCoKhoi)).toMatchObject({ ok: false, loi: expect.stringContaining("guiDauLuot") });
  });

  it("bản vào thiếu KHOA (khối đọc khoá kéo bù) ⇒ từ chối", () => {
    const wf = structuredClone(banCu);
    const node = wf.nodes.find((n) => n.type === "n8n-nodes-base.code");
    if (!node?.parameters.jsCode) throw new Error("fixture thiếu node Code");
    node.parameters.jsCode = node.parameters.jsCode.replaceAll("const KHOA = ", "const KHOA_KHAC = ");
    expect(dungBanLuiGiuDauLuot(wf, banCoKhoi)).toMatchObject({ ok: false, loi: expect.stringContaining("KHOA") });
  });

  it("bản vào thiếu tên khối dựa vào (laThieuQuyenFinance) ⇒ từ chối", () => {
    const wf = structuredClone(banCu);
    const node = wf.nodes.find((n) => n.type === "n8n-nodes-base.code");
    if (!node?.parameters.jsCode) throw new Error("fixture thiếu node Code");
    node.parameters.jsCode = node.parameters.jsCode.replaceAll("laThieuQuyenFinance", "laThieuQuyenKhac");
    expect(dungBanLuiGiuDauLuot(wf, banCoKhoi)).toMatchObject({
      ok: false,
      loi: expect.stringContaining("laThieuQuyenFinance"),
    });
  });

  it("bản nguồn khối mất dòng đánh dấu cuối ⇒ từ chối", () => {
    const wf = structuredClone(banCoKhoi);
    const node = wf.nodes.find((n) => n.type === "n8n-nodes-base.code");
    if (!node?.parameters.jsCode) throw new Error("thiếu node Code");
    node.parameters.jsCode = node.parameters.jsCode.replace(DONG_CUOI_KHOI, "");
    expect(dungBanLuiGiuDauLuot(banCu, wf)).toMatchObject({ ok: false });
  });
});

describe("CLI — chỉ ghi file mới, mã thoát", () => {
  const thuMuc = mkdtempSync(path.join(tmpdir(), "ban-lui-n8n-"));
  afterAll(() => rmSync(thuMuc, { recursive: true, force: true }));
  const chay = (thamSo: string[]) => {
    const r = spawnSync("./node_modules/.bin/tsx", ["scripts/n8n-dung-ban-lui-giu-dau-luot.ts", ...thamSo], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });
    if (r.error) throw r.error;
    return r;
  };

  it("bản main ⇒ thoát 0, file ra = đúng workflow hàm thuần dựng", () => {
    const ra = path.join(thuMuc, "ban-lui.json");
    const r = chay(["--vao", FIXTURE_CU, "--ra", ra]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(ra, "utf8"))).toEqual(banLui.workflow);
  });

  it("bản vào đã có khối ⇒ thoát ≠ 0, KHÔNG ghi file", () => {
    const ra = path.join(thuMuc, "khong-ghi.json");
    const r = chay(["--vao", BAN_HIEN_HANH, "--ra", ra]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("TỪ CHỐI");
    expect(existsSync(ra)).toBe(false);
  });
});
