import type { OrderStatus } from "@prisma/client";
import { endOfDay } from "date-fns";

import { isProvisionalPlatformFee } from "@/lib/orders/provisional-fee";
import { prisma } from "@/lib/prisma";
import type { DateRange } from "@/lib/date-range";

import { CUA_SO_CHO_QUYET_TOAN_NGAY, type DonHoanConTien, type DonLech } from "./doi-soat-tien-ve";

/**
 * Đối soát tiền về Shopee, cấp TỪNG ĐƠN — nguồn là ví (`ShopeeSettlement`).
 *
 * Thuần hiển thị. Số ở đây KHÔNG sửa gì trong P&L (bất biến #7): phí Shopee trong P&L lấy từ Pancake
 * `fee_marketplace`, lấy thêm từ ví là đếm hai lần.
 *
 * ⚠️ **Vì sao KHÔNG dùng file Income** dù nó có chi tiết phí: đo được ví phủ ĐÚNG BẰNG Income và khớp
 * tuyệt đối, nên Income chỉ thêm chi tiết phí — thứ không hiện lên UI và không được dùng cho P&L.
 *
 * 📄 **Số đo đầy đủ nằm ở MỘT chỗ duy nhất:** `docs/lo-trinh-du-an.md`, mục
 * "Đối soát tiền về Shopee cấp đơn — nguồn là VÍ, không phải file Income". Đừng chép số ra đây —
 * repo đã ba lần dính lớp lỗi "đuổi theo con số ở hai nơi thì nơi nào cũng sai".
 *
 * Bốn quyết định của phép đo này, mỗi cái chặn một cách hiểu sai:
 *
 * 1. **Gom NET theo `orderCode`, KHÔNG so từng dòng.** Một đơn có thể có nhiều dòng ví ở nhiều thời
 *    điểm — đo được ca thật: đơn `…F7SFCQ3W` có dòng trả `+170.387` (30/04) rồi dòng hoàn `−172.007`
 *    (18/05). So từng dòng thì đơn đó hiện "lệch" hai lần trong khi sự thật là net `−1.620`.
 * 2. **Bỏ `WITHDRAWAL` và mọi dòng không mang mã đơn.** Rút tiền về ngân hàng và phí lẻ là DÒNG TIỀN
 *    của ví, không thuộc đơn nào; kéo vào phép đối soát cấp đơn là gán tiền cho đơn không liên quan.
 * 3. **Đơn mirror lịch sử KHÔNG phải cảnh báo.** Xem `khongDuKhoa` dưới.
 * 4. **Cùng trục thời gian với khối TikTok** (neo `orderedAt`), để hai khối cạnh nhau trong một tab
 *    không mang hai nghĩa khác nhau.
 */

/** Kết quả đối soát Shopee. Cùng khuôn khối TikTok, thêm đúng một nhóm riêng. */
export type DoiSoatShopee = {
  khop: number;
  lech: number;
  chuaThay: number;
  treoChuaGiao: number;
  dangCho: number;
  /**
   * Đơn thuộc kỷ nguyên "mất gốc": Pancake xoá đơn Shopee cũ khỏi shop bán, app cứu bằng bản sao shop
   * Kho Tổng — bản cứu KHÔNG mang mã đơn sàn nên vĩnh viễn không nối được với ví.
   *
   * ⚠️ Nhóm này TUYỆT ĐỐI không được tính vào `chuaThay`. "Chưa thấy quyết toán" là cảnh báo CẦN
   * HÀNH ĐỘNG; nhóm này thì vô phương cứu và sẽ không bao giờ đổi. Nhét chung là dựng ra một vệt đỏ
   * vĩnh viễn, và vệt đỏ không bao giờ tắt thì người ta thôi đọc màu đỏ — tức giết luôn cảnh báo thật.
   *
   * * Nhận diện bằng CỘT `Order.backfilledFromMirror`, KHÔNG đoán theo tiền tố `AF` của `pancakeId` —
   * dùng cờ thì đơn mirror phát sinh MỚI vẫn vào đúng nhóm, đoán theo tiền tố thì chỉ đúng tình cờ.
   * Phép đo chứng minh cờ khớp dạng mã: xem mục tài liệu nêu ở đầu file.
   */
  khongDuKhoa: number;
  /**
   * Đơn nằm NGOÀI vùng thời gian mà file ví đã nhập phủ tới.
   *
   * ⚠️ Vì sao phải có ô này: ví Shopee là NHẬP TAY, khác TikTok tự kéo qua API mỗi đêm. Thiếu nó thì
   * tháng nào chủ shop chưa nhập file, mọi đơn tháng đó rơi vào "Chưa thấy quyết toán" kèm câu
   * "quá 30 ngày mà sàn vẫn chưa có giao dịch nào" — câu đó nói về SÀN, trong khi sự thật là APP CHƯA
   * ĐƯỢC NẠP FILE. App khẳng định thứ nó không biết, và lại đẻ đúng vệt đỏ giả mà cả tính năng này
   * dựng ra để tránh.
   */
  chuaNhapVi: number;
  /**
   * Vùng thời gian file ví đã nhập phủ tới — `null` khi chưa có dòng ví nào. Hiện lên UI.
   *
   * ⚠️ **Đo bằng MIN/MAX nên là vùng THÔ, không phải danh sách kỳ đã nhập.** Nhập file tháng 3 và
   * tháng 8 nhưng bỏ tháng 6 thì đơn tháng 6 vẫn nằm trong `[min, max]` ⇒ vẫn bị kết luận "chưa thấy
   * quyết toán". Chấp nhận ở v1 vì nó đã chặn được ca thường gặp nhất (chưa nhập gì, hoặc mới nhập
   * một kỳ); muốn chặt hơn phải lưu kỳ phủ của TỪNG lượt nhập — việc đó cần cột mới, ngoài phạm vi.
   */
  phuTu: Date | null;
  phuDen: Date | null;
  tongDelta: number;
  tongLechTuyetDoi: number;
  danhSachLech: DonLech[];
  hoanConTien: DonHoanConTien[];
  tongTienVeDonHoan: number;
};

type Hang = {
  id: string;
  code: string;
  pancake_id: string;
  status: OrderStatus;
  items_total: number;
  platform_fee_est: number;
  thuc_nhan: bigint;
  san_tra: bigint | null;
  so_gd: number | null;
  mirror: boolean;
  ordered_at: Date;
  qua_cua_so: boolean;
};

/**
 * Cửa sổ chờ quyết toán của Shopee.
 *
 * Dùng lại hằng của khối TikTok, nhưng KHÔNG phải vì "bê cho tiện" — hằng đó đo trên đơn TikTok,
 * không nói gì về Shopee. **Đã đo riêng cho Shopee và 30 ngày phủ trọn quan sát**; dãy đo, cỡ mẫu và
 * cảnh báo mẫu nhỏ nằm ở mục tài liệu nêu đầu file. Muốn nới hằng thì ĐO LẠI, đừng suy theo cảm tính.
 */
export const CUA_SO_CHO_QUYET_TOAN_SHOPEE_NGAY = CUA_SO_CHO_QUYET_TOAN_NGAY;

export async function doiSoatTienVeShopee(range: DateRange): Promise<DoiSoatShopee> {
  // endOfDay: đồng bộ với khối TikTok. Thiếu nó thì gọi hàm với `to` lúc 00:00 (bộ chọn ngày) sẽ làm
  // khối Shopee MẤT ngày cuối trong khi khối TikTok vẫn có — hai khối cạnh nhau, khác tập đơn, không
  // ai nhìn ra.
  const to = endOfDay(range.to);
  const moc = new Date(Date.now() - CUA_SO_CHO_QUYET_TOAN_SHOPEE_NGAY * 86_400_000);

  // Vùng phủ của ví: đọc TRƯỚC, vì mọi kết luận "sàn chưa trả" chỉ có nghĩa trong vùng này.
  const bien = await prisma.shopeeSettlement.aggregate({ _min: { txnTime: true }, _max: { txnTime: true } });
  const phuTu = bien._min.txnTime ?? null;
  const phuDen = bien._max.txnTime ?? null;

  const rows = await prisma.$queryRaw<Hang[]>`
    WITH vi AS (
      SELECT
        "orderCode"        AS ma,
        SUM(amount)::bigint AS san_tra,
        COUNT(*)::int       AS so_gd
      FROM "ShopeeSettlement"
      -- ⚠️ Vế orderCode IS NOT NULL KHÔNG CHỊU LỰC — giữ để đọc ra ý định, không phải để chặn.
      -- Đo bằng mutation 2026-08-20: bỏ vế này đi thì 9/9 test vẫn xanh, vì GROUP BY sinh một nhóm
      -- ma = NULL mà LEFT JOIN theo pancakeId không bao giờ khớp (NULL = x ra NULL).
      -- Thứ THẬT SỰ chặn là ngữ nghĩa JOIN. Ai sau này đổi sang INNER JOIN hay COALESCE thì phải tự
      -- dựng lại lớp chặn, đừng tin vào dòng WHERE này.
      WHERE "orderCode" IS NOT NULL
        -- DANH SÁCH CHO PHÉP, không phải danh sách cấm — phải khớp ĐÚNG định nghĩa net của khối
        -- "Tiền đã về" ngay phía trên (cash-flow.ts) và bất biến #7: net = Σ REVENUE + ADJUSTMENT.
        -- Dùng danh sách cấm thì loại OTHER (nhãn Shopee lạ, mapType so chuỗi con nên rất dễ rơi vào)
        -- lọt vào đây trong khi khối trên loại nó ra và bật cảnh báo vàng ⇒ hai con số cùng màn hình,
        -- hai định nghĩa tiền khác nhau, lệch âm thầm.
        AND type IN ('REVENUE', 'ADJUSTMENT')
      GROUP BY 1
    )
    SELECT
      o.id,
      o.code,
      o."pancakeId"                                              AS pancake_id,
      o.status,
      o."itemsTotal"                                             AS items_total,
      o."platformFeeEst"                                         AS platform_fee_est,
      (o."itemsTotal" - o.discount - o."platformFeeEst")::bigint  AS thuc_nhan,
      vi.san_tra                                                 AS san_tra,
      vi.so_gd                                                   AS so_gd,
      o."backfilledFromMirror"                                   AS mirror,
      o."orderedAt"                                              AS ordered_at,
      (o."orderedAt" < ${moc})                                   AS qua_cua_so
    FROM "Order" o
    LEFT JOIN vi ON vi.ma = o."pancakeId"
    WHERE o."channelId" = 'shopee'
      AND o."orderedAt" >= ${range.from}
      AND o."orderedAt" <= ${to}
  `;

  let khop = 0;
  let lech = 0;
  let chuaThay = 0;
  let treoChuaGiao = 0;
  let dangCho = 0;
  let khongDuKhoa = 0;
  let chuaNhapVi = 0;
  let tongDelta = 0;
  let tongLechTuyetDoi = 0;
  let tongTienVeDonHoan = 0;
  const danhSachLech: DonLech[] = [];
  const hoanConTien: DonHoanConTien[] = [];

  for (const r of rows) {
    // Nhóm mirror ra riêng TRƯỚC mọi phép phân loại khác: nó không nối được nên mọi kết luận về nó
    // đều vô nghĩa, kể cả "khớp".
    if (r.mirror) {
      khongDuKhoa += 1;
      continue;
    }

    const sanTra = r.san_tra === null ? 0 : Number(r.san_tra);
    const thucNhanApp = Number(r.thuc_nhan);

    if (r.status === "RETURNED" || r.status === "CANCELLED") {
      // App cố ý không tính "thực nhận" cho đơn hoàn/hủy nên đem so công thức là đỏ oan. Chỉ hỏi một
      // câu: sàn có còn giữ tiền dương cho đơn này không. Net ÂM là bình thường (sàn đã đòi lại).
      if (r.san_tra !== null && sanTra > 0) {
        hoanConTien.push({
          id: r.id,
          code: r.code,
          pancakeId: r.pancake_id,
          status: r.status,
          sanTra,
          doanhThuSan: null, // ví không đo được đại lượng này — xem docblock DonHoanConTien
          soGiaoDich: r.so_gd ?? 0,
          choGiaoDichDao: !r.qua_cua_so,
        });
        tongTienVeDonHoan += sanTra;
      }
      continue;
    }

    if (r.san_tra === null) {
      // Ngoài vùng ví đã nhập ⇒ KHÔNG kết luận gì. Đặt TRƯỚC nhánh cửa sổ chờ: đơn cũ nằm ngoài vùng
      // phủ vừa "quá 30 ngày" vừa "chưa nhập file", mà nguyên nhân đúng là cái sau.
      if (phuTu === null || phuDen === null || r.ordered_at < phuTu || r.ordered_at > phuDen) {
        chuaNhapVi += 1;
        continue;
      }
      if (!r.qua_cua_so) dangCho += 1;
      else if (r.status === "COMPLETED") chuaThay += 1;
      else treoChuaGiao += 1;
      continue;
    }

    const delta = sanTra - thucNhanApp;
    if (delta === 0) {
      khop += 1;
      continue;
    }

    lech += 1;
    tongDelta += delta;
    tongLechTuyetDoi += Math.abs(delta);
    danhSachLech.push({
      id: r.id,
      code: r.code,
      pancakeId: r.pancake_id,
      status: r.status,
      thucNhanApp,
      sanTra,
      delta,
      soGiaoDich: r.so_gd ?? 0,
      // Truyền đủ 4 field theo hợp đồng của helper: nó tự loại kênh không dùng phí thật và tự loại
      // trạng thái chưa chốt phí. Dựng lại điều kiện ở đây là đẻ bản sao thứ hai của cùng một luật.
      phiTamTinh: isProvisionalPlatformFee({
        channelId: "shopee",
        status: r.status,
        itemsTotal: r.items_total,
        platformFeeEst: r.platform_fee_est,
      }),
    });
  }

  danhSachLech.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  // Cùng thứ tự với khối TikTok: việc CẦN LÀM lên trước, rồi tới tiền lớn. Không sắp thì bảng trộn
  // "cần kiểm tra" với "chờ giao dịch đảo" theo thứ tự DB tuỳ ý, việc cần làm chìm xuống dưới.
  hoanConTien.sort(
    (a, b) => Number(a.choGiaoDichDao) - Number(b.choGiaoDichDao) || b.sanTra - a.sanTra,
  );

  return {
    khop,
    lech,
    chuaThay,
    treoChuaGiao,
    dangCho,
    khongDuKhoa,
    chuaNhapVi,
    phuTu,
    phuDen,
    tongDelta,
    tongLechTuyetDoi,
    danhSachLech,
    hoanConTien,
    tongTienVeDonHoan,
  };
}
