import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { docTextPdf, LoiDocPdf, TRAN_KICH_THUOC_PDF } from "@/lib/sao-ke-the/doc-text-pdf";
import { parseSaoKeTechcombank } from "@/lib/sao-ke-the/techcombank-sao-ke-parser";

import { THU_MUC_FIXTURE_SAO_KE } from "./doc-fixture-sao-ke-the";

const ma = (s: string) => new TextEncoder().encode(s);

/** PDF hợp lệ tối giản: 1 trang trắng, KHÔNG có lớp chữ (giống ảnh scan). */
const PDF_TRANG_TRONG = ma(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF`);

describe("docTextPdf — chặn file lạ trước khi đụng pdfjs", () => {
  it("file rỗng", async () => {
    await expect(docTextPdf(new Uint8Array())).rejects.toThrow(new LoiDocPdf("File rỗng."));
  });

  it("không phải PDF (thiếu magic %PDF-)", async () => {
    await expect(docTextPdf(ma("SAO KÊ TÀI KHOẢN THẺ TÍN DỤNG"))).rejects.toThrow("File không phải PDF.");
  });

  it("quá 3 MB — kể cả khi mở đầu đúng %PDF-", async () => {
    const lon = new Uint8Array(TRAN_KICH_THUOC_PDF + 1);
    lon.set(ma("%PDF-1.7\n"));
    await expect(docTextPdf(lon)).rejects.toThrow(/quá 3 MB/);
  });

  it("PDF hỏng ⇒ lỗi tiếng Việt, không lộ lỗi pdfjs", async () => {
    await expect(docTextPdf(ma("%PDF-1.7\nrac rac\n%%EOF"))).rejects.toThrow("File PDF hỏng hoặc không đọc được.");
  });

  it("PDF không có lớp chữ ⇒ từ chối như ảnh scan", async () => {
    await expect(docTextPdf(PDF_TRANG_TRONG)).rejects.toThrow(/không có lớp chữ \(ảnh scan\)/);
  });

  it("không đụng buffer của bên gọi", async () => {
    const buf = PDF_TRANG_TRONG.slice();
    await docTextPdf(buf).catch(() => {});
    expect(buf).toEqual(PDF_TRANG_TRONG);
  });
});

/**
 * Tích hợp với PDF sao kê THẬT — file chứa thông tin cá nhân nên KHÔNG commit (gitignore); chủ shop
 * đặt ở `tests/fixtures/sao-ke-the/*.pdf` trên máy mình thì test chạy, thiếu thì bỏ qua.
 */
const PDF_1020 = path.join(THU_MUC_FIXTURE_SAO_KE, "techcombank-2026-10-20.pdf");
const PDF_0918 = path.join(THU_MUC_FIXTURE_SAO_KE, "techcombank-2026-09-18.pdf");

describe("docTextPdf + parser trên PDF sao kê thật", () => {
  // Chỉ so số IN TRÊN PDF thật. Không ghép với `docBillFixture()` nữa: fixture bill đã gột (nhân
  // hệ số, đổi số thẻ) nên số đề xuất ghép giữa PDF thật và bill tổng hợp không còn ý nghĩa — ca
  // đối chiếu đầy đủ chạy trên fixture text + bill cùng bộ gột ở `doi-chieu-sao-ke-the.test.ts`.
  it.skipIf(!existsSync(PDF_1020))("sao kê 20/10: text pdfjs ⇒ parser đọc đủ 357 dòng và tổng in trên sao kê", async () => {
    const text = await docTextPdf(new Uint8Array(readFileSync(PDF_1020)));
    const r = parseSaoKeTechcombank(text);
    if (!r.ok) throw new Error(r.loi);
    expect(r.saoKe.dong).toHaveLength(357);
    expect([r.saoKe.tongGhiNo, r.saoKe.tongGhiCo, r.saoKe.duNoCuoiKy]).toEqual([49_280_959, 32_499_900, 23_681_959]);
  });

  it.skipIf(!existsSync(PDF_0918))("sao kê 18/09: 46 dòng, dư nợ 6.900.900", async () => {
    const text = await docTextPdf(new Uint8Array(readFileSync(PDF_0918)));
    const r = parseSaoKeTechcombank(text);
    if (!r.ok) throw new Error(r.loi);
    expect(r.saoKe.dong).toHaveLength(46);
    expect(r.saoKe.duNoCuoiKy).toBe(6_900_900);
  });
});
