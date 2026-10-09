"use server";

import { startOfDay } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";

import type { ActionResult } from "@/lib/actions/action-result";
import { maLoiNhatKy } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { formatVnd } from "@/lib/format";
import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { refIdChoPhieu, TIEN_TO_REF_ID } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import type { HanhDong } from "@/lib/nhat-ky/hanh-dong";
import { daBatNoPhaiTra, LoiChuaBat } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import {
  daTraTruocHopLe,
  LoiPhieu,
  lyDoLechSchema,
  noiLyDoLech,
  type DaTraTruocChapNhan,
} from "@/lib/no-phai-tra/luat-da-tra-truoc-phieu";
import { chanHoanVuotDaTra, LoiHoSoNo } from "@/lib/no-phai-tra/ho-so-dong-tien-no";
import { ngayTienMoiSchema } from "@/lib/no-phai-tra/ngay-tien-moi-schema";
import {
  docPhieuBronzeMoiNhat,
  docPhieuTheoId,
  khoaCacPhieu,
  type PhieuConNo,
} from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { prisma } from "@/lib/prisma";
import { lyDoKhongXoaPhieu } from "@/lib/no-phai-tra/ly-do-khong-xoa-phieu";
import { congAction, congChuShopAction } from "@/lib/quyen/cong-action";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";
import { laChuShop, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { laLoiDongTienBan, OPT_TX_DONG_TIEN, THONG_BAO_KHOA_DONG_TIEN_BAN } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * HỒ SƠ NGHĨA VỤ phiếu nhập (`PhieuNhapNo`) — spec §5.3. Tách nghĩa vụ (phiếu Pancake nói shop nợ
 * nhà cung cấp bao nhiêu) khỏi tiền (dòng `SUPPLIER_PAY` ngày trả thật). Hồ sơ KHÔNG mang tiền nên
 * ghi nhận được cả TRƯỚC khi bật M (giai đoạn chuẩn bị); chỉ phần "đã trả ngay" — một dòng tiền mới —
 * mới cần cổng `daBatNoPhaiTra()`.
 *
 * ĐỌC LẠI phiếu Pancake (bản Bronze mới nhất) TRONG action, không nhận số từ client: client chỉ gửi
 * uuid + phần chủ shop biết mà Pancake không có (đã trả trước D0 / đã trả ngay). Cùng nguyên tắc với
 * `chi-phi-nhap-hang.ts`.
 *
 * Hậu kiểm (`hauKiemPhieu`) chỉ CẢNH BÁO; bốn action sửa dưới đây là bốn nút chủ shop bấm sau khi
 * đọc cảnh báo. Mọi lượt sửa khoá dòng phiếu (`khoaCacPhieu`) — cùng khoá với đợt trả gộp, nên một
 * lượt sửa tổng không chen được giữa lúc đợt trả đang kiểm vân tay.
 *
 * PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` — `dangPhucHoi()` gọi trực
 * tiếp trong thân từng export.
 */

/** Pancake: 1 = phiếu còn hiệu lực, 2 = đã huỷ (đo được). Mã khác ⇒ app không đoán. */
const STATUS_CON_HIEU_LUC = 1;
const STATUS_DA_HUY = 2;

const tienDuong = z.coerce
  .number({ error: "Số tiền không hợp lệ" })
  .int("Số tiền phải là số nguyên")
  .positive("Số tiền phải lớn hơn 0")
  .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)");

const tienKhongAm = z.coerce
  .number({ error: "Số tiền không hợp lệ" })
  .int("Số tiền phải là số nguyên")
  .min(0, "Số tiền không âm")
  .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)");

const idPhieu = z.string().min(1, "Thiếu phiếu");

type KetQuaPhieu = { phieuNhapId: string; tongTien: number; daTraTruoc: number; conNo: number };

function tomTat(p: PhieuConNo): KetQuaPhieu {
  return { phieuNhapId: p.id, tongTien: p.tongTien, daTraTruoc: p.daTraTruoc, conNo: p.conNo };
}

function lamMoi(): void {
  lamMoiTrang();
  revalidatePath("/tai-chinh/chi-phi-nhap-hang");
}

/** Lỗi đã bắt ⇒ `ActionResult` thất bại. Lỗi hạ tầng: log đủ phía server, client nhận câu cố định. */
function ketQuaLoi(e: unknown, macDinh: string): { ok: false; error: string; code?: string; field?: string } {
  if (e instanceof LoiPhieu) return { ok: false, error: e.message, code: e.code, field: e.field };
  if (laLoiDongTienBan(e)) return { ok: false, error: THONG_BAO_KHOA_DONG_TIEN_BAN };
  console.error(macDinh, e);
  return { ok: false, error: macDinh };
}

/** Nhật ký LOI cho lượt ghi đã vào tới transaction rồi thất bại. */
async function ghiLoi(nguoiDung: NguoiDung, hanhDong: HanhDong, id: string | undefined, e: unknown): Promise<void> {
  await ghiNhatKyLoi({
    actor: nguoiDung,
    hanhDong,
    doiTuong: { loai: "PhieuNhapNo", id },
    ghiChu: { lyDo: maLoiNhatKy(e) },
  });
}

/** Ba cột "đã giải thích lệch" theo kết quả luật — CÙNG câu ghi với `daTraTruoc` (phương án Y). */
function cotGiaiThich(kq: DaTraTruocChapNhan, noteCu: string) {
  if (kq.giaiThich === null) return { lechDaGiaiThich: false, lechDaGiaiThichSo: null, note: noteCu };
  return {
    lechDaGiaiThich: true,
    lechDaGiaiThichSo: kq.giaiThich.soChiPhi,
    note: noiLyDoLech(noteCu, kq.giaiThich.lyDo),
  };
}

// ─── Ghi nhận ─────────────────────────────────────────────────────────────────────────────────────

const ghiNhanSchema = z.object({
  uuid: z.string().min(1, "Thiếu phiếu nhập"),
  /** Bỏ trống ⇒ theo số nguồn (dòng Sổ chi phí cùng refId / 0); phiếu trước D0 gõ tự do (`daTraTruocHopLe`). */
  daTraTruoc: tienKhongAm.optional(),
  /** Phương án Y: gõ `daTraTruoc` KHÁC số nguồn — chỉ chủ shop, bắt buộc kèm lý do. */
  lyDoLech: lyDoLechSchema,
  /** "Đã trả ngay X, ngày …" ⇒ một dòng `SUPPLIER_PAY` cùng transaction. Ngày kiểm sau khi biết M. */
  daTraNgay: z.object({ soTien: tienDuong, ngay: z.unknown() }).optional(),
});

/**
 * "Ghi nhận vào sổ nợ" từ màn duyệt phiếu nhập: tạo `PhieuNhapNo` (`tongTien = total_price` bản Bronze
 * mới nhất), kèm `SUPPLIER_PAY` nếu chủ shop khai "đã trả ngay". Một phiếu = một hồ sơ (`refId`
 * unique) — gửi lại ⇒ `DA_GHI_ROI`, không ghi gì.
 */
export async function ghiNhanPhieuVaoSoNo(input: unknown): Promise<ActionResult<KetQuaPhieu>> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = ghiNhanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { uuid, daTraTruoc: daGo, daTraNgay, lyDoLech } = parsed.data;

  // "Đã trả ngay" là TIỀN MỚI ⇒ chỉ sống sau khi bật. Từ chối TRƯỚC mọi câu ghi: không được để lại
  // hồ sơ mà thiếu dòng tiền chủ shop vừa khai (họ sẽ tưởng đã ghi cả hai).
  let traNgay: { soTien: number; ngay: Date } | null = null;
  if (daTraNgay !== undefined) {
    let mocM: Date;
    try {
      mocM = await daBatNoPhaiTra();
    } catch (e) {
      if (e instanceof LoiChuaBat) return { ok: false, error: e.message, code: e.code };
      throw e;
    }
    const ngay = ngayTienMoiSchema(mocM).safeParse(daTraNgay.ngay);
    if (!ngay.success) return { ok: false, error: ngay.error.issues[0].message, field: "daTraNgay" };
    traNgay = { soTien: daTraNgay.soTien, ngay: startOfDay(ngay.data) };
  }

  const p = (await docPhieuBronzeMoiNhat([uuid])).get(uuid);
  if (p === undefined) {
    return {
      ok: false,
      error: "Không còn thấy phiếu nhập này bên Pancake — tải lại trang",
      code: "DANH_SACH_DA_DOI",
    };
  }
  if (p.status !== STATUS_CON_HIEU_LUC) {
    return {
      ok: false,
      error:
        p.status === STATUS_DA_HUY
          ? "Phiếu đã bị huỷ bên Pancake — không ghi nhận nghĩa vụ"
          : `Phiếu mang trạng thái app chưa biết (mã ${p.status}) — kiểm tra bên Pancake trước`,
      code: "PHIEU_KHONG_HIEU_LUC",
    };
  }

  const refId = refIdChoPhieu(uuid);
  const maPhieu = p.displayId !== null ? `#${p.displayId}` : `#${uuid.slice(0, 8)}`;
  let idTao: string | undefined;
  try {
    const kq = await daTraTruocHopLe(prisma, { refId, ngayPhieu: p.ngay }, daGo, {
      laChuShop: laChuShop(nguoiDung),
      lyDoLech,
    });
    const { kho: shopId } = await layCauHinhShop();
    const ket = await prisma.$transaction(async (tx) => {
      const tao = await tx.phieuNhapNo.create({
        data: {
          refId,
          shopId,
          maPhieu,
          ngayPhieu: p.ngay,
          tongTien: p.soTien,
          daTraTruoc: kq.daTraTruoc,
          ...cotGiaiThich(kq, ""),
        },
        select: { id: true },
      });
      idTao = tao.id;
      if (traNgay !== null) {
        await tx.cashMovement.create({
          data: {
            date: traNgay.ngay,
            kind: "SUPPLIER_PAY",
            amount: traNgay.soTien,
            phieuNhapId: tao.id,
            description: `Trả tiền hàng phiếu ${maPhieu} (trả ngay lúc ghi nhận)`,
          },
        });
      }
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "NHAP_HANG_GHI_NO",
        doiTuong: { loai: "PhieuNhapNo", id: tao.id, moTa: maPhieu },
        ghiChu: { soDong: traNgay === null ? 0 : 1 },
      });
      const doc = await docPhieuTheoId(tao.id, tx);
      if (doc === null) throw new Error(`PhieuNhapNo ${tao.id} vừa tạo mà không đọc lại được`);
      return tomTat(doc);
    });
    lamMoi();
    return { ok: true, data: ket };
  } catch (e) {
    // `refId` unique: phiếu đã có hồ sơ (tab khác vừa ghi, hoặc bấm lại) ⇒ transaction đã lùi trọn.
    if ((e as { code?: string })?.code === "P2002") {
      return { ok: false, error: `Phiếu ${maPhieu} đã có trong sổ nợ — không ghi thêm`, code: "DA_GHI_ROI" };
    }
    if (!(e instanceof LoiPhieu)) await ghiLoi(nguoiDung, "NHAP_HANG_GHI_NO", idTao, e);
    return ketQuaLoi(e, "Không ghi nhận được phiếu vào sổ nợ — lỗi hệ thống, thử lại sau.");
  }
}

// ─── Sửa sau hậu kiểm ─────────────────────────────────────────────────────────────────────────────

/**
 * Khung chung của bốn lượt sửa: khoá phiếu → đọc lại → `sua` → nhật ký → trả số mới. `sua` trả
 * `false` ⇒ không có gì đổi (bấm lặp), bỏ nhật ký.
 */
async function suaPhieu(
  nguoiDung: NguoiDung,
  phieuNhapId: string,
  hanhDong: HanhDong,
  lyDo: string,
  sua: (tx: Prisma.TransactionClient, p: PhieuConNo) => Promise<boolean>,
): Promise<ActionResult<KetQuaPhieu>> {
  try {
    const ket = await prisma.$transaction(async (tx) => {
      await khoaCacPhieu(tx, [phieuNhapId]);
      const p = await docPhieuTheoId(phieuNhapId, tx);
      if (p === null) throw new LoiPhieu("Không tìm thấy phiếu trong sổ nợ — tải lại trang", "KHONG_TIM_THAY");
      const coDoi = await sua(tx, p);
      if (!coDoi) return tomTat(p);
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong,
        doiTuong: { loai: "PhieuNhapNo", id: p.id, moTa: p.maPhieu },
        ghiChu: { lyDo },
      });
      const moi = await docPhieuTheoId(phieuNhapId, tx);
      if (moi === null) throw new Error(`PhieuNhapNo ${phieuNhapId} biến mất giữa lượt sửa đang khoá`);
      return tomTat(moi);
    }, OPT_TX_DONG_TIEN);
    lamMoi();
    return { ok: true, data: ket };
  } catch (e) {
    if (!(e instanceof LoiPhieu)) await ghiLoi(nguoiDung, hanhDong, phieuNhapId, e);
    return ketQuaLoi(e, "Không cập nhật được phiếu nợ — lỗi hệ thống, thử lại sau.");
  }
}

function uuidCua(p: PhieuConNo): string {
  if (!p.refId.startsWith(TIEN_TO_REF_ID)) throw new LoiPhieu("Phiếu này không gắn phiếu nhập Pancake");
  return p.refId.slice(TIEN_TO_REF_ID.length);
}

const capNhatTongSchema = z.object({
  phieuNhapId: idPhieu,
  /** Tổng Pancake chủ shop VỪA THẤY trên cảnh báo — khác bản Bronze hiện tại ⇒ tải lại. */
  tongTienMoi: tienKhongAm,
});

/** "Cập nhật tổng": `tongTien` := `total_price` bản Bronze mới nhất (đúng số chủ shop vừa thấy). */
export async function capNhatTongPhieu(input: unknown): Promise<ActionResult<KetQuaPhieu>> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = capNhatTongSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { phieuNhapId, tongTienMoi } = parsed.data;

  return suaPhieu(nguoiDung, phieuNhapId, "NHAP_HANG_SUA_NO", "tongTien", async (tx, p) => {
    const uuid = uuidCua(p);
    const b = (await docPhieuBronzeMoiNhat([uuid], tx)).get(uuid);
    if (b === undefined) throw new LoiPhieu("Không còn thấy phiếu này bên Pancake — không cập nhật được tổng");
    if (b.soTien !== tongTienMoi) {
      throw new LoiPhieu(
        `Pancake vừa đổi tổng phiếu (hiện ${formatVnd(b.soTien)}) — tải lại trang rồi cập nhật lại`,
        "DANH_SACH_DA_DOI",
      );
    }
    if (p.tongTien === b.soTien) return false;
    await tx.phieuNhapNo.update({ where: { id: p.id }, data: { tongTien: b.soTien } });
    return true;
  });
}

const capNhatDaTraTruocSchema = z.object({ phieuNhapId: idPhieu, daTraTruoc: tienKhongAm, lyDoLech: lyDoLechSchema });

/**
 * "Cập nhật đã trả trước": theo luật `daTraTruocHopLe` (đúng số nguồn ⇒ ai có quyền cũng được; khác số
 * nguồn ⇒ chỉ chủ shop + lý do lệch — phương án Y). Không lệch ⇒ TẮT cờ "đã giải thích" (lời giải thích
 * cũ không còn áp); lệch có lý do ⇒ BẬT cờ + lưu số Sổ chi phí lúc giải thích + nối lý do vào ghi chú.
 */
export async function capNhatDaTraTruoc(input: unknown): Promise<ActionResult<KetQuaPhieu>> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = capNhatDaTraTruocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { phieuNhapId, daTraTruoc, lyDoLech } = parsed.data;

  return suaPhieu(nguoiDung, phieuNhapId, "NHAP_HANG_SUA_NO", "daTraTruoc", async (tx, p) => {
    const kq = await daTraTruocHopLe(tx, p, daTraTruoc, { laChuShop: laChuShop(nguoiDung), lyDoLech });
    const data = { daTraTruoc: kq.daTraTruoc, ...cotGiaiThich(kq, p.note) };
    const coDoi =
      data.daTraTruoc !== p.daTraTruoc ||
      data.lechDaGiaiThich !== p.lechDaGiaiThich ||
      data.lechDaGiaiThichSo !== p.lechDaGiaiThichSo ||
      data.note !== p.note;
    if (!coDoi) return false;
    await tx.phieuNhapNo.update({ where: { id: p.id }, data });
    // Bớt "đã trả trước" cũng hạ trần hoàn tiền: NCC đã hoàn 5 thì đã trả không được tụt dưới 5.
    try {
      await chanHoanVuotDaTra(tx, [p.id]);
    } catch (e) {
      if (e instanceof LoiHoSoNo) throw new LoiPhieu(e.message, e.code, "daTraTruoc");
      throw e;
    }
    return true;
  });
}

const huySchema = z.object({ phieuNhapId: idPhieu });

/**
 * "Đánh dấu huỷ" (CHỈ chủ shop): nghĩa vụ về 0, tiền đã trả giữ nguyên lịch sử và hiện thành "cần thu
 * hồi" (còn nợ âm) — đóng bằng `SUPPLIER_REFUND` khi nhà cung cấp hoàn. Không cần Pancake `status=2`:
 * nhà cung cấp có thể huỷ đơn ngoài Pancake.
 */
export async function danhDauHuyPhieu(input: unknown): Promise<ActionResult<KetQuaPhieu>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = huySchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };

  return suaPhieu(nguoiDung, parsed.data.phieuNhapId, "NHAP_HANG_HUY_NO", "daHuy", async (tx, p) => {
    if (p.daHuy) return false;
    await tx.phieuNhapNo.update({ where: { id: p.id }, data: { daHuy: true } });
    return true;
  });
}

const boQuaSchema = z.object({
  phieuNhapId: idPhieu,
  note: z.string().trim().min(1, "Ghi lý do lệch").max(200, "Tối đa 200 ký tự"),
});

/**
 * "Đã giải thích" lệch Sổ chi phí ≠ đã trả trước (CHỈ chủ shop — cho lệch phát sinh SAU ghi nhận, vd
 * Expense bị sửa/xoá): bật cờ `lechDaGiaiThich`, lưu số Sổ chi phí HIỆN TẠI (không có dòng ⇒ 0) vào
 * `lechDaGiaiThichSo`, ghi lý do vào `note`. Hậu kiểm ẩn `LECH_DA_TRA_TRUOC` chừng nào Sổ chi phí còn
 * đúng số đó; Expense đổi tiếp ⇒ cảnh báo hiện lại. "Cập nhật đã trả trước" không lệch ⇒ cờ tắt.
 */
export async function boQuaLechDaGiaiThich(input: unknown): Promise<ActionResult<KetQuaPhieu>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = boQuaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { phieuNhapId, note } = parsed.data;

  return suaPhieu(nguoiDung, phieuNhapId, "NHAP_HANG_SUA_NO", "lechDaGiaiThich", async (tx, p) => {
    const chiPhi = await tx.expense.findUnique({ where: { refId: p.refId }, select: { amount: true } });
    const soChiPhi = chiPhi?.amount ?? 0;
    if (p.lechDaGiaiThich && p.note === note && p.lechDaGiaiThichSo === soChiPhi) return false;
    await tx.phieuNhapNo.update({
      where: { id: p.id },
      data: { lechDaGiaiThich: true, lechDaGiaiThichSo: soChiPhi, note },
    });
    return true;
  });
}

/**
 * Xoá MỘT hồ sơ phiếu nợ ghi nhận nhầm — CHỈ khi không còn dòng tiền nào gắn phiếu (`lyDoKhongXoaPhieu`;
 * FK `CashMovement.phieuNhapId` Restrict cũng chặn). Hồ sơ vào thùng rác (spec §5.7), khôi phục dựng lại
 * đúng id + `refId`. Không mang tiền ⇒ không cần cổng bật; khoá phiếu như mọi lượt sửa để không chen giữa
 * một đợt trả gộp đang kiểm vân tay.
 */
export async function xoaPhieu(input: unknown): Promise<ActionResult> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = huySchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { phieuNhapId } = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      await khoaCacPhieu(tx, [phieuNhapId]);
      const phieu = await tx.phieuNhapNo.findUnique({ where: { id: phieuNhapId } });
      if (!phieu) throw new LoiPhieu("Không tìm thấy phiếu trong sổ nợ — tải lại trang", "KHONG_TIM_THAY");
      const lyDo = lyDoKhongXoaPhieu({ soDongTien: await tx.cashMovement.count({ where: { phieuNhapId } }) });
      if (lyDo !== null) throw new LoiPhieu(lyDo, "CON_DONG_TIEN");
      await chupVaoThungRac(tx, { bang: "PhieuNhapNo", banGhi: phieu });
      await tx.phieuNhapNo.delete({ where: { id: phieuNhapId } });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "NHAP_HANG_XOA_NO",
        doiTuong: { loai: "PhieuNhapNo", id: phieuNhapId, moTa: phieu.maPhieu },
      });
    }, OPT_TX_DONG_TIEN);
  } catch (e) {
    if (!(e instanceof LoiPhieu)) await ghiLoi(nguoiDung, "NHAP_HANG_XOA_NO", phieuNhapId, e);
    return ketQuaLoi(e, "Không xoá được phiếu nợ — lỗi hệ thống, thử lại sau.");
  }
  lamMoi();
  return { ok: true, data: undefined };
}
