import type { Prisma } from "@/generated/prisma/client";

import { dieuKienDiSanSql } from "./anh-di-san-moc-land-don";
import { phanLoaiNenQuaJs } from "./phan-loai-nen-doi-chieu-qua-js";

/**
 * Phân loại từng đơn NGHI LỆCH của bước kiểm landSeq (định nghĩa: chú thích đầu `dem-khop-moc-land-don.ts`) bằng phép so
 * theo cách đường ghi đọc dữ liệu — xem `phan-loai-nen-doi-chieu-qua-js.ts`. Cả `Order.raw` lẫn payload đọc qua CÙNG client
 * Prisma (`jsonb` ⇒ `JSON.parse`) như transform đọc rồi ghi. Lô 500 đơn/lượt; chỉ chạm đơn nghi lệch (thường rất ít).
 */
export async function phanLoaiDonNghiLech(
  tx: Prisma.TransactionClient,
  coCot: boolean,
): Promise<{ giaiThichDuoc: number; lechBanKhac: number; khongDuCanCu: { pancakeId: string; lyDo: string }[] }> {
  // Bằng CHÍNH XÁC bản tham chiếu ⇒ chắc chắn đúng, bỏ qua. Nhóm DI SẢN (`anh-di-san-moc-land-don.ts`: không có kho thô /
  // không có mốc nguồn, chưa có `rawLandSeq`) tách riêng — CÙNG một luật dù `raw` khớp chính xác hay chỉ khớp qua JS.
  // Còn lại ⇒ nghi lệch, phân loại ở JS (gồm cả đơn có mốc mà không dòng nào cùng mốc ⇒ không có tham chiếu).
  const ref = coCot
    ? `r."fetchedAt" = o."rawFetchedAt" AND (o."rawLandSeq" IS NULL OR r."landSeq" = o."rawLandSeq")`
    : `r."fetchedAt" = o."rawFetchedAt"`;
  const ids = (
    await tx.$queryRawUnsafe<{ p: string }[]>(`
      SELECT o."pancakeId" AS p FROM "Order" o
      WHERE NOT ${dieuKienDiSanSql(coCot)}
        AND NOT EXISTS (
          SELECT 1 FROM "RawPancakeOrder" r
          WHERE r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id' AND ${ref}
            AND r.payload = (o.raw - '_buTuDonKho'))
      ORDER BY o."pancakeId" COLLATE "C"`)
  ).map((r) => r.p);
  let giaiThichDuoc = 0;
  let lechBanKhac = 0;
  const khongDuCanCu: { pancakeId: string; lyDo: string }[] = [];
  const cotSeq = coCot ? `o."rawLandSeq"::text` : `NULL::text`;
  for (let i = 0; i < ids.length; i += 500) {
    const lo = ids.slice(i, i + 500);
    const don = await tx.$queryRawUnsafe<{ p: string; raw: unknown; f: Date | null; s: string | null }[]>(
      `SELECT o."pancakeId" AS p, o.raw, o."rawFetchedAt" AS f, ${cotSeq} AS s FROM "Order" o
       WHERE o."pancakeId" = ANY($1::text[])`,
      lo,
    );
    const dong = await tx.$queryRawUnsafe<
      { e: string; id: string; h: string; payload: unknown; f: Date; s: string | null }[]
    >(
      `SELECT r."externalId" AS e, r.id, r."payloadHash" AS h, r.payload, r."fetchedAt" AS f, ${
        coCot ? `r."landSeq"::text` : `NULL::text`
      } AS s
       FROM "RawPancakeOrder" r JOIN "Order" o ON o."pancakeId" = r."externalId" AND r."shopId" = o.raw->>'shop_id'
       WHERE o."pancakeId" = ANY($1::text[])`,
      lo,
    );
    const dongTheoDon = new Map<string, typeof dong>();
    for (const d of dong) dongTheoDon.set(d.e, [...(dongTheoDon.get(d.e) ?? []), d]);
    for (const o of don) {
      const cua = dongTheoDon.get(o.p) ?? [];
      const cungMoc = o.f === null ? [] : cua.filter((d) => d.f.getTime() === o.f!.getTime());
      // Tham chiếu: dòng cặp (fetchedAt, landSeq) nếu có số; không thì dòng DUY NHẤT cùng mốc.
      const laThamChieu = (d: (typeof cua)[number]) =>
        o.s !== null ? cungMoc.includes(d) && d.s === o.s : cungMoc.length === 1 && cungMoc[0] === d;
      const kq = phanLoaiNenQuaJs(
        o.raw,
        cua.map((d) => ({ id: d.id, payloadHash: d.h, payload: d.payload, laThamChieu: laThamChieu(d) })),
      );
      if (kq.loai === "GIAI_THICH_DUOC") giaiThichDuoc++;
      else if (kq.loai === "LECH_BAN_KHAC") lechBanKhac++;
      else khongDuCanCu.push({ pancakeId: o.p, lyDo: kq.lyDo });
    }
  }
  khongDuCanCu.sort((a, b) => (a.pancakeId < b.pancakeId ? -1 : a.pancakeId > b.pancakeId ? 1 : 0));
  return { giaiThichDuoc, lechBanKhac, khongDuCanCu };
}
