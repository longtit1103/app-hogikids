/**
 * Mapping Bronze ẢNH CHỤP chi phí quảng cáo một ngày (`/bc/account/cost/get/`, stream `tiktokbusiness/cost`) →
 * Silver `TiktokAdsTinDung` (advertiser × ngày). THUẦN — không DB, không đồng hồ.
 *
 * Đầu vào là các trường đã rút thành CHUỖI trong Postgres (`#>> '{}'` — xem `transform-tiktok-ads-tin-dung.ts`),
 * KHÔNG phải payload đã `JSON.parse`: `advertiser_id` có thể là SỐ JSON 19 chữ số (int64 ⇒ làm tròn). Tiền đo thật
 * 24/10 là SỐ JSON (`"amount":-995050`) — rút qua `#>> '{}'` thành chuỗi `"-995050"`; nhận cả chuỗi lẫn số.
 *
 * DẤU (đo 24/10, ngày 20/10: `amount -995050 · cash_amount -750294 · grant_amount -244756`): endpoint báo CHI PHÍ
 * bằng số ÂM. Silver lưu theo nghĩa "chi phí" ⇒ `chiPhi = −giá trị API` (API âm ⇒ Silver dương). Giá trị DƯƠNG từ
 * API (hoàn/điều chỉnh) ⇒ Silver ÂM — giữ nguyên, không ép 0, không bỏ ảnh chụp: P&L cộng theo ngày rồi tự kẹp.
 *
 * CÙNG advertiser có thể tách NHIỀU dòng trong `cost_list` (đo 24/10) ⇒ PHẢI CỘNG, không lấy dòng đầu; cộng xong
 * mới làm tròn (số có thể lẻ). Ảnh chụp có thể NHIỀU TRANG (`page_size` trần 50): người land gom mọi trang của
 * một ngày vào MỘT dòng Bronze (`bocAnhChupChiPhiTiktok`), mapping kiểm đủ trang rồi mới cộng.
 *
 * Dòng / trang nào không đọc CHẮC CHẮN được thì trả LÝ DO cho CẢ ảnh chụp (người gọi bỏ ảnh + báo đỏ, giữ số cũ),
 * KHÔNG ép 0: ghi tín dụng 0đ cho một ngày thật ra có tín dụng là P&L tính thừa chi phí trong im lặng; ghi THIẾU
 * một dòng của advertiser cũng thế.
 *
 * `tax_amount` của endpoint này KHÔNG dùng (đo 24/10: ngày 23/10 = 95.535 ≠ 10% cash — tính theo phần đã lập hoá
 * đơn, không theo ngày chi tiêu). VAT lấy theo THÁNG từ hoá đơn (`buildVatByMonth`).
 */

/** Một phần tử `cost_list`, giá trị đã rút thành chuỗi (JSON null ⇒ null). Số cũng nhận (gọi thẳng từ code). */
export type DongChiPhiTho = Readonly<Record<string, string | number | null | undefined>>;

/** Đầu mỗi TRANG của ảnh chụp, các trường đã rút thành chuỗi trong Postgres. */
export type TrangChiPhiTho = {
  /** `code` của envelope trang (TikTok trả 0 khi thành công). */
  code: string | null;
  /** `jsonb_typeof(data)` — phải là "object". */
  kieuData: string | null;
  /** `jsonb_typeof(data.cost_list)` — `null` = TikTok bỏ hẳn khoá (trang không có dòng nào). */
  kieuDanhSach: string | null;
  /** `data.page_info.page` — vắng ⇒ coi như đúng thứ tự land. */
  trang: string | null;
  /** `data.page_info.total_page` — vắng ⇒ coi như 1 trang; `"0"` CHỈ hợp lệ với ảnh chụp rỗng (xem `kiemCacTrang`). */
  tongTrang: string | null;
  /**
   * `data.page_info.total_number` — tổng số dòng `cost_list` TikTok báo cho CẢ ảnh chụp (mọi trang, giống nhau mọi
   * trang). Có ⇒ Σ dòng land được phải bằng đúng số này (`kiemCacTrang`); vắng ⇒ chỉ kiểm số trang như trước.
   */
  tongDong?: string | null;
};

/** Ảnh chụp một ngày của một Business Center, như transform đọc từ Bronze. */
export type AnhChupChiPhiTho = {
  /** `shopId` của dòng Bronze = bc_id. */
  bcId: string;
  /** `payload->>'_ngay'` — ngày app bơm lúc land ("YYYY-MM-DD" giờ VN). */
  ngay: string | null;
  /** Các trang đã land, ĐÚNG thứ tự trong `trang` của dòng Bronze. `null` = dòng Bronze không có mảng `trang`. */
  cacTrang: TrangChiPhiTho[] | null;
  /** Mọi phần tử `cost_list` của MỌI trang (nối theo thứ tự trang), đã rút trường (không phải object ⇒ `null`). */
  dong: (DongChiPhiTho | null)[] | null;
};

export type TinDungAdvertiser = {
  advertiserId: string;
  /**
   * Phần trả bằng tín dụng tặng — CHƯA VAT, Int đồng, theo nghĩa CHI PHÍ (= −`grant_amount` của API). Dương = tín
   * dụng đã tiêu; âm = TikTok hoàn/điều chỉnh lại. Đã cộng mọi dòng cùng advertiser rồi mới làm tròn.
   */
  grantExVat: number;
  cashExVat: number;
  amountExVat: number;
  /** Các dòng gốc đã cộng — lưu `raw` để đối chiếu (chuỗi, lossless). */
  nguon: DongChiPhiTho[];
};

export type KetQuaMapAnhChup =
  | { ok: true; ngay: string; ngayLuc: Date; theoAdvertiser: TinDungAdvertiser[] }
  | { ok: false; loi: string };

/** Tiền tệ DUY NHẤT chấp nhận — tài khoản đổi tiền tệ là số sai hàng chục nghìn lần. */
const TIEN_TE_HOP_LE = "VND";

/** Trần cột Postgres INTEGER: vượt thì upsert nổ — báo lý do rõ ràng thay vì lỗi DB mơ hồ. */
const TRAN_INT4 = 2_147_483_647;

/** Khoá mảng bọc ảnh chụp — PHẢI khớp `arrayPath` của stream `tiktokbusiness/cost` (streams.ts) và n8n. */
export const KHOA_MANG_ANH_CHUP = "ban_chup";

/** Khoá mảng các TRANG trong một ảnh chụp ngày — PHẢI khớp `idExpr` (streams.ts), transform và n8n. */
export const KHOA_TRANG_ANH_CHUP = "trang";

/**
 * Bọc TEXT THÔ của MỌI trang `/bc/account/cost/get/` của MỘT ngày thành envelope một phần tử để land Bronze:
 * `{"ban_chup":[{"trang":[<trang 1>,<trang 2>,…]}]}`.
 *
 * NỐI CHUỖI, TUYỆT ĐỐI KHÔNG `JSON.parse` rồi `JSON.stringify` lại (bất biến 6 — int64 như `advertiser_id` bị làm
 * tròn, thứ tự key đổi ⇒ hash đổi). Postgres tự `::jsonb` cả khối. Text không phải JSON ⇒ Postgres ném khi land —
 * kêu to đúng chỗ. Bản soi gương trong `n8n/tiktok-business-nightly.json` (`bocAnhChup`) phải đổi cùng.
 */
export function bocAnhChupChiPhiTiktok(cacTrang: string | readonly string[]): string {
  const ds = typeof cacTrang === "string" ? [cacTrang] : [...cacTrang];
  if (ds.length === 0 || ds.some((t) => typeof t !== "string" || t.trim() === "")) {
    throw new Error("Body /bc/account/cost/get/ rỗng — không có gì để land.");
  }
  return `{"${KHOA_MANG_ANH_CHUP}":[{"${KHOA_TRANG_ANH_CHUP}":[${ds.join(",")}]}]}`;
}

/**
 * Số trang của ảnh chụp chi phí, đọc từ `data` (đã parse — CHỈ để điều khiển vòng lặp trang, text land vẫn là bản
 * thô) của trang `page`. Ngày KHÔNG chi tiêu (đo 24/10: 15/07, 20/07, 05/08/2026) TikTok trả `cost_list: []` +
 * `page_info {page:1, total_number:0, total_page:0}` ⇒ đúng MỘT trang rỗng, vẫn land (để app gỡ số cũ).
 * `total_page = 0` mà có dòng / `total_number` ≠ 0 / không phải trang 1 ⇒ ném (mâu thuẫn, không land). Người kéo
 * trang của script backfill dùng thẳng hàm này; bản soi gương trong n8n `tiktok-business-nightly.json`
 * (`soTrangChiPhi`) phải đổi cùng. Mapping kiểm lại lần nữa ở `kiemCacTrang`.
 */
export function soTrangAnhChupChiPhi(data: Readonly<Record<string, unknown>> | undefined, page: number): number {
  const pi = (data?.page_info ?? {}) as { total_page?: unknown; total_number?: unknown };
  if (pi.total_page !== undefined && pi.total_page !== null && Number(pi.total_page) === 0) {
    const ds = data?.cost_list;
    const soDong = Array.isArray(ds) ? ds.length : 0;
    if (page !== 1 || soDong !== 0 || Number(pi.total_number) !== 0) {
      throw new Error(
        `/bc/account/cost/get/: total_page 0 mà trang ${page} có ${soDong} dòng, total_number ${String(pi.total_number)} — mâu thuẫn, không land.`,
      );
    }
    return 1;
  }
  return Number(pi.total_page || 1);
}

function chuoi(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Tiền CHƯA VAT của API (chuỗi hay số, CÓ DẤU, có thể lẻ) → số. Rác / thiếu ⇒ lý do lỗi. CHƯA đổi dấu, CHƯA làm
 * tròn — đổi dấu + làm tròn SAU khi cộng các dòng cùng advertiser (làm tròn từng dòng là lệch 1đ mỗi dòng).
 */
export function tienApi(
  v: string | number | null | undefined,
  ten: string,
): { ok: true; so: number } | { ok: false; loi: string } {
  const s = chuoi(v);
  if (s === null) return { ok: false, loi: `thiếu ${ten}` };
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return { ok: false, loi: `${ten} "${s}" không phải số` };
  const so = Number(s);
  if (!Number.isFinite(so) || Math.abs(so) > TRAN_INT4) return { ok: false, loi: `${ten} "${s}" vượt trần số nguyên` };
  return { ok: true, so };
}

/** Tổng API (có dấu, số thực) → chi phí Int: đổi dấu rồi làm tròn; `+ 0` để −0 thành 0. */
function chiPhiTuApi(tongApi: number): number {
  return Math.round(-tongApi) + 0;
}

/** "YYYY-MM-DD" có thật trên lịch (khuôn đúng mà 2026-02-31 vẫn lọt regex). */
export function laNgayCoThat(ngay: string | null | undefined): ngay is string {
  if (typeof ngay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ngay)) return false;
  const [nam, thang, ngayTrongThang] = ngay.split("-").map(Number);
  const d = new Date(Date.UTC(nam, thang - 1, ngayTrongThang));
  return d.getUTCFullYear() === nam && d.getUTCMonth() === thang - 1 && d.getUTCDate() === ngayTrongThang;
}

/**
 * Phần P&L trừ ra = round(grant × (1 + VAT)). VAT là suất mà `Expense` ads đã nhân lên TOÀN BỘ chi tiêu (gồm cả
 * phần tín dụng) ⇒ trừ đúng phần đó khỏi chi phí. TikTok chỉ đánh VAT trên phần tiền mặt, nên phần VAT "trên tín
 * dụng" cũng không phải tiền shop mất. Grant âm (TikTok hoàn) ⇒ kết quả âm, cùng phép nhân.
 */
export function tinhGrantGomVat(grantExVat: number, vatRate: number): number {
  return Math.round(grantExVat * (1 + vatRate)) + 0;
}

/**
 * Kiểm đủ trang + mọi trang đều là kết quả THÀNH CÔNG + đủ DÒNG. `null` = ổn. `soDong` = tổng phần tử `cost_list`
 * của mọi trang.
 *
 * Ngày KHÔNG chi tiêu (đo 24/10 các ngày 15/07, 20/07, 05/08/2026): TikTok trả `cost_list: []` kèm
 * `page_info {page:1, total_number:0, total_page:0}` — đúng MỘT trang rỗng. Đó là ảnh chụp RỖNG HỢP LỆ (tin "ngày này
 * không còn gì", để gỡ số cũ), KHÔNG phải lỗi: từ chối nó là bỏ ảnh chụp + báo đỏ MỖI ĐÊM có BC không chạy ads, và
 * ngày TikTok chỉnh hồi tố về 0 không bao giờ gỡ được tín dụng cũ. `total_page = 0` mà có dòng / `total_number` ≠ 0
 * / nhiều trang thì mâu thuẫn ⇒ lỗi.
 *
 * Đủ trang CHƯA đủ: một trang `{total_page 1, total_number 5}` mà vắng `cost_list` từng lọt như ảnh chụp RỖNG ⇒
 * người ghi `deleteMany` gỡ sạch tín dụng của BC ngày đó. Vì vậy: `total_number` có mặt thì Σ dòng mọi trang phải
 * bằng ĐÚNG số đó, `total_number` phải giống nhau mọi trang, và trang vắng hẳn `cost_list` chỉ được nhận khi
 * `total_number = 0` (không có `total_number` thì không chứng minh được "ngày rỗng"). Từ chối ⇒ người gọi bỏ CẢ ảnh
 * chụp (số cũ giữ nguyên, `skipped` ⇒ báo đỏ) — chiều an toàn: thiếu một đêm tín dụng là P&L tạm tính THỪA chi phí,
 * đêm sau ảnh chụp đủ tự ghi lại.
 */
function kiemCacTrang(cacTrang: TrangChiPhiTho[] | null, soDong: number): string | null {
  if (cacTrang === null || cacTrang.length === 0) return "ảnh chụp không có trang nào";
  const tong = chuoi(cacTrang[0]?.tongTrang) ?? "1";
  const tongDong = chuoi(cacTrang[0]?.tongDong);
  if (tong === "0") {
    if (cacTrang.length !== 1) return `total_page 0 mà land ${cacTrang.length} trang`;
    if (soDong !== 0) return `total_page 0 mà cost_list có ${soDong} dòng`;
    if (tongDong !== "0") return `total_page 0 mà total_number "${tongDong ?? ""}" (phải là 0)`;
  } else if (!/^[1-9]\d*$/.test(tong)) {
    return `total_page "${tong}" không hợp lệ`;
  } else if (Number(tong) !== cacTrang.length) {
    return `ảnh chụp có ${tong} trang mà chỉ land ${cacTrang.length} — thiếu advertiser, không ghi nửa ngày`;
  }
  for (let i = 0; i < cacTrang.length; i++) {
    const t = cacTrang[i];
    if (!t || chuoi(t.code) !== "0") return `trang ${i + 1}: code "${t?.code ?? ""}" không phải 0 (body lỗi)`;
    if (t.kieuData !== "object") return `trang ${i + 1}: data là "${t.kieuData ?? "null"}", không phải object`;
    if (t.kieuDanhSach !== null && t.kieuDanhSach !== "array") {
      return `trang ${i + 1}: data.cost_list là "${t.kieuDanhSach}", không phải mảng`;
    }
    const soTrang = chuoi(t.trang);
    if (soTrang !== null && Number(soTrang) !== i + 1) return `trang thứ ${i + 1} mang page_info.page = ${soTrang}`;
    if ((chuoi(t.tongTrang) ?? "1") !== tong) return `trang ${i + 1}: total_page lệch trang đầu`;
    if (chuoi(t.tongDong) !== tongDong) return `trang ${i + 1}: total_number lệch trang đầu`;
  }
  if (tongDong !== null) {
    if (!/^\d+$/.test(tongDong)) return `total_number "${tongDong}" không hợp lệ`;
    const bao = Number(tongDong);
    if (soDong < bao) return `ảnh chụp thiếu dòng (${soDong}/${bao}) — không ghi nửa ngày, giữ số cũ`;
    if (soDong > bao) return `ảnh chụp thừa dòng (${soDong}/${bao}) — không nhất quán, giữ số cũ`;
  }
  const trangVang = cacTrang.findIndex((t) => t.kieuDanhSach === null);
  if (trangVang !== -1 && tongDong !== "0") {
    return `trang ${trangVang + 1} không có cost_list mà total_number "${tongDong ?? ""}" (chỉ hợp lệ khi bằng 0)`;
  }
  return null;
}

/** Ảnh chụp một ngày → các dòng Silver theo advertiser (đã cộng, theo nghĩa chi phí). */
export function mapAnhChupChiPhiTiktok(a: AnhChupChiPhiTho): KetQuaMapAnhChup {
  if (!chuoi(a.bcId)) return { ok: false, loi: "thiếu bc_id (shopId Bronze)" };
  const ngay = a.ngay;
  if (!laNgayCoThat(ngay)) return { ok: false, loi: `ngày ảnh chụp "${ngay ?? ""}" không phải YYYY-MM-DD có thật` };

  // TikTok BỎ HẲN khoá mảng khi trang rỗng (cùng thói quen của endpoint report) ⇒ trang đó không có dòng nào.
  const dong = a.dong ?? [];
  const loiTrang = kiemCacTrang(a.cacTrang, dong.length);
  if (loiTrang !== null) return { ok: false, loi: loiTrang };

  const gop = new Map<string, { grant: number; cash: number; amount: number; nguon: DongChiPhiTho[] }>();
  for (let i = 0; i < dong.length; i++) {
    const d = dong[i];
    if (!d || typeof d !== "object") return { ok: false, loi: `cost_list[${i}] không phải object` };
    const advertiserId = chuoi(d.advertiser_id);
    if (advertiserId === null) return { ok: false, loi: `cost_list[${i}] thiếu advertiser_id` };
    const tienTe = chuoi(d.currency);
    if (tienTe !== null && tienTe !== TIEN_TE_HOP_LE) {
      return { ok: false, loi: `cost_list[${i}] (${advertiserId}) tiền tệ "${tienTe}", không phải VND` };
    }
    const grant = tienApi(d.grant_amount, "grant_amount");
    if (!grant.ok) return { ok: false, loi: `cost_list[${i}] (${advertiserId}): ${grant.loi}` };
    const cash = tienApi(d.cash_amount, "cash_amount");
    if (!cash.ok) return { ok: false, loi: `cost_list[${i}] (${advertiserId}): ${cash.loi}` };
    const amount = tienApi(d.amount, "amount");
    if (!amount.ok) return { ok: false, loi: `cost_list[${i}] (${advertiserId}): ${amount.loi}` };

    const g = gop.get(advertiserId) ?? { grant: 0, cash: 0, amount: 0, nguon: [] };
    g.grant += grant.so;
    g.cash += cash.so;
    g.amount += amount.so;
    g.nguon.push(d);
    gop.set(advertiserId, g);
  }

  const theoAdvertiser: TinDungAdvertiser[] = [];
  for (const [advertiserId, g] of gop) {
    const grantExVat = chiPhiTuApi(g.grant);
    const cashExVat = chiPhiTuApi(g.cash);
    const amountExVat = chiPhiTuApi(g.amount);
    if (Math.max(Math.abs(grantExVat), Math.abs(cashExVat), Math.abs(amountExVat)) > TRAN_INT4) {
      return { ok: false, loi: `advertiser ${advertiserId}: tổng vượt trần số nguyên` };
    }
    theoAdvertiser.push({ advertiserId, grantExVat, cashExVat, amountExVat, nguon: g.nguon });
  }
  theoAdvertiser.sort((x, y) => x.advertiserId.localeCompare(y.advertiserId));

  return {
    ok: true,
    ngay,
    // Neo 00:00 giờ VN — CÙNG neo `Expense.date` của dòng ads (`prepareAdsExpenseRow`) ⇒ P&L lọc chung một biên kỳ.
    ngayLuc: new Date(`${ngay}T00:00:00+07:00`),
    theoAdvertiser,
  };
}
