import { endOfDay, format } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { docDemSan, docTienSan } from "@/lib/marketing/doc-so-san";
import { nhanTrangThaiChotHoaHong } from "@/lib/marketing/nhan-trang-thai-chot-hoa-hong";
import { prisma } from "@/lib/prisma";

import { cong, khoi } from "./cong-so-san";

/**
 * BẢNG CREATOR (tab Creator) — `RawTiktokShopAffiliateOrder`, khoá `<_don_id>:<sku_id>`, mỗi dòng
 * là MỘT DÒNG SKU của đơn được sàn quy công cho creator (workflow đã làm phẳng, xem
 * `src/lib/bronze/streams.ts`).
 *
 * BẤT BIẾN #2: đơn/GMV/hoa hồng ở đây là SỐ SÀN TỰ NHẬN CÔNG — bọc `<SoSanBao>`, không vào
 * `pnl.ts`, và TUYỆT ĐỐI không trộn/đối chiếu "lệch" với khối *Affiliate theo kỳ (Pancake)* của P1:
 * hai nguồn đếm hai thứ khác nhau (sàn liệt kê đơn quy công — gồm cả INELIGIBLE/đã hoàn; Pancake
 * chỉ ghi khi THẬT SỰ bị trừ hoa hồng).
 *
 * 🔑 `{}` ≠ `{amount:"0"}` (đo 28/08): TikTok báo 0 TƯỜNG MINH khi ý là 0, và dùng object RỖNG khi
 * KHÔNG báo. `docTienSan` trả null cho `{}` (chết ở `currency !== "VND"`) — hai ca phải ra `0` và
 * `null` khác nhau, và phép cộng LAN NULL (`cong`) giữ đúng luật đó ở cấp creator: một dòng sàn
 * không báo thì tổng của creator là "không biết", không phải "cộng phần đọc được".
 *
 * Hoa hồng một dòng = GỘP HAI bucket loại trừ nhau (`paid_commission` + `paid_shop_ads_commission`)
 * — xem `hoaHongDong`. Review 28/08 bắt được: chỉ đọc bucket chuẩn thì creator chạy hợp tác
 * shop-ads (7/20 dòng đo được) hiện "—" trong khi sàn CÓ báo tiền — nhãn nói sai sự thật.
 *
 * KHÁC 4 stream analytics — KHÔNG có `mocSanSang`/`soNgayThieu` theo khuôn `xepNgayTheoMoc`:
 * đơn affiliate là SỰ KIỆN THƯA (đo trong DB: T7 có 1, T8 có 2 đơn), ngày không có dòng là ngày
 * KHÔNG CÓ ĐƠN (bình thường), không phải ngày thiếu — còn đêm 0 đơn thì workflow cố ý KHÔNG land
 * (cổng total_count=0) nên cũng không có bằng chứng per-ngày nào để đếm "thiếu". Đếm theo khuôn
 * analytics ở đây là chế ra cảnh báo ma mỗi tuần vắng đơn. Tín hiệu thay thế: `ngayDonMoiNhat`.
 */

export type DongCreator = {
  /**
   * Khoá gom nhóm = tên hiển thị (`creator_username`). Chủ shop chốt 28/08: payload KHÔNG có
   * creator id ổn định (`open_collaboration_id` là id HỢP TÁC, một creator có thể có nhiều).
   * Creator đổi tên ⇒ tách dòng: rủi ro đã biết và chấp nhận; Bronze vẫn giữ
   * `open_collaboration_id` nên đổi cách gom sau được. Dòng sàn không trả tên ⇒ "" (UI tự ghi nhãn).
   */
  creatorUsername: string;
  /** Số ĐƠN riêng biệt (DISTINCT `_don_id`) — KHÔNG phải số dòng SKU. */
  donSan: number;
  /** Số dòng SKU — để đối chiếu với `total_count` của sàn (sàn đếm DÒNG, đo 28/08). */
  dongSkuSan: number;
  /** Σ price × quantity — cộng LAN NULL: một dòng không đọc được tiền thì cả creator là null. */
  gmvSan: number | null;
  hoaHongUocTinh: number | null; // Σ estimated_paid_commission
  hoaHongDaTra: number | null; // Σ actual_paid_commission
  /**
   * Tỉ trọng DÒNG SKU theo kênh nội dung, cộng lại = 1 trên các dòng RÕ loại. `SHOP` = gian
   * hàng/showcase của CHÍNH creator — kênh thứ ba THẬT (đo 28/08 bác suy đoán "không có creator"),
   * KHÔNG phải `LINKSHARE` như spec đoán.
   */
  tiTrongVideo: number | null;
  tiTrongLive: number | null;
  tiTrongShop: number | null;
  /** `content_type` ngoài {VIDEO, LIVE, SHOP} hoặc thiếu ⇒ đếm riêng, KHÔNG im lặng bỏ. */
  soDongKhongRoLoai: number;
  /** Đơn không đủ điều kiện / đã hoàn — chủ shop chốt 28/08: GIỮ, tách cột để không bóp méo hoa hồng. */
  dongIneligible: number;
  dongHoanToanBo: number; // fully_return === "Yes"
  /**
   * Dòng SKU sàn CHƯA chốt hoa hồng — cùng luật fail-open với drawer (`nhanTrangThaiChotHoaHong`): mọi
   * `settlement_status` ngoài SETTLED/INELIGIBLE, kể cả thiếu. Để ô "HH đã trả" tự giải thích vì sao
   * nó nhỏ hơn "ước tính" hoặc "—" ở kỳ gần (sàn chốt SAU giao — trễ TB 3,94 / max 17 ngày, đo 28/08),
   * thay vì để người đọc suy "bị hoàn". Chỉ đếm, không đụng tiền.
   */
  dongChoChot: number;
};

export type CreatorTiktok = {
  dong: DongCreator[];
  /**
   * Ngày (giờ VN) của dòng affiliate MỚI NHẤT đã land — TOÀN KHO, không giới hạn kỳ. null = chưa
   * có dòng nào. Đây KHÔNG phải "mốc sẵn sàng" của sàn (envelope affiliate không có
   * `latest_available_date`): nó chỉ nói "app đã từng ghi nhận đơn affiliate tới ngày X".
   */
  ngayDonMoiNhat: string | null;
};

export type DonCuaCreator = {
  donId: string;
  skuId: string;
  loaiNoiDung: string | null;
  contentId: string | null;
  ngay: string;
  hoaHongUocTinh: number | null;
  hoaHongDaTra: number | null;
  trangThaiChot: string | null;
  hoanToanBo: boolean;
};

type HangAff = { payload: unknown };

function chuoiHoacNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Hoa hồng creator của MỘT dòng SKU — GỘP hai bucket LOẠI TRỪ NHAU của sàn. Đo 28/08 trên 20 dòng:
 * `*_paid_commission` có giá trị 10/20 · `*_paid_shop_ads_commission` 7/20, cộng đúng bằng độ phủ
 * `actual_commission_base` 17/20 ⇒ mỗi dòng đi MỘT trong hai đường (hợp tác thường vs shop-ads).
 * `{}` ở bucket này khi bucket kia CÓ số nghĩa là "khoản không áp dụng" — cộng phần có; CẢ HAI cùng
 * `{}` = sàn không báo gì ⇒ null (giữ luật `{}` ≠ 0 ở đơn vị dòng).
 * `*_paid_partner_commission` / `*_cofunded_creator_bonus_amount` đo 0/20 có giá trị — CỐ Ý CHƯA
 * cộng: chưa từng thấy số thật, xuất hiện thì probe lại rồi mới quyết, không cộng mù.
 */
function hoaHongDong(p: Record<string, unknown>, kieu: "estimated" | "actual"): number | null {
  const chuan = docTienSan(p[`${kieu}_paid_commission`]);
  const shopAds = docTienSan(p[`${kieu}_paid_shop_ads_commission`]);
  if (chuan === null && shopAds === null) return null;
  return (chuan ?? 0) + (shopAds ?? 0);
}

/**
 * Bản MỚI NHẤT của từng dòng SKU trong kỳ — `DISTINCT ON` + `fetchedAt DESC, id DESC` y 7 reader P2.
 * So ngày bằng CHUỖI `YYYY-MM-DD` trên `payload->>'_ngay'` (workflow bơm sẵn theo giờ VN), KHÔNG
 * `AT TIME ZONE` trong câu lọc. LỌC `shopId` BẮT BUỘC — xem `moc-du-lieu-san-sang.ts`.
 */
async function dongTrongKy(range: DateRange, shopIds: string[]): Promise<HangAff[]> {
  const tu = format(range.from, "yyyy-MM-dd");
  const den = format(endOfDay(range.to), "yyyy-MM-dd");
  return prisma.$queryRaw<HangAff[]>`
    SELECT DISTINCT ON ("shopId", "externalId") payload
    FROM "RawTiktokShopAffiliateOrder"
    WHERE "shopId" = ANY(${shopIds}::text[])
      AND payload->>'_ngay' >= ${tu}
      AND payload->>'_ngay' <= ${den}
    ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
  `;
}

export async function creatorTiktok(range: DateRange): Promise<CreatorTiktok> {
  const shopIds = await shopIdsChoVai(["tiktokShop"]);
  const [rows, moi] = await Promise.all([
    dongTrongKy(range, shopIds),
    prisma.$queryRaw<{ m: string | null }[]>`
      SELECT max(payload->>'_ngay') AS m FROM "RawTiktokShopAffiliateOrder"
      WHERE "shopId" = ANY(${shopIds}::text[])
    `,
  ]);

  type Gom = DongCreator & { donIds: Set<string>; dongVideo: number; dongLive: number; dongShop: number };
  const gom = new Map<string, Gom>();

  for (const r of rows) {
    const p = khoi(r.payload) ?? {};
    const ten = chuoiHoacNull(p.creator_username) ?? "";
    const g: Gom = gom.get(ten) ?? {
      creatorUsername: ten,
      donSan: 0,
      dongSkuSan: 0,
      gmvSan: 0,
      hoaHongUocTinh: 0,
      hoaHongDaTra: 0,
      tiTrongVideo: null,
      tiTrongLive: null,
      tiTrongShop: null,
      soDongKhongRoLoai: 0,
      dongIneligible: 0,
      dongHoanToanBo: 0,
      dongChoChot: 0,
      donIds: new Set(),
      dongVideo: 0,
      dongLive: 0,
      dongShop: 0,
    };

    const donId = chuoiHoacNull(p._don_id);
    if (donId !== null) g.donIds.add(donId);
    g.dongSkuSan++;

    // GMV dòng = price × quantity; một vế không đọc được ⇒ dòng null ⇒ cả creator null (cộng lan null).
    const gia = docTienSan(p.price);
    const soLuong = docDemSan(p.quantity);
    g.gmvSan = cong(g.gmvSan, gia === null || soLuong === null ? null : gia * soLuong);
    g.hoaHongUocTinh = cong(g.hoaHongUocTinh, hoaHongDong(p, "estimated"));
    g.hoaHongDaTra = cong(g.hoaHongDaTra, hoaHongDong(p, "actual"));

    const loai = chuoiHoacNull(p.content_type);
    if (loai === "VIDEO") g.dongVideo++;
    else if (loai === "LIVE") g.dongLive++;
    else if (loai === "SHOP") g.dongShop++;
    else g.soDongKhongRoLoai++;

    const trangThaiChot = chuoiHoacNull(p.settlement_status);
    if (trangThaiChot === "INELIGIBLE") g.dongIneligible++;
    if (nhanTrangThaiChotHoaHong(trangThaiChot).nhan === "đang chờ sàn chốt") g.dongChoChot++;
    if (p.fully_return === "Yes") g.dongHoanToanBo++;

    gom.set(ten, g);
  }

  const dong: DongCreator[] = [...gom.values()]
    .map(({ donIds, dongVideo, dongLive, dongShop, ...g }) => {
      const coRoLoai = dongVideo + dongLive + dongShop;
      return {
        ...g,
        donSan: donIds.size,
        tiTrongVideo: coRoLoai > 0 ? dongVideo / coRoLoai : null,
        tiTrongLive: coRoLoai > 0 ? dongLive / coRoLoai : null,
        tiTrongShop: coRoLoai > 0 ? dongShop / coRoLoai : null,
      };
    })
    // GMV ↓, chốt phụ (dòng SKU ↓ rồi tên) để hai lượt chạy ra cùng một thứ tự bảng.
    .sort(
      (a, b) =>
        (b.gmvSan ?? -1) - (a.gmvSan ?? -1) ||
        b.dongSkuSan - a.dongSkuSan ||
        (a.creatorUsername < b.creatorUsername ? -1 : a.creatorUsername > b.creatorUsername ? 1 : 0),
    );

  return { dong, ngayDonMoiNhat: moi[0]?.m ?? null };
}

/** Đơn cấp DÒNG SKU của MỘT creator trong kỳ — cho drawer khi nhấn dòng bảng. */
export async function donCuaCreator(range: DateRange, creatorUsername: string): Promise<DonCuaCreator[]> {
  const shopIds = await shopIdsChoVai(["tiktokShop"]);
  const rows = await dongTrongKy(range, shopIds);

  return rows
    .map((r) => khoi(r.payload) ?? {})
    .filter((p) => (chuoiHoacNull(p.creator_username) ?? "") === creatorUsername)
    .map((p) => ({
      donId: chuoiHoacNull(p._don_id) ?? "",
      skuId: chuoiHoacNull(p.sku_id) ?? "",
      loaiNoiDung: chuoiHoacNull(p.content_type),
      contentId: chuoiHoacNull(p.content_id),
      ngay: chuoiHoacNull(p._ngay) ?? "",
      hoaHongUocTinh: hoaHongDong(p, "estimated"),
      hoaHongDaTra: hoaHongDong(p, "actual"),
      trangThaiChot: chuoiHoacNull(p.settlement_status),
      hoanToanBo: p.fully_return === "Yes",
    }))
    // Mới trước; chốt phụ (đơn, SKU) cho ổn định.
    .sort(
      (a, b) =>
        (a.ngay < b.ngay ? 1 : a.ngay > b.ngay ? -1 : 0) ||
        (a.donId < b.donId ? -1 : a.donId > b.donId ? 1 : 0) ||
        (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0),
    );
}
