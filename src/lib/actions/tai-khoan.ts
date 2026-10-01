"use server";

/**
 * Quản lý tài khoản nhân sự (trang `/quan-tri`, CHỈ chủ shop) — spec phân quyền §1.3, §3.2, §6.
 *
 * Bất biến:
 * - Mọi action mở bằng `congChuShopAction()`, rồi chặn khi đang phục hồi DB (bản backup sẽ lùi mất
 *   lượt ghi) — TRƯỚC mọi mutation, trước cả khi sinh mật khẩu tạm.
 * - Chủ shop BẤT KHẢ XÂM PHẠM: mọi mutation trên tài khoản có sẵn khoá dòng đích `SELECT … FOR UPDATE`
 *   rồi mới quyết; đích là OWNER ⇒ `KHONG_TAC_DONG_CHU_SHOP`, không đổi gì. Tạo mới chỉ ra STAFF
 *   (schema không có trường `role`; DB còn partial unique index một-OWNER).
 * - Nhật ký OK ghi CÙNG transaction với mutation; thất bại ghi LOI bằng client gốc sau rollback.
 *   Nhật ký KHÔNG BAO GIỜ chứa mật khẩu tạm/hash — mật khẩu tạm chỉ đi ra đúng một lần trong `data`.
 */
import { Prisma, type Role } from "@prisma/client";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { chuanHoaEmail } from "@/lib/chuan-hoa-email";
import { ghiNhatKy, ghiNhatKyLoi, type ActorNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG, type HanhDong } from "@/lib/nhat-ky/hanh-dong";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { sinhMatKhauTam } from "@/lib/quan-tri/mat-khau-tam";
import { congChuShopAction } from "@/lib/quyen/cong-action";
import { chuanHoaQuyen } from "@/lib/quyen/danh-muc-quyen";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { sinhMocPhien, thuHoiPhienCuaNguoi, type ClientTrongTransaction } from "@/lib/session";

type MaLoiTaiKhoan = "EMAIL_DA_DUNG" | "KHONG_TAC_DONG_CHU_SHOP" | "TO_HOP_QUYEN_SAI" | "KHONG_TIM_THAY";
type ThatBai = Extract<ActionResult, { ok: false }>;

const THONG_BAO: Record<MaLoiTaiKhoan, string> = {
  EMAIL_DA_DUNG: "Email này đã được dùng cho một tài khoản khác",
  KHONG_TAC_DONG_CHU_SHOP: "Không thể thao tác trên tài khoản chủ shop",
  TO_HOP_QUYEN_SAI: "Danh sách quyền không hợp lệ",
  KHONG_TIM_THAY: "Không tìm thấy tài khoản — có thể đã bị xoá",
};
/** Ô form gắn lỗi (UI tô đỏ đúng chỗ). */
const O_FORM: Partial<Record<MaLoiTaiKhoan, string>> = { EMAIL_DA_DUNG: "email", TO_HOP_QUYEN_SAI: "quyen" };
const LOI_LUU = "Không lưu được thay đổi — thử lại";

class LoiTaiKhoan extends Error {
  constructor(readonly code: MaLoiTaiKhoan) {
    super(code);
  }
}

function thatBai(code: MaLoiTaiKhoan, error = THONG_BAO[code]): ThatBai {
  const field = O_FORM[code];
  return field ? { ok: false, error, code, field } : { ok: false, error, code };
}

function actorCua(nd: NguoiDung): ActorNhatKy {
  return { id: nd.id, email: nd.email };
}

/** Trùng unique (`email` hoặc index `lower(email)`) — Prisma báo P2002 cho cả unique index viết tay. */
function laLoiTrungEmail(loi: unknown): boolean {
  return loi instanceof Prisma.PrismaClientKnownRequestError && loi.code === "P2002";
}

/**
 * Lỗi sau khi transaction đã rollback: lỗi nghiệp vụ ⇒ mã + dòng LOI; lỗi lạ ⇒ log server + câu chung
 * (không đẩy chi tiết DB ra client).
 */
async function xuLyLoi(actor: ActorNhatKy, hanhDong: HanhDong, loi: unknown, doiTuong: { id?: string; moTa?: string }): Promise<ThatBai> {
  const code: MaLoiTaiKhoan | null =
    loi instanceof LoiTaiKhoan ? loi.code : laLoiTrungEmail(loi) ? "EMAIL_DA_DUNG" : null;
  if (!code) console.error(`[tai-khoan] ${hanhDong} lỗi:`, loi);
  await ghiNhatKyLoi({ actor, hanhDong, doiTuong: { loai: "User", ...doiTuong }, ghiChu: { lyDo: code ?? "lỗi lưu" } });
  return code ? thatBai(code) : { ok: false, error: LOI_LUU };
}

const taoTaiKhoanSchema = z.object({
  email: z.preprocess(
    (v) => (typeof v === "string" ? chuanHoaEmail(v) : v),
    z.email("Email không hợp lệ").max(254, "Email quá dài"),
  ),
  tenHienThi: z.string("Tên hiển thị không hợp lệ").trim().min(1, "Nhập tên hiển thị").max(80, "Tên hiển thị tối đa 80 ký tự"),
  quyen: z.array(z.string().max(64)).max(100),
});

/**
 * Tạo tài khoản NHÂN SỰ (STAFF). Form: `email`, `tenHienThi`, `quyen` (lặp, `formData.getAll`). Trường
 * lạ (vd `role`) bị bỏ qua. Server sinh mật khẩu tạm, bắt đổi ở lần đăng nhập đầu; mật khẩu tạm trả về
 * MỘT lần duy nhất trong `data` — không lưu, không ghi nhật ký.
 */
export async function taoTaiKhoan(formData: FormData): Promise<ActionResult<{ id: string; matKhauTam: string }>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  const actor = actorCua(c.nguoiDung);

  const parsed = taoTaiKhoanSchema.safeParse({
    email: formData.get("email"),
    tenHienThi: formData.get("tenHienThi") ?? "",
    quyen: formData.getAll("quyen"),
  });
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { email, tenHienThi } = parsed.data;
  const quyen = chuanHoaQuyen(parsed.data.quyen);
  if (!quyen.ok) return thatBai("TO_HOP_QUYEN_SAI", quyen.error);

  const matKhauTam = sinhMatKhauTam();
  // scrypt tốn hàng trăm ms — băm XONG rồi mới mở transaction.
  const passwordHash = await hashPassword(matKhauTam);

  try {
    const id = await prisma.$transaction(async (tx) => {
      const { id } = await tx.user.create({
        data: {
          email,
          passwordHash,
          role: "STAFF",
          tenHienThi,
          quyen: quyen.quyen,
          mustChangePassword: true,
          // Epoch ngẫu nhiên ngay từ đầu (không để mặc định "0"): cookie đời cũ không mang `mocPhien`
          // quy về "0" — tài khoản mới không có lý do gì để khớp dạng đó.
          sessionEpoch: sinhMocPhien(),
        },
        select: { id: true },
      });
      await ghiNhatKy(tx, { actor, hanhDong: HANH_DONG.TAI_KHOAN_TAO, doiTuong: { loai: "User", id, moTa: email } });
      return id;
    });
    return { ok: true, data: { id, matKhauTam } };
  } catch (loi) {
    return xuLyLoi(actor, HANH_DONG.TAI_KHOAN_TAO, loi, { moTa: email });
  }
}

// ─── Mutation trên tài khoản CÓ SẴN: khoá dòng đích, chủ shop bất khả xâm phạm ────────────────────

type DongDich = {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
  sessionEpoch: string;
  mustChangePassword: boolean;
};

/** Khoá dòng đích tới hết transaction. Không có ⇒ `KHONG_TIM_THAY`; là OWNER ⇒ `KHONG_TAC_DONG_CHU_SHOP`. */
async function khoaDongDich(tx: ClientTrongTransaction, id: string): Promise<DongDich> {
  const [dong] = await tx.$queryRaw<DongDich[]>`
    SELECT "id", "email", "role"::text AS "role", "isActive", "sessionEpoch", "mustChangePassword"
    FROM "User" WHERE "id" = ${id} FOR UPDATE`;
  if (!dong) throw new LoiTaiKhoan("KHONG_TIM_THAY");
  if (dong.role === "OWNER") throw new LoiTaiKhoan("KHONG_TAC_DONG_CHU_SHOP");
  return dong;
}

function laIdHopLe(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 64;
}

/**
 * Khuôn chung: một transaction = khoá dòng đích + mutation + nhật ký OK (đối tượng mang email SNAPSHOT
 * — sống qua hard delete).
 */
async function capNhatTaiKhoanDich<T>(
  nd: NguoiDung,
  id: unknown,
  hanhDong: HanhDong,
  mutation: (tx: ClientTrongTransaction, dong: DongDich) => Promise<T>,
): Promise<ActionResult<T>> {
  if (!laIdHopLe(id)) return thatBai("KHONG_TIM_THAY");
  const actor = actorCua(nd);
  try {
    const data = await prisma.$transaction(async (tx) => {
      const dong = await khoaDongDich(tx, id);
      const kq = await mutation(tx, dong);
      await ghiNhatKy(tx, { actor, hanhDong, doiTuong: { loai: "User", id: dong.id, moTa: dong.email } });
      return kq;
    });
    return { ok: true, data };
  } catch (loi) {
    return xuLyLoi(actor, hanhDong, loi, { id });
  }
}

const danhSachQuyenSchema = z.array(z.string().max(64)).max(100);

/**
 * Thay TOÀN BỘ quyền của một tài khoản nhân sự. KHÔNG đổi epoch (spec §6): mỗi request đọc `quyen` từ
 * DB nên quyền mới áp ngay ở request kế; đẩy epoch chỉ đá người ta ra vô cớ.
 */
export async function suaQuyenTaiKhoan(id: string, quyen: string[]): Promise<ActionResult> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = danhSachQuyenSchema.safeParse(quyen);
  if (!parsed.success) return thatBai("TO_HOP_QUYEN_SAI");
  const chuan = chuanHoaQuyen(parsed.data);
  if (!chuan.ok) return thatBai("TO_HOP_QUYEN_SAI", chuan.error);

  return capNhatTaiKhoanDich(c.nguoiDung, id, HANH_DONG.TAI_KHOAN_SUA_QUYEN, async (tx, dong) => {
    await tx.user.update({ where: { id: dong.id }, data: { quyen: chuan.quyen } });
  });
}

/** Khoá: `isActive=false` + thu hồi mọi phiên của người đó, cùng transaction. */
export async function khoaTaiKhoan(id: string): Promise<ActionResult> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  return capNhatTaiKhoanDich(c.nguoiDung, id, HANH_DONG.TAI_KHOAN_KHOA, async (tx, dong) => {
    await tx.user.update({ where: { id: dong.id }, data: { isActive: false } });
    await thuHoiPhienCuaNguoi(tx, dong.id);
  });
}

/** Mở khoá: `isActive=true`, KHÔNG đổi epoch — phiên đã bị thu hồi lúc khoá vẫn chết, phải đăng nhập lại. */
export async function moKhoaTaiKhoan(id: string): Promise<ActionResult> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  return capNhatTaiKhoanDich(c.nguoiDung, id, HANH_DONG.TAI_KHOAN_MO_KHOA, async (tx, dong) => {
    await tx.user.update({ where: { id: dong.id }, data: { isActive: true } });
  });
}

/**
 * Xoá HẲN (hard delete, chốt spec §6). Dấu vết còn ở `AuditLog`: `actorId` bất biến (không FK) +
 * `doiTuongMoTa` = email snapshot. Phiên còn sống của người bị xoá: request kế không tìm thấy dòng ⇒
 * `docNguoiDungPhien` trả `null`.
 */
export async function xoaTaiKhoan(id: string): Promise<ActionResult> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  return capNhatTaiKhoanDich(c.nguoiDung, id, HANH_DONG.TAI_KHOAN_XOA, async (tx, dong) => {
    await tx.user.delete({ where: { id: dong.id } });
  });
}

/**
 * Đặt lại mật khẩu: hash mật khẩu tạm mới + bắt đổi ở lần đăng nhập kế + thu hồi mọi phiên, CÙNG
 * transaction (khoá dòng đích). Mật khẩu tạm trả về MỘT lần trong `data`. Một lượt đổi mật khẩu lần
 * đầu đang chờ khoá dòng sẽ thấy epoch đã đổi ⇒ `TRANG_THAI_DA_DOI`, không đè hash vừa đặt lại.
 */
export async function datLaiMatKhau(id: string): Promise<ActionResult<{ matKhauTam: string }>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  if (!laIdHopLe(id)) return thatBai("KHONG_TIM_THAY");

  const matKhauTam = sinhMatKhauTam();
  // scrypt tốn hàng trăm ms — băm XONG rồi mới khoá dòng.
  const passwordHash = await hashPassword(matKhauTam);

  return capNhatTaiKhoanDich(c.nguoiDung, id, HANH_DONG.TAI_KHOAN_DAT_LAI_MK, async (tx, dong) => {
    await tx.user.update({ where: { id: dong.id }, data: { passwordHash, mustChangePassword: true } });
    await thuHoiPhienCuaNguoi(tx, dong.id);
    return { matKhauTam };
  });
}
