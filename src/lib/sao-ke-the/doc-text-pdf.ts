/**
 * Trích lớp chữ từ file PDF sao kê (chạy trong server action Node — không DOM, không worker file).
 *
 * Thư viện: `unpdf` (MIT, 0 dependency) — bản build PDF.js v6.4 (unpdf 1.9.x) "serverless" đóng gói sẵn worker
 * vào một file, chạy thẳng trên event loop của Node; không cần `window`, không cần file worker riêng,
 * không native. Vì sao không chọn:
 *  - `pdf-parse` v2: dependency CỨNG `@napi-rs/canvas` (native binary) — trái yêu cầu pure JS;
 *    `pdf-parse` v1: đóng gói pdfjs 2018, bỏ bảo trì.
 *  - `pdfjs-dist` trực tiếp: phải tự dựng "fake worker" (import động file worker) — dễ gãy khi Next
 *    đóng gói server, `@napi-rs/canvas` là optional nhưng vẫn kéo về.
 * Đo 26/10 trên 2 PDF sao kê Techcombank thật: `extractText(mergePages)` ra text GIỐNG pypdf từng
 * dòng (chỉ khác khoảng trắng đầu dòng ở trang hướng dẫn) ⇒ fixture text dùng chung cho parser.
 *
 * Giới hạn file lạ: ≤ 3 MB (bằng trần body server action), byte đầu `%PDF-`, ≤ 60 trang, ≤ 400.000 ký tự
 * chữ, hết giờ 20 giây (pdfjs serverless chạy trên event loop của tiến trình Next DUY NHẤT). Không có chữ ⇒ coi
 * là ảnh scan, từ chối rõ.
 *
 * Đọc TỪNG TRANG (không gọi `extractText` một phát): dừng ngay khi vượt trần ký tự — một content stream nén cực
 * mạnh (3 MB ⇒ hàng trăm MB chữ) không kịp ngốn RAM. Cách ghép chữ chép đúng `extractText(pdf, { mergePages: true })`
 * của unpdf 1.8.1 (`getPageText` + `normalizeMergedText`) để text ra y như fixture parser đang dùng. Hết giờ ⇒ huỷ
 * `loadingTask` (pdfjs dừng việc dở) chứ không chỉ bỏ rơi promise.
 */

export const TRAN_KICH_THUOC_PDF = 3 * 1024 * 1024;
export const TRAN_SO_TRANG_PDF = 60;
/** Sao kê thật 357 dòng ≈ 60.000 ký tự — trần gấp ~6 lần. */
export const TRAN_KY_TU_PDF = 400_000;
const HET_GIO_DOC_PDF_MS = 20_000;
/** Ít hơn ngần này ký tự không trắng ⇒ PDF không có lớp chữ. */
const SO_KY_TU_TOI_THIEU = 20;
const LOI_HET_GIO = "Đọc PDF quá lâu — file có thể hỏng hoặc quá phức tạp.";

/** Lỗi người dùng đọc được (tiếng Việt) — action hiển thị thẳng. */
export class LoiDocPdf extends Error {}

function batDauBangPdf(buf: Uint8Array): boolean {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  return buf.byteLength >= magic.length && magic.every((b, i) => buf[i] === b);
}

/** Chạy `p` tối đa `ms`; quá giờ ⇒ gọi `khiHetGio` (huỷ việc dở) rồi ném lỗi tiếng Việt. */
async function voiHetGio<T>(p: Promise<T>, ms: number, khiHetGio: () => void): Promise<T> {
  let hen: ReturnType<typeof setTimeout> | undefined;
  const hetGio = new Promise<never>((_, reject) => {
    hen = setTimeout(() => {
      khiHetGio();
      reject(new LoiDocPdf(LOI_HET_GIO));
    }, ms);
  });
  try {
    return await Promise.race([p, hetGio]);
  } finally {
    clearTimeout(hen);
  }
}

/** Chữ một trang — y `getPageText` của unpdf: nối `str` không dấu cách, `hasEOL` ⇒ xuống dòng. */
function chuMotTrang(items: ReadonlyArray<unknown>): string {
  return (items as Array<{ str?: string | null; hasEOL?: boolean }>)
    .filter((it) => it.str != null)
    .map((it) => it.str + (it.hasEOL ? "\n" : ""))
    .join("");
}

/** Ghép các trang — y `normalizeMergedText` của unpdf (`mergePages: true`). */
function ghepTrang(trang: string[]): string {
  return trang
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** `hetGioMs` chỉ để test rút ngắn hạn giờ — mặc định 20 giây. */
export async function docTextPdf(buf: Uint8Array, opts: { hetGioMs?: number } = {}): Promise<string> {
  if (buf.byteLength === 0) throw new LoiDocPdf("File rỗng.");
  if (buf.byteLength > TRAN_KICH_THUOC_PDF) throw new LoiDocPdf("File quá 3 MB — sao kê PDF thật chỉ vài trăm KB.");
  if (!batDauBangPdf(buf)) throw new LoiDocPdf("File không phải PDF.");

  // Import động: trang/action import module này không phải nạp pdfjs (~MB) cho tới khi thật sự đọc.
  const { getDocumentProxy } = await import("unpdf");
  type TaiLieu = Awaited<ReturnType<typeof getDocumentProxy>>;
  const viec: { pdf: TaiLieu | null; daHuy: boolean } = { pdf: null, daHuy: false };
  const huy = () => {
    viec.daHuy = true;
    void viec.pdf?.loadingTask.destroy().catch(() => {});
  };

  return voiHetGio(
    (async () => {
      let pdf: TaiLieu;
      try {
        // Chép buffer: pdfjs có thể chuyển giao (detach) ArrayBuffer của bên gọi.
        pdf = await getDocumentProxy(new Uint8Array(buf), {
          // (pdfjs 5 đã bỏ hẳn đường `eval` cho font nên không còn cờ `isEvalSupported`.)
          maxImageSize: 16 * 1024 * 1024,
          verbosity: 0, // tắt cảnh báo pdfjs ra console server ("Indexing all PDF objects"…)
        });
      } catch (e) {
        const ten = e instanceof Error ? e.name : "";
        if (ten === "PasswordException") throw new LoiDocPdf("PDF có mật khẩu — hãy mở khoá rồi tải lại.");
        throw new LoiDocPdf("File PDF hỏng hoặc không đọc được.");
      }
      viec.pdf = pdf;
      if (viec.daHuy) huy(); // hết giờ đúng lúc đang mở file ⇒ huỷ luôn
      try {
        if (pdf.numPages > TRAN_SO_TRANG_PDF) {
          throw new LoiDocPdf(`PDF có ${pdf.numPages} trang (tối đa ${TRAN_SO_TRANG_PDF}) — không giống sao kê thẻ.`);
        }
        const trang: string[] = [];
        let tongKyTu = 0;
        for (let i = 1; i <= pdf.numPages; i++) {
          if (viec.daHuy) throw new LoiDocPdf(LOI_HET_GIO);
          const noiDung = await (await pdf.getPage(i)).getTextContent();
          const chuTrang = chuMotTrang(noiDung.items);
          tongKyTu += chuTrang.length;
          if (tongKyTu > TRAN_KY_TU_PDF) {
            throw new LoiDocPdf(`PDF có quá nhiều chữ (trên ${TRAN_KY_TU_PDF.toLocaleString("vi-VN")} ký tự) — không giống sao kê thẻ.`);
          }
          trang.push(chuTrang);
        }
        const chu = ghepTrang(trang);
        if (chu.replace(/\s/g, "").length < SO_KY_TU_TOI_THIEU) {
          throw new LoiDocPdf("PDF không có lớp chữ (ảnh scan) — hãy tải bản PDF gốc từ ngân hàng điện tử.");
        }
        return chu;
      } finally {
        // PDF.js 6.4 (unpdf 1.9.x) bỏ `PDFDocumentProxy.destroy()`; giải phóng qua loading task.
        await pdf.loadingTask.destroy().catch(() => {});
      }
    })(),
    opts.hetGioMs ?? HET_GIO_DOC_PDF_MS,
    huy,
  );
}
