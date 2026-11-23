import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { type AnhDiSan, chupAnhDiSan, docTien16ChiSo } from "./anh-di-san-moc-land-don";
import { phanLoaiDonNghiLech } from "./phan-loai-don-nghi-lech";

/**
 * BƯỚC KIỂM CHỈ-ĐỌC cho migration `20261106150000_raw_pancake_order_land_seq` — chạy TRƯỚC và SAU migrate.
 *
 * Đếm, trên `Order`, đơn khớp bao nhiêu dòng `RawPancakeOrder` theo ĐÚNG câu JOIN backfill của migration
 * (`externalId = pancakeId`, `shopId = raw->>'shop_id'`, `fetchedAt = rawFetchedAt`):
 *  - `khop`: đúng một dòng ⇒ migration điền `rawLandSeq` = `landSeq` dòng đó;
 *  - `moHo`: ≥ 2 dòng cùng mốc tới mili-giây ⇒ migration RAISE EXCEPTION (cuộn lại toàn bộ) — phải = 0 TRƯỚC migrate.
 *    `ungVienMoHo` liệt kê từng đơn + các dòng kho thô khớp để người vận hành lập báo cáo / phương án RIÊNG — hàm này
 *    KHÔNG chọn bản nào (không theo uuid), không xoá gì, không gán gì. SAU migrate số mơ hồ chỉ để tham khảo: hai bản
 *    trùng mili-giây land sau migrate là hợp lệ (`landSeq` phân xử);
 *  - `khongKhop`: không dòng nào (không mốc nguồn, mốc lệch) ⇒ `rawLandSeq` NULL (luật cũ).
 *  - `khongDoiChieuDuoc` (NỀN, đo được cả trước lẫn sau migrate): đơn mà `Order.raw` (bỏ khoá `_buTuDonKho` của đơn bù)
 *    KHÔNG bằng CHÍNH XÁC payload của BẤT KỲ dòng kho thô nào của đơn. Nguyên nhân thật đã gặp: (1) `Order.raw` được ghi
 *    từ payload đã qua `JSON.parse` của JS ⇒ số nguyên > 2^53 / số thực nhiều chữ số bị làm tròn (hành vi có sẵn trên
 *    `origin/main`); (2) đơn mà kho thô không còn / không có dòng nào cùng (đơn, shop) — vd `raw` lưu hình dạng khác, đơn
 *    ghi bằng đường khác; (3) Silver giữ một bản mà phép so CHÍNH XÁC không nhận ra vì (1). Mỗi đơn trong nền được
 *    chưa đối chiếu được — KHÔNG được coi là đạt chỉ vì con số không đổi trước ↔ sau.
 *  - ĐƠN NGHI LỆCH = nền ∪ đơn có bản tham chiếu mà `Order.raw` KHÁC chính xác bản tham chiếu nhưng BẰNG chính xác một bản
 *    khác. Mỗi đơn nghi lệch được PHÂN LOẠI bằng phép so theo đúng cách đường ghi đọc dữ liệu
 *    (`phan-loai-nen-doi-chieu-qua-js.ts`): `giaiThichDuoc` (khớp bản tham chiếu sau chuyển đổi JS — lệch chỉ do lưu trữ),
 *    `lechBanKhac` (khớp MỘT bản khác — Silver giữ sai bản), `khongDuCanCu` (không khớp bản nào / nhiều bản khác nhau
 *    thành giống nhau sau chuyển đổi JS / không có bản tham chiếu — KHÔNG ĐỦ CĂN CỨ, không tính đạt). Phép so JS KHÔNG
 *    khôi phục được độ chính xác int64 đã mất.
 *    Bản tham chiếu: sau migrate là dòng cặp (`rawFetchedAt`, `rawLandSeq`); trước migrate (hoặc `rawLandSeq` NULL) là
 *    dòng DUY NHẤT có `fetchedAt` = `rawFetchedAt`. Đơn có mốc mà không dòng nào cùng mốc ⇒ không có tham chiếu ⇒ KHÔNG ĐỦ
 *    CĂN CỨ (cùng luật dù `raw` khớp chính xác hay qua JS).
 *  - NHÓM DI SẢN (`anh-di-san-moc-land-don.ts`): đơn CHƯA có `rawLandSeq` mà không có kho thô / không có mốc nguồn — TÁCH
 *    khỏi nghi lệch, KHÔNG coi là đã xác minh; chỉ chấp nhận khi ẢNH (id + lý do + C1/C2 từng đơn) không đổi giữa lần kiểm
 *    trước và sau migrate (`soAnhDiSan`). Đơn ĐÃ có `rawLandSeq` mà mất dòng tham chiếu vẫn là LỖI (`lechCap`).
 *
 * MỘT ảnh dữ liệu: mọi câu chạy trong MỘT transaction `REPEATABLE READ, READ ONLY` — các số trong một lượt chụp cùng thời
 * điểm. Thời hạn tường minh: trần transaction 10 phút, `statement_timeout` 120 s, `lock_timeout` 5 s (đổi được qua
 * `thoiHan` cho test). Hết hạn ⇒ ném `LoiKiemKhongHoanThanh` (script: KHÔNG HOÀN THÀNH, mã riêng) — không tính đạt.
 * Transaction không bao giờ chờ người nhập (mọi tham số nhận trước khi mở).
 * Sau migrate (cột đã có) thêm:
 *  - `daDien`: số đơn có `rawLandSeq`;
 *  - `lechCap`: đơn có `rawLandSeq` mà KHÔNG dòng nào mang ĐÚNG cặp (`rawFetchedAt`, `rawLandSeq`) — dấu hiệu cặp mốc lệch
 *    (vd ảnh cũ ghi `rawFetchedAt` mà không đụng `rawLandSeq`), phải = 0;
 *  - `lechNoiDung` (= `lechBanKhac` sau migrate): Silver đang giữ nội dung bản KHÁC bản cặp mốc trỏ tới (vd ảnh cũ dựng
 *    lại tay chọn bản theo `id`), phải = 0.
 *
 * Không dựa vào NOTICE của migration: `prisma migrate deploy` không in NOTICE. Mọi câu là SELECT, chạy trong transaction
 * READ ONLY — không thể ghi gì dù lỡ tay sửa câu.
 *
 * KHOÁ GHI CHUNG CLI/RESTORE: client Prisma của script CLI coi `$executeRaw*` là thao tác GHI ⇒ câu
 * `SET TRANSACTION READ ONLY` làm script giành khoá ghi chung (`pg_try_advisory_lock_shared`, `khoa-chung-cli.ts`) trên DB
 * đích như mọi CLI khác. Đang có lượt phục hồi giữ khoá độc quyền ⇒ script TỪ CHỐI (`LoiCliDangPhucHoi`, thoát 1) thay vì
 * đếm; trong lúc script chạy, lượt phục hồi nhận 409. Cố ý giữ phối hợp này (đếm giữa lúc schema đang bị thay là số vô
 * nghĩa) — đo thật: `logs/90-script-kiem-va-khoa-chung-cli.log` của lượt thi công.
 */
export type UngVienMoHo = {
  pancakeId: string;
  rawFetchedAt: string;
  /** Các dòng kho thô cùng (đơn, shop, mốc) — đúng thứ tự `id` chỉ để in ổn định, KHÔNG phải thứ tự ưu tiên. */
  dong: { id: string; payloadHash: string; status: string | null; updatedAt: string | null; silverOutcome: string | null }[];
};

export type DonKhongDuCanCu = { pancakeId: string; lyDo: string };

export type DemKhopMocLandDon = {
  tongDon: number;
  khop: number;
  moHo: number;
  khongKhop: number;
  khongDoiChieuDuoc: number;
  /** Đơn NGHI LỆCH (xem chú thích đầu file) phân loại theo cách đường ghi đọc dữ liệu. */
  giaiThichDuoc: number;
  lechBanKhac: number;
  khongDuCanCu: number;
  /** Một TRANG đơn KHÔNG ĐỦ CĂN CỨ (xếp `pancakeId` so theo byte) kèm lý do — để tra tay. */
  donKhongDuCanCu: DonKhongDuCanCu[];
  /** `pancakeId` cuối trang khi còn trang sau (truyền vào `sauDonKhongDuCanCu`); `null` = đã hết. */
  donKhongDuCanCuTrangSau: string | null;
  /** Ảnh ĐẦY ĐỦ nhóm di sản (id + lý do + C1/C2) — lưu ra file ở lần kiểm trước, so ở lần sau. */
  anhDiSan: AnhDiSan;
  /** Mức cô lập + chỉ-đọc THẬT của transaction đã chạy (`current_setting`) — để chứng minh một ảnh dữ liệu. */
  anhDuLieu: { mucCoLap: string; chiDoc: string };
  /** `null` khi cột `Order.rawLandSeq` chưa có (trước migrate). */
  daDien: number | null;
  lechCap: number | null;
  lechNoiDung: number | null;
  /** Một TRANG đơn mơ hồ (xếp `pancakeId`, rồi `raw_id`, so theo byte — `COLLATE "C"`) kèm các dòng kho thô khớp. */
  ungVienMoHo: UngVienMoHo[];
  /** `pancakeId` cuối của trang khi còn trang sau (truyền vào `sauDon` để lấy tiếp); `null` = đã hết. */
  ungVienTrangSau: string | null;
};

export const GIOI_HAN_UNG_VIEN = 200;

export type TuyChonDemKhop = {
  /** Con trỏ trang ứng viên mơ hồ: chỉ lấy đơn có `pancakeId` > giá trị này (so theo byte). */
  sauDon?: string;
  /** Con trỏ trang danh sách KHÔNG ĐỦ CĂN CỨ: chỉ lấy đơn có `pancakeId` > giá trị này (so theo byte). */
  sauDonKhongDuCanCu?: string;
  /** Số đơn mỗi trang (ứng viên mơ hồ, không đủ căn cứ) — 1–1000, mặc định `GIOI_HAN_UNG_VIEN`. */
  gioiHan?: number;
  /** Thời hạn (ms) — mặc định trần transaction 600 000, câu lệnh 120 000, chờ khoá 5 000. */
  thoiHan?: { giaoDichMs?: number; cauLenhMs?: number; khoaMs?: number };
};

/** Bước kiểm KHÔNG chạy xong trong thời hạn (transaction / câu lệnh / chờ khoá) — kết quả KHÔNG được dùng. */
export class LoiKiemKhongHoanThanh extends Error {
  constructor(nguyenNhan: unknown) {
    const goc = nguyenNhan instanceof Error ? nguyenNhan.message : String(nguyenNhan);
    // Thông báo Prisma nhiều dòng, dòng đầu thường rỗng ⇒ gộp các dòng có chữ để người vận hành thấy nguyên nhân.
    const gon = goc.split("\n").map((d) => d.trim()).filter(Boolean).join(" | ").slice(0, 400);
    super(`Bước kiểm KHÔNG HOÀN THÀNH: ${gon}`);
    this.name = "LoiKiemKhongHoanThanh";
  }
}

/** Lỗi hết hạn: transaction Prisma quá trần (P2028), Postgres `statement_timeout` (57014) / `lock_timeout` (55P03). */
function laLoiHetHan(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2028") return true;
  const m = e instanceof Error ? e.message : String(e);
  return /57014|55P03|statement timeout|lock timeout|expired transaction|Transaction already closed|timeout for this transaction/i.test(m);
}

const soMs = (v: number | undefined, macDinh: number) => Math.max(1, Math.trunc(v ?? macDinh));

export async function demKhopMocLandDon(db: PrismaClient, tuyChon: TuyChonDemKhop = {}): Promise<DemKhopMocLandDon> {
  const gioiHan = Math.min(1000, Math.max(1, Math.trunc(tuyChon.gioiHan ?? GIOI_HAN_UNG_VIEN)));
  const giaoDichMs = soMs(tuyChon.thoiHan?.giaoDichMs, 10 * 60_000);
  const cauLenhMs = soMs(tuyChon.thoiHan?.cauLenhMs, 120_000);
  const khoaMs = soMs(tuyChon.thoiHan?.khoaMs, 5_000);
  try {
    return await db.$transaction(
      (tx) => demTrongMotAnh(tx, tuyChon, gioiHan, cauLenhMs, khoaMs),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: giaoDichMs, maxWait: 30_000 },
    );
  } catch (e) {
    if (laLoiHetHan(e)) throw new LoiKiemKhongHoanThanh(e);
    throw e;
  }
}

async function demTrongMotAnh(
  tx: Prisma.TransactionClient,
  tuyChon: TuyChonDemKhop,
  gioiHan: number,
  cauLenhMs: number,
  khoaMs: number,
): Promise<DemKhopMocLandDon> {
  // Câu ĐẦU của transaction (trước mọi SELECT) ⇒ có hiệu lực cho cả ảnh dữ liệu REPEATABLE READ.
  await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
  await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${cauLenhMs}`);
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${khoaMs}`);
  const [anhDuLieu] = await tx.$queryRawUnsafe<{ mucCoLap: string; chiDoc: string }[]>(
    `SELECT current_setting('transaction_isolation') AS "mucCoLap", current_setting('transaction_read_only') AS "chiDoc"`,
  );
  const [dem] = await tx.$queryRawUnsafe<
    { tong: bigint; khop: bigint; mo_ho: bigint; khong: bigint; khong_doi_chieu: bigint }[]
  >(`
    SELECT count(*)::bigint AS tong,
           count(*) FILTER (WHERE m.n = 1)::bigint AS khop,
           count(*) FILTER (WHERE m.n > 1)::bigint AS mo_ho,
           count(*) FILTER (WHERE m.n = 0)::bigint AS khong,
           count(*) FILTER (WHERE NOT m.bang_mot_dong)::bigint AS khong_doi_chieu
    FROM "Order" o
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE r."fetchedAt" = o."rawFetchedAt") AS n,
             coalesce(bool_or(r.payload = (o.raw - '_buTuDonKho')), false) AS bang_mot_dong
      FROM "RawPancakeOrder" r
      WHERE r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id'
    ) m`);
  // Trang ứng viên: khoá sắp xếp XÁC ĐỊNH (`pancakeId` rồi `raw_id`, so theo byte) + con trỏ `sauDon` ⇒ xem được HẾT danh
  // sách qua nhiều lượt chạy, không trùng không sót. Chỉ in định danh/mốc/hash — không payload, không dữ liệu khách.
  const ungVien = await tx.$queryRawUnsafe<
    { p: string; f: string; id: string; h: string; st: string | null; u: string | null; kc: string | null }[]
  >(
    `
    WITH mo_ho AS (
      SELECT o."pancakeId" AS p, o.raw->>'shop_id' AS s, o."rawFetchedAt" AS f FROM "Order" o
      JOIN "RawPancakeOrder" r
        ON r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id' AND r."fetchedAt" = o."rawFetchedAt"
      WHERE ($1::text IS NULL OR o."pancakeId" COLLATE "C" > $1::text COLLATE "C")
      GROUP BY 1, 2, 3 HAVING count(*) > 1 ORDER BY o."pancakeId" COLLATE "C" LIMIT $2::int
    )
    SELECT m.p, to_char(m.f, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS f, r.id, r."payloadHash" AS h,
           r.payload->>'status' AS st, r.payload->>'updated_at' AS u, r."silverOutcome" AS kc
    FROM mo_ho m JOIN "RawPancakeOrder" r ON r."externalId" = m.p AND r."shopId" = m.s AND r."fetchedAt" = m.f
    ORDER BY m.p COLLATE "C", r.id COLLATE "C"`,
    tuyChon.sauDon ?? null,
    gioiHan + 1,
  );
  const theoDon = new Map<string, UngVienMoHo>();
  for (const r of ungVien) {
    const uv = theoDon.get(r.p) ?? { pancakeId: r.p, rawFetchedAt: r.f, dong: [] };
    uv.dong.push({ id: r.id, payloadHash: r.h, status: r.st, updatedAt: r.u, silverOutcome: r.kc });
    theoDon.set(r.p, uv);
  }
  const tatCaUngVien = [...theoDon.values()];
  const conTrangSau = tatCaUngVien.length > gioiHan;
  const trangUngVien = tatCaUngVien.slice(0, gioiHan);
  const [{ co }] = await tx.$queryRawUnsafe<{ co: boolean }[]>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Order' AND column_name = 'rawLandSeq'
    ) AS co`);
  const nen = await phanLoaiDonNghiLech(tx, co);
  // 16 chỉ số tiền đọc trong CÙNG ảnh dữ liệu (snapshot REPEATABLE READ chỉ đọc) — ảnh trước migrate mang theo để
  // KIỂM SAU tự so (cùng với tổng đơn và da_dien = khop trước migrate).
  const tien16 = await docTien16ChiSo(tx);
  const anhDiSan = await chupAnhDiSan(tx, co, { khop: Number(dem.khop), tien16 });
  const kdcc = tuyChon.sauDonKhongDuCanCu === undefined
    ? nen.khongDuCanCu
    : nen.khongDuCanCu.filter((d) => d.pancakeId > tuyChon.sauDonKhongDuCanCu!);
  const trangKdcc = kdcc.slice(0, gioiHan);
  let daDien: number | null = null;
  let lechCap: number | null = null;
  let lechNoiDung: number | null = null;
  if (co) {
    const [sau] = await tx.$queryRawUnsafe<{ da_dien: bigint; lech: bigint }[]>(`
      SELECT count(*) FILTER (WHERE o."rawLandSeq" IS NOT NULL)::bigint AS da_dien,
             count(*) FILTER (WHERE o."rawLandSeq" IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM "RawPancakeOrder" r
               WHERE r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id'
                 AND r."fetchedAt" = o."rawFetchedAt" AND r."landSeq" = o."rawLandSeq"))::bigint AS lech
      FROM "Order" o`);
    daDien = Number(sau.da_dien);
    lechCap = Number(sau.lech);
    lechNoiDung = nen.lechBanKhac;
  }
  return {
    tongDon: Number(dem.tong),
    khop: Number(dem.khop),
    moHo: Number(dem.mo_ho),
    khongKhop: Number(dem.khong),
    khongDoiChieuDuoc: Number(dem.khong_doi_chieu),
    giaiThichDuoc: nen.giaiThichDuoc,
    lechBanKhac: nen.lechBanKhac,
    khongDuCanCu: nen.khongDuCanCu.length,
    donKhongDuCanCu: trangKdcc,
    donKhongDuCanCuTrangSau: kdcc.length > gioiHan ? trangKdcc[trangKdcc.length - 1].pancakeId : null,
    anhDiSan,
    anhDuLieu,
    daDien,
    lechCap,
    lechNoiDung,
    ungVienMoHo: trangUngVien,
    ungVienTrangSau: conTrangSau ? trangUngVien[trangUngVien.length - 1].pancakeId : null,
  };
}
