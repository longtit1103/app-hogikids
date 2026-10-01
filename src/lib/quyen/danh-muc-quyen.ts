/**
 * Danh mục quyền cấp được cho tài khoản STAFF — NGUỒN DUY NHẤT (form quản trị, cổng server, lưới test).
 *
 * Mã `<module>:xem` / `<module>:sua` + 2 quyền đặc biệt. Thuần: không import Prisma/Next, dùng được ở
 * cả server lẫn client.
 *
 * Owner-only (tải backup, phục hồi, xoá toàn bộ dữ liệu, quản lý tài khoản, khoá kết nối, nhật ký)
 * CỐ Ý không có mặt ở đây — chúng không phải quyền cấp được; cổng kiểm `role === "OWNER"`.
 */

export const MODULES = [
  "tong-quan",
  "don-hang",
  "san-pham",
  "ton-kho",
  "kenh",
  "marketing",
  "bao-cao",
  "tai-chinh-loi-lo",
  "tai-chinh-dong-tien",
  "tai-chinh-so-quy",
  "chi-phi",
  "cai-dat",
] as const;
export type Module = (typeof MODULES)[number];

/** Module có thao tác ghi. Module còn lại (đơn hàng, tồn kho…) là view read-only ⇒ chỉ `xem`. */
export const MODULE_CO_SUA = [
  "san-pham",
  "marketing",
  "tai-chinh-dong-tien",
  "tai-chinh-so-quy",
  "chi-phi",
  "cai-dat",
] as const;
type ModuleCoSua = (typeof MODULE_CO_SUA)[number];

export type Quyen = `${Module}:xem` | `${ModuleCoSua}:sua` | "gia-von-loi-nhuan:xem" | "xuat-du-lieu";

const QUYEN_LOI_LO: Quyen = "tai-chinh-loi-lo:xem";
const QUYEN_GIA_VON: Quyen = "gia-von-loi-nhuan:xem";

/** Mọi mã hợp lệ, theo thứ tự hiển thị trên form (mỗi module: xem rồi sua), quyền đặc biệt cuối. */
export const DANH_MUC_QUYEN: readonly Quyen[] = Object.freeze([
  ...MODULES.flatMap((m): Quyen[] =>
    (MODULE_CO_SUA as readonly string[]).includes(m) ? [`${m}:xem`, `${m}:sua` as Quyen] : [`${m}:xem`],
  ),
  QUYEN_GIA_VON,
  "xuat-du-lieu",
]);

const TAP_QUYEN: ReadonlySet<string> = new Set(DANH_MUC_QUYEN);

const NHAN_MODULE: Record<Module, string> = {
  "tong-quan": "Tổng quan",
  "don-hang": "Đơn hàng",
  "san-pham": "Sản phẩm",
  "ton-kho": "Tồn kho",
  kenh: "Kênh bán",
  marketing: "Marketing",
  "bao-cao": "Báo cáo",
  "tai-chinh-loi-lo": "Tài chính — Lãi/Lỗ",
  "tai-chinh-dong-tien": "Tài chính — Dòng tiền",
  "tai-chinh-so-quy": "Tài chính — Sổ quỹ",
  "chi-phi": "Sổ chi phí",
  "cai-dat": "Cài đặt",
};

/** Nhãn tiếng Việt cho form quản trị. */
export const NHAN_QUYEN: Record<Quyen, string> = Object.freeze(
  Object.fromEntries(
    DANH_MUC_QUYEN.map((q) => {
      if (q === QUYEN_GIA_VON) return [q, "Xem giá vốn & lợi nhuận"];
      if (q === "xuat-du-lieu") return [q, "Xuất dữ liệu ra file"];
      const [m, hanhVi] = q.split(":") as [Module, "xem" | "sua"];
      return [q, `${NHAN_MODULE[m]} — ${hanhVi === "xem" ? "Xem" : "Sửa"}`];
    }),
  ) as Record<Quyen, string>,
);

export function laQuyen(x: string): x is Quyen {
  return TAP_QUYEN.has(x);
}

/** `"chi-phi:sua"` → `"chi-phi:xem"`; mã không phải `:sua` → `null`. */
export function xemCuaSua(q: Quyen): Quyen | null {
  if (!q.endsWith(":sua")) return null;
  const xem = `${q.slice(0, -":sua".length)}:xem`;
  return laQuyen(xem) ? xem : null;
}

/**
 * Chuẩn hoá danh sách quyền từ form/DB:
 * - bỏ mã lạ (không ném — DB có thể còn mã đời cũ/sửa tay),
 * - `sua` kéo theo `xem` cùng module,
 * - `tai-chinh-loi-lo:xem` BẮT BUỘC kèm `gia-von-loi-nhuan:xem` (P&L bản chất là lợi nhuận) — thiếu thì
 *   trả lỗi, KHÔNG tự tick (người cấp phải chủ động cho thấy lợi nhuận),
 * - trả mảng không trùng, theo thứ tự `DANH_MUC_QUYEN`.
 */
export function chuanHoaQuyen(
  input: readonly string[],
): { ok: true; quyen: Quyen[] } | { ok: false; error: string } {
  const tap = new Set<Quyen>();
  for (const x of input) {
    if (!laQuyen(x)) continue;
    tap.add(x);
    const xem = xemCuaSua(x);
    if (xem) tap.add(xem);
  }
  if (tap.has(QUYEN_LOI_LO) && !tap.has(QUYEN_GIA_VON)) {
    return { ok: false, error: "Lãi/Lỗ cần kèm quyền Xem giá vốn & lợi nhuận" };
  }
  return { ok: true, quyen: DANH_MUC_QUYEN.filter((q) => tap.has(q)) };
}
