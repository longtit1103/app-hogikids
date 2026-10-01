import { isValidElement } from "react";

/**
 * Quét ĐỆ QUY cây phần tử React mà một Server Component trả về (KHÔNG render) — mọi giá trị nằm trong
 * props của mọi phần tử con, kể cả mảng/object lồng nhau. Mọi thứ một trang gửi xuống component con
 * (client ⇒ payload RSC, server ⇒ HTML) đều phải đi qua props, nên đây là TẬP CHA của cả hai: giá trị
 * không có ở đây thì không thể lộ ra trình duyệt.
 *
 * Trả về đường dẫn tới từng giá trị để câu báo đỏ chỉ thẳng chỗ lộ.
 */
export function quetGiaTri(goc: unknown): { duong: string; giaTri: unknown }[] {
  const ra: { duong: string; giaTri: unknown }[] = [];
  const daThay = new WeakSet<object>();

  function di(nut: unknown, duong: string, sau: number): void {
    if (sau > 60) return;
    if (nut === null || nut === undefined) return;
    if (typeof nut === "function" || typeof nut === "symbol") return;
    if (typeof nut !== "object") {
      ra.push({ duong, giaTri: nut });
      return;
    }
    if (daThay.has(nut)) return;
    daThay.add(nut);
    if (nut instanceof Date) {
      ra.push({ duong, giaTri: nut.toISOString() });
      return;
    }
    if (isValidElement(nut)) {
      const ten =
        typeof nut.type === "string"
          ? nut.type
          : ((nut.type as { name?: string; displayName?: string })?.displayName ??
            (nut.type as { name?: string })?.name ??
            "?");
      di(nut.props, `${duong}<${ten}>`, sau + 1);
      return;
    }
    if (nut instanceof Map) {
      for (const [k, v] of nut) di(v, `${duong}.get(${String(k)})`, sau + 1);
      return;
    }
    if (nut instanceof Set) {
      for (const v of nut) di(v, `${duong}{}`, sau + 1);
      return;
    }
    if (Array.isArray(nut)) {
      nut.forEach((v, i) => di(v, `${duong}[${i}]`, sau + 1));
      return;
    }
    for (const [k, v] of Object.entries(nut)) di(v, `${duong}.${k}`, sau + 1);
  }

  di(goc, "", 0);
  return ra;
}

/** Những chỗ trong cây mang `soCanh` — dạng số, hoặc chuỗi có chứa chữ số đó (kể cả đã chấm ngăn nghìn). */
export function choChuaSoCanh(goc: unknown, soCanh: number): string[] {
  const dangChu = [String(soCanh), soCanh.toLocaleString("vi-VN")];
  return quetGiaTri(goc)
    .filter(({ giaTri }) =>
      typeof giaTri === "number"
        ? giaTri === soCanh
        : typeof giaTri === "string" && dangChu.some((c) => giaTri.includes(c)),
    )
    .map(({ duong }) => duong);
}

/** Mọi khoá object xuất hiện trong cây (để khẳng định không có khoá nhạy cảm nào đi xuống). */
export function khoaTrongCay(goc: unknown): Set<string> {
  const khoa = new Set<string>();
  for (const { duong } of quetGiaTri(goc)) {
    const m = duong.match(/\.([A-Za-z_$][\w$]*)$/);
    if (m) khoa.add(m[1]);
  }
  return khoa;
}
