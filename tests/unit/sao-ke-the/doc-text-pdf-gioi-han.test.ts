import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Giới hạn khi đọc PDF với pdfjs GIẢ (`unpdf` được thay): đọc chữ từng trang THEO LUỒNG, dừng khi vượt trần ký tự (kể
 * cả giữa một trang); hết giờ thì huỷ `loadingTask` chứ không chỉ bỏ rơi promise; cách ghép chữ y
 * `extractText(mergePages)` của unpdf.
 */
const { getDocumentProxy } = vi.hoisted(() => ({ getDocumentProxy: vi.fn() }));
vi.mock("unpdf", () => ({ getDocumentProxy }));

import { docTextPdf, TRAN_KY_TU_PDF } from "@/lib/sao-ke-the/doc-text-pdf";

const PDF = new TextEncoder().encode("%PDF-1.7 gia");

type Item = { str: string; hasEOL?: boolean };

/**
 * Trang giả: chữ đẩy theo LÔ như pdfjs (`streamTextContent`); `getTextContent` = đọc trọn luồng rồi mới trả (y pdfjs).
 * `dem.keo` = số lô pdfjs đã phải dựng, `dem.huy` = luồng bị huỷ. `treo` = luồng không bao giờ ra lô nào.
 */
function trangGia(lo: Item[][], treo = false) {
  const dem = { keo: 0, huy: false };
  const streamTextContent = () =>
    new ReadableStream<{ items: Item[] }>(
      {
        pull: (ctrl) => {
          if (treo) return new Promise<void>(() => {});
          if (dem.keo >= lo.length) ctrl.close();
          else ctrl.enqueue({ items: lo[dem.keo++] });
        },
        cancel: () => {
          dem.huy = true;
        },
      },
      { highWaterMark: 0 },
    );
  const getTextContent = async () => {
    const items: Item[] = [];
    const doc = streamTextContent().getReader();
    for (;;) {
      const { value, done } = await doc.read();
      if (done) return { items };
      items.push(...value.items);
    }
  };
  return { dem, trang: { streamTextContent, getTextContent } };
}

/** Tài liệu giả: mỗi trang là một danh sách lô item `{ str, hasEOL }`. */
function taiLieuLo(trang: Item[][][], treo = false) {
  const destroy = vi.fn(async () => {});
  const cacTrang = trang.map((lo) => trangGia(lo, treo));
  const getPage = vi.fn(async (i: number) => cacTrang[i - 1].trang);
  return { numPages: trang.length, getPage, loadingTask: { destroy }, cacTrang };
}

/** Mỗi trang một lô. */
function taiLieu(trang: Item[][], treo = false) {
  return taiLieuLo(
    trang.map((items) => [items]),
    treo,
  );
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

  it("ghép nhiều lô trong một trang y như một lô (hasEOL giữ nguyên chỗ xuống dòng)", async () => {
    const tl = taiLieuLo([
      [
        [{ str: "SAO KÊ ", hasEOL: false }, { str: "THẺ", hasEOL: true }],
        [{ str: "Ngày 20/10/2026 đủ chữ để không bị coi là ảnh scan" }],
      ],
    ]);
    getDocumentProxy.mockResolvedValue(tl);
    expect(await docTextPdf(PDF)).toBe("SAO KÊ THẺ\nNgày 20/10/2026 đủ chữ để không bị coi là ảnh scan");
  });

  it("MỘT trang mà chữ vượt trần ⇒ dừng ngay ở lô vượt (không dựng trọn trang), huỷ luồng, vẫn giải phóng", async () => {
    // Bom một trang: 10 lô × 150.000 ký tự = 1,5 triệu ký tự; trần 400.000 ⇒ lô thứ 3 vượt.
    const tl = taiLieuLo([Array.from({ length: 10 }, () => [{ str: "x".repeat(150_000) }])]);
    getDocumentProxy.mockResolvedValue(tl);
    await expect(docTextPdf(PDF)).rejects.toThrow(/quá nhiều chữ/);
    expect(tl.cacTrang[0].dem.keo).toBe(3);
    expect(tl.cacTrang[0].dem.huy).toBe(true);
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
