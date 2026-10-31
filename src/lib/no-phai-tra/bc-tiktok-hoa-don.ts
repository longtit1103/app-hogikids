import { Prisma } from "@/generated/prisma/client";
import { BC_ID_TIKTOK_HOP_LE } from "@/lib/bronze/khuon-bc-id-tiktok";
import { sqlThoiDiem } from "@/lib/ingest/tiktok-settlement-upsert";
import { MODE_DAU_KET_THUC, STREAM_HOA_DON_TIKTOK } from "@/lib/no-phai-tra/dau-luot-hoa-don-tiktok";
import { dieuKienHoaDonTiktokTinhNoThe } from "@/lib/no-phai-tra/du-no-the";

/**
 * Trạng thái BỀN của từng Business Center TikTok với lượt kéo hoá đơn (bảng `TiktokBcHoaDon`) — nguồn của ba luật
 * cổng chốt sao kê thẻ phải sống qua cửa sổ D − 30 của `SyncLog` và qua việc dọn `SyncLog`:
 *  1. BC đã TỪNG đọc được hoá đơn nay báo thiếu quyền finance / biến mất ⇒ CHẶN (không giới hạn ngày);
 *  2. BC chủ shop đánh dấu "không dùng thẻ" ⇒ bỏ khỏi tập xét; BC thiếu quyền chưa xác nhận ⇒ CHẶN;
 *  3. App đã từng nhận một dấu lượt (của bất kỳ BC nào) ⇒ chế độ dấu lượt toàn cục, không quay về luật cũ.
 *
 * KHÔNG tiền: không đọc/ghi quỹ, P&L, dư nợ.
 */

/** Nơi chủ shop đánh dấu BC "không dùng thẻ" — câu lý do của cổng trỏ về đây. */
export const NOI_DANH_DAU_BC_KHONG_DUNG = "Tài chính › Nợ phải trả, mục Business Center TikTok";

type DbGhiBc = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Route dấu lượt ghi nhận BC vừa gửi dấu — MỘT câu `INSERT … ON CONFLICT` (hai dấu cùng BC đua nhau không P2002):
 *  - `lanDauCoDau` chỉ đặt LẦN ĐẦU (giữ mốc cũ);
 *  - `docDuoc` (dấu kết thúc đã GET được ≥ 1 trang — TikTok cho đọc hoá đơn) ⇒ `lanCuoiDocDuoc` = max(cũ, lúc này).
 * Gửi lại cùng dấu chỉ có thể dời `lanCuoiDocDuoc` tới lúc gửi lại (vẫn "đã từng đọc được") — kết quả cổng không đổi.
 * Không chạm ba cột `khongDung*` (quyết định của chủ shop).
 */
export async function ghiNhanDauBcTiktok(db: DbGhiBc, bcId: string, docDuoc: boolean, luc: Date = new Date()): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "TiktokBcHoaDon" AS t ("bcId", "lanDauCoDau", "lanCuoiDocDuoc", "createdAt", "updatedAt")
    VALUES (${bcId}::text, ${sqlThoiDiem(luc)}, ${sqlThoiDiem(docDuoc ? luc : null)}, ${sqlThoiDiem(luc)}, ${sqlThoiDiem(luc)})
    ON CONFLICT ("bcId") DO UPDATE SET
      "lanDauCoDau" = COALESCE(t."lanDauCoDau", EXCLUDED."lanDauCoDau"),
      "lanCuoiDocDuoc" = GREATEST(t."lanCuoiDocDuoc", EXCLUDED."lanCuoiDocDuoc"),
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}

export type TrangThaiBcBen = {
  /** App đã từng nhận dấu lượt (bảng có dòng mang `lanDauCoDau`) ⇒ chế độ nghiêm toàn cục. */
  daCoDau: boolean;
  /** BC từng đọc được hoá đơn ở MỌI thời điểm: `lanCuoiDocDuoc` ∪ BC có hoá đơn trong kho thô. */
  tungDocDuoc: Set<string>;
  /** BC app đã từng nhận dấu lượt (`lanDauCoDau`) — khi nghiêm, BC im lặng > 30 ngày vẫn nằm trong tập xét. */
  coDau: Set<string>;
  /** BC chủ shop đã xác nhận "không dùng thẻ" ⇒ mốc xác nhận (`khongDungTu`). */
  khongDung: Map<string, Date>;
  /** BC có hoá đơn trong kho thô land từ `tuCuaSo` (BC "đang dùng" của cửa sổ xét). */
  coHoaDonTrongCuaSo: Set<string>;
};

type DbDocBc = Pick<Prisma.TransactionClient, "tiktokBcHoaDon" | "rawTiktokBusinessInvoice">;

/**
 * Đọc trạng thái bền cho cổng. Kho thô `RawTiktokBusinessInvoice` không bị dọn (kể cả "Xoá dữ liệu giao dịch") nên
 * BC đã land hoá đơn TRƯỚC khi có bảng này vẫn được nhớ — không cần backfill trong migration.
 */
export async function docTrangThaiBcBen(db: DbDocBc, tuCuaSo: Date): Promise<TrangThaiBcBen> {
  const [dong, bronze] = await Promise.all([
    db.tiktokBcHoaDon.findMany({ select: { bcId: true, lanDauCoDau: true, lanCuoiDocDuoc: true, khongDungTu: true } }),
    db.rawTiktokBusinessInvoice.groupBy({ by: ["shopId"], _max: { fetchedAt: true } }),
  ]);
  return {
    daCoDau: dong.some((d) => d.lanDauCoDau !== null),
    tungDocDuoc: new Set([
      ...dong.flatMap((d) => (d.lanCuoiDocDuoc !== null ? [d.bcId] : [])),
      ...bronze.map((b) => b.shopId),
    ]),
    coDau: new Set(dong.flatMap((d) => (d.lanDauCoDau !== null ? [d.bcId] : []))),
    khongDung: new Map(dong.flatMap((d) => (d.khongDungTu !== null ? [[d.bcId, d.khongDungTu] as const] : []))),
    coHoaDonTrongCuaSo: new Set(
      bronze.flatMap((b) => (b._max.fetchedAt !== null && b._max.fetchedAt >= tuCuaSo ? [b.shopId] : [])),
    ),
  };
}

export type BcTiktokHienThi = {
  bcId: string;
  /** `ketQua` dấu kết thúc gần nhất trong 30 ngày (`xong` | `loi` | `khong-quyen-finance`); null = không có. */
  ketQuaGanNhat: string | null;
  /** Lần cuối đọc được hoá đơn (max của dấu kết thúc đọc được và lần land kho thô); null = chưa từng. */
  lanCuoiDocDuoc: Date | null;
  lanDauCoDau: Date | null;
  khongDungTu: Date | null;
  khongDungGhiChu: string | null;
  khongDungBoi: string | null;
};

const maxNgay = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a > b ? a : b);

const SO_NGAY_KET_QUA_GAN_NHAT = 30;

/**
 * Danh sách BC cho khối "Business Center TikTok" (Nợ phải trả): hợp bảng bền + BC có hoá đơn trong kho thô + BC chỉ thấy
 * qua `SyncLog` stream hoá đơn 30 ngày (trang lỗi của BC mới khi dấu cũng hỏng — cổng vẫn xét nó, nên phải đánh dấu
 * được), kèm `ketQua` dấu kết thúc gần nhất để chủ shop thấy BC nào đang bị TikTok từ chối.
 */
export async function docDanhSachBcTiktok(db: DbDocBc & Pick<Prisma.TransactionClient, "syncLog">): Promise<BcTiktokHienThi[]> {
  const [dong, bronze, dau] = await Promise.all([
    db.tiktokBcHoaDon.findMany(),
    db.rawTiktokBusinessInvoice.groupBy({ by: ["shopId"], _max: { fetchedAt: true } }),
    db.syncLog.findMany({
      where: {
        kind: "TIKTOK_ADS",
        startedAt: { gte: new Date(Date.now() - SO_NGAY_KET_QUA_GAN_NHAT * 86_400_000) },
        stats: { path: ["stream"], equals: STREAM_HOA_DON_TIKTOK },
      },
      select: { stats: true },
      orderBy: { startedAt: "desc" },
      take: 5000,
    }),
  ]);
  const ketQuaTheoBc = new Map<string, string>();
  const bcNhatKy = new Set<string>();
  for (const d of dau) {
    const st = d.stats !== null && typeof d.stats === "object" && !Array.isArray(d.stats) ? d.stats : {};
    if (typeof st.shopId !== "string" || !BC_ID_TIKTOK_HOP_LE.test(st.shopId)) continue;
    bcNhatKy.add(st.shopId);
    if (st.mode === MODE_DAU_KET_THUC && typeof st.ketQua === "string" && !ketQuaTheoBc.has(st.shopId)) {
      ketQuaTheoBc.set(st.shopId, st.ketQua);
    }
  }
  const theoBc = new Map<string, BcTiktokHienThi>();
  for (const d of dong) {
    theoBc.set(d.bcId, {
      bcId: d.bcId,
      ketQuaGanNhat: ketQuaTheoBc.get(d.bcId) ?? null,
      lanCuoiDocDuoc: d.lanCuoiDocDuoc,
      lanDauCoDau: d.lanDauCoDau,
      khongDungTu: d.khongDungTu,
      khongDungGhiChu: d.khongDungGhiChu,
      khongDungBoi: d.khongDungBoi,
    });
  }
  for (const b of bronze) {
    const cu = theoBc.get(b.shopId);
    if (cu) cu.lanCuoiDocDuoc = maxNgay(cu.lanCuoiDocDuoc, b._max.fetchedAt);
    else {
      theoBc.set(b.shopId, {
        bcId: b.shopId,
        ketQuaGanNhat: ketQuaTheoBc.get(b.shopId) ?? null,
        lanCuoiDocDuoc: b._max.fetchedAt,
        lanDauCoDau: null,
        khongDungTu: null,
        khongDungGhiChu: null,
        khongDungBoi: null,
      });
    }
  }
  for (const bcId of bcNhatKy) {
    if (!theoBc.has(bcId)) {
      theoBc.set(bcId, {
        bcId,
        ketQuaGanNhat: ketQuaTheoBc.get(bcId) ?? null,
        lanCuoiDocDuoc: null,
        lanDauCoDau: null,
        khongDungTu: null,
        khongDungGhiChu: null,
        khongDungBoi: null,
      });
    }
  }
  return [...theoBc.values()].sort((a, b) => a.bcId.localeCompare(b.bcId));
}

/**
 * BC app đã biết (đánh dấu được): có dòng bảng bền, có hoá đơn trong kho thô, hoặc có dòng `SyncLog` stream hoá đơn
 * (trang/dấu) — mọi BC cổng có thể xét đều thuộc một trong ba nguồn này.
 */
export async function bcTiktokDaBiet(
  db: Pick<Prisma.TransactionClient, "tiktokBcHoaDon" | "rawTiktokBusinessInvoice" | "syncLog">,
  bcId: string,
): Promise<boolean> {
  const [dong, hoaDon, nhatKy] = await Promise.all([
    db.tiktokBcHoaDon.findUnique({ where: { bcId }, select: { bcId: true } }),
    db.rawTiktokBusinessInvoice.findFirst({ where: { shopId: bcId }, select: { id: true } }),
    db.syncLog.findFirst({
      where: {
        kind: "TIKTOK_ADS",
        AND: [
          { stats: { path: ["stream"], equals: STREAM_HOA_DON_TIKTOK } },
          { stats: { path: ["shopId"], equals: bcId } },
        ],
      },
      select: { id: true },
    }),
  ]);
  return dong !== null || hoaDon !== null || nhatKy !== null;
}

export type HoaDonTinhNoTheCuaBc = { bcId: string; createTime: Date; amount: number };

/**
 * Hoá đơn TikTok của các BC `bcIds` thuộc tập "tính vào dư nợ thẻ" (`dieuKienHoaDonTiktokTinhNoThe`, cùng luật dư nợ)
 * tạo trong `[tu, truoc)`. BC có hoá đơn này thì thiếu hoá đơn của nó làm dư nợ thẻ lệch — kể cả khi ví TikTok Shop trả
 * (bù bằng `VI_TRU` từ nguồn khác) — nên KHÔNG được coi là "không dùng thẻ".
 */
export async function docHoaDonTinhNoTheCuaBc(
  db: Pick<Prisma.TransactionClient, "tiktokAdsHoaDon">,
  bcIds: readonly string[],
  tu: Date,
  truoc: Date,
): Promise<HoaDonTinhNoTheCuaBc[]> {
  if (bcIds.length === 0 || tu >= truoc) return [];
  return db.tiktokAdsHoaDon.findMany({
    where: { ...dieuKienHoaDonTiktokTinhNoThe(tu, truoc), bcId: { in: [...bcIds] } },
    select: { bcId: true, createTime: true, amount: true },
    orderBy: { createTime: "asc" },
  });
}
