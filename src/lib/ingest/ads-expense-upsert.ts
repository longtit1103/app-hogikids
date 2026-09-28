import type { Prisma, PrismaClient } from "@prisma/client";

import { adsChannelId, type AdsSource, type PreparedAdsExpense } from "./ads-expense-row";
import type { UpsertStats } from "./pancake-upsert";

/** Client Prisma thường HOẶC client trong `$transaction` — route ingest ghi cả lô trong 1 transaction. */
export type AdsExpenseDb = PrismaClient | Prisma.TransactionClient;

/**
 * Ảnh chụp sổ chi phí, nạp MỘT lần trước khi ghi cả lô.
 *
 * Vì sao phải chụp trước: mỗi câu lệnh Prisma là một round-trip. Lượt dựng lại quét 32.535 khoá
 * (đo prod 28/07), qua Tailscale ~10,5 ms/round-trip là ~343 giây — quá cửa sổ ~100s Cloudflare cắt
 * và gần chạm mốc 15 phút mà `dungLaiTuKhoTho` coi một lượt là còn sống. Ba tập dưới đây trả lời
 * được mọi câu hỏi "dòng này đã có chưa, ai sở hữu khoá này" mà không đụng DB thêm lần nào.
 */
export type SoChiTieuAds = {
  /** `refId` của các dòng chi tiêu quảng cáo ĐANG có trong sổ. */
  refIdAds: Set<string>;
  /** `refId` đang bị dòng KHÔNG phải quảng cáo chiếm (chủ shop nhập tay lỡ gõ trùng khoá). */
  refIdSoTay: Set<string>;
  /** `${adsSource}|${YYYY-MM-DD}` những ngày chủ shop đã ghi đè bằng file import CSV ads. */
  ngayGhiDeBangFile: Set<string>;
};

/**
 * Đúng 3 bộ đếm mà cổng ghi này chạm tới. `UpsertStats` (lượt dựng lại) thoả kiểu này nên truyền
 * thẳng được, còn route ingest chỉ cần dựng một object 3 field.
 *
 * `skipped` và `boQuaCoChuDich` TÁCH RIÊNG vì hai kết cục khác hẳn nhau: `skipped` = mất dòng thật
 * (hỏng shape, ghi lỗi) và là điều kiện hạ cờ backlog; `boQuaCoChuDich` = không ghi vì đúng ý chủ
 * shop. Xem `UpsertStats.boQuaCoChuDich`.
 */
export type AdsExpenseStats = Pick<
  UpsertStats,
  "adsExpensesUpserted" | "skipped" | "boQuaCoChuDich"
>;

/**
 * Đường vào KHOÁ GHI CHI TIÊU ADS cho người gọi đứng NGOÀI transaction (lượt dựng lại từ kho thô):
 * người gọi mở transaction, giành khoá, rồi chạy `fn` bằng client của transaction đó.
 *
 * Vì sao là callback chứ không phải `import { prisma }` ngay tại đây: module này CỐ Ý thuần — nhận
 * `db` qua tham số nên route ingest truyền `tx` của mình vào được và test gọi được mà không mock gì.
 * Tự mở transaction bằng prisma singleton bên trong sẽ thành transaction LỒNG khi `db` đang là `tx`.
 *
 * Route `/api/ingest/ads` KHÔNG truyền: cả lô của nó đã nằm trong transaction giữ đúng khoá này.
 */
export type ChayTrongKhoaGhiAds = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

const ADS_CATEGORY_ID = "ads";

/**
 * Một ngày tính bằng mili-giây. Việt Nam KHÔNG có DST nên cộng đúng 24h vào mốc 00:00+07 luôn ra
 * 00:00+07 của ngày kế tiếp — không cần thư viện lịch và không phụ thuộc TZ của máy chạy.
 */
const MS_MOT_NGAY = 24 * 60 * 60 * 1000;

// Dòng import neo `date` 00:00 giờ VN y hệt dòng ADS_API ⇒ format theo giờ VN cho ra đúng khoá ngày,
// độc lập TZ máy chạy.
const VN_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Khoá ngày của một dòng chi phí quảng cáo: `${adsSource}|${YYYY-MM-DD}`. */
function khoaNgay(adsSource: string, dateKey: string): string {
  return `${adsSource}|${dateKey}`;
}

/**
 * Ghi nhận "bỏ dòng vì ngày này chủ shop đã ghi đè bằng file" — 2 cổng dùng chung ĐÚNG một câu.
 *
 * Đếm vào `boQuaCoChuDich`, KHÔNG phải `skipped`: đây là kết cục ĐÚNG (tôn trọng quyết định của chủ
 * shop), không phải dòng kẹt. Xem `UpsertStats.boQuaCoChuDich`.
 */
function boQuaNgayGhiDeBangFile(
  source: AdsSource,
  m: PreparedAdsExpense,
  so: SoChiTieuAds,
  stats: AdsExpenseStats,
  warnings: string[]
): void {
  stats.boQuaCoChuDich++;
  warnings.push(
    `Bỏ chi tiêu ads ${m.refId}: ngày ${m.dateKey} đã được ghi đè bằng file import, giữ nguyên số ` +
      `chủ shop chọn (ghi thêm là chi phí ngày đó đếm 2 lần)`
  );
  so.ngayGhiDeBangFile.add(khoaNgay(source, m.dateKey)); // nhớ lại để các dòng sau cùng ngày khỏi hỏi nữa
}

/** Nạp ảnh chụp sổ chi phí quảng cáo — 2 truy vấn, dùng cho cả lô. */
export async function napSoChiTieuAds(db: AdsExpenseDb): Promise<SoChiTieuAds> {
  const [coRefId, ghiDeBangFile] = await Promise.all([
    db.expense.findMany({
      where: { refId: { not: null } },
      select: { refId: true, source: true },
    }),
    db.expense.findMany({
      where: { categoryId: ADS_CATEGORY_ID, source: "IMPORT" },
      select: { adsSource: true, date: true },
    }),
  ]);

  const refIdAds = new Set<string>();
  const refIdSoTay = new Set<string>();
  for (const e of coRefId) {
    if (!e.refId) continue;
    (e.source === "ADS_API" ? refIdAds : refIdSoTay).add(e.refId);
  }

  const ngayGhiDeBangFile = new Set<string>();
  for (const e of ghiDeBangFile) {
    if (!e.adsSource) continue;
    ngayGhiDeBangFile.add(khoaNgay(e.adsSource, VN_DATE_FORMATTER.format(e.date)));
  }

  return { refIdAds, refIdSoTay, ngayGhiDeBangFile };
}

/**
 * Ngày này (đúng nguồn ads) có dòng chi phí do chủ shop import từ file không — hỏi THẲNG DB, không
 * qua ảnh chụp. Chỉ gọi ở nhánh TẠO MỚI, nơi hậu quả của việc đọc số cũ là đếm tiền 2 lần.
 *
 * So theo KHOẢNG NGÀY VN `[00:00+07, 00:00+07 ngày sau)`, KHÔNG so khớp đúng một mốc: cổng ảnh chụp
 * bên trên nhận diện ngày bằng KHOÁ NGÀY (`VN_DATE_FORMATTER`), nên hai cách đo phải phủ đúng cùng
 * một tập dòng. Dòng IMPORT lệch mốc (hợp đồng đời cũ, hoặc sửa thẳng bằng SQL) mà cổng này bỏ sót
 * thì ngày đó có CẢ dòng IMPORT lẫn ADS_API ⇒ chi phí quảng cáo đếm 2 lần.
 */
async function coDongImportTrongNgay(
  db: AdsExpenseDb,
  source: AdsSource,
  m: PreparedAdsExpense
): Promise<boolean> {
  const n = await db.expense.count({
    where: {
      categoryId: ADS_CATEGORY_ID,
      source: "IMPORT",
      adsSource: source,
      date: { gte: m.date, lt: new Date(m.date.getTime() + MS_MOT_NGAY) },
    },
  });
  return n > 0;
}

/**
 * Ghi 1 dòng chi tiêu quảng cáo vào `Expense` — CỔNG DUY NHẤT của cả hai đường ghi
 * (`/api/ingest/ads` mỗi đêm và lượt dựng lại từ kho thô).
 *
 * ⚠️ CHỈ được chạm dòng `source = "ADS_API"`. Điều kiện `source` nằm NGAY trong `WHERE` của
 * `updateMany`, và trước khi tạo dòng mới còn soi lại khoá xem có bị dòng nhập tay chiếm không —
 * chi phí chủ shop nhập tay không có bản gốc nào để dựng lại, đụng nhầm là mất vĩnh viễn.
 *
 * NGÀY CHỦ SHOP ĐÃ GHI ĐÈ BẰNG FILE: import CSV ads ở chế độ ghi đè XOÁ dòng ADS_API của ngày đó
 * rồi thay bằng dòng `IMPORT` (xem `ads-import.ts`). Tạo lại dòng ADS_API cho đúng ngày đó là bày
 * cả hai lên sổ ⇒ chi phí quảng cáo ngày đó đếm 2 lần, lãi ròng tụt mà không ai truy ra. Chủ shop
 * đã ra quyết định — lượt ghi máy KHÔNG được lật.
 *
 * DÒNG 0đ: chỉ HẠ dòng đã có về 0, KHÔNG tạo dòng mới. Nguồn trả về mọi (chiến dịch, ngày), phần
 * lớn bằng 0 (đo prod 28/07: 30.803/31.234 khoá TikTok chi tiêu 0). Dòng 0đ có đúng MỘT mục đích —
 * hạ chi tiêu của chiến dịch đã tắt về 0; tạo mới thì chỉ phình màn Chi phí thêm hàng chục nghìn
 * dòng 0đ mà không đổi một đồng nào trong P&L.
 *
 * Nhánh cập nhật ghi lại ĐỦ các field suy ra được từ khoá (không riêng số tiền): lượt dựng lại phải
 * đưa dòng về đúng bản gốc, kể cả khi dòng cũ mang ngày / kênh sai từ một hợp đồng ingest đời trước.
 *
 * NHÁNH TẠO MỚI CHẠY DƯỚI KHOÁ khi người gọi cấp `chayTrongKhoa` (lượt dựng lại — nó ghi ngoài mọi
 * transaction): cặp "hỏi ngày này đã ghi đè bằng file chưa" + "tạo dòng" phải nguyên tử với lượt
 * import, không thì câu hỏi chạy lúc dòng IMPORT chưa commit sẽ trả 0. Nhánh cập nhật là MỘT câu
 * `updateMany` (tự nó đã nguyên tử) nên cố ý KHÔNG bọc — nó là đường đi của gần như toàn bộ hàng
 * chục nghìn khoá, bọc thêm là trả 3 round-trip mỗi khoá mà không đổi lấy gì.
 *
 * Lỗi DB được NÉM RA cho người gọi quyết: route ingest để cả lô hỏng (không ghi nửa vời), lượt dựng
 * lại bắt lấy và đi tiếp.
 */
export async function upsertOneAdsExpense(
  db: AdsExpenseDb,
  source: AdsSource,
  m: PreparedAdsExpense,
  so: SoChiTieuAds,
  stats: AdsExpenseStats,
  warnings: string[],
  chayTrongKhoa?: ChayTrongKhoaGhiAds
): Promise<void> {
  // Không có dòng nào để hạ mà chi tiêu cũng bằng 0 ⇒ không có việc gì phải làm. Cắt round-trip ở
  // đây là cắt phần lớn thời gian của lượt dựng lại (đo prod: 19.116/32.535 khoá rơi vào ca này).
  if (m.amount === 0 && !so.refIdAds.has(m.refId)) return;

  const daSua = await db.expense.updateMany({
    where: { refId: m.refId, source: "ADS_API" },
    data: {
      amount: m.amount,
      description: m.description,
      date: m.date,
      categoryId: ADS_CATEGORY_ID,
      adsSource: source,
      channelId: adsChannelId(source),
    },
  });
  if (daSua.count > 0) {
    so.refIdAds.add(m.refId);
    stats.adsExpensesUpserted++;
    return;
  }
  if (m.amount === 0) return;

  // Cổng "ngày đã ghi đè bằng file", hỏi ẢNH CHỤP trước: trả lời được thì dừng ngay, không mở
  // transaction. Ảnh chụp của lượt dựng lại có thể cũ hàng phút nên chỉ tin được câu trả lời CÓ.
  if (so.ngayGhiDeBangFile.has(khoaNgay(source, m.dateKey))) {
    boQuaNgayGhiDeBangFile(source, m, so, stats, warnings);
    return;
  }

  // Hỏi lại DB rồi tạo dòng phải NGUYÊN TỬ với lượt import file: hai câu lệnh rời thì câu hỏi có thể
  // chạy lúc dòng IMPORT của lượt import CHƯA commit (mức cô lập READ COMMITTED không thấy) ⇒ trả 0
  // ⇒ đẻ dòng ADS_API cho đúng ngày vừa được thay bằng số của chủ shop, mà `deleteMany` của lượt
  // import đã chạy xong nên không xoá được dòng mới sinh. P&L cộng MỌI dòng danh mục "ads" ⇒ chi phí
  // ngày đó đếm 2 lần, lãi ròng tụt và KHÔNG tự lành.
  // `chayTrongKhoa` do người gọi ĐỨNG NGOÀI transaction cấp (lượt dựng lại); route ingest bỏ trống
  // vì cả lô của nó đã nằm trong transaction giữ khoá.
  type KetQuaTaoDong = "da-tao" | "ngay-da-ghi-de-bang-file" | "khoa-thuoc-chi-phi-nhap-tay";
  const taoDongMoi = async (tx: AdsExpenseDb): Promise<KetQuaTaoDong> => {
    // GIỮ ĐÚNG thứ tự hai cổng như bản trước: hỏi DB "ngày này đã ghi đè bằng file chưa" TRƯỚC, rồi
    // mới soi khoá nhập tay. Một dòng có thể dính CẢ HAI, và thứ tự quyết định chủ shop đọc được câu
    // cảnh báo nào — đảo thứ tự là lặng lẽ đổi thông báo mà không test nào bắt được. Soi `refIdSoTay`
    // chỉ là đọc Set trong bộ nhớ nên nằm trong transaction cũng không tốn thêm round-trip nào.
    if (await coDongImportTrongNgay(tx, source, m)) return "ngay-da-ghi-de-bang-file";
    if (so.refIdSoTay.has(m.refId)) return "khoa-thuoc-chi-phi-nhap-tay";
    await tx.expense.create({
      data: {
        date: m.date,
        categoryId: ADS_CATEGORY_ID,
        adsSource: source,
        description: m.description,
        channelId: adsChannelId(source),
        amount: m.amount,
        source: "ADS_API",
        refId: m.refId,
      },
    });
    return "da-tao";
  };
  const ketQua = chayTrongKhoa ? await chayTrongKhoa(taoDongMoi) : await taoDongMoi(db);

  // Cập nhật bộ đếm / ảnh chụp SAU khi transaction đã xong: mutate trước rồi transaction lỗi là số
  // liệu báo về không còn khớp sổ.
  if (ketQua === "ngay-da-ghi-de-bang-file") {
    boQuaNgayGhiDeBangFile(source, m, so, stats, warnings);
    return;
  }
  if (ketQua === "khoa-thuoc-chi-phi-nhap-tay") {
    // Cũng là kết cục ĐÚNG (chi phí nhập tay được ưu tiên tuyệt đối), không phải dòng kẹt.
    stats.boQuaCoChuDich++;
    warnings.push(
      `Bỏ chi tiêu ads ${m.refId}: khoá này đang thuộc một khoản chi phí nhập tay — không ghi đè, ` +
        `sửa lại khoản nhập tay đó rồi chạy lại`
    );
    return;
  }
  so.refIdAds.add(m.refId);
  stats.adsExpensesUpserted++;
}
