import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";

import { formatVnd } from "@/lib/format";
import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import {
  rutPhieuTuPayload,
  TIEN_TO_REF_ID,
  type PhieuNhapPancake,
} from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { conNoPhieu, nhanTrangThaiPhieu, type TrangThaiPhieu } from "@/lib/no-phai-tra/con-no-phieu";
import { laPhieuTruocMoSo } from "@/lib/no-phai-tra/luat-da-tra-truoc-phieu";
import { prisma } from "@/lib/prisma";
import { HAN_CHO_KHOA_DONG_TIEN_MS, khoaDongTienCoHan } from "@/lib/so-quy/khoa-dong-tien-co-han";
import { ngayMoSo } from "@/lib/so-quy/so-quy-queries";

/**
 * Đọc / khoá / hậu kiểm HỒ SƠ NGHĨA VỤ phiếu nhập (`PhieuNhapNo`) — spec §5.1, §5.3.
 *
 * Còn nợ KHÔNG có cột: luôn suy lại từ chính các dòng tiền gắn phiếu (`SUPPLIER_PAY` trừ,
 * `SUPPLIER_REFUND` cộng) qua `conNoPhieu` — cùng nguyên tắc "dư nợ suy từ dòng tiền" của khoản vay,
 * không có con số thứ hai để lệch với sổ.
 *
 * Mọi hàm nhận `db` (prisma gốc hoặc `tx`): action trả gộp gọi TRONG transaction, SAU `khoaCacPhieu`,
 * để vân tay tính trên đúng dữ liệu đã khoá.
 */

/** Client đọc được — prisma gốc hoặc `tx` của transaction đang chạy. */
type DbDoc = Prisma.TransactionClient;

const KIND_PHIEU = ["SUPPLIER_PAY", "SUPPLIER_REFUND"] as const;

/** Một phiếu kèm số đã trả / đã hoàn / còn nợ suy từ dòng tiền. */
export type PhieuConNo = {
  id: string;
  refId: string;
  shopId: string;
  maPhieu: string;
  ngayPhieu: Date;
  tongTien: number;
  daTraTruoc: number;
  daHuy: boolean;
  lechDaGiaiThich: boolean;
  /** Số Sổ chi phí lúc chủ shop giải thích lệch (null = chưa giải thích). */
  lechDaGiaiThichSo: number | null;
  note: string;
  /** Σ `SUPPLIER_PAY` gắn phiếu. */
  daTra: number;
  /** Σ `SUPPLIER_REFUND` gắn phiếu. */
  daHoan: number;
  /** Âm = trả thừa (phiếu thường) / cần thu hồi (phiếu huỷ). */
  conNo: number;
  trangThai: TrangThaiPhieu;
  /** Số dòng tiền gắn phiếu (mọi kind) — để chặn xoá hồ sơ (`ly-do-khong-xoa-phieu.ts`). */
  soDongTien: number;
};

const CHON_PHIEU = {
  id: true,
  refId: true,
  shopId: true,
  maPhieu: true,
  ngayPhieu: true,
  tongTien: true,
  daTraTruoc: true,
  daHuy: true,
  lechDaGiaiThich: true,
  lechDaGiaiThichSo: true,
  note: true,
} as const;

type HangPhieu = Prisma.PhieuNhapNoGetPayload<{ select: typeof CHON_PHIEU }>;

/** Ghép Σ dòng tiền vào từng phiếu. `where` rỗng = mọi phiếu. */
async function docVaGhep(db: DbDoc, where: Prisma.PhieuNhapNoWhereInput): Promise<PhieuConNo[]> {
  const phieu: HangPhieu[] = await db.phieuNhapNo.findMany({
    where,
    select: CHON_PHIEU,
    // Cũ → mới: thứ tự gợi ý phân bổ "cũ trước" của màn trả gộp; id phá hoà để thứ tự tất định.
    orderBy: [{ ngayPhieu: "asc" }, { id: "asc" }],
  });
  if (phieu.length === 0) return [];

  // groupBy theo (phiếu, kind) — đếm luôn số dòng để biết phiếu còn dòng tiền hay không.
  const nhom = await db.cashMovement.groupBy({
    by: ["phieuNhapId", "kind"],
    where: { phieuNhapId: { in: phieu.map((p) => p.id) } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  return phieu.map((p) => {
    let daTra = 0;
    let daHoan = 0;
    let soDongTien = 0;
    for (const g of nhom) {
      if (g.phieuNhapId !== p.id) continue;
      soDongTien += g._count._all;
      if (g.kind === "SUPPLIER_PAY") daTra += g._sum.amount ?? 0;
      else if (g.kind === "SUPPLIER_REFUND") daHoan += g._sum.amount ?? 0;
      // Kind khác gắn phieuNhapId bị CHECK `CashMovement_kind_khoa_bat_buoc` cấm — không cộng gì.
    }
    const conNo = conNoPhieu({ tongTien: p.tongTien, daTraTruoc: p.daTraTruoc, daHuy: p.daHuy, daTra, daHoan });
    return { ...p, daTra, daHoan, conNo, trangThai: nhanTrangThaiPhieu(conNo, p.daHuy), soDongTien };
  });
}

/** Mọi phiếu nợ (kể cả đã trả đủ / huỷ), sắp cũ → mới, kèm còn nợ. */
export async function docPhieuConNo(db: DbDoc = prisma): Promise<PhieuConNo[]> {
  return docVaGhep(db, {});
}

/** Một phiếu theo `refId` (khoá phiếu Pancake) — `null` khi chưa ghi nhận vào sổ nợ. */
export async function docPhieuTheoRefId(refId: string, db: DbDoc = prisma): Promise<PhieuConNo | null> {
  const [p] = await docVaGhep(db, { refId });
  return p ?? null;
}

/** Một phiếu theo id — `null` khi không có. */
export async function docPhieuTheoId(id: string, db: DbDoc = prisma): Promise<PhieuConNo | null> {
  const [p] = await docVaGhep(db, { id });
  return p ?? null;
}

/**
 * VÂN TAY danh sách phiếu nợ chủ shop VỪA NHÌN khi phân bổ một đợt trả gộp: sha256 của các cặp
 * `id|conNo` SẮP XẾP theo id (thứ tự đọc không ảnh hưởng). Tính trên MỌI phiếu (không chỉ phiếu được
 * phân bổ): client không tự tính được băm của tập con, nên trang đưa một vân tay cho cả danh sách và
 * action tính lại đúng trên cả danh sách. Phiếu nào đổi còn nợ (tab khác vừa trả, vừa hoàn, vừa ghi
 * nhận phiếu mới, vừa cập nhật tổng/huỷ) ⇒ vân tay đổi ⇒ đợt trả bị từ chối, bắt tải lại — từ chối
 * thừa một lượt rẻ hơn nhiều so với phân bổ trên số còn nợ đã cũ.
 */
export function vanTayPhieuConNo(rows: readonly Pick<PhieuConNo, "id" | "conNo">[]): string {
  const cap = rows.map((r) => `${r.id}|${r.conNo}`).sort();
  return createHash("sha256").update(cap.join("\n")).digest("hex");
}

/**
 * KHOÁ các phiếu (`FOR UPDATE`) — KHUÔN Y HỆT `khoaCacKhoanVay` (`vi-tu-du-no.ts`): bỏ trùng, sắp id
 * tăng dần rồi khoá TỪNG id một câu theo đúng thứ tự đó. Hai đợt trả gộp chạm cùng tập phiếu vì thế
 * không bao giờ giữ chéo nhau; KHÔNG dùng một câu `= ANY(...)` vì Postgres không hứa thứ tự khoá các
 * dòng trong một câu. Chờ khoá có hạn (ngân sách chung của transaction — `khoa-dong-tien-co-han.ts`).
 * Id không có dòng ⇒ 0 hàng, không khoá gì — caller tự báo "không tìm thấy" sau khi đọc lại.
 */
export async function khoaCacPhieu(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
  hanChoMs: number = HAN_CHO_KHOA_DONG_TIEN_MS,
): Promise<void> {
  const sap = [...new Set(ids)].sort();
  if (sap.length === 0) return;
  await khoaDongTienCoHan(
    tx,
    sap.map((id) => () => tx.$queryRaw`SELECT id FROM "PhieuNhapNo" WHERE id = ${id} FOR UPDATE`),
    hanChoMs,
  );
}

/** `refId` phiếu Pancake ⇒ uuid phiếu (`null` khi không mang tiền tố của app). */
function uuidTuRefId(refId: string): string | null {
  return refId.startsWith(TIEN_TO_REF_ID) ? refId.slice(TIEN_TO_REF_ID.length) : null;
}

/**
 * Bản Bronze MỚI NHẤT của từng phiếu nhập kho (DISTINCT ON — cùng lý do `doc-phieu-nhap-bronze.ts`:
 * mỗi lượt đồng bộ chụp lại cả danh sách, bản cũ còn mang status=1 của phiếu sau đó đã huỷ).
 * `uuids` có ⇒ chỉ đọc các phiếu đó. Chỉ trả phiếu nhập hàng THẬT (`rutPhieuTuPayload` lọc).
 */
export async function docPhieuBronzeMoiNhat(
  uuids?: readonly string[],
  db: DbDoc = prisma,
): Promise<Map<string, PhieuNhapPancake>> {
  const { kho } = await layCauHinhShop();
  if (uuids !== undefined && uuids.length === 0) return new Map();
  const locId =
    uuids === undefined ? Prisma.empty : Prisma.sql`AND "externalId" IN (${Prisma.join([...uuids])})`;
  const rows = await db.$queryRaw<{ payload: unknown }[]>`
    SELECT DISTINCT ON ("shopId", "externalId") payload
      FROM "RawPancakePurchase"
     WHERE "shopId" = ${kho} ${locId}
     ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC`;
  const ketQua = new Map<string, PhieuNhapPancake>();
  for (const r of rows) {
    const p = rutPhieuTuPayload(r.payload);
    if (p !== null) ketQua.set(p.uuid, p);
  }
  return ketQua;
}

/** Status Pancake đã ĐO là "đã huỷ" (xem `doi-chieu-phieu-nhap.ts` — #173/#179). */
const STATUS_DA_HUY = 2;

type CanhBaoChung = { phieuNhapId: string; maPhieu: string; chiTiet: string };

/** Cảnh báo hậu kiểm — CHỈ cảnh báo, không tự sửa gì (tiền đã trả không bao giờ tự xoá). */
export type CanhBaoHauKiem =
  | (CanhBaoChung & { loai: "DOI_TONG"; soCu: number; soMoi: number })
  | (CanhBaoChung & { loai: "DA_HUY_PANCAKE" })
  | (CanhBaoChung & { loai: "LECH_DA_TRA_TRUOC"; soCu: number; soMoi: number });

/**
 * HẬU KIỂM phiếu đã ghi nhận vào sổ nợ — ba loại lệch giữa ảnh chụp `PhieuNhapNo` và nguồn:
 * - `DOI_TONG`: Pancake (bản Bronze mới nhất) khai `total_price` khác `tongTien` ⇒ nút "Cập nhật tổng".
 * - `DA_HUY_PANCAKE`: Pancake `status=2` mà phiếu chưa `daHuy` ⇒ nút "Đánh dấu huỷ". Mã lạ (≠1, ≠2)
 *   KHÔNG suy là huỷ (cùng luật fail-closed của màn chi phí nhập hàng).
 * - `LECH_DA_TRA_TRUOC`: số nguồn ≠ `daTraTruoc` — số nguồn = `amount` dòng Sổ chi phí cùng `refId`
 *   (khoản "Nhập hàng" cũ trước M); KHÔNG có dòng mà phiếu từ D0 trở đi (hoặc chưa mở sổ) ⇒ số nguồn
 *   0 (cùng luật `daTraTruocHopLe`): dòng chi phí bị xoá thì tiền đó chưa rời quỹ, sổ nợ không được
 *   nói "đã trả". Phiếu trước D0 không dòng chi phí ⇒ không cảnh báo (gõ tay hợp lệ). Ẩn khi chủ shop
 *   đã giải thích (`lechDaGiaiThich`) ĐÚNG số nguồn hiện tại (`lechDaGiaiThichSo`) — số nguồn đổi
 *   tiếp sau lời giải thích ⇒ hiện lại.
 * Phiếu không còn bản Bronze (hoặc không còn là phiếu nhập thật) ⇒ bỏ qua hai luật đầu.
 */
export async function hauKiemPhieu(db: DbDoc = prisma): Promise<CanhBaoHauKiem[]> {
  const phieu = await db.phieuNhapNo.findMany({
    select: CHON_PHIEU,
    orderBy: [{ ngayPhieu: "asc" }, { id: "asc" }],
  });
  if (phieu.length === 0) return [];

  const uuids = phieu.flatMap((p) => {
    const u = uuidTuRefId(p.refId);
    return u === null ? [] : [u];
  });
  const bronze = await docPhieuBronzeMoiNhat(uuids, db);
  const chiPhi = new Map(
    (
      await db.expense.findMany({
        where: { refId: { in: phieu.map((p) => p.refId) } },
        select: { refId: true, amount: true },
      })
    ).flatMap((e) => (e.refId === null ? [] : [[e.refId, e.amount] as const])),
  );

  const d0 = await ngayMoSo();

  const ra: CanhBaoHauKiem[] = [];
  for (const p of phieu) {
    const chung = { phieuNhapId: p.id, maPhieu: p.maPhieu };
    const u = uuidTuRefId(p.refId);
    const b = u === null ? undefined : bronze.get(u);
    if (b !== undefined && b.soTien !== p.tongTien) {
      ra.push({
        ...chung,
        loai: "DOI_TONG",
        soCu: p.tongTien,
        soMoi: b.soTien,
        chiTiet: `Phiếu ${p.maPhieu}: sổ nợ ghi tổng ${formatVnd(p.tongTien)}, Pancake hiện khai ${formatVnd(b.soTien)}.`,
      });
    }
    if (b !== undefined && b.status === STATUS_DA_HUY && !p.daHuy) {
      ra.push({
        ...chung,
        loai: "DA_HUY_PANCAKE",
        chiTiet: `Phiếu ${p.maPhieu} đã bị huỷ bên Pancake nhưng sổ nợ vẫn còn nghĩa vụ ${formatVnd(p.tongTien)}.`,
      });
    }
    const coDongChiPhi = chiPhi.has(p.refId);
    const soNguon = coDongChiPhi ? chiPhi.get(p.refId) : laPhieuTruocMoSo(p.ngayPhieu, d0) ? undefined : 0;
    const daGiaiThich = p.lechDaGiaiThich && p.lechDaGiaiThichSo === soNguon;
    if (soNguon !== undefined && soNguon !== p.daTraTruoc && !daGiaiThich) {
      ra.push({
        ...chung,
        loai: "LECH_DA_TRA_TRUOC",
        soCu: p.daTraTruoc,
        soMoi: soNguon,
        chiTiet: coDongChiPhi
          ? `Phiếu ${p.maPhieu}: sổ nợ ghi đã trả trước ${formatVnd(p.daTraTruoc)}, ` +
            `Sổ chi phí đang giữ ${formatVnd(soNguon)}.`
          : `Phiếu ${p.maPhieu}: sổ nợ ghi đã trả trước ${formatVnd(p.daTraTruoc)} nhưng Sổ chi phí không còn ` +
            `dòng nào cho phiếu này — khoản đó chưa rời quỹ.`,
      });
    }
  }
  return ra;
}
