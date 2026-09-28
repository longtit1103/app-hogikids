import { endOfDay, format } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { docDemSan, docTienSan } from "@/lib/marketing/doc-so-san";
import { prisma } from "@/lib/prisma";

import { chia, cong, khoi, ngayTrongKy } from "./cong-so-san";
import { mocDuLieuSanSang, xepNgayTheoMoc } from "./moc-du-lieu-san-sang";
import { KHOI_NGUON, type KhoiNguon } from "./nguon-doanh-so-tiktok";

/**
 * BẢNG "SẢN PHẨM × NGUỒN" — mỗi lần xem MỘT khối nguồn (bảng ánh xạ tên trường ở
 * `nguon-doanh-so-tiktok.ts`, dùng lại chứ KHÔNG chép: hai bảng tên trường là hai bảng sẽ trôi).
 *
 * TÊN SẢN PHẨM nối qua `Product.code` (A3) bằng MỘT truy vấn riêng rồi map ở TS — KHÔNG join
 * trong SQL với bảng Bronze: Bronze là kho thô, nối nó với bảng nghiệp vụ trong một câu là mở
 * đường cho lần sau ai đó nối cả số tiền. Không khớp ⇒ hiện ID TRẦN, KHÔNG ẩn dòng: đo đầy đủ ở
 * checkpoint P2 thấy 133/148 = 89,9% khớp, tức ~10% dòng hiện id trần là TRẠNG THÁI BÌNH THƯỜNG
 * (15 SP có trong analytics mà không có trong danh bạ) — cấm cảnh báo "thiếu" (A14 mục 4).
 *
 * BẤT BIẾN #2: số sàn tự nhận công — tham khảo, không vào `pnl.ts`.
 */
export type SanPhamNguon = {
  /** id sản phẩm TikTok = `Product.code`; không khớp ⇒ `ten` = id. */
  id: string;
  ten: string;
  hienThi: number | null;
  click: number | null;
  /** = click ÷ hienThi. */
  ctr: number | null;
  /** = add_cart_count ÷ click. Khối shop_tab KHÔNG có phép đo thêm giỏ ⇒ null. */
  tiLeThemGio: number | null;
  /** = đơn ÷ click. Khối không có khái niệm "đơn" ⇒ null. */
  tiLeClickRaDon: number | null;
  donSan: number | null;
  gmvSan: number | null;
};

export type SanPhamNguonTiktok = {
  dong: SanPhamNguon[];
  soNgayThieu: number;
  soNgayChuaSanSang: number;
  mocSanSang: string | null;
};

type HangSanPham = { ngay: string; payload: unknown };

/** Bộ cộng của MỘT sản phẩm qua các ngày trong kỳ. */
type Gom = {
  hienThi: number | null;
  click: number | null;
  themGio: number | null;
  donSan: number | null;
  gmvSan: number | null;
};

export async function sanPhamNguonTiktok(
  range: DateRange,
  khoiNguon: KhoiNguon,
): Promise<SanPhamNguonTiktok> {
  const dinhNghia = KHOI_NGUON[khoiNguon];
  const to = endOfDay(range.to);
  const shopIds = await shopIdsChoVai(["tiktokShop"]);

  const [rows, moc] = await Promise.all([
    prisma.$queryRaw<HangSanPham[]>`
      SELECT DISTINCT ON ("shopId", "externalId") left("externalId", 10) AS ngay, payload
      FROM "RawTiktokShopAnalyticsProduct"
      WHERE "shopId" = ANY(${shopIds}::text[])
        AND left("externalId", 10) >= ${format(range.from, "yyyy-MM-dd")}
        AND left("externalId", 10) <= ${format(to, "yyyy-MM-dd")}
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    `,
    mocDuLieuSanSang(),
  ]);

  const ngays = ngayTrongKy(range);
  const { soNgayThieu, soNgayChuaSanSang } = xepNgayTheoMoc(
    ngays,
    new Set(rows.map((r) => r.ngay)),
    moc.products,
  );

  // `add_cart_count` là tên chung của 7/8 khối; shop_tab có bộ trường RIÊNG và không có phép đo
  // thêm giỏ nào cả (ghi-chu-shape-thuc-te §2) ⇒ ô đó phải là "—", không phải 0.
  const coThemGio = dinhNghia.khoa !== "shop_tab_performance";

  const gom = new Map<string, Gom>();
  for (const r of rows) {
    const p = khoi(r.payload) ?? {};
    const id = typeof p.id === "string" && p.id !== "" ? p.id : null;
    // Vắng khối ⇒ sản phẩm này KHÔNG có dòng ở bảng của khối đó (không có gì để bày), khác hẳn
    // với "0" của bảng tổng hợp 8 khối — ở đó dòng luôn có mặt vì nó nói về cả shop.
    const k = khoi(p, dinhNghia.khoa);
    if (id === null || k === undefined) continue;

    const g: Gom = gom.get(id) ?? {
      hienThi: 0,
      click: 0,
      themGio: coThemGio ? 0 : null,
      donSan: dinhNghia.truongDon === null ? null : 0,
      gmvSan: 0,
    };
    g.hienThi = cong(g.hienThi, docDemSan(k[dinhNghia.truongHienThi]));
    g.click = cong(g.click, docDemSan(k[dinhNghia.truongClick]));
    if (coThemGio) g.themGio = cong(g.themGio, docDemSan(k.add_cart_count));
    if (dinhNghia.truongDon !== null) g.donSan = cong(g.donSan, docDemSan(k[dinhNghia.truongDon]));
    g.gmvSan = cong(g.gmvSan, docTienSan(k[dinhNghia.truongGmv]));
    gom.set(id, g);
  }

  const ids = [...gom.keys()];
  const ten = new Map<string, string>();
  if (ids.length > 0) {
    const sp = await prisma.product.findMany({
      where: { code: { in: ids } },
      select: { code: true, name: true },
      // `Product.code` KHÔNG có @unique (schema). Đo prod 25/08: 0 mã trùng — nên đây không phải
      // rủi ro hôm nay, nhưng thứ tự phải TẤT ĐỊNH: bài học `Variant.sku` (22/08) là hai lượt chạy
      // nhặt hai bản ghi khác nhau mà không ai thấy. Bản ĐẦU theo id thắng, cố định.
      orderBy: { id: "asc" },
    });
    for (const s of sp) if (s.code && !ten.has(s.code)) ten.set(s.code, s.name);
  }

  const hut = soNgayThieu > 0;
  const dong: SanPhamNguon[] = ids
    .map((id) => {
      const g = gom.get(id)!;
      const hienThi = hut ? null : g.hienThi;
      const click = hut ? null : g.click;
      const donSan = hut ? null : g.donSan;
      return {
        id,
        ten: ten.get(id) ?? id,
        hienThi,
        click,
        ctr: chia(click, hienThi),
        tiLeThemGio: chia(hut ? null : g.themGio, click),
        tiLeClickRaDon: chia(donSan, click),
        donSan,
        gmvSan: hut ? null : g.gmvSan,
      };
    })
    // GMV giảm dần; chốt phụ hiển thị rồi id để hai lượt chạy không ra hai thứ tự khác nhau khi
    // cả cột GMV cùng bằng 0 (đúng trạng thái thường ngày của phần lớn sản phẩm).
    .sort(
      (a, b) =>
        (b.gmvSan ?? -1) - (a.gmvSan ?? -1) ||
        (b.hienThi ?? -1) - (a.hienThi ?? -1) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  return { dong, soNgayThieu, soNgayChuaSanSang, mocSanSang: moc.products };
}
