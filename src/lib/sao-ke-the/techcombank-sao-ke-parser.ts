/**
 * Tách sao kê thẻ tín dụng Techcombank (text đã trích từ PDF) thành cấu trúc — THUẦN, không DB.
 *
 * Bố cục sao kê (đo trên 2 kỳ 18/09 + 20/10/2026, text trích bằng pypdf lẫn pdfjs/unpdf ra GIỐNG
 * NHAU từng dòng trừ khoảng trắng đầu dòng):
 *  - Đầu trang: "Ngày sao kê … dd/mm/yyyy", "Hạn mức tín dụng (VND) … 50,000,000".
 *  - Khối "Tóm tắt sao kê" có ĐÚNG 5 số theo thứ tự: dư nợ kỳ trước · tổng ghi nợ · tổng ghi có ·
 *    dư nợ cuối kỳ · trả tối thiểu, rồi hạn trả "17:00 dd/mm/yyyy". Đọc 5 số THEO THỨ TỰ chứ không
 *    dò từng nhãn ⇒ chịu được việc thư viện PDF xếp nhãn và số khác dòng.
 *  - Bảng chi tiết, mỗi giao dịch mở đầu bằng một dòng có ngày:
 *      `17/09/2026 19/09/2026 143,000.00 VND 143,000[ diễn giải]` (ngày GD, ngày ghi sổ)
 *      `26/09/2026 713,900.00 VND 9,900`                         (phí ngoại tệ: CHỈ ngày ghi sổ)
 *      `14/09/2026 599,000 Phí thường niên/Annual Fee`            (phí / hoàn phí: không số gốc)
 *    diễn giải kéo dài các dòng sau tới dòng có ngày kế tiếp; tiêu đề cột + số trang + "TC191" lặp
 *    mỗi trang bị bỏ.
 *  - Cuối bảng: "Total Debit/Credit in Period: …", "Outstanding Balance: …" — đối chiếu chéo.
 *
 * PDF in dư nợ ÂM khi đang nợ (`-23,681,959`) ⇒ `duNoKyTruoc`/`duNoCuoiKy` đổi dấu: DƯƠNG = đang nợ.
 * Cột Ghi nợ/Ghi có không phân biệt được trong text (chỉ còn một con số) ⇒ ghi có nhận diện bằng
 * diễn giải ("Thanh toan no the", "Hoan phi…"); phân loại sai thì CỔNG CHẶN tổng bắt được. Từ khoá hoàn chỉ
 * xét ở phần LOẠI giao dịch (đầu diễn giải / trước "Thẻ/Card No"), không xét tên merchant — merchant
 * "… HOAN KIEM HA NOI" không được biến lần mua thành ghi có (Σ lệch ⇒ từ chối cả file).
 *
 * CỔNG CHẶN (từng đồng): Σ ghiNo = tongGhiNo ∧ Σ ghiCo = tongGhiCo ∧
 * duNoKyTruoc + tongGhiNo − tongGhiCo = duNoCuoiKy. Mọi chỗ không đọc chắc ⇒ `ok:false` + lý do,
 * KHÔNG BAO GIỜ ép 0.
 */

import { formatVnd } from "@/lib/format";

export type DongSaoKe = {
  /** yyyy-MM-dd; dòng chỉ có ngày ghi sổ (phí ngoại tệ, phí thường niên) ⇒ = ngayGhiSo. */
  ngayGiaoDich: string;
  ngayGhiSo: string;
  ghiNo: number;
  ghiCo: number;
  dienGiai: string;
  /**
   * Dòng có "tiktok" trong diễn giải: ghi NỢ = lần TikTok trừ thẻ (ghép hoá đơn POSITIVE), ghi CÓ = TikTok hoàn về
   * thẻ (ghép hoá đơn NEGATIVE). Dòng PHÍ / HOÀN PHÍ đi kèm giao dịch TikTok ngoại tệ (diễn giải "PHI GIAO DICH NOI TE
   * O NUOC NGOAI - … TIKTOK ADS SINGAPORE SG", "Hoan phi …") KHÔNG tính — đó là phí ngân hàng, không phải hoá đơn
   * TikTok. Thanh toán nợ thẻ không bao giờ là TikTok.
   */
  laTiktok: boolean;
  /** Ghi có "Thanh toan no the" (chủ thẻ trả nợ). */
  laThanhToan: boolean;
};

export type SaoKeThe = {
  nganHang: "TECHCOMBANK";
  ngaySaoKe: string;
  soCuoiThe: string;
  hanMuc: number;
  duNoKyTruoc: number;
  tongGhiNo: number;
  tongGhiCo: number;
  /** DƯƠNG = đang nợ (PDF in "-23,681,959"). */
  duNoCuoiKy: number;
  traToiThieu: number;
  hanTra: string;
  dong: DongSaoKe[];
};

export type KetQuaParseSaoKe = { ok: true; saoKe: SaoKeThe } | { ok: false; loi: string };

const NGAY = String.raw`(\d{2})/(\d{2})/(\d{4})`;
/** Số tiền in kiểu Techcombank: `143,000`, `0`, `-6,900,900`, có thể kèm `.00`. */
const RE_TOKEN_SO_TIEN = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.0+)?$/;
/** Số tiền BẮT BUỘC đúng dạng nhóm phẩy (dòng phí không có số gốc) — chặn "5000000 VND" trong diễn giải. */
const RE_TOKEN_SO_TIEN_NHOM = /^\d{1,3}(?:,\d{3})*$/;
const RE_TIEN_TE = /^[A-Z]{3}$/;
const RE_DONG_GIAO_DICH = new RegExp(String.raw`^${NGAY}(?:\s+${NGAY})?\s+(.*)$`);

/** Cụm tiêu đề cột lặp ở đầu mỗi trang bảng chi tiết. */
const TIEU_DE_COT = [
  "Ngày giao dịch",
  "Transaction date",
  "Ngày cập nhật hệ thống",
  "Post date",
  "Số tiền giao dịch gốc",
  "Original amount",
  "Ghi nợ (VND)",
  "Ghi có (VND)",
  "Diễn giải giao dịch",
  "Transaction description",
  "Debit",
  "Credit",
];

class LoiDocSaoKe extends Error {}

function hong(loi: string): never {
  throw new LoiDocSaoKe(loi);
}

/** Diễn giải "Thanh toan no the" (chủ thẻ trả nợ) — bỏ dấu trước khi so. */
const RE_THANH_TOAN_NO_THE = /thanh toan no the/i;
/** Dòng phí ngân hàng (kể cả hoàn phí) — không phải giao dịch TikTok dù diễn giải nhắc tên TikTok. */
const RE_DONG_PHI = /^(?:hoan\s+)?phi\b/i;
/** Cụm loại giao dịch HOÀN (ghi có): "Hoan phi …", "Hoan tien …", "Hoan tra …", "Refund". Không phải từ đơn "hoan". */
const RE_CUM_HOAN = /\b(?:hoan\s+(?:phi|tien|tra)|refund)\b/i;
/** Ranh giới loại giao dịch ↔ merchant trên dòng mua bằng thẻ: "… Số Thẻ/Card No: 0000...9999 <merchant>". */
const RE_SO_THE = /the\/card no/i;

/**
 * Dòng hoàn (ghi có) theo PHẦN LOẠI giao dịch của diễn giải đã bỏ dấu:
 *  - có "Thẻ/Card No" ⇒ chỉ xét đoạn TRƯỚC nó (merchant đứng sau — tên merchant không quyết loại giao dịch);
 *  - không có ⇒ cụm hoàn phải đứng ĐẦU diễn giải (mẫu đo: "Hoan phi thuong nien …").
 */
function laDongHoan(k: string): boolean {
  const iThe = k.search(RE_SO_THE);
  if (iThe >= 0) return RE_CUM_HOAN.test(k.slice(0, iThe));
  const m = k.match(RE_CUM_HOAN);
  return m !== null && m.index === 0;
}

/**
 * Dòng là thanh toán nợ thẻ — theo diễn giải. Dùng chung cho parser và cho dòng sao kê ĐÃ LƯU (`DongSaoKeThe` không có
 * cột này), để đối chiếu lại một kỳ cũ cùng một luật.
 */
export function laThanhToanNoThe(dienGiai: string): boolean {
  return RE_THANH_TOAN_NO_THE.test(boDau(dienGiai));
}

/** Bỏ dấu tiếng Việt để so khớp từ khoá ("Hoàn phí" ~ "Hoan phi"). */
function boDau(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d");
}

function ngayIso(dd: string, mm: string, yyyy: string): string | null {
  const d = Number(dd);
  const m = Number(mm);
  const y = Number(yyyy);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function ngayIsoBatBuoc(dd: string, mm: string, yyyy: string, noi: string): string {
  return ngayIso(dd, mm, yyyy) ?? hong(`Ngày không hợp lệ ${dd}/${mm}/${yyyy} ở ${noi}.`);
}

/** Token số tiền → Int VND (giữ dấu). `null` nếu không phải số tiền nguyên. */
function docSoTien(token: string): number | null {
  if (!RE_TOKEN_SO_TIEN.test(token)) return null;
  const n = Number(token.replace(/,/g, "").replace(/\.0+$/, ""));
  return Number.isSafeInteger(n) ? n : null;
}

/** Đổi số dư in trên PDF (âm = đang nợ) sang quy ước app (dương = đang nợ); `0` giữ `+0`. */
function doiDauDuNo(n: number): number {
  return 0 - n;
}

function laDongNhieu(dong: string): boolean {
  if (/^\d{1,3}$/.test(dong) || /^TC\d{3}$/.test(dong)) return true;
  let s = dong;
  for (const cum of TIEU_DE_COT) s = s.split(cum).join(" ");
  s = s.replace(/\bTC\d{3}\b/g, " ").trim();
  return s === "" || /^\d{1,3}$/.test(s);
}

type DongDangDoc = Omit<DongSaoKe, "dienGiai" | "laTiktok" | "laThanhToan"> & {
  soTien: number;
  dienGiai: string[];
};

/** Phần sau (các) ngày của dòng mở đầu giao dịch → số tiền + đuôi diễn giải; `null` nếu không phải. */
function tachPhanSau(phanSau: string): { soTien: number; duoi: string } | null {
  const tokens = phanSau.split(" ").filter(Boolean);
  let i = 0;
  // Số tiền gốc + mã tiền tệ: "143,000.00 VND" hoặc dính liền "143,000.00VND".
  const dinh = tokens[0]?.match(/^([\d,]+(?:\.\d+)?)([A-Z]{3})$/);
  if (dinh) i = 1;
  else if (tokens[0] && /^[\d,]+(?:\.\d+)?$/.test(tokens[0]) && RE_TIEN_TE.test(tokens[1] ?? "")) i = 2;
  const coSoGoc = i > 0;
  const tokenTien = tokens[i];
  if (!tokenTien) return null;
  if (!coSoGoc && !RE_TOKEN_SO_TIEN_NHOM.test(tokenTien)) return null;
  const soTien = docSoTien(tokenTien);
  if (soTien === null || soTien < 0) return null;
  const duoi = tokens.slice(i + 1).join(" ");
  // Dòng không có số gốc (phí/hoàn phí) luôn có diễn giải ngay trên dòng — thiếu ⇒ không nhận.
  if (!coSoGoc && duoi === "") return null;
  return { soTien, duoi };
}

function docDongGiaoDich(vung: string[]): DongSaoKe[] {
  const ketQua: DongDangDoc[] = [];
  for (const dong of vung) {
    const m = dong.match(RE_DONG_GIAO_DICH);
    const tach = m ? tachPhanSau(m[7]) : null;
    if (m && tach) {
      const ngay1 = ngayIsoBatBuoc(m[1], m[2], m[3], `dòng "${dong}"`);
      const ngay2 = m[4] ? ngayIsoBatBuoc(m[4], m[5], m[6], `dòng "${dong}"`) : null;
      ketQua.push({
        ngayGiaoDich: ngay1,
        ngayGhiSo: ngay2 ?? ngay1,
        soTien: tach.soTien,
        ghiNo: 0,
        ghiCo: 0,
        dienGiai: tach.duoi ? [tach.duoi] : [],
      });
      continue;
    }
    // Dòng nối diễn giải của giao dịch đang đọc (dòng trước giao dịch đầu tiên bị bỏ).
    const hienTai = ketQua[ketQua.length - 1];
    if (hienTai && !laDongNhieu(dong)) hienTai.dienGiai.push(dong);
  }
  return ketQua.map(({ soTien, dienGiai, ...d }) => {
    const dg = dienGiai.join(" ").replace(/\s+/g, " ").trim();
    const k = boDau(dg);
    const laThanhToanNo = RE_THANH_TOAN_NO_THE.test(k);
    const laGhiCo = laThanhToanNo || laDongHoan(k);
    const ghiNo = laGhiCo ? 0 : soTien;
    return {
      ...d,
      ghiNo,
      ghiCo: laGhiCo ? soTien : 0,
      dienGiai: dg,
      laTiktok: !laThanhToanNo && /tiktok/i.test(k) && !RE_DONG_PHI.test(k),
      laThanhToan: laThanhToanNo,
    };
  });
}

function viTriBatBuoc(text: string, re: RegExp, tu: number, ten: string): number {
  const i = text.slice(tu).search(re);
  if (i < 0) hong(`Không thấy mục "${ten}" — file không giống sao kê thẻ tín dụng Techcombank.`);
  return tu + i;
}

function docSaoKe(textGoc: string): SaoKeThe {
  const dongs = textGoc
    .normalize("NFC")
    .replace(/[   ]/g, " ")
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const text = dongs.join("\n");

  if (!/techcombank/i.test(text) || !/Credit Card Account Statement|SAO KÊ TÀI KHOẢN THẺ TÍN DỤNG/i.test(text)) {
    hong("Không phải sao kê thẻ tín dụng Techcombank (chỉ hỗ trợ Techcombank).");
  }

  const iTomTat = viTriBatBuoc(text, /Tóm tắt sao kê|Statement Summary/i, 0, "Tóm tắt sao kê");
  const iChiTiet = viTriBatBuoc(text, /Thông tin chi tiết|Statement details/i, iTomTat, "Thông tin chi tiết");
  const iHet = viTriBatBuoc(
    text,
    /Tổng ghi nợ trong kỳ\s*Total Debit in Period|Kết Thúc Sao Kê|End Of Statement/i,
    iChiTiet,
    "Kết thúc sao kê",
  );

  // Đầu trang: ngày sao kê + hạn mức.
  const dau = text.slice(0, iTomTat);
  const mNgaySaoKe = dau.match(new RegExp(String.raw`(?:Ngày sao kê|Statement date)[^\d]*?${NGAY}`, "i"));
  if (!mNgaySaoKe) hong("Không đọc được Ngày sao kê.");
  const ngaySaoKe = ngayIsoBatBuoc(mNgaySaoKe[1], mNgaySaoKe[2], mNgaySaoKe[3], "Ngày sao kê");
  const mHanMuc = dau.match(/(?:Hạn mức tín dụng|Credit limit)[^\d-]*?(\d{1,3}(?:,\d{3})+|\d+)(?![\d,])/i);
  const hanMuc = mHanMuc ? docSoTien(mHanMuc[1]) : null;
  if (hanMuc === null || hanMuc <= 0) hong("Không đọc được Hạn mức tín dụng.");

  // Khối tóm tắt: đúng 5 số theo thứ tự in + hạn trả.
  const tomTat = text.slice(iTomTat, iChiTiet);
  const so = tomTat
    .split(/\s+/)
    .map((t) => docSoTien(t))
    .filter((n): n is number => n !== null);
  if (so.length !== 5) {
    hong(`Khối "Tóm tắt sao kê" có ${so.length} con số (cần đúng 5: dư nợ kỳ trước, tổng ghi nợ, tổng ghi có, dư nợ cuối kỳ, trả tối thiểu).`);
  }
  const [inDuNoKyTruoc, tongGhiNo, tongGhiCo, inDuNoCuoiKy, traToiThieu] = so;
  if (tongGhiNo < 0 || tongGhiCo < 0 || traToiThieu < 0) hong("Tóm tắt sao kê có tổng ghi nợ/ghi có/trả tối thiểu âm — không nhận.");
  const duNoKyTruoc = doiDauDuNo(inDuNoKyTruoc);
  const duNoCuoiKy = doiDauDuNo(inDuNoCuoiKy);
  const mHanTra = tomTat.match(new RegExp(String.raw`\d{1,2}:\d{2}\s+${NGAY}`)) ?? tomTat.match(new RegExp(NGAY));
  if (!mHanTra) hong("Không đọc được Thời hạn thanh toán.");
  const hanTra = ngayIsoBatBuoc(mHanTra[1], mHanTra[2], mHanTra[3], "Thời hạn thanh toán");

  const mThe = text.match(/Card No:?\s*\d{4,6}\s*\.{2,}\s*(\d{4})\b/i);
  if (!mThe) hong("Không đọc được số cuối thẻ (Card No).");
  const soCuoiThe = mThe[1];

  // Bảng chi tiết: từ sau tiêu đề "Thông tin chi tiết" tới dòng tổng cuối bảng.
  const vung = text.slice(text.indexOf("\n", iChiTiet) + 1, iHet).split("\n");
  const dong = docDongGiaoDich(vung);

  // Dòng tổng cuối bảng (nếu có) phải khớp khối tóm tắt.
  const cuoi = text.slice(iChiTiet);
  const doiChieuCuoi: Array<[RegExp, number, string]> = [
    [/Total Debit in Period:?\s*(-?[\d,]+)/i, tongGhiNo, "tổng ghi nợ"],
    [/Total Credit in Period:?\s*(-?[\d,]+)/i, tongGhiCo, "tổng ghi có"],
    [/Outstanding Balance:?\s*(-?[\d,]+)/i, inDuNoCuoiKy, "số dư cần thanh toán"],
  ];
  for (const [re, mongDoi, ten] of doiChieuCuoi) {
    const m = cuoi.match(re);
    if (m && docSoTien(m[1]) !== mongDoi) {
      hong(`Dòng ${ten} cuối bảng (${m[1]}) khác khối Tóm tắt — file có thể đọc sai.`);
    }
  }

  // CỔNG CHẶN.
  const sumNo = dong.reduce((s, d) => s + d.ghiNo, 0);
  const sumCo = dong.reduce((s, d) => s + d.ghiCo, 0);
  if (sumNo !== tongGhiNo) {
    hong(`Σ ghi nợ ${dong.length} dòng = ${formatVnd(sumNo)} ≠ Tổng ghi nợ trên sao kê ${formatVnd(tongGhiNo)} (lệch ${formatVnd(sumNo - tongGhiNo)}) — không nhận để tránh số sai.`);
  }
  if (sumCo !== tongGhiCo) {
    hong(`Σ ghi có ${dong.length} dòng = ${formatVnd(sumCo)} ≠ Tổng ghi có trên sao kê ${formatVnd(tongGhiCo)} (lệch ${formatVnd(sumCo - tongGhiCo)}) — không nhận để tránh số sai.`);
  }
  if (duNoKyTruoc + tongGhiNo - tongGhiCo !== duNoCuoiKy) {
    hong(`Dư nợ kỳ trước ${formatVnd(duNoKyTruoc)} + ghi nợ ${formatVnd(tongGhiNo)} − ghi có ${formatVnd(tongGhiCo)} ≠ dư nợ cuối kỳ ${formatVnd(duNoCuoiKy)} — không nhận.`);
  }

  return {
    nganHang: "TECHCOMBANK",
    ngaySaoKe,
    soCuoiThe,
    hanMuc,
    duNoKyTruoc,
    tongGhiNo,
    tongGhiCo,
    duNoCuoiKy,
    traToiThieu,
    hanTra,
    dong,
  };
}

export function parseSaoKeTechcombank(text: string): KetQuaParseSaoKe {
  try {
    return { ok: true, saoKe: docSaoKe(text) };
  } catch (e) {
    if (e instanceof LoiDocSaoKe) return { ok: false, loi: e.message };
    throw e;
  }
}
