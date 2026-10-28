import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Giới hạn khi đọc PDF với pdfjs GIẢ (`unpdf` được thay): đọc từng trang, dừng khi vượt trần ký tự; hết giờ thì huỷ
 * `loadingTask` chứ không chỉ bỏ rơi promise; cách ghép chữ y `extractText(mergePages)` của unpdf.
 */
const { getDocumentProxy } = vi.hoisted(() => ({ getDocumentProxy: vi.fn() }));
vi.mock("unpdf", () => ({ getDocumentProxy }));

import { docTextPdf, TRAN_KY_TU_PDF } from "@/lib/sao-ke-the/doc-text-pdf";

const PDF = new TextEncoder().encode("%PDF-1.7 gia");

type Item = { str: string; hasEOL?: boolean };

/** Tài liệu giả: mỗi trang là danh sách item `{ str, hasEOL }`; `treo` = getTextContent không bao giờ xong. */
function taiLieu(trang: Item[][], treo = false) {
  const destroy = vi.fn(async () => {});
  const getPage = vi.fn(async (i: number) => ({
    getTextContent: treo ? () => new Promise<never>(() => {}) : async () => ({ items: trang[i - 1] }),
  }));
  return { numPages: trang.length, getPage, loadingTask: { destroy } };
}

afterEach(() => {
  getDocumentProxy.mockReset();
});

describe("docTextPdf — giới hạn", () => {
  it("ghép chữ như unpdf mergePages: nối item, hasEOL xuống dòng, gộp khoảng trắng, trang nối bằng xuống dòng", async () => {
    const tl = taiLieu([
      [{ str: "SAO KÊ  THẺ", hasEOL: true }, { str: "Ngày 20/10/2026 " }, { str: " ", hasEOL: true }],
      [{ str: "Trang hai có đủ chữ để không bị coi là ảnh scan" }],
    ]);
    getDocumentProxy.mockResolvedValue(tl);
    // Trang 1 kết bằng xuống dòng + nối trang bằng xuống dòng ⇒ một dòng trống (y unpdf).
    expect(await docTextPdf(PDF)).toBe("SAO KÊ THẺ\nNgày 20/10/2026\n\nTrang hai có đủ chữ để không bị coi là ảnh scan");
    expect(tl.loadingTask.destroy).toHaveBeenCalled();
  });

  it(`tổng chữ vượt ${TRAN_KY_TU_PDF} ký tự ⇒ dừng ở trang vượt, lỗi tiếng Việt, vẫn giải phóng`, async () => {
    const tl = taiLieu(Array.from({ length: 5 }, () => [{ str: "x".repeat(150_000) }]));
    getDocumentProxy.mockResolvedValue(tl);
    await expect(docTextPdf(PDF)).rejects.toThrow(/quá nhiều chữ/);
    expect(tl.getPage).toHaveBeenCalledTimes(3);
    expect(tl.loadingTask.destroy).toHaveBeenCalled();
  });

  it("hết giờ ⇒ lỗi 'quá lâu' VÀ huỷ loadingTask (pdfjs dừng việc dở)", async () => {
    const tl = taiLieu([[{ str: "x" }]], true);
    getDocumentProxy.mockResolvedValue(tl);
    await expect(docTextPdf(PDF, { hetGioMs: 30 })).rejects.toThrow(/quá lâu/);
    expect(tl.getPage).toHaveBeenCalledTimes(1);
    expect(tl.loadingTask.destroy).toHaveBeenCalled();
  });
});
