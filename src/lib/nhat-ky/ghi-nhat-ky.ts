/**
 * Ghi nhật ký thao tác (`AuditLog`) — HAI đường ghi:
 *
 * - `ghiNhatKy(db, …)`: dòng OK, gọi BÊN TRONG transaction của mutation (truyền `tx`). Mutation
 *   rollback thì dòng nhật ký biến mất theo; ghi nhật ký ném thì mutation cũng không lưu — không bao
 *   giờ có thay đổi mà thiếu dấu vết.
 * - `ghiNhatKyLoi(…)`: dòng LOI, dùng client gốc SAU KHI cổng từ chối / transaction đã rollback. Lỗi
 *   ghi bị nuốt (console.error): nhật ký hỏng không được biến lượt từ chối thành 500. Tự BỎ QUA khi
 *   đang phục hồi DB (xem thân hàm).
 *
 * KHÔNG ghi giá trị trước/sau, IP, hay bất kỳ bí mật nào — `ghiChu` chỉ nhận khoá trong allowlist
 * (kiểu chặn lúc biên dịch, runtime lọc lại phòng khi có ép kiểu).
 */
import type { Prisma } from "@/generated/prisma/client";

import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import type { HanhDong } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import type { ClientPhien } from "@/lib/session";

const KHOA_GHI_CHU = ["soDong", "ky", "thang", "loaiBanGhi", "quyenThieu", "lyDo", "email"] as const;
type KhoaGhiChu = (typeof KHOA_GHI_CHU)[number];

export type GhiChuNhatKy = Partial<Record<KhoaGhiChu, string | number>>;
export type ActorNhatKy = { id: string; email: string };
export type DoiTuongNhatKy = { loai: string; id?: string; moTa?: string };

type ThamSoNhatKy = {
  hanhDong: HanhDong;
  doiTuong?: DoiTuongNhatKy;
  ghiChu?: GhiChuNhatKy;
};

/** Trần độ dài email khai (RFC 5321: 320) — đầu vào từ form đăng nhập, không tin cậy. */
const TRAN_DANH_TINH = 320;

function locGhiChu(ghiChu: GhiChuNhatKy | undefined): Prisma.InputJsonObject | undefined {
  if (!ghiChu) return undefined;
  const sach: Record<string, string | number> = {};
  for (const khoa of KHOA_GHI_CHU) {
    const v = ghiChu[khoa];
    if (typeof v === "string" || typeof v === "number") sach[khoa] = v;
  }
  return Object.keys(sach).length > 0 ? sach : undefined;
}

function duLieuChung(p: ThamSoNhatKy) {
  return {
    hanhDong: p.hanhDong,
    doiTuongLoai: p.doiTuong?.loai ?? null,
    doiTuongId: p.doiTuong?.id ?? null,
    doiTuongMoTa: p.doiTuong?.moTa ?? null,
    ghiChu: locGhiChu(p.ghiChu),
  };
}

/** Dòng OK trong transaction của mutation. Ném ⇒ người gọi để transaction rollback (cố ý không nuốt). */
export async function ghiNhatKy(
  db: ClientPhien,
  p: ThamSoNhatKy & { actor: ActorNhatKy },
): Promise<void> {
  await db.auditLog.create({
    data: {
      ...duLieuChung(p),
      actorId: p.actor.id,
      actorEmail: p.actor.email,
      ketQua: "OK",
    },
  });
}

/**
 * Dòng LOI bằng client gốc. `actor` = người ĐÃ xác thực bị từ chối; `danhTinhKhaiBao` = email người
 * gọi KHAI khi chưa xác thực (đăng nhập sai / không tồn tại) — không bao giờ coi là actor.
 */
export async function ghiNhatKyLoi(
  p: ThamSoNhatKy & { actor?: ActorNhatKy; danhTinhKhaiBao?: string },
): Promise<void> {
  // Đang phục hồi DB: schema đích đang bị xoá + nạp lại — dòng ghi lúc này hoặc lỗi, hoặc treo chờ
  // khoá DROP, hoặc bị bản backup lùi mất. Bỏ dòng LOI (cổng vẫn từ chối như thường), cùng luật với
  // nhật ký đăng nhập ở `auth.ts`.
  if (dangPhucHoi()) return;
  try {
    await prisma.auditLog.create({
      data: {
        ...duLieuChung(p),
        actorId: p.actor?.id ?? null,
        actorEmail: p.actor?.email ?? null,
        danhTinhKhaiBao: p.danhTinhKhaiBao?.trim().slice(0, TRAN_DANH_TINH) ?? null,
        ketQua: "LOI",
      },
    });
  } catch (loi) {
    console.error("[nhat-ky] Không ghi được dòng LOI:", p.hanhDong, loi);
  }
}
