import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { BC_ID_TIKTOK_HOP_LE } from "@/lib/bronze/khuon-bc-id-tiktok";

/**
 * DẤU LƯỢT kéo hoá đơn TikTok Business — n8n gửi qua `POST /api/ingest/luot-hoa-don-tiktok`, MỖI BC MỖI LƯỢT hai dấu:
 *  - `bat-dau`: TRƯỚC lần GET hoá đơn đầu tiên của BC — lượt hỏng ngay trang 1 (timeout, lỗi tham số) hay n8n chết
 *    giữa chừng vẫn để lại dấu bắt đầu, cổng thấy lượt mới chưa kết thúc thay vì dùng lượt sạch cũ;
 *  - `ket-thuc`: sau trang cuối, khi lượt đứt giữa chừng, hoặc khi TikTok báo BC thiếu quyền finance — kèm số liệu để
 *    app TỰ kiểm đủ trang và `ketQua` nói n8n dừng vì sao (KHÔNG suy từ số đếm: BC 0 hoá đơn và BC thiếu quyền đều có
 *    0 trang land, nhưng một bên là dữ liệu đủ, một bên là không đọc được).
 * Route ghi mỗi dấu thành một dòng `SyncLog` kind `TIKTOK_ADS`, `stats` cùng `stream`/`shopId` (= bc_id) với trang hoá
 * đơn + `luotId` + `giaiDoan` + `mode` (`luot-bat-dau` | `luot-ket-thuc`), và ghi nhận BC vào bảng bền
 * `TiktokBcHoaDon` (`bc-tiktok-hoa-don.ts`: lần đầu có dấu, lần cuối đọc được) — trạng thái cổng cần nhớ quá cửa sổ
 * D − 30 của `SyncLog`.
 *
 * Vì sao cần: trang bị 400/413/502/timeout TRƯỚC khi có SyncLog thì cổng chốt sao kê thẻ không thấy, n8n ghi lỗi rồi
 * đi tiếp ⇒ lượt trông "sạch" dù thiếu hoá đơn; lượt đang chạy dở cũng trông như sạch. Dấu kết thúc nói lượt ĐÃ XONG
 * và đã GET/land bao nhiêu trang; cổng đối số trang n8n khai với số trang OK chính app ghi nhận (`xetLuotCoDau`).
 *
 * Khuôn fail-closed: thiếu/thừa khoá, sai kiểu, số âm, cộng không khớp ⇒ 400, KHÔNG ghi dòng nào (cổng thấy "chưa có
 * dấu kết thúc" ⇒ chặn).
 *
 * PHẠM VI THỜI GIAN (`phamVi`, mang ở CẢ hai dấu): đúng `filtering{start_time, end_time}` n8n đã gửi GET
 * `/bc/account/transaction/get/` của lượt — cổng chỉ nhận lượt làm bằng chứng cho ngày sao kê D khi phạm vi PHỦ trọn D
 * (`phamViPhuNgayVn`). Ở dấu bắt đầu để lượt chết giữa chừng (không dấu kết thúc) vẫn biết là lượt phủ D ⇒ chặn, không để
 * lượt phủ D cũ hơn che; ở dấu kết thúc để số liệu "đủ" và phạm vi được khai cùng nhau — hai dấu phải khai TRÙNG nhau.
 * Vắng `phamVi` (workflow bản trước khi có phạm vi) ⇒ route VẪN nhận (lượt hỏng vẫn hiện ra với cổng) nhưng lượt đó
 * KHÔNG BAO GIỜ là bằng chứng; có mà sai khuôn ⇒ 400 (n8n hỏng, kêu to).
 */

/** Stream của trang hoá đơn — dấu lượt dùng CHUNG để cổng đọc trang + dấu bằng một câu truy vấn. */
export const STREAM_HOA_DON_TIKTOK = "tiktokbusiness/invoice";
export const MODE_DAU_BAT_DAU = "luot-bat-dau";
export const MODE_DAU_KET_THUC = "luot-ket-thuc";

/** Khuôn `luotId` (id execution n8n) — dùng chung route trang (`/api/ingest/raw`) và route dấu lượt. */
export const LUOT_ID_HOP_LE = /^[A-Za-z0-9_-]{1,64}$/;
/** n8n kéo tối đa 50 trang mỗi BC (trần trong jsCode); nới gấp đôi để không 400 oan nếu sau này nâng trần. */
const TRAN_SO_TRANG = 100;
const soTrang = z.number().int().min(0).max(TRAN_SO_TRANG);
/** Trần `total_number` cùng cỡ trần `total_page` (10 000 trang × 50 hoá đơn) — chỉ chặn số rác. */
const TRAN_TONG_HOA_DON_NGUON = 10_000 * 50;

/**
/**
 * Múi giờ của chuỗi giờ treo tường trong `phamVi` — n8n tính `start_time`/`end_time` theo lịch VN. Hợp đồng cố định:
 * n8n đổi cách tính thì phải đổi hằng này (dấu khác múi ⇒ 400), không ngầm hiểu.
 */
export const MUI_GIO_PHAM_VI_HOA_DON = "UTC+07:00";

/**
 * TikTok KHÔNG ghi rõ `filtering.start_time/end_time` hiểu theo múi nào. Cách hiểu có thể: múi của ad account/BC (giờ VN
 * — chủ shop xác nhận 14/07; hoá đơn trả `timezone` "UTC+07:00") hoặc UTC. Cổng xét BẢO THỦ: phạm vi phải phủ ngày D
 * theo MỌI cách hiểu trong danh sách (phút lệch so với UTC). Phủ được hai đầu mút là phủ mọi múi ở giữa (+0 … +7).
 */
const CACH_HIEU_MUI_NGUON_PHUT = [7 * 60, 0] as const;
const MOT_NGAY_MS = 24 * 3600 * 1000;
const KHUON_GIO_TREO_TUONG = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** "YYYY-MM-DD HH:MM:SS" ⇒ mili giây nếu đọc như giờ UTC (giờ treo tường, chưa gắn múi); sai khuôn / ngày không có ⇒ null. */
function msGioTreoTuong(s: string): number | null {
  const m = KHUON_GIO_TREO_TUONG.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") === s ? ms : null;
}

const gioTreoTuong = z.string().refine((s) => msGioTreoTuong(s) !== null, "phải là giờ có thật dạng YYYY-MM-DD HH:MM:SS");

const phamViSchema = z
  .strictObject({
    /** Đúng `filtering.start_time` đã gửi GET hoá đơn. */
    startTime: gioTreoTuong,
    /** Đúng `filtering.end_time` đã gửi GET hoá đơn. */
    endTime: gioTreoTuong,
    muiGio: z.literal(MUI_GIO_PHAM_VI_HOA_DON),
  })
  .refine((p) => (msGioTreoTuong(p.startTime) ?? 0) < (msGioTreoTuong(p.endTime) ?? 0), "startTime phải trước endTime");

export type PhamViHoaDon = z.infer<typeof phamViSchema>;

/**
 * Phạm vi `p` PHỦ TRỌN ngày `ngay` (YYYY-MM-DD, giờ VN: [D 00:00, D+1 00:00) VN) theo MỌI cách hiểu múi của nguồn
 * (`CACH_HIEU_MUI_NGUON_PHUT`). Coi `endTime` là mốc LOẠI TRỪ (bảo thủ — TikTok không nói rõ có lấy đúng giây cuối):
 * phải ≥ D+1 00:00. Nghĩa là `startTime` ≤ "D−1 17:00:00" (cách hiểu UTC trói) và `endTime` ≥ "D+1 00:00:00" (cách hiểu
 * giờ VN trói).
 */
export function phamViPhuNgayVn(p: PhamViHoaDon, ngay: string): boolean {
  return phuTheoCachHieu(p, ngay, "moi");
}

/**
 * Vị từ LỎNG: phạm vi `p` phủ trọn ngày `ngay` theo ÍT NHẤT MỘT cách hiểu múi của nguồn — lượt như vậy CÓ THỂ đã hỏi
 * TikTok về D (vd start "D 00:00:00": phủ D nếu nguồn hiểu giờ VN). Dùng để quyết lượt nào là "lượt phủ D" khi xét lượt
 * phủ D sau cùng có hỏng không (hỏng ⇒ chặn, lượt cũ không che); KHÔNG đủ để làm bằng chứng (cần `phamViPhuNgayVn`).
 */
export function phamViCoThePhuNgayVn(p: PhamViHoaDon, ngay: string): boolean {
  return phuTheoCachHieu(p, ngay, "mot");
}

function phuTheoCachHieu(p: PhamViHoaDon, ngay: string, cach: "moi" | "mot"): boolean {
  const tu = msGioTreoTuong(p.startTime);
  const den = msGioTreoTuong(p.endTime);
  const dauNgay = Date.parse(`${ngay}T00:00:00+07:00`);
  if (tu === null || den === null || Number.isNaN(dauNgay)) return false;
  const phu = (lech: number) => tu - lech * 60_000 <= dauNgay && den - lech * 60_000 >= dauNgay + MOT_NGAY_MS;
  return cach === "moi" ? CACH_HIEU_MUI_NGUON_PHUT.every(phu) : CACH_HIEU_MUI_NGUON_PHUT.some(phu);
}

/** `stats.phamVi` của một dòng dấu ⇒ phạm vi, `null` (vắng — dấu bản cũ), hoặc `"sai"` (có mà sai khuôn). */
export function docPhamVi(stats: Prisma.JsonValue | null): PhamViHoaDon | null | "sai" {
  if (stats === null || typeof stats !== "object" || Array.isArray(stats)) return null;
  if (stats.phamVi === undefined || stats.phamVi === null) return null;
  const kq = phamViSchema.safeParse(stats.phamVi);
  return kq.success ? kq.data : "sai";
}

/**
 * Vì sao n8n dừng lượt của BC:
 *  - `xong`: đi hết phân trang (dừng vì `page ≥ total_page`) — kể cả cửa sổ 0 hoá đơn (`total_page 0`);
 *  - `loi`: GET/phân trang đứt (timeout, lỗi tham số, quá trần trang…) — kể cả ngay trang 1;
 *  - `khong-quyen-finance`: TikTok trả lỗi mà THÔNG ĐIỆP nói thiếu quyền finance (luật `laThieuQuyenFinance` của
 *    jsCode, không khớp `permission` trơn) ngay trang 1, chưa GET được trang nào.
 */
export const KET_QUA_LUOT = ["xong", "loi", "khong-quyen-finance"] as const;
export const KET_QUA_KHONG_QUYEN_FINANCE = "khong-quyen-finance" satisfies (typeof KET_QUA_LUOT)[number];

const thanBatDau = z.strictObject({
  luotId: z.string().regex(LUOT_ID_HOP_LE),
  bcId: z.string().regex(BC_ID_TIKTOK_HOP_LE),
  giaiDoan: z.literal("bat-dau"),
  phamVi: phamViSchema.optional(),
});

const thanKetThuc = z.strictObject({
  luotId: z.string().regex(LUOT_ID_HOP_LE),
  bcId: z.string().regex(BC_ID_TIKTOK_HOP_LE),
  giaiDoan: z.literal("ket-thuc"),
  phamVi: phamViSchema.optional(),
  /** `page_info.total_page` nguồn báo ở trang GET cuối; null = nguồn không báo (cổng chặn — không kiểm được đủ trang). */
  tongTrangNguon: z.number().int().min(0).max(10_000).nullable(),
  /** Số trang GET được (`code = 0`). */
  soTrangDaGet: soTrang,
  /** Số trang có hoá đơn mà POST `/api/ingest/raw` trả 2xx. */
  soTrangLand: soTrang,
  /** Số trang GET được nhưng `transaction_list` rỗng (n8n không land trang rỗng). */
  soTrangRong: soTrang,
  /** Số trang có hoá đơn mà POST land hỏng (400/413/5xx/timeout…). */
  soTrangLoi: soTrang,
  /**
   * `page_info.total_number` nguồn báo ở trang GET cuối; null = nguồn không báo (bỏ qua phép đối số hoá đơn, các phép
   * đối số trang vẫn áp).
   */
  tongHoaDonNguon: z.number().int().min(0).max(TRAN_TONG_HOA_DON_NGUON).nullable(),
  /** Số hoá đơn nằm trên các trang land OK (POST 2xx) — trang land hỏng không cộng. */
  soHoaDon: z.number().int().min(0).max(TRAN_SO_TRANG * 50),
  /** n8n đi hết phân trang (dừng vì `page ≥ total_page`), không đứt giữa chừng. Phải khớp `ketQua` (`xong` ⇔ true). */
  hoanTat: z.boolean(),
  /** Vì sao n8n dừng lượt (`KET_QUA_LUOT`). */
  ketQua: z.enum(KET_QUA_LUOT),
  /** Lỗi n8n gặp trong lượt của BC (dấu bắt đầu không tới app, GET đứt…) — rỗng khi sạch. */
  loi: z.array(z.string().max(500)).max(20),
});

const thanDauLuot = z.discriminatedUnion("giaiDoan", [thanBatDau, thanKetThuc]);

export type SoLieuKetThuc = Omit<z.infer<typeof thanKetThuc>, "luotId" | "bcId" | "giaiDoan" | "phamVi">;
export type ThanDauLuot = z.infer<typeof thanDauLuot>;

/**
 * Số liệu kết thúc tự mâu thuẫn ⇒ câu lỗi (null = nhất quán). Dùng chung khi route nhận dấu và khi cổng đọc lại
 * `stats` đã lưu:
 *  - `soTrangLand + soTrangRong + soTrangLoi = soTrangDaGet` (mỗi trang GET được rơi vào đúng một ngăn);
 *  - `ketQua` khớp `hoanTat`: `xong` ⇔ `hoanTat` true; `loi` phải kèm ít nhất một câu lỗi;
 *  - `khong-quyen-finance`: chưa GET được trang nào (0 trang, 0 hoá đơn, nguồn chưa báo số nào) + kèm thông điệp
 *    TikTok — BC đã GET được trang mà sau đó báo thiếu quyền là chuyện khác, n8n phải khai `loi`.
 * Lệch là n8n đếm/phân loại sai, không tin được số nào.
 */
function mauThuanKetThuc(d: SoLieuKetThuc): string | null {
  if (d.soTrangLand + d.soTrangRong + d.soTrangLoi !== d.soTrangDaGet) {
    return (
      `soTrangLand (${d.soTrangLand}) + soTrangRong (${d.soTrangRong}) + soTrangLoi (${d.soTrangLoi}) phải bằng ` +
      `soTrangDaGet (${d.soTrangDaGet})`
    );
  }
  if ((d.ketQua === "xong") !== d.hoanTat) return `ketQua '${d.ketQua}' không khớp hoanTat ${d.hoanTat}`;
  if (d.ketQua !== "xong" && d.loi.length === 0) return `ketQua '${d.ketQua}' phải kèm ít nhất một câu lỗi`;
  if (
    d.ketQua === KET_QUA_KHONG_QUYEN_FINANCE &&
    (d.soTrangDaGet !== 0 || d.soHoaDon !== 0 || d.tongTrangNguon !== null || d.tongHoaDonNguon !== null)
  ) {
    return "ketQua 'khong-quyen-finance' chỉ hợp lệ khi chưa GET được trang nào (0 trang, 0 hoá đơn, nguồn chưa báo số)";
  }
  return null;
}

/**
 * Thân POST ⇒ dấu lượt hợp lệ, hoặc câu lỗi (400). Ngoài khuôn từng trường, dấu kết thúc phải nhất quán
 * (`mauThuanKetThuc`).
 */
export function docThanDauLuot(raw: unknown): { ok: true; dau: ThanDauLuot } | { ok: false; loi: string } {
  const kq = thanDauLuot.safeParse(raw);
  if (!kq.success) {
    const dau = kq.error.issues[0];
    const truong = dau?.path.join(".") || "thân";
    return { ok: false, loi: `dấu lượt hoá đơn sai khuôn ở '${truong}': ${dau?.message ?? "không hợp lệ"}` };
  }
  const d = kq.data;
  if (d.giaiDoan === "ket-thuc") {
    const mauThuan = mauThuanKetThuc(d);
    if (mauThuan !== null) return { ok: false, loi: `dấu kết thúc sai: ${mauThuan}` };
  }
  return { ok: true, dau: d };
}

/**
 * Lý do lượt CHƯA ĐỦ theo chính số n8n khai (rỗng = n8n báo đủ). Route dùng để đánh dòng dấu ERROR (bật banner đồng
 * bộ); cổng dùng lại trên `stats` đã lưu — không tin trạng thái dòng một mình.
 *  - n8n báo lỗi / có trang land hỏng / không đi hết phân trang;
 *  - nguồn không báo `total_page`;
 *  - số trang GET < `max(total_page, 1)` (TikTok trả `total_page 0` khi cửa sổ rỗng nhưng n8n vẫn GET trang 1);
 *  - nguồn báo ≥ 1 trang mà có trang GET về RỖNG: cửa sổ rỗng hợp lệ là `total_page 0`; còn `total_page ≥ 1` mà trang
 *    không có mảng hoá đơn là nguồn trục trặc hoặc đổi tên khoá mảng — n8n không land gì, app thấy 0 trang OK = 0 khai
 *    nên các phép đối trang khác đều mù;
 *  - nguồn báo `total_number` mà số hoá đơn đã land OK ít hơn (nhận ≥ — hoá đơn mới về giữa lượt làm trang xô);
 *  - nguồn TỰ MÂU THUẪN: báo `total_page 0` hoặc `total_number 0` mà có trang mang hoá đơn (land OK hay hỏng). n8n
 *    dừng phân trang theo `total_page` (`|| 1`) nên nguồn báo 0 sai là chỉ GET trang 1 — số thật có thể nhiều trang.
 */
export function lyDoKetThucChuaDu(s: SoLieuKetThuc): string[] {
  const ly: string[] = [...s.loi];
  if (s.soTrangLoi > 0) ly.push(`${s.soTrangLoi} trang hoá đơn land hỏng`);
  if (!s.hoanTat) ly.push("n8n chưa đi hết phân trang (lượt đứt giữa chừng)");
  if (s.tongTrangNguon === null) ly.push("nguồn không báo total_page — không kiểm được đủ trang");
  else if (s.soTrangDaGet < Math.max(s.tongTrangNguon, 1)) {
    ly.push(`mới GET ${s.soTrangDaGet}/${Math.max(s.tongTrangNguon, 1)} trang nguồn báo`);
  }
  if (s.tongTrangNguon !== null && s.tongTrangNguon > 0 && s.soTrangRong > 0) {
    ly.push(`nguồn báo ${s.tongTrangNguon} trang mà ${s.soTrangRong} trang GET về rỗng (không có mảng hoá đơn)`);
  }
  if (s.tongHoaDonNguon !== null && s.soHoaDon < s.tongHoaDonNguon) {
    ly.push(`mới land ${s.soHoaDon}/${s.tongHoaDonNguon} hoá đơn nguồn báo`);
  }
  const soTrangCoHoaDon = s.soTrangLand + s.soTrangLoi;
  if (soTrangCoHoaDon > 0 && (s.tongTrangNguon === 0 || s.tongHoaDonNguon === 0)) {
    ly.push(
      `nguồn tự mâu thuẫn: báo total_page ${s.tongTrangNguon ?? "?"} / total_number ${s.tongHoaDonNguon ?? "?"} mà ` +
        `${soTrangCoHoaDon} trang có hoá đơn — không tin được số trang nguồn báo`,
    );
  }
  return ly;
}

/**
 * `stats` dòng dấu kết thúc ⇒ số liệu n8n khai (qua đúng khuôn + phép nhất quán route nhận); sai ⇒ null (cổng chặn).
 * Dòng dấu ghi bởi bản app trước khi có `ketQua` thiếu khoá này ⇒ null ⇒ chặn (lượt đó coi như không kiểm được).
 */
export function docSoLieuKetThuc(stats: Prisma.JsonValue | null): SoLieuKetThuc | null {
  if (stats === null || typeof stats !== "object" || Array.isArray(stats)) return null;
  const kq = thanKetThuc.omit({ luotId: true, bcId: true, giaiDoan: true, phamVi: true }).safeParse({
    tongTrangNguon: stats.tongTrangNguon,
    tongHoaDonNguon: stats.tongHoaDonNguon,
    soTrangDaGet: stats.soTrangDaGet,
    soTrangLand: stats.soTrangLand,
    soTrangRong: stats.soTrangRong,
    soTrangLoi: stats.soTrangLoi,
    soHoaDon: stats.soHoaDon,
    hoanTat: stats.hoanTat,
    ketQua: stats.ketQua,
    loi: stats.loi,
  });
  return kq.success && mauThuanKetThuc(kq.data) === null ? kq.data : null;
}

/** Một dòng SyncLog thuộc một lượt (trang hoá đơn hoặc dấu lượt) — đủ để `xetLuotCoDau` xét. */
export type DongCuaLuot = { status: string; mode: string | null; stats: Prisma.JsonValue | null };

export type KetQuaLuotCoDau =
  | { loai: "du" }
  /** Có trang hoá đơn ERROR. */
  | { loai: "trang-loi" }
  /** Dấu kết thúc báo lỗi / chưa đủ (theo dòng ERROR hoặc theo số khai). */
  | { loai: "bao-loi"; chiTiet: string }
  /** Còn dòng RUNNING (đang chạy hoặc chết giữa chừng chưa dọn). */
  | { loai: "dang-chay" }
  /** Không có dấu bắt đầu (workflow bản cũ, dấu không tới app, trang mang mã lượt lạ). */
  | { loai: "thieu-bat-dau" }
  /** Có dấu bắt đầu mà chưa có dấu kết thúc. */
  | { loai: "chua-ket-thuc" }
  /** Số trang app ghi nhận không khớp số n8n khai, hoặc dấu trùng/sai khuôn. */
  | { loai: "khong-khop"; chiTiet: string }
  /**
   * Đủ dấu, TikTok báo BC thiếu quyền finance ngay trang 1 (không đọc được hoá đơn). Lượt KHÔNG đủ ⇒ cổng CHẶN: "mất
   * quyền" (BC đã từng đọc được) hoặc "chưa xác nhận" (chưa từng) — trừ khi chủ shop đánh dấu BC "không dùng thẻ".
   */
  | { loai: "khong-quyen-finance"; chiTiet: string };

const laDau = (d: DongCuaLuot) => d.mode === MODE_DAU_BAT_DAU || d.mode === MODE_DAU_KET_THUC;

const cungPhamVi = (a: PhamViHoaDon | null, b: PhamViHoaDon | null): boolean =>
  a === null || b === null ? a === b : a.startTime === b.startTime && a.endTime === b.endTime && a.muiGio === b.muiGio;

/**
 * Xét MỘT lượt (mọi dòng cùng `luotId` của một BC) theo luật dấu lượt. ĐỦ khi đồng thời:
 *  1. không trang hoá đơn nào ERROR/RUNNING, không dấu nào ERROR/RUNNING;
 *  2. đúng một dấu bắt đầu + đúng một dấu kết thúc;
 *  3. số khai ở dấu kết thúc báo đủ (`lyDoKetThucChuaDu` rỗng: 0 lỗi, đi hết phân trang, GET ≥ total_page, không trang
 *     rỗng khi nguồn báo ≥ 1 trang, land đủ total_number);
 *  4. số trang OK app ghi nhận cho lượt = `soTrangLand` n8n khai — trang mất TRƯỚC khi có SyncLog (502/timeout) làm
 *     app thấy ít hơn; n8n không biết trang đó hỏng thì chỉ phép đối này bắt được;
 *  5. phạm vi thời gian hai dấu khai TRÙNG nhau (cùng vắng — dấu bản cũ — cũng tính là trùng; lượt đó ĐỦ nhưng không bao
 *     giờ là bằng chứng phủ ngày sao kê, xem `timLuotPhuNgay`).
 * Lượt 0 hoá đơn hợp lệ (nguồn `total_page 0`, n8n GET 1 trang rỗng, land 0, `ketQua` `xong`) ⇒ ĐỦ.
 * Lượt `ketQua` `khong-quyen-finance` (đủ hai dấu, không trang nào) ⇒ `khong-quyen-finance`; có trang hoá đơn mang mã
 * lượt đó mà n8n lại khai thiếu quyền ⇒ `khong-khop`.
 */
export function xetLuotCoDau(dong: readonly DongCuaLuot[]): KetQuaLuotCoDau {
  const trang = dong.filter((d) => !laDau(d));
  const batDau = dong.filter((d) => d.mode === MODE_DAU_BAT_DAU);
  const ketThuc = dong.filter((d) => d.mode === MODE_DAU_KET_THUC);

  if (trang.some((d) => d.status === "ERROR")) return { loai: "trang-loi" };
  const ktLoi = ketThuc.find((d) => d.status === "ERROR");
  if (ktLoi) {
    const s = docSoLieuKetThuc(ktLoi.stats);
    return { loai: "bao-loi", chiTiet: s ? lyDoKetThucChuaDu(s).join("; ") || "n8n báo lỗi" : "n8n báo lỗi" };
  }
  if (batDau.some((d) => d.status === "ERROR")) return { loai: "bao-loi", chiTiet: "dấu bắt đầu ghi lỗi" };
  if (dong.some((d) => d.status === "RUNNING")) return { loai: "dang-chay" };
  if (batDau.length === 0) return { loai: "thieu-bat-dau" };
  if (batDau.length > 1) return { loai: "khong-khop", chiTiet: `${batDau.length} dấu bắt đầu cho một lượt` };
  if (ketThuc.length === 0) return { loai: "chua-ket-thuc" };
  if (ketThuc.length > 1) return { loai: "khong-khop", chiTiet: `${ketThuc.length} dấu kết thúc cho một lượt` };

  const s = docSoLieuKetThuc(ketThuc[0].stats);
  if (s === null) return { loai: "khong-khop", chiTiet: "dấu kết thúc sai khuôn" };
  const pvBatDau = docPhamVi(batDau[0].stats);
  const pvKetThuc = docPhamVi(ketThuc[0].stats);
  if (pvBatDau === "sai" || pvKetThuc === "sai") return { loai: "khong-khop", chiTiet: "phạm vi thời gian của dấu sai khuôn" };
  if (!cungPhamVi(pvBatDau, pvKetThuc)) {
    return { loai: "khong-khop", chiTiet: "phạm vi thời gian dấu kết thúc khác dấu bắt đầu" };
  }
  if (s.ketQua === KET_QUA_KHONG_QUYEN_FINANCE) {
    if (trang.length > 0) {
      return { loai: "khong-khop", chiTiet: `n8n khai thiếu quyền finance mà app có ${trang.length} trang hoá đơn của lượt` };
    }
    return { loai: "khong-quyen-finance", chiTiet: s.loi.join("; ") };
  }
  const chuaDu = lyDoKetThucChuaDu(s);
  if (chuaDu.length > 0) return { loai: "bao-loi", chiTiet: chuaDu.join("; ") };

  const soOkApp = trang.filter((d) => d.status === "OK").length;
  if (soOkApp !== s.soTrangLand) {
    return {
      loai: "khong-khop",
      chiTiet: `n8n khai land ${s.soTrangLand} trang, app ghi nhận ${soOkApp} trang (nguồn báo ${s.tongTrangNguon} trang)`,
    };
  }
  return { loai: "du" };
}

/** Phạm vi thời gian lượt đã gửi TikTok — đọc từ ĐÚNG MỘT dấu bắt đầu; không có / nhiều dấu / sai khuôn ⇒ null (không rõ). */
export function phamViCuaLuot(dong: readonly DongCuaLuot[]): PhamViHoaDon | null {
  const batDau = dong.filter((d) => d.mode === MODE_DAU_BAT_DAU);
  if (batDau.length !== 1) return null;
  const pv = docPhamVi(batDau[0].stats);
  return pv === "sai" ? null : pv;
}

export type KetQuaLuotPhuNgay =
  /** `chiSo` = lượt bằng chứng: ĐỦ (`xetLuotCoDau`) và phạm vi khai PHỦ ngày D. */
  | { loai: "co"; chiSo: number }
  /**
   * Lượt MỚI NHẤT trong số các lượt (có thể) phủ D không đủ ⇒ lượt phủ D cũ hơn không được che. `loaiLuot` = kết quả
   * `xetLuotCoDau` của lượt đó, hoặc `khong-ro-pham-vi` (lượt đủ mà dấu không mang phạm vi) — cổng chọn câu hướng dẫn.
   */
  | { loai: "phu-hong"; chiSo: number; chiTiet: string; loaiLuot: KetQuaLuotCoDau["loai"] | "khong-ro-pham-vi" }
  /** Không lượt nào (có thể) phủ D. */
  | { loai: "khong-phu" };

/** Câu ngắn cho kết quả lượt không đủ — chỉ dùng trong câu lý do của cổng. */
function moTaLuotKhongDu(k: KetQuaLuotCoDau): string {
  switch (k.loai) {
    case "du":
      return "đủ";
    case "trang-loi":
      return "có trang hoá đơn lỗi";
    case "dang-chay":
      return "còn trang chưa xong";
    case "thieu-bat-dau":
      return "không có dấu bắt đầu";
    case "chua-ket-thuc":
      return "chưa có dấu kết thúc";
    default:
      return k.chiTiet;
  }
}

/**
 * Tìm lượt BẰNG CHỨNG cho ngày sao kê `ngay` trong các lượt của MỘT BC (`cacLuot` theo thời điểm bắt đầu TĂNG). Hai vị
 * từ: LỎNG (`phamViCoThePhuNgayVn` — phủ D theo ít nhất một cách hiểu múi) quyết lượt nào là "lượt phủ D"; CHẶT
 * (`phamViPhuNgayVn` — phủ D theo MỌI cách hiểu) quyết lượt nào làm được bằng chứng. Duyệt từ mới về cũ, bỏ qua lượt mà
 * phạm vi khai CHẮC CHẮN không phủ D (không phủ theo cách hiểu nào). Với lượt còn lại (phủ D lỏng, hoặc KHÔNG RÕ phạm vi
 * — dấu bản cũ, thiếu dấu bắt đầu: fail-closed coi như có thể phủ D):
 *  - không đủ, hoặc đủ mà không rõ phạm vi ⇒ `phu-hong` (lượt phủ D sau cùng hỏng thì lượt phủ D cũ hơn KHÔNG che);
 *  - đủ VÀ phủ D chặt ⇒ bằng chứng;
 *  - đủ mà chỉ phủ D lỏng ⇒ không hỏng, không làm bằng chứng ⇒ xét tiếp lượt cũ hơn.
 * KHÔNG dựa ngày chạy thành công hay số ngày cố định — chỉ dựa phạm vi n8n đã thật sự gửi TikTok.
 */
export function timLuotPhuNgay(cacLuot: readonly (readonly DongCuaLuot[])[], ngay: string): KetQuaLuotPhuNgay {
  for (let i = cacLuot.length - 1; i >= 0; i--) {
    const pv = phamViCuaLuot(cacLuot[i]);
    if (pv !== null && !phamViCoThePhuNgayVn(pv, ngay)) continue;
    const kq = xetLuotCoDau(cacLuot[i]);
    if (kq.loai === "du" && pv !== null) {
      if (phamViPhuNgayVn(pv, ngay)) return { loai: "co", chiSo: i };
      continue;
    }
    return {
      loai: "phu-hong",
      chiSo: i,
      loaiLuot: kq.loai === "du" ? "khong-ro-pham-vi" : kq.loai,
      chiTiet:
        kq.loai !== "du"
          ? moTaLuotKhongDu(kq)
          : "dấu lượt không mang phạm vi thời gian đã gửi TikTok (workflow bản cũ) — không biết lượt có phủ ngày sao kê không",
    };
  }
  return { loai: "khong-phu" };
}

/** "YYYY-MM-DD HH:MM:SS → YYYY-MM-DD HH:MM:SS (UTC+07:00)" — hiện phạm vi trong câu lý do. */
export const hienPhamVi = (p: PhamViHoaDon): string => `${p.startTime} → ${p.endTime} (${p.muiGio})`;
