/**
 * Đọc cờ của CLI `scripts/dem-khop-moc-land-don-pancake.ts` — CHẶT, thuần để test được.
 *
 * Vì sao chặt: cờ gõ sai mà bị lặng lẽ bỏ qua là cổng xanh giả. Ví dụ `--so-anh=f` hoặc `--soanh f` sau migrate với
 * nhóm di sản rỗng ⇒ không so ảnh mà vẫn ĐẠT. Vì vậy TỪ CHỐI (`LoiCoCli`):
 *  - cờ lạ;
 *  - dạng `--co=gia-tri`;
 *  - đối số trơn không thuộc cờ nào;
 *  - cờ lặp lại;
 *  - cờ thiếu giá trị (hết đối số hoặc gặp cờ khác);
 *  - `--gioi-han` không phải số nguyên 1–1000;
 *  - cặp xung đột `--ghi-anh` + `--so-anh`: mỗi lượt chỉ CHỤP hoặc SO. Chụp và so trong cùng lượt dễ thành chụp lại
 *    baseline, vô hiệu phép so.
 */
export type CoCliKiemMocLandDon = {
  ghiAnh: boolean;
  /** Đường dẫn file ảnh, hoặc `-` = stdin; `undefined` = không so. */
  soAnh?: string;
  lietKeMoHo: boolean;
  gioiHan?: number;
  sau?: string;
  sauKdcc?: string;
};

export class LoiCoCli extends Error {
  constructor(thongDiep: string) {
    super(thongDiep);
    this.name = "LoiCoCli";
  }
}

const CO_BAT_TAT = new Set(["--ghi-anh", "--liet-ke-mo-ho"]);
const CO_GIA_TRI = new Set(["--so-anh", "--gioi-han", "--sau", "--sau-kdcc"]);

export function docCoCli(thamSo: readonly string[]): CoCliKiemMocLandDon {
  const da = new Map<string, string | true>();
  for (let i = 0; i < thamSo.length; i++) {
    const a = thamSo[i];
    if (a.startsWith("--") && a.includes("=")) {
      const ten = a.slice(0, a.indexOf("="));
      // Ba nhánh: cờ có giá trị (gợi ý viết tách) · cờ bật/tắt (không nhận giá trị) · cờ lạ (không gợi ý viết tách).
      throw new LoiCoCli(
        CO_GIA_TRI.has(ten)
          ? `cờ dạng "${a}" không nhận — viết tách: ${ten} <giá trị>`
          : CO_BAT_TAT.has(ten)
            ? `cờ dạng "${a}" không nhận — ${ten} là cờ bật/tắt, không nhận giá trị`
            : `cờ lạ "${ten}" (dạng "${a}")`,
      );
    }
    if (!CO_BAT_TAT.has(a) && !CO_GIA_TRI.has(a)) {
      throw new LoiCoCli(a.startsWith("-") ? `cờ lạ "${a}"` : `đối số thừa "${a}" (không thuộc cờ nào)`);
    }
    if (da.has(a)) throw new LoiCoCli(`cờ ${a} lặp lại`);
    if (CO_BAT_TAT.has(a)) {
      da.set(a, true);
      continue;
    }
    const v = thamSo[i + 1];
    if (v === undefined || (v.startsWith("-") && v !== "-")) throw new LoiCoCli(`cờ ${a} thiếu giá trị`);
    da.set(a, v);
    i++;
  }
  if (da.has("--ghi-anh") && da.has("--so-anh")) {
    throw new LoiCoCli("--ghi-anh và --so-anh xung đột — mỗi lượt chỉ CHỤP hoặc SO (runbook ③a-6: chụp xong mới so riêng)");
  }
  const chuoi = (k: string) => da.get(k) as string | undefined;
  const gh = chuoi("--gioi-han");
  if (gh !== undefined && (!/^[1-9]\d{0,3}$/.test(gh) || Number(gh) > 1000)) {
    throw new LoiCoCli(`--gioi-han "${gh}" phải là số nguyên 1–1000`);
  }
  return {
    ghiAnh: da.has("--ghi-anh"),
    soAnh: chuoi("--so-anh"),
    lietKeMoHo: da.has("--liet-ke-mo-ho"),
    gioiHan: gh === undefined ? undefined : Number(gh),
    sau: chuoi("--sau"),
    sauKdcc: chuoi("--sau-kdcc"),
  };
}
