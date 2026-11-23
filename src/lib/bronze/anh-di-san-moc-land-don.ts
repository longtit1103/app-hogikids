import { readFileSync } from "node:fs";
import path from "node:path";

import type { Prisma } from "@/generated/prisma/client";

/**
 * NHÓM DI SẢN của bước kiểm landSeq (`dem-khop-moc-land-don.ts`) + ẢNH để so trước ↔ sau migrate.
 *
 * Hai nhóm có sẵn trước migration mà phép kiểm KHÔNG xác minh được phiên bản (migration cũng không đụng: `rawLandSeq`
 * để NULL):
 *  - `khong-co-kho-tho`: Silver có đơn, kho thô KHÔNG có dòng nào cùng (đơn, shop) — trạng thái có thật, có chủ đích
 *    (đơn cũ hơn cửa sổ kho thô; xem `rebuild.ts#warnStuckSilverOrders`).
 *  - `khong-co-moc-nguon`: `Order.rawFetchedAt` NULL (đơn ghi trước khi có cột mốc nguồn) — CÙNG một luật dù `Order.raw`
 *    khớp chính xác hay chỉ khớp qua cách đọc JS của payload.
 * Chỉ đơn CHƯA có `rawLandSeq` mới vào nhóm di sản: đơn ĐÃ có `rawLandSeq` mà mất dòng tham chiếu là LỖI (lệch cặp).
 *
 * Hai nhóm KHÔNG được coi là đã xác minh đúng phiên bản. Chúng chỉ được CHẤP NHẬN khi, trong cửa sổ migration đã dừng
 * ghi, ảnh của chúng KHÔNG đổi giữa lần kiểm trước và sau migrate: cùng tập `pancakeId`, cùng lý do, cùng checksum
 * nghiệp vụ (C1: cột tiền/trạng thái của đơn + dòng hàng) và payload (C2: `Order.raw` + các dòng kho thô của đơn). Đơn di
 * sản mới xuất hiện / biến mất / đổi lý do / đổi dữ liệu ⇒ cổng ĐỎ.
 *
 * NGUỒN GỐC ảnh (phiên bản 2): DB (`current_database()` + `oid`), schema, định danh cluster (`system_identifier`), thời
 * điểm và GIAI ĐOẠN (trước / sau migrate = chưa / đã có cột `Order.rawLandSeq`). Ảnh baseline CHỈ được xuất TRƯỚC migrate
 * khi cổng ĐẠT (`lyDoKhongXuatAnh`); lần so chỉ nhận ảnh cùng nguồn, chụp trước migrate (`kiemNguonAnh`) — chụp lại SAU
 * migrate rồi so với chính nó là cách vô hiệu hoá phép so.
 *
 * SỐ LIỆU ĐỐI SOÁT (phiên bản 3): ảnh trước migrate mang thêm `khop` (số đơn khớp ĐÚNG MỘT dòng kho thô = số đơn
 * migration sẽ điền `rawLandSeq`) và `tien16` (dòng 16 chỉ số tiền của `deploy/tien-16-chi-so.sql` — cùng file pha A/B
 * dùng), đọc trong CÙNG ảnh dữ liệu chỉ đọc. Sau migrate, phép so tự đối chiếu `tongDon`, `da_dien` = `khop` trước và
 * `tien16` (`soSoLieuTruocSau`) — thiếu hoặc lệch ⇒ cổng ĐỎ, không để mắt người tự so.
 */
export type LyDoDiSan = "khong-co-kho-tho" | "khong-co-moc-nguon";

export type DonDiSan = { pancakeId: string; lyDo: LyDoDiSan; c1: string; c2: string };

export type GiaiDoanAnh = "truoc-migrate" | "sau-migrate";

/** `cluster` = `pg_control_system().system_identifier` (chuỗi — vượt 2^53); `null` khi role đang nối không có quyền gọi. */
export type NguonAnh = { db: string; dbOid: string; schema: string; cluster: string | null };

export type AnhDiSan = {
  phienBan: 3;
  nguon: NguonAnh;
  giaiDoan: GiaiDoanAnh;
  /** `now()` của transaction kiểm (giờ VN) — chỉ để người vận hành đối chiếu, không dùng để quyết. */
  luc: string;
  tongDon: number;
  /** Số đơn Silver khớp ĐÚNG MỘT dòng kho thô cùng mốc (câu backfill của migration) — sau migrate phải = `da_dien`. */
  khop: number;
  /** 16 chỉ số tiền, ngăn `|`, đúng thứ tự cột của `deploy/tien-16-chi-so.sql` — sau migrate phải BẰNG từng ký tự. */
  tien16: string;
  diSan: DonDiSan[];
};

/** Đường file 16 chỉ số tiền — một nguồn với pha A/B (`deploy/tien-16-chi-so.sql`), tính từ thư mục làm việc (`/app` trong ảnh). */
export const FILE_TIEN_16_CHI_SO = path.join("deploy", "tien-16-chi-so.sql");

/** Dạng hợp lệ của dòng 16 chỉ số: 16 số nguyên (có thể âm), ngăn `|`. */
const MAU_TIEN_16 = /^-?\d+(\|-?\d+){15}$/;

/**
 * Đọc 16 chỉ số tiền TRONG transaction kiểm (cùng ảnh dữ liệu chỉ đọc với mọi phép đếm khác). Chạy NGUYÊN câu SELECT của
 * `deploy/tien-16-chi-so.sql` (bỏ dòng chú thích `--` và dấu `;` cuối), lấy dòng kết quả dạng `row::text` rồi đổi sang
 * dạng `a|b|…` như `psql -tA -F'|'`. Thiếu file / không đúng 16 số nguyên ⇒ ném lỗi (script thoát 1 — thiếu kết quả là dừng).
 */
export async function docTien16ChiSo(tx: Prisma.TransactionClient, thuMucGoc = process.cwd()): Promise<string> {
  const tho = readFileSync(path.resolve(thuMucGoc, FILE_TIEN_16_CHI_SO), "utf8");
  const cau = tho
    .split("\n")
    .filter((d) => !d.trimStart().startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;\s*$/, "");
  const [{ dong }] = await tx.$queryRawUnsafe<{ dong: string }[]>(`SELECT t::text AS dong FROM (${cau}) t`);
  const tien16 = dong.replace(/^\(|\)$/g, "").split(",").join("|");
  if (!MAU_TIEN_16.test(tien16)) throw new Error(`16 chỉ số tiền đọc ra sai dạng: "${tien16}" (cần 16 số nguyên ngăn |)`);
  return tien16;
}

/** Số liệu hiện tại để so với ảnh trước migrate. */
export type SoLieuHienTai = { tongDon: number; daDien: number | null; tien16: string };

/**
 * So số liệu SAU migrate với ảnh TRƯỚC migrate — thuần. Rỗng = khớp. App + mọi nguồn ghi dừng suốt cửa sổ nên cả ba phải
 * BẰNG tuyệt đối: tổng đơn, số đơn đã điền `rawLandSeq` = `khop` trước migrate, 16 chỉ số tiền. Chưa có cột (`daDien`
 * null) ⇒ báo thiếu kết quả.
 */
export function soSoLieuTruocSau(truoc: AnhDiSan, hienTai: SoLieuHienTai): string[] {
  const loi: string[] = [];
  if (hienTai.tongDon !== truoc.tongDon) loi.push(`tong_don: trước ${truoc.tongDon} ≠ sau ${hienTai.tongDon}`);
  if (hienTai.daDien === null) loi.push("da_dien: chưa có cột Order.rawLandSeq — thiếu kết quả sau migrate");
  else if (hienTai.daDien !== truoc.khop) loi.push(`da_dien: sau ${hienTai.daDien} ≠ khop trước migrate ${truoc.khop}`);
  if (hienTai.tien16 !== truoc.tien16) loi.push(`tien16: trước ${truoc.tien16} ≠ sau ${hienTai.tien16}`);
  return loi;
}

/** File ảnh không dùng được (rỗng / hỏng / sai định dạng / không đọc được) — script báo rõ, thoát 1, KHÔNG so. */
export class LoiAnhDiSan extends Error {
  constructor(thongDiep: string) {
    super(thongDiep);
    this.name = "LoiAnhDiSan";
  }
}

/**
 * Nguồn + giai đoạn + thời điểm của ảnh, đọc TRONG transaction kiểm. Định danh cluster lấy bằng QUYỀN HIỆN CÓ: hỏi
 * `has_function_privilege` trước, chỉ gọi `pg_control_system()` khi được phép (gọi thẳng khi thiếu quyền là lỗi làm hỏng
 * cả transaction); thiếu quyền ⇒ `cluster = null`, KHÔNG tự cấp quyền.
 */
async function docNguonAnh(tx: Prisma.TransactionClient, coCotRawLandSeq: boolean) {
  const [a] = await tx.$queryRawUnsafe<{ db: string; dbOid: string; schema: string; luc: string; tongDon: number; quyen: boolean }[]>(`
    SELECT current_database() AS db, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS "dbOid",
           current_schema() AS schema,
           to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS"+07:00"') AS luc,
           (SELECT count(*)::int FROM "Order") AS "tongDon",
           has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE') AS quyen`);
  let cluster: string | null = null;
  if (a.quyen) {
    [{ cluster }] = await tx.$queryRawUnsafe<{ cluster: string }[]>(
      `SELECT system_identifier::text AS cluster FROM pg_control_system()`,
    );
  }
  const giaiDoan: GiaiDoanAnh = coCotRawLandSeq ? "sau-migrate" : "truoc-migrate";
  return { nguon: { db: a.db, dbOid: a.dbOid, schema: a.schema, cluster }, giaiDoan, luc: a.luc, tongDon: a.tongDon };
}

/** Điều kiện SQL "đơn thuộc nhóm di sản" trên bí danh `o` — dùng chung cho đếm, ảnh và loại khỏi tập nghi lệch. */
export function dieuKienDiSanSql(coCotRawLandSeq: boolean): string {
  const chuaCoSo = coCotRawLandSeq ? `o."rawLandSeq" IS NULL AND ` : "";
  return `(${chuaCoSo}(o."rawFetchedAt" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "RawPancakeOrder" r0 WHERE r0."externalId" = o."pancakeId" AND r0."shopId" = o.raw->>'shop_id')))`;
}

/**
 * Ảnh nhóm di sản (đã xếp theo `pancakeId` so theo byte). C1/C2 tính trong Postgres bằng `row(...)::text` — giữ vị trí
 * NULL + ranh giới trường; dòng hàng / dòng kho thô xếp ổn định không theo `id` Silver.
 */
export async function chupAnhDiSan(
  tx: Prisma.TransactionClient,
  coCotRawLandSeq: boolean,
  soLieu: { khop: number; tien16: string },
): Promise<AnhDiSan> {
  const dong = await tx.$queryRawUnsafe<DonDiSan[]>(`
    SELECT o."pancakeId" AS "pancakeId",
           CASE WHEN NOT EXISTS (
             SELECT 1 FROM "RawPancakeOrder" r0 WHERE r0."externalId" = o."pancakeId" AND r0."shopId" = o.raw->>'shop_id'
           ) THEN 'khong-co-kho-tho' ELSE 'khong-co-moc-nguon' END AS "lyDo",
           md5(row(o."pancakeId", o.code, o."channelId", o.status, o."orderedAt", o."statusChangedAt", o."customerName",
                   o."itemsTotal", o."shipFeeCustomer", o.discount, o."platformFeeEst", o."returnedFee", o."paidAtShop",
                   o."backfilledFromMirror")::text
               || coalesce((SELECT string_agg(x, '|' ORDER BY x COLLATE "C") FROM (
                    SELECT row(i."variantId", i.sku, i."productName", i.quantity, i."unitPrice", i."lineDiscount")::text AS x
                    FROM "OrderItem" i WHERE i."orderId" = o.id) t), '')) AS c1,
           md5(coalesce(md5(o.raw::text), 'NULL')
               || coalesce((SELECT string_agg(x, '|' ORDER BY x COLLATE "C") FROM (
                    SELECT row(r.id, r."payloadHash", md5(r.payload::text), r."fetchedAt")::text AS x
                    FROM "RawPancakeOrder" r WHERE r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id') t),
                  '')) AS c2
    FROM "Order" o
    WHERE ${dieuKienDiSanSql(coCotRawLandSeq)}
    ORDER BY o."pancakeId" COLLATE "C"`);
  return { phienBan: 3, ...(await docNguonAnh(tx, coCotRawLandSeq)), khop: soLieu.khop, tien16: soLieu.tien16, diSan: dong };
}

/**
 * Lý do KHÔNG được xuất ảnh baseline (`--ghi-anh`); `null` = được. Chỉ xuất khi: TRƯỚC migrate, cổng ĐẠT (mã 0), và có
 * định danh cluster. Sau migrate KHÔNG BAO GIỜ xuất — giữ nguyên ảnh trước migrate, không chụp lại để thay baseline.
 */
export function lyDoKhongXuatAnh(anh: AnhDiSan, maCong: number): string | null {
  if (anh.giaiDoan !== "truoc-migrate") {
    return "DB đã SAU migrate (có cột Order.rawLandSeq) — ảnh baseline chỉ chụp TRƯỚC migrate; giữ nguyên ảnh đã lưu, KHÔNG chụp lại để thay";
  }
  if (maCong !== 0) return `cổng chưa ĐẠT (mã ${maCong}) — ảnh của lượt chưa đạt không được dùng làm baseline`;
  if (anh.nguon.cluster === null) {
    return "role đang nối KHÔNG có quyền EXECUTE pg_control_system() ⇒ không lấy được định danh cluster; KHÔNG tự cấp quyền — báo chủ shop quyết";
  }
  return null;
}

/** Ảnh ĐÃ LƯU có dùng được để so với DB ĐANG KIỂM không — rỗng = dùng được; mỗi phần tử là một lý do từ chối. */
export function kiemNguonAnh(daLuu: AnhDiSan, hienTai: AnhDiSan): string[] {
  const loi: string[] = [];
  if (daLuu.giaiDoan !== "truoc-migrate") loi.push(`ảnh chụp ở giai đoạn "${daLuu.giaiDoan}" — chỉ nhận ảnh chụp TRƯỚC migrate`);
  if (hienTai.nguon.cluster === null) loi.push("không lấy được định danh cluster của DB đang kiểm bằng quyền hiện có");
  for (const k of ["db", "dbOid", "schema", "cluster"] as const) {
    if (daLuu.nguon[k] !== hienTai.nguon[k]) loi.push(`${k}: ảnh "${daLuu.nguon[k]}" ≠ DB đang kiểm "${hienTai.nguon[k]}"`);
  }
  return loi;
}

/** Một khác biệt giữa ảnh trước và ảnh sau. */
export type KhacBietDiSan =
  | { loai: "moi"; pancakeId: string }
  | { loai: "mat"; pancakeId: string }
  | { loai: "doi-ly-do" | "doi-c1" | "doi-c2"; pancakeId: string };

/** So hai ảnh — thuần. Rỗng = khớp hoàn toàn. Thứ tự kết quả theo `pancakeId` (so theo byte) cho ổn định. */
export function soAnhDiSan(truoc: AnhDiSan, sau: AnhDiSan): KhacBietDiSan[] {
  const t = new Map(truoc.diSan.map((d) => [d.pancakeId, d]));
  const s = new Map(sau.diSan.map((d) => [d.pancakeId, d]));
  const ket: KhacBietDiSan[] = [];
  for (const id of [...new Set([...t.keys(), ...s.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const a = t.get(id);
    const b = s.get(id);
    if (!a) ket.push({ loai: "moi", pancakeId: id });
    else if (!b) ket.push({ loai: "mat", pancakeId: id });
    else if (a.lyDo !== b.lyDo) ket.push({ loai: "doi-ly-do", pancakeId: id });
    else if (a.c1 !== b.c1) ket.push({ loai: "doi-c1", pancakeId: id });
    else if (a.c2 !== b.c2) ket.push({ loai: "doi-c2", pancakeId: id });
  }
  return ket;
}

const laChuoi = (x: unknown): x is string => typeof x === "string" && x !== "";

/**
 * Đọc ảnh từ chuỗi JSON (file người vận hành lưu ở lần kiểm trước) — kiểm hình dạng; rỗng / hỏng / sai ⇒ `LoiAnhDiSan`
 * nói rõ nguyên nhân (file rỗng thường là lượt `--ghi-anh` thoát mã khác 0 mà shell vẫn tạo file đích).
 */
export function docAnhDiSan(json: string): AnhDiSan {
  if (json.trim() === "") {
    throw new LoiAnhDiSan(
      "ảnh di sản RỖNG — file không có nội dung (lượt --ghi-anh tạo file có thoát mã 0 không? mã khác 0 ⇒ file KHÔNG phải ảnh)",
    );
  }
  let v: Partial<AnhDiSan> | null;
  try {
    v = JSON.parse(json) as Partial<AnhDiSan> | null;
  } catch (e) {
    throw new LoiAnhDiSan(`ảnh di sản HỎNG — không phải JSON hợp lệ (${e instanceof Error ? e.message : String(e)})`);
  }
  if (v?.phienBan !== 3) {
    throw new LoiAnhDiSan(
      `ảnh di sản phiên bản ${JSON.stringify(v?.phienBan ?? null)} — cần phiên bản 3 (có nguồn DB/schema/cluster + giai đoạn + ` +
        "số liệu đối soát khop/tien16); ảnh thiếu căn cứ đối soát không được dùng",
    );
  }
  const n = v.nguon;
  if (!n || !laChuoi(n.db) || !laChuoi(n.dbOid) || !laChuoi(n.schema) || !laChuoi(n.cluster)) {
    throw new LoiAnhDiSan("ảnh di sản sai định dạng: thiếu nguồn (db / dbOid / schema / cluster)");
  }
  if (v.giaiDoan !== "truoc-migrate" && v.giaiDoan !== "sau-migrate") throw new LoiAnhDiSan("ảnh di sản sai định dạng: giai đoạn lạ");
  if (!laChuoi(v.luc) || typeof v.tongDon !== "number" || !Array.isArray(v.diSan)) {
    throw new LoiAnhDiSan("ảnh di sản sai định dạng: thiếu luc / tongDon / diSan");
  }
  if (!Number.isInteger(v.khop) || (v.khop as number) < 0 || typeof v.tien16 !== "string" || !MAU_TIEN_16.test(v.tien16)) {
    throw new LoiAnhDiSan("ảnh di sản sai định dạng: thiếu / sai số liệu đối soát khop (số nguyên ≥ 0) / tien16 (16 số ngăn |)");
  }
  for (const d of v.diSan) {
    if (typeof d?.pancakeId !== "string" || typeof d.c1 !== "string" || typeof d.c2 !== "string") {
      throw new LoiAnhDiSan("ảnh di sản sai định dạng: mỗi đơn cần pancakeId/lyDo/c1/c2");
    }
    if (d.lyDo !== "khong-co-kho-tho" && d.lyDo !== "khong-co-moc-nguon") throw new LoiAnhDiSan(`ảnh di sản: lý do lạ "${d.lyDo}"`);
  }
  return v as AnhDiSan;
}
