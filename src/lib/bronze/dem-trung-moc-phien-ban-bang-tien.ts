import { Prisma } from "@/generated/prisma/client";

import { mocPhienBanSql, thuTuPhienBanSql } from "@/lib/bronze/transform-raw-helpers";

/**
 * PHÁT HIỆN (chỉ đọc) hai ca làm "bản đứng đầu" của một khoá Bronze bảng TIỀN do uuid ngẫu nhiên quyết thay vì do
 * thứ tự thật — bộ đọc (`thuTuPhienBanSql` = `<mốc> DESC, "id" DESC`) và CAS Silver (nhận BẰNG) đều tin mốc, nên hai
 * bản cùng mốc là ca duy nhất chúng không phân xử được:
 *
 *  1. `trungMocDau` — khoá có ≥ 2 dòng ở mốc LỚN NHẤT của khoá (= đúng nhóm mà `"id" DESC` đang chọn bừa). Bản có mốc
 *     nhỏ hơn không tính: đã có bản mới hơn thắng rõ ràng. Trùng mốc ở bản đầu ĐỨNG YÊN tới khi có phiên bản mới của
 *     khoá (trang gửi lại trùng hash không dựng lại), và Bronze không bao giờ dọn ⇒ phép đếm này là tín hiệu BỀN.
 *  2. `lapTrongLuot` — khoá có ≥ 2 dòng cùng `syncLogId` (một trang API trả cùng khoá hai lần, khác nội dung): thứ tự
 *     giữa chúng chỉ là thứ tự chèn của câu INSERT, không phải thứ tự nguồn. Theo phạm vi lượt (`syncLogId` truyền vào)
 *     thì đếm mọi khoá lặp của lượt đó; không truyền `syncLogId` (đếm toàn bảng) thì CHỈ tính khoá mà lượt lặp chứa
 *     chính bản đứng đầu — lặp ở bản đã bị phiên bản mới hơn đè thì vô hại, không được giữ banner đỏ mãi mãi.
 *
 * Không đổi thứ tự đọc, CAS, câu INSERT hay Silver — mọi nhánh ở đây chỉ SELECT. Mốc lấy từ `mocPhienBanSql` /
 * `thuTuPhienBanSql` (cùng nghĩa với bộ đọc), không tự viết lại.
 */

/**
 * Bốn bảng Bronze mà bản đứng đầu quyết số TIỀN (Silver `TiktokPayment`, `TiktokAdsSettlement`, `TiktokAdsHoaDon`,
 * `TiktokAdsTinDung`). Hằng registry — an toàn nội suy vào SQL (cùng lý do `latestPayloads`). `shopee/wallet` cố ý
 * ngoài: số tiền nằm TRONG khoá nên hai nội dung khác nhau là hai khoá khác nhau.
 */
export const BANG_TIEN_SOI_THU_TU = [
  "RawTiktokShopPayment",
  "RawTiktokShopTransaction",
  "RawTiktokBusinessInvoice",
  "RawTiktokBusinessCost",
] as const;

export type BangTienSoiThuTu = (typeof BANG_TIEN_SOI_THU_TU)[number];

export function laBangTienSoiThuTu(table: string): table is BangTienSoiThuTu {
  return (BANG_TIEN_SOI_THU_TU as readonly string[]).includes(table);
}

/** Số KHOÁ (không phải số dòng) dính từng ca. Không trả payload. */
export type KetQuaTrungMoc = { trungMocDau: number; lapTrongLuot: number };

export const KHONG_TRUNG_MOC: KetQuaTrungMoc = { trungMocDau: 0, lapTrongLuot: 0 };

export function coTrungMoc(k: KetQuaTrungMoc): boolean {
  return k.trungMocDau > 0 || k.lapTrongLuot > 0;
}

/** Chỉ cần `$queryRaw` — nhận cả `prisma` lẫn client giao dịch. */
type DbDoc = Pick<Prisma.TransactionClient, "$queryRaw">;

export type PhamViDem = {
  /** Giới hạn theo shop (bc_id với `tiktokbusiness/*`). */
  shopId?: string;
  /**
   * Giới hạn các khoá. MẢNG RỖNG ⇒ 0 truy vấn, kết quả 0 (cùng hợp đồng `LatestFilter` của `latestPayloads`). Vẫn xét
   * MỌI dòng của các khoá đó (không chỉ dòng vừa land) — trùng mốc là quan hệ giữa các dòng của một khoá.
   */
  externalIds?: readonly string[];
  /** Lượt ingest (SyncLog.id): `lapTrongLuot` chỉ đếm khoá lặp BÊN TRONG lượt này. */
  syncLogId?: string;
};

function locKhoa(p: PhamViDem): Prisma.Sql {
  const dieuKien: Prisma.Sql[] = [];
  if (p.shopId !== undefined) dieuKien.push(Prisma.sql`"shopId" = ${p.shopId}`);
  if (p.externalIds !== undefined) dieuKien.push(Prisma.sql`"externalId" = ANY(${[...p.externalIds]}::text[])`);
  return dieuKien.length > 0 ? Prisma.sql`WHERE ${Prisma.join(dieuKien, " AND ")}` : Prisma.empty;
}

/** `locKhoa` nhưng nối thêm điều kiện bắt buộc (câu đã có WHERE riêng). */
function locKhoaVaCo(p: PhamViDem, them: Prisma.Sql): Prisma.Sql {
  const dieuKien: Prisma.Sql[] = [them];
  if (p.shopId !== undefined) dieuKien.push(Prisma.sql`"shopId" = ${p.shopId}`);
  if (p.externalIds !== undefined) dieuKien.push(Prisma.sql`"externalId" = ANY(${[...p.externalIds]}::text[])`);
  return Prisma.sql`WHERE ${Prisma.join(dieuKien, " AND ")}`;
}

/**
 * Đếm hai ca cho MỘT bảng tiền. `table` phải thuộc `BANG_TIEN_SOI_THU_TU` (ném nếu không — tên bảng được nội suy).
 */
export async function demTrungMoc(db: DbDoc, table: string, pham: PhamViDem = {}): Promise<KetQuaTrungMoc> {
  if (!laBangTienSoiThuTu(table)) {
    throw new Error(`demTrungMoc: bảng "${table}" không thuộc danh sách soi thứ tự phiên bản (${BANG_TIEN_SOI_THU_TU.join(", ")})`);
  }
  if (pham.externalIds !== undefined && pham.externalIds.length === 0) return { ...KHONG_TRUNG_MOC };

  const bang = Prisma.raw(`"${table}"`);
  const moc = Prisma.raw(mocPhienBanSql(table));
  const thuTu = Prisma.raw(thuTuPhienBanSql(table));

  // Khoá có ≥ 2 dòng ở mốc lớn nhất của chính khoá đó.
  const dauRows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT "shopId", "externalId"
      FROM (
        SELECT "shopId", "externalId", ${moc} AS moc,
               max(${moc}) OVER (PARTITION BY "shopId", "externalId") AS moc_max
        FROM ${bang}
        ${locKhoa(pham)}
      ) x
      WHERE moc = moc_max
      GROUP BY "shopId", "externalId"
      HAVING count(*) >= 2
    ) y`;

  // Khoá lặp trong một lượt.
  const lapRows =
    pham.syncLogId !== undefined
      ? await db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM (
            SELECT 1 FROM ${bang}
            ${locKhoaVaCo(pham, Prisma.sql`"syncLogId" = ${pham.syncLogId}`)}
            GROUP BY "shopId", "externalId"
            HAVING count(*) >= 2
          ) z`
      : await db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM (
            SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "syncLogId"
            FROM ${bang}
            ${locKhoa(pham)}
            ORDER BY "shopId", "externalId", ${thuTu}
          ) h
          WHERE h."syncLogId" IS NOT NULL
            AND (
              SELECT count(*) FROM ${bang} t
              WHERE t."shopId" = h."shopId" AND t."externalId" = h."externalId" AND t."syncLogId" = h."syncLogId"
            ) >= 2`;

  return { trungMocDau: dauRows[0]?.n ?? 0, lapTrongLuot: lapRows[0]?.n ?? 0 };
}

export type TrungMocTheoBang = { bang: BangTienSoiThuTu } & KetQuaTrungMoc;

/** Đếm TOÀN bảng cho cả bốn bảng — nguồn của banner. Chỉ trả bảng có ca. */
export async function demTongTrungMocBangTien(db: DbDoc): Promise<TrungMocTheoBang[]> {
  const ketQua: TrungMocTheoBang[] = [];
  for (const bang of BANG_TIEN_SOI_THU_TU) {
    const k = await demTrungMoc(db, bang);
    if (coTrungMoc(k)) ketQua.push({ bang, ...k });
  }
  return ketQua;
}

/**
 * Câu cảnh báo cho SyncLog của lượt ingest (null nếu lượt sạch). Nói rõ bảng, số khoá và việc cần làm — người đọc log
 * không có ngữ cảnh plan.
 */
export function canhBaoTrungMocLuot(stream: string, shopId: string, table: string, k: KetQuaTrungMoc): string | null {
  if (!coTrungMoc(k)) return null;
  const phan: string[] = [];
  if (k.trungMocDau > 0) {
    phan.push(`${k.trungMocDau} khoá có ≥ 2 phiên bản CÙNG mốc ở bản đầu (bản nào là mới nhất do uuid ngẫu nhiên quyết)`);
  }
  if (k.lapTrongLuot > 0) {
    phan.push(`${k.lapTrongLuot} khoá lặp ≥ 2 lần với nội dung khác nhau trong CÙNG trang (thứ tự giữa chúng không đáng tin)`);
  }
  return (
    `Stream "${stream}" (shop ${shopId}, bảng ${table}): ${phan.join("; ")}. ` +
    "Dữ liệu đã land, Silver có thể đang giữ sai bản của các khoá đó — số tiền KHÔNG tự sửa. " +
    "Báo dev: chạy lại file SQL đo phase 02 (plans/261125-1430-thu-tu-phien-ban-bronze-con-lai) để xác định khoá, " +
    "kiểm tay từng khoá với nguồn; có ca thật thì mở phương án landSeq."
  );
}

/** Kết quả soi một lượt ingest: `canhBao` = có ca (⇒ SyncLog ERROR); `khongSoiDuoc` = lỗi đọc (⇒ chỉ cảnh báo). */
export type KetQuaSoiLuot = { canhBao: string | null; khongSoiDuoc: string | null };

/**
 * Soi phạm vi MỘT lượt ingest của stream tiền: các khoá vừa land (`landedIds`) + trang (`syncLogId`) của chính request.
 * KHÔNG BAO GIỜ ném: soi là đường đọc phụ, lỗi của nó không được chặn bước dựng Silver sau land (dữ liệu đã commit) —
 * lỗi trả về `khongSoiDuoc` để route ghi cảnh báo (không im lặng). Stream ngoài danh sách soi ⇒ không làm gì.
 */
export async function soiTrungMocCuaLuot(
  db: DbDoc,
  p: { stream: string; table: string; shopId: string; landedIds: readonly string[]; syncLogId: string },
): Promise<KetQuaSoiLuot> {
  if (!laBangTienSoiThuTu(p.table)) return { canhBao: null, khongSoiDuoc: null };
  try {
    const k = await demTrungMoc(db, p.table, { shopId: p.shopId, externalIds: p.landedIds, syncLogId: p.syncLogId });
    return { canhBao: canhBaoTrungMocLuot(p.stream, p.shopId, p.table, k), khongSoiDuoc: null };
  } catch (err) {
    const lyDo = err instanceof Error ? err.message : String(err);
    console.error(`[ingest/raw] không soi được trùng mốc phiên bản (${p.table}):`, err);
    return {
      canhBao: null,
      khongSoiDuoc: `Stream "${p.stream}": không soi được trùng mốc phiên bản của ${p.table} (${lyDo}) — dữ liệu vẫn đã land.`,
    };
  }
}

/** Câu cho banner toàn app (null khi sạch). */
export function canhBaoTrungMocBanner(ds: readonly TrungMocTheoBang[]): string | null {
  if (ds.length === 0) return null;
  const chiTiet = ds
    .map((d) => `${d.bang}: ${d.trungMocDau} trùng mốc bản đầu, ${d.lapTrongLuot} lặp khoá trong trang`)
    .join("; ");
  return (
    "Kho thô tiền TikTok có khoá trùng thứ tự phiên bản — Silver (quỹ / nợ thẻ / tín dụng) có thể đang giữ sai bản. " +
    `${chiTiet}. Báo dev kiểm từng khoá; cảnh báo tự tắt khi khoá có phiên bản mới hơn.`
  );
}
