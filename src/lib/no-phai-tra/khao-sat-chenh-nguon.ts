import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * LÕI THUẦN của script khảo sát chênh nguồn ads (Sổ chi phí) ↔ ví TikTok (`TiktokAdsSettlement`).
 *
 * ⚠️ KẾT QUẢ Ở ĐÂY KHÔNG PHẢI SỐ ĐIỀU CHỈNH QUỸ. Chỉ cho biết hai trục ngày (ngày chi tiêu ads trong sổ
 * vs ngày đơn `orderCreateTime` của dòng ví) lệch cỡ nào và dữ liệu phủ đủ không. Điều chỉnh quỹ chỉ
 * đi qua đường riêng đã duyệt; lầm "số chênh" thành "quỹ sai" là lỗi phân tích, không phải lỗi dữ liệu.
 *
 * Không đọc DB, không ghi gì: nhận mảng dòng đã đọc, trả số liệu. Mọi khoá ngày là ngày VN (`khoaNgayVn`).
 */

export type DongAds = { adsSource: string | null; source: string; date: Date; amount: number };
export type DongViTiktok = { orderCreateTime: Date; settlementAmount: number; syncedAt: Date };
export type DongPayment = { paidTime: Date | null; settlementValue: number };

export type DongTuan = {
  /** Thứ Hai đầu tuần (ngày VN, yyyy-MM-dd). */
  tuanBatDau: string;
  adsTiktok: number;
  /** |Σ settlementAmount| ví TikTok theo ngày đơn (cộng CÓ DẤU rồi mới lấy trị tuyệt đối, không abs từng dòng). */
  viTiktok: number;
  /** Σ tiền về bank (payment PAID) theo `paidTime` — chỉ để đối chiếu, không so trực tiếp với ads. */
  bankVe: number;
  /** ví / ads; `null` khi ads = 0. */
  tiLeViTrenAds: number | null;
};

export type KetQuaKhaoSat = {
  tuan: DongTuan[];
  /** Ngày có ads TIKTOK_ADS > 0 nhưng ví = 0. */
  soNgayAdsCoViKhong: number;
  /** Ngày có ví > 0 nhưng ads TIKTOK_ADS = 0. */
  soNgayViCoAdsKhong: number;
  /** Trung vị (ngày) của `syncedAt − orderCreateTime`; `null` khi không có dòng ví. `syncedAt` là lần sync ĐẦU nên dữ liệu backfill làm phồng số này. */
  trungViTreDongBoNgay: number | null;
  /** Như trên nhưng CHỈ dòng có `syncedAt ≤ orderCreateTime + 30 ngày` (loại backfill). */
  trungViTreKhongBackfillNgay: number | null;
  soDongAdsKhongNguon: number;
  adsTheoSource: Record<string, number>;
  adsTheoNguon: Record<string, number>;
  /** Mỗi mốc T: hai phía (< T trong [T−7,T−1], ≥ T trong [T,T+7]) cho cả ads và ví. KHÔNG phải số điều chỉnh quỹ. */
  moc: KetQuaMoc[];
};

export type KetQuaMoc = {
  t: string;
  adsTruocT: number;
  adsTuT: number;
  /** |Σ có dấu| ví theo `orderCreateTime`. */
  viTruocT: number;
  viTuT: number;
  /** |(ads≥T) − (ví≥T)| − |(ads<T) − (ví<T)|. Chỉ để THAM KHẢO, KHÔNG phải số điều chỉnh quỹ. */
  uocLuongLechHaiTruc: number;
};

const NGAY_BACKFILL = 30;

const MS_NGAY = 24 * 3600 * 1000;

/** Cộng `n` ngày vào khoá yyyy-MM-dd (tính trên UTC thuần, không dính múi giờ máy). */
export function congNgay(khoa: string, n: number): string {
  return new Date(Date.parse(`${khoa}T00:00:00Z`) + n * MS_NGAY).toISOString().slice(0, 10);
}

/** Thứ Hai của tuần chứa ngày `khoa`. */
export function dauTuan(khoa: string): string {
  const thu = new Date(`${khoa}T00:00:00Z`).getUTCDay(); // 0 = CN
  return congNgay(khoa, -((thu + 6) % 7));
}

/** Trung vị; mảng chẵn lấy trung bình hai số giữa. */
export function trungVi(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const g = s.length >> 1;
  return s.length % 2 === 1 ? s[g] : (s[g - 1] + s[g]) / 2;
}

function cong(m: Map<string, number>, k: string, v: number): void {
  m.set(k, (m.get(k) ?? 0) + v);
}

const treNgay = (v: DongViTiktok) => (v.syncedAt.getTime() - v.orderCreateTime.getTime()) / MS_NGAY;

export function khaoSatChenhNguon(vao: {
  ads: DongAds[];
  vi: DongViTiktok[];
  payment: DongPayment[];
  /** Các mốc T (yyyy-MM-dd, ngày VN) để đo hai phía quanh từng T. */
  mocT?: string[];
}): KetQuaKhaoSat {
  const adsNgay = new Map<string, number>();
  const viNgay = new Map<string, number>();
  const bankNgay = new Map<string, number>();
  const adsTheoSource: Record<string, number> = {};
  const adsTheoNguon: Record<string, number> = {};
  let soDongAdsKhongNguon = 0;

  for (const a of vao.ads) {
    adsTheoSource[a.source] = (adsTheoSource[a.source] ?? 0) + 1;
    if (a.adsSource === null) {
      soDongAdsKhongNguon += 1;
      continue;
    }
    adsTheoNguon[a.adsSource] = (adsTheoNguon[a.adsSource] ?? 0) + 1;
    if (a.adsSource === "TIKTOK_ADS") cong(adsNgay, khoaNgayVn(a.date), a.amount);
  }
  for (const v of vao.vi) cong(viNgay, khoaNgayVn(v.orderCreateTime), v.settlementAmount);
  for (const p of vao.payment) {
    if (p.paidTime !== null) cong(bankNgay, khoaNgayVn(p.paidTime), p.settlementValue);
  }

  // Gộp theo tuần (thứ Hai đầu tuần).
  const tuanMap = new Map<string, { ads: number; vi: number; bank: number }>();
  const tuanCuaNgay = (k: string) => {
    const t = dauTuan(k);
    let g = tuanMap.get(t);
    if (g === undefined) tuanMap.set(t, (g = { ads: 0, vi: 0, bank: 0 }));
    return g;
  };
  for (const [k, v] of adsNgay) tuanCuaNgay(k).ads += v;
  for (const [k, v] of viNgay) tuanCuaNgay(k).vi += v; // cộng có dấu; abs ở bước xuất tuần
  for (const [k, v] of bankNgay) tuanCuaNgay(k).bank += v;

  const tuan: DongTuan[] = [...tuanMap]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([tuanBatDau, g]) => ({
      tuanBatDau,
      adsTiktok: g.ads,
      viTiktok: Math.abs(g.vi),
      bankVe: g.bank,
      tiLeViTrenAds: g.ads === 0 ? null : Math.abs(g.vi) / g.ads,
    }));

  const tatCaNgay = new Set([...adsNgay.keys(), ...viNgay.keys()]);
  let soNgayAdsCoViKhong = 0;
  let soNgayViCoAdsKhong = 0;
  for (const k of tatCaNgay) {
    const a = adsNgay.get(k) ?? 0;
    const v = Math.abs(viNgay.get(k) ?? 0);
    if (a > 0 && v === 0) soNgayAdsCoViKhong += 1;
    if (v > 0 && a === 0) soNgayViCoAdsKhong += 1;
  }

  const moc: KetQuaMoc[] = (vao.mocT ?? []).map((t) => {
    const truocTu = congNgay(t, -7);
    const tuTDen = congNgay(t, 7);
    const tongCoDau = (m: Map<string, number>) => {
      let truoc = 0;
      let tu = 0;
      for (const [k, v] of m) {
        if (k >= truocTu && k < t) truoc += v;
        else if (k >= t && k <= tuTDen) tu += v;
      }
      return { truoc, tu };
    };
    const a = tongCoDau(adsNgay);
    const v = tongCoDau(viNgay);
    const viTruocT = Math.abs(v.truoc);
    const viTuT = Math.abs(v.tu);
    return {
      t,
      adsTruocT: a.truoc,
      adsTuT: a.tu,
      viTruocT,
      viTuT,
      uocLuongLechHaiTruc: Math.abs(a.tu - viTuT) - Math.abs(a.truoc - viTruocT),
    };
  });

  return {
    tuan,
    soNgayAdsCoViKhong,
    soNgayViCoAdsKhong,
    trungViTreDongBoNgay: trungVi(vao.vi.map(treNgay)),
    trungViTreKhongBackfillNgay: trungVi(vao.vi.map(treNgay).filter((d) => d <= NGAY_BACKFILL)),
    soDongAdsKhongNguon,
    adsTheoSource,
    adsTheoNguon,
    moc,
  };
}

export type CheDoDb = { che: "test" | "prod"; databaseUrl: string };

/**
 * Bắt buộc đúng MỘT cờ DB: `--db-test` (ép TEST_DATABASE_URL, tên DB phải kết thúc `_test`) hoặc `--prod`.
 * Không cờ / cả hai ⇒ ném lỗi (script thoát mã 2). Không đọc/ghi `process.env` ở đây.
 */
export function phanTichCheDoDb(argv: string[], env: Record<string, string | undefined>): CheDoDb {
  const test = argv.includes("--db-test");
  const prod = argv.includes("--prod");
  if (test === prod) {
    throw new Error(
      test
        ? "Chỉ được chọn MỘT trong --db-test hoặc --prod, không dùng cả hai."
        : "Thiếu cờ DB: dùng --db-test (TEST_DATABASE_URL) hoặc --prod (DATABASE_URL, CHỈ ĐỌC, cần phép của chủ shop).",
    );
  }
  if (test) {
    const url = env.TEST_DATABASE_URL;
    if (!url) throw new Error("Thiếu TEST_DATABASE_URL cho --db-test.");
    const ten = new URL(url).pathname.replace(/^\//, "");
    if (!ten.endsWith("_test")) throw new Error(`--db-test: tên DB phải kết thúc "_test", nhận "${ten}".`);
    return { che: "test", databaseUrl: url };
  }
  const url = env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL cho --prod.");
  return { che: "prod", databaseUrl: url };
}

/**
 * Danh sách mốc T. Có `--moc-t` ⇒ tách phẩy, bỏ T ngoài [tu, den] (trả kèm cảnh báo).
 * Không có ⇒ các ngày mùng 1 trong (tu, den] (T = tu bị loại vì không có phía "trước T" trong cửa sổ).
 */
export function chonMocT(tu: string, den: string, moi: string | undefined): { mocT: string[]; canhBao: string[] } {
  const canhBao: string[] = [];
  if (moi !== undefined) {
    const ds = moi.split(",").map((x) => x.trim()).filter(Boolean);
    const mocT: string[] = [];
    for (const t of ds) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`--moc-t phải dạng yyyy-MM-dd, nhận "${t}".`);
      if (t < tu || t > den) canhBao.push(`Bỏ mốc T=${t}: nằm ngoài cửa sổ [${tu}, ${den}].`);
      else if (!mocT.includes(t)) mocT.push(t);
    }
    return { mocT: mocT.sort(), canhBao };
  }
  const mocT: string[] = [];
  for (let k = congNgay(tu, 1); k <= den; k = congNgay(k, 1)) if (k.endsWith("-01")) mocT.push(k);
  return { mocT, canhBao };
}
