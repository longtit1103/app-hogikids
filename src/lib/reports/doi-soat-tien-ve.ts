import type { OrderStatus } from "@prisma/client";
import { differenceInCalendarDays, endOfDay, startOfDay } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { isProvisionalPlatformFee } from "@/lib/orders/provisional-fee";
import { prisma } from "@/lib/prisma";

/**
 * ĐỐI SOÁT TIỀN VỀ CẤP ĐƠN — kênh TikTok.
 *
 * Trả lời câu hỏi mà tab Dòng tiền trước nay bỏ ngỏ: ba con số (dự kiến thu, net
 * đã về, đã rút bank) đứng cạnh nhau nhưng KHÔNG ai nói chúng có khớp không. Ở
 * đây so TỪNG ĐƠN: số app tính được nhận vs số sàn thật sự trả về.
 *
 * BẤT BIẾN #7 giữ nguyên tuyệt đối: đây là lớp SO SÁNH, số quyết toán KHÔNG bao
 * giờ chảy ngược vào `pnl.ts` hay `Order.platformFeeEst`. Hai bên độc lập; lệch
 * là thông tin để người đọc tự quyết, không phải lệnh sửa dữ liệu.
 *
 * Vì sao đọc thẳng Bronze `RawTiktokShopTransaction`: Silver `TiktokSettlement`
 * là cấp SAO KÊ (một dòng gộp nhiều đơn) nên không trả lời được "đơn này sàn trả
 * bao nhiêu". Cùng lối đi và cùng khuôn khử trùng với `tiktok-quyet-toan-don.ts`
 * — file đó lo MỘT đơn cho drawer, file này lo CẢ KỲ cho tab Dòng tiền.
 *
 * ⚠️ TRỤC THỜI GIAN: neo `orderedAt` (NGÀY ĐẶT đơn). Khối "Tiền đã về" ngay phía
 * trên trong cùng tab neo `statementTime` (NGÀY SAO KÊ) và còn gồm cả giao dịch
 * quảng cáo — nên hai khối **không bao giờ cộng khớp nhau**, và lớp hiển thị phải
 * nói thẳng điều đó. Cũng ĐỪNG nói khối này "cùng trục với Dự kiến thu": cùng trục
 * ngày thật, nhưng khác TẬP ĐƠN — `expectedIn` chỉ lấy COMPLETED (`cash-flow.ts`),
 * còn ở đây gồm cả PENDING/SHIPPING để bắt được đơn Pancake quên cập nhật.
 *
 * Shopee KHÔNG ở đây mà ở module riêng `doi-soat-tien-ve-shopee.ts`: nguồn là VÍ
 * (`ShopeeSettlement`) — đo 20/08 ví nối được cấp đơn (66/66) nên file Income đã bỏ
 * (D2 xong 20/08). Câu cũ "ví không đủ chi tiết cấp đơn" là kết luận chưa đo, sai.
 */

/**
 * Đơn mới quyết toán chưa xong là chuyện BÌNH THƯỜNG, không phải lệch.
 *
 * ⚠️ Cửa sổ này CHỈ quyết định "vắng quyết toán là bình thường hay bất thường".
 * Nó TUYỆT ĐỐI không được chặn phép so khi sàn ĐÃ trả số: chặn như vậy thì đơn
 * lệch nặng trong tháng hiện tại bị giấu tới 30 ngày, mà kỳ mặc định của tab lại
 * chính là tháng hiện tại ⇒ khối câm đúng lúc cần nhất.
 *
 * 30 ngày: đo prod 2026-08-18 trên 295 đơn TikTok quá 30 ngày thì 295/295 đều đã
 * có giao dịch quyết toán (0 đơn "chưa thấy") ⇒ quá mốc này mà vẫn trống là dấu
 * hiệu thật, không phải còn đang chờ sàn.
 */
export const CUA_SO_CHO_QUYET_TOAN_NGAY = 30;

export type DonLech = {
  /** Khoá app — dùng mở drawer `/don-hang?don=<id>`. */
  id: string;
  /** Mã đơn hiển thị. ⚠️ KHÔNG định danh được đơn: TikTok có 2 cặp mã trùng (`1`, `3`). */
  code: string;
  /** Mã đơn TikTok — khoá định danh THẬT, phải hiện kèm để không tra nhầm đơn bên Pancake. */
  pancakeId: string;
  status: OrderStatus;
  /** Số app tính được nhận = itemsTotal − discount − platformFeeEst (đúng mạch `buildOrderProfitLines`). */
  thucNhanApp: number;
  /** Số sàn thật sự trả về, cộng dồn mọi giao dịch quyết toán của đơn. */
  sanTra: number;
  /** sanTra − thucNhanApp. ÂM = tiền về ít hơn app tưởng. */
  delta: number;
  soGiaoDich: number;
  /**
   * Phí sàn của đơn đang là số TẠM TÍNH (`isProvisionalPlatformFee`). Khi true thì
   * lệch KHÔNG phải mất tiền mà là app chưa nhận được phí thật — nguyên nhân khác
   * hẳn, và việc cần làm cũng khác hẳn (sửa trạng thái bên Pancake, không đi tra
   * soát với sàn). Đo 2026-08-18: 3/7 đơn lệch trên prod thuộc nhóm này.
   */
  phiTamTinh: boolean;
};

/**
 * Đơn ĐÃ đánh hoàn/hủy nhưng sàn VẪN ghi nhận doanh thu hoặc vẫn trả tiền dương.
 *
 * Đây là lỗ mù của chính phép đối soát: đơn hoàn/hủy bị loại khỏi bảng lệch (app cố
 * ý không tính "thực nhận" cho chúng), nên nếu trạng thái bị đánh sai thì KHÔNG có
 * lưới nào bắt. Đo 2026-08-19: ba đơn tháng 3 vừa được đánh hoàn trong khi sàn vẫn
 * ghi nhận doanh thu ĐỦ và đã trả đủ.
 *
 * ⚠️ CHỈ CẢNH BÁO. Tuyệt đối không tự sửa trạng thái, và tuyệt đối không đưa doanh
 * thu này trở lại P&L — P&L chỉ đọc `Order.status`, còn status là số của Pancake.
 */
export type DonHoanConTien = {
  id: string;
  code: string;
  pancakeId: string;
  status: OrderStatus;
  /**
   * Doanh thu sàn ghi nhận cho đơn (revenue_amount cộng dồn).
   *
   * `null` = NGUỒN KHÔNG ĐO ĐƯỢC đại lượng này, không phải "đo được và bằng 0" — ví Shopee chỉ có số
   * tiền vào/ra, không có khái niệm doanh thu sàn ghi nhận. In `0` cho ca đó là bịa số, và người đọc
   * sẽ kết luận "sàn đã huỷ ghi nhận doanh thu" trong khi sàn chưa từng nói gì.
   */
  doanhThuSan: number | null;
  /** NET sàn trả về. Dương = tiền đã về mà P&L đang loại đơn này. */
  sanTra: number;
  soGiaoDich: number;
  /**
   * Đơn ĐẶT còn trong 30 ngày ⇒ sàn chưa chắc đã kịp đảo, chưa kết luận được.
   * Cố ý neo NGÀY ĐẶT chứ không neo mốc đổi trạng thái: mốc kia bị đẩy lùi mỗi lượt
   * sửa Pancake, nên đơn cũ vừa sửa hôm nay vẫn phải hiện "cần kiểm tra".
   */
  choGiaoDichDao: boolean;
};

/**
 * Đơn HỢP LỆ (không hoàn/hủy) mà sàn ĐÃ có giao dịch quyết toán cho đơn nhưng Σ
 * `revenue_amount` ≤ 0 — sàn CHƯA ghi đồng doanh thu nào (có khi còn thu ngược phí).
 * App vẫn cộng doanh thu vào P&L vì Pancake để trạng thái delivered/còn hiệu lực.
 *
 * Đo prod 2026-09-18: 2 đơn/561.000đ, cả hai `COMPLETED`, đặt 08/04/2026 — một đơn
 * chỉ có 1 dòng ghi PHÍ (chưa từng ghi doanh thu), một đơn bán rồi bị đảo ngược sạch.
 * Ca `PENDING` cũng có thể xảy ra (sàn chưa quyết toán xong) nên KHÔNG lọc theo
 * status ngoài loại `RETURNED`/`CANCELLED` — chỉ cần ĐÃ có giao dịch mà doanh thu ≤ 0.
 *
 * ⚠️ CHỈ CẢNH BÁO — CHỈ ĐỌC. Đơn thuộc nhóm này VẪN đi tiếp vào nhánh so lệch phía
 * trên như bình thường (không rẽ nhánh, không đổi `khop`/`lech`/`danhSachLech`/
 * `tongDelta`). App KHÔNG tự sửa P&L, KHÔNG tự sửa trạng thái đơn.
 */
export type DonSanChuaGhiDoanhThu = {
  id: string;
  code: string;
  pancakeId: string;
  status: OrderStatus;
  /**
   * = `itemsTotal` — doanh thu GỘP app đang cộng vào P&L cho đơn này. CỐ Ý không phải
   * "thực nhận" (`itemsTotal − discount − platformFeeEst`): tên cảnh báo nói "doanh
   * thu", và bất biến #1 định nghĩa doanh thu gộp = Σ itemsTotal đơn hợp lệ — đây
   * đúng con số đang thực sự chảy vào `pnl.ts`.
   */
  doanhThuApp: number;
  /** Σ settlement_amount sàn đã trả — có thể âm nếu sàn chỉ thu ngược phí. */
  sanTra: number;
  soGiaoDich: number;
  /** Số ngày từ NGÀY ĐẶT (`orderedAt`) tới hôm nay, giờ VN. */
  tuoiNgay: number;
  /**
   * Đơn ĐẶT còn trong `CUA_SO_CHO_QUYET_TOAN_NGAY` ngày ⇒ sàn có thể chưa kịp ghi
   * nhận/đảo xong, chưa kết luận được là bất thường. Tái dùng đúng cửa sổ + đúng mốc
   * (NGÀY ĐẶT) với `qua_cua_so` ở trên — không dựng cửa sổ riêng.
   */
  conTrongCuaSoCho: boolean;
};

export type DoiSoatTienVe = {
  /** Đơn khớp TỪNG ĐỒNG. */
  khop: number;
  /** Đơn lệch (bất kỳ mức nào ≠ 0). */
  lech: number;
  /** Đơn ĐÃ GIAO XONG mà quá cửa sổ chờ vẫn không có giao dịch nào — bất thường thật. */
  chuaThay: number;
  /** Đơn CHƯA giao xong mà quá cửa sổ chờ — dấu hiệu Pancake chưa cập nhật trạng thái. */
  treoChuaGiao: number;
  /** Còn trong cửa sổ chờ và sàn chưa trả số — chưa kết luận được. */
  dangCho: number;
  /** Σ delta có DẤU. Hai đơn lệch ngược chiều triệt tiêu nhau ⇒ đọc một mình là hiểu nhầm. */
  tongDelta: number;
  /** Σ|delta| — quy mô lệch thật, không bị bù trừ dấu. */
  tongLechTuyetDoi: number;
  /** Danh sách đơn lệch, nặng tiền nhất trước. */
  danhSachLech: DonLech[];
  /** Đơn hoàn/hủy mà sàn vẫn ghi nhận doanh thu hoặc vẫn trả tiền dương. */
  hoanConTien: DonHoanConTien[];
  /**
   * Σ tiền sàn đã trả cho nhóm trên, CHỈ cộng phần dương. Không bù trừ với
   * `tongDelta`/`tongLechTuyetDoi` — ba con số nói ba chuyện khác nhau, gộp lại là
   * mất nghĩa.
   */
  tongTienVeDonHoan: number;
  /**
   * Đơn HỢP LỆ mà sàn ĐÃ có giao dịch nhưng CHƯA ghi đồng doanh thu nào. Danh sách
   * BỔ SUNG, độc lập với `danhSachLech` — cùng một đơn có thể vừa nằm ở đây vừa nằm
   * ở `danhSachLech` (nhóm này không rẽ nhánh, xem chú thích `DonSanChuaGhiDoanhThu`).
   */
  sanChuaGhiDoanhThu: DonSanChuaGhiDoanhThu[];
  /** Σ `doanhThuApp` của nhóm trên — tổng doanh thu app đang tính mà sàn chưa ghi nhận. */
  tongDoanhThuSanChuaGhi: number;
};

type Hang = {
  id: string;
  code: string;
  pancake_id: string;
  status: OrderStatus;
  channel_id: string;
  items_total: number;
  platform_fee_est: number;
  thuc_nhan: bigint;
  san_tra: bigint | null;
  doanh_thu_san: bigint | null;
  so_gd: number | null;
  qua_cua_so: boolean;
  /** Ngày đặt — cần riêng (không suy được từ `qua_cua_so`) để tính tuổi đơn theo NGÀY, không chỉ cờ nhị phân. */
  ordered_at: Date;
};

/**
 * Đối soát mọi đơn TikTok ĐẶT trong kỳ.
 *
 * Loại đơn hoàn/hủy: app CỐ Ý không tính "thực nhận" cho chúng, nên đem trừ là so
 * với số không tồn tại — mọi đơn hoàn/hủy sẽ đỏ rực bằng đúng giá trị đơn. Cùng
 * lý do `buildSettlementLines` nhận `thucNhanApp = null` cho nhóm này.
 */
export async function doiSoatTienVe(range: DateRange): Promise<DoiSoatTienVe> {
  const to = endOfDay(range.to);
  // Chốt MỘT mốc "bây giờ" cho cả cửa sổ chờ lẫn tuổi đơn — tránh lệch vài mili-giây
  // giữa hai phép tính trong cùng một lượt gọi.
  const now = new Date();
  const moc = new Date(now.getTime() - CUA_SO_CHO_QUYET_TOAN_NGAY * 24 * 60 * 60 * 1000);

  const rows = await prisma.$queryRaw<Hang[]>`
    WITH moi_nhat AS (
      -- MỘT bản cho mỗi giao dịch. Bronze khử trùng theo NỘI DUNG (payloadHash) nên
      -- TikTok bắn lại cùng giao dịch với số khác là thêm DÒNG chứ không đè; SUM
      -- thẳng sẽ cộng cả bản cũ lẫn bản mới ⇒ số sàn phồng lên mà nhìn vẫn hợp lý.
      -- Rút sẵn 2 field thay vì mang cả payload qua sort: payload là JSONB vài KB,
      -- kéo nguyên nó qua bước sắp xếp ~9k dòng là tự chuốc spill vô ích.
      SELECT DISTINCT ON ("shopId", "externalId")
             payload->>'order_id'          AS ma,
             payload->>'settlement_amount'  AS tien,
             payload->>'revenue_amount'     AS doanh_thu
      FROM "RawTiktokShopTransaction"
      WHERE payload->>'order_id' IS NOT NULL
        -- Bản bắn lại có thể RỚT hẳn field type (đã gặp thật) — lọc cứng bằng
        -- 'ORDER' sẽ vứt đúng bản mới nhất đó đi. Cổng thật chặn giao dịch quảng
        -- cáo là order_id IS NOT NULL ở trên: đo 2026-08-18, mọi loại không phải
        -- ORDER đều không có order_id.
        AND (payload->>'type' = 'ORDER' OR payload->>'type' IS NULL)
      -- id chốt cuối: fetchedAt là TIMESTAMP(3) và cả một lô land dùng chung
      -- clock_timestamp() nên trùng mili-giây là chuyện đi được; thiếu chốt thì
      -- bản thắng là TUỲ Ý. Cùng quy ước transform-raw-helpers.ts.
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ),
    txn AS (
      SELECT
        ma,
        -- Chuỗi tiền TikTok nằm trong JSON dạng CHUỖI; một giá trị dị làm văng cả
        -- truy vấn, mà hàm này chạy trong Promise.all của trang Tài chính nên sẽ hạ
        -- NGUYÊN TRANG. Lọc bằng regex trước khi ép kiểu.
        SUM(CASE WHEN tien ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN tien::numeric ELSE 0 END)::bigint AS san_tra,
        SUM(CASE WHEN doanh_thu ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN doanh_thu::numeric ELSE 0 END)::bigint AS doanh_thu_san,
        COUNT(*)::int AS so_gd
      FROM moi_nhat
      GROUP BY 1
    )
    SELECT
      o.id,
      o.code,
      o."pancakeId"                                              AS pancake_id,
      o.status,
      o."channelId"                                              AS channel_id,
      o."itemsTotal"                                             AS items_total,
      o."platformFeeEst"                                         AS platform_fee_est,
      (o."itemsTotal" - o.discount - o."platformFeeEst")::bigint  AS thuc_nhan,
      txn.san_tra                                                AS san_tra,
      txn.doanh_thu_san                                          AS doanh_thu_san,
      txn.so_gd                                                  AS so_gd,
      o."orderedAt"                                              AS ordered_at,
      -- MỘT cờ duy nhất, neo NGÀY ĐẶT — dùng cho cả hai nhánh.
      --
      -- Quy tắc chủ shop chốt 2026-08-19: ĐỒNG HỒ KHÔNG ĐƯỢC RESET BỞI MỘT LƯỢT SỬA
      -- PANCAKE. statusChangedAt không dùng làm mốc được: deriveStatusChangedAt
      -- chỉ lấy mốc thật từ status_history khi có entry khớp mã, thiếu thì rơi về
      -- updated_at — mà cái đó nhảy cả khi sàn đối soát phí lẫn khi sửa tay. Neo
      -- vào nó thì mỗi lượt chạm đơn đẩy lùi hạn 30 ngày, cảnh báo không bao giờ
      -- leo lên. Ngày đặt thì bất biến, không ai đẩy lùi được.
      --
      -- Bản trước từng thêm vế OR COALESCE(statusChangedAt, orderedAt) < moc làm
      -- lưới phòng dữ liệu bẩn. Đo prod 2026-08-19: 533/533 đơn có
      -- statusChangedAt >= orderedAt, 0 ca sớm hơn, 0 ca trống ⇒ vế đó KHÔNG BAO
      -- GIỜ đổi được kết quả (sca < moc kéo theo orderedAt < moc). Bỏ đi thay vì để
      -- lại một vế chết kèm mười dòng chú thích biện minh cho nó.
      (o."orderedAt" < ${moc})                                   AS qua_cua_so
    FROM "Order" o
    LEFT JOIN txn ON txn.ma = o."pancakeId"
    WHERE o."channelId" = 'tiktok'
      -- KHÔNG lọc trạng thái ở đây: đơn hoàn/hủy bị loại khỏi bảng lệch nhưng vẫn
      -- cần cho lưới "hoàn mà sàn còn ghi nhận tiền". Một lượt quét Bronze phục vụ
      -- cả hai, phân nhánh ở JS.
      AND o."orderedAt" >= ${range.from}
      AND o."orderedAt" <= ${to}
  `;

  let khop = 0;
  let lech = 0;
  let chuaThay = 0;
  let treoChuaGiao = 0;
  let dangCho = 0;
  const danhSachLech: DonLech[] = [];
  const hoanConTien: DonHoanConTien[] = [];
  const sanChuaGhiDoanhThu: DonSanChuaGhiDoanhThu[] = [];

  for (const r of rows) {
    // ── Nhánh đơn HOÀN/HỦY ──────────────────────────────────────────────────
    // App cố ý không tính "thực nhận" cho nhóm này nên không so được, nhưng vẫn
    // phải soi: nếu sàn còn ghi nhận doanh thu hoặc còn trả tiền dương thì nhiều
    // khả năng trạng thái bị đánh sai, mà P&L thì đang loại đơn khỏi doanh thu.
    // Hiện NGAY, không đợi hết cửa sổ chờ — cửa sổ chỉ đổi NHÃN, không giấu dòng.
    if (r.status === "RETURNED" || r.status === "CANCELLED") {
      const doanhThuSan = Number(r.doanh_thu_san ?? 0);
      const sanTra = Number(r.san_tra ?? 0);
      // Không cần hỏi lại `san_tra !== null`: vắng giao dịch thì cả hai vế đã là 0.
      if (doanhThuSan > 0 || sanTra > 0) {
        hoanConTien.push({
          id: r.id,
          code: r.code,
          pancakeId: r.pancake_id,
          status: r.status,
          doanhThuSan,
          sanTra,
          soGiaoDich: Number(r.so_gd ?? 0),
          choGiaoDichDao: !r.qua_cua_so,
        });
      }
      continue;
    }

    // ── Nhánh đơn HỢP LỆ ────────────────────────────────────────────────────
    // Vắng số sàn — CHỈ ở nhánh này cửa sổ chờ mới có tiếng nói. Quá hạn mà đơn đã
    // giao xong là bất thường thật; đơn chưa giao xong thì là trạng thái Pancake
    // chưa cập nhật, hai việc phải làm khác hẳn nhau nên đếm riêng.
    if (r.san_tra === null) {
      if (!r.qua_cua_so) dangCho += 1;
      else if (r.status === "COMPLETED") chuaThay += 1;
      else treoChuaGiao += 1;
      continue;
    }

    // ── Nhóm BỔ SUNG: sàn ĐÃ có giao dịch cho đơn nhưng CHƯA ghi đồng doanh thu nào ──
    // KHÔNG rẽ nhánh (không `continue`) — đơn vẫn đi tiếp xuống phần so lệch bình
    // thường ngay dưới, y hệt trước khi có nhóm này. Đây chỉ là một danh sách quan
    // sát THÊM, không đổi khop/lech/danhSachLech/tongDelta.
    const soGiaoDich = Number(r.so_gd ?? 0);
    const doanhThuSan = Number(r.doanh_thu_san ?? 0);
    if (soGiaoDich > 0 && doanhThuSan <= 0) {
      sanChuaGhiDoanhThu.push({
        id: r.id,
        code: r.code,
        pancakeId: r.pancake_id,
        status: r.status,
        doanhThuApp: Number(r.items_total),
        sanTra: Number(r.san_tra),
        soGiaoDich,
        tuoiNgay: differenceInCalendarDays(startOfDay(now), startOfDay(r.ordered_at)),
        conTrongCuaSoCho: !r.qua_cua_so,
      });
    }

    // Đã có số sàn thì SO NGAY, bất kể tuổi đơn.
    const thucNhanApp = Number(r.thuc_nhan);
    const sanTra = Number(r.san_tra);
    const delta = sanTra - thucNhanApp;
    if (delta === 0) {
      khop += 1;
      continue;
    }
    lech += 1;
    danhSachLech.push({
      id: r.id,
      code: r.code,
      pancakeId: r.pancake_id,
      status: r.status,
      thucNhanApp,
      sanTra,
      delta,
      soGiaoDich: Number(r.so_gd ?? 0),
      phiTamTinh: isProvisionalPlatformFee({
        channelId: r.channel_id,
        status: r.status,
        itemsTotal: Number(r.items_total),
        platformFeeEst: Number(r.platform_fee_est),
      }),
    });
  }

  danhSachLech.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  // Đơn CŨ (cần kiểm tra trạng thái) lên trước đơn mới (còn chờ giao dịch đảo),
  // trong mỗi nhóm thì nhiều tiền lên trước.
  hoanConTien.sort(
    (a, b) => Number(a.choGiaoDichDao) - Number(b.choGiaoDichDao) || b.sanTra - a.sanTra
  );
  // Đơn ĐÃ quá cửa sổ chờ (cần kiểm tra) lên trước đơn còn trong cửa sổ (còn chờ
  // sàn) — cùng luật sắp xếp với `hoanConTien`. Trong mỗi nhóm, tuổi đơn cao xếp
  // trước vì đó là dấu hiệu bất thường rõ hơn.
  sanChuaGhiDoanhThu.sort(
    (a, b) => Number(a.conTrongCuaSoCho) - Number(b.conTrongCuaSoCho) || b.tuoiNgay - a.tuoiNgay
  );

  return {
    khop,
    lech,
    chuaThay,
    treoChuaGiao,
    dangCho,
    tongDelta: danhSachLech.reduce((s, d) => s + d.delta, 0),
    tongLechTuyetDoi: danhSachLech.reduce((s, d) => s + Math.abs(d.delta), 0),
    danhSachLech,
    hoanConTien,
    // CHỈ cộng phần dương: một đơn hoàn có net âm (sàn đã đảo xong) không được kéo
    // tổng xuống, che mất tiền thật đang treo ở đơn khác.
    tongTienVeDonHoan: hoanConTien.reduce((s, d) => s + Math.max(0, d.sanTra), 0),
    sanChuaGhiDoanhThu,
    tongDoanhThuSanChuaGhi: sanChuaGhiDoanhThu.reduce((s, d) => s + d.doanhThuApp, 0),
  };
}
