import { adsSourceLabel } from "@/lib/ads-source-label";
import { formatVnd } from "@/lib/format";

import type { PnlBreakdown } from "@/lib/reports/pnl";
import { EXCLUDED_ORDER_STATUS_SLUGS } from "@/lib/reports/pnl-drill-href";
import type { PlatformFeeComponent } from "@/lib/reports/platform-fee-breakdown";
import type { VoucherBreakdown } from "@/lib/reports/voucher-breakdown";

/**
 * 1 dòng bảng P&L. `value` LUÔN dương cho các dòng bị trừ (khớp trực tiếp
 * field PnlBreakdown, vd `platformFee`) — `displayValue()` mới đổi dấu để
 * hiển thị. Tách khỏi field gốc để "Σ con = cha" (ads expand) không phải tự
 * cộng lại số (đọc thẳng `adsBySource`, không suy luận).
 *
 * Module THUẦN (không JSX) — dùng CHUNG bởi bảng trên màn (`pnl-tab.tsx`) và
 * sheet xuất Excel (`report-export-buttons.tsx`) để 2 nơi không lệch số; tách
 * riêng khỏi component để giữ mỗi file dưới ~200 dòng (quy ước modularize).
 */
export type PnlLineItem = {
  id: string;
  label: string;
  value: number;
  isDeduction: boolean;
  /**
   * `group` = dòng TỔNG của một khối, đứng TRƯỚC các dòng con giải thích nó
   * (kiểu bảng quyết toán của sàn: đọc tổng trước, muốn hiểu thì bung ra).
   * `subtotal`/`total` = mốc kết quả của mạch tính dọc bảng.
   */
  kind: "line" | "group" | "subtotal" | "total";
  href?: string;
  /** Bậc thụt lề: 0 = mạch chính, 1 = con của nhóm, 2 = con của con. */
  depth?: number;
  warn?: boolean;
  /**
   * Cảnh báo có đích để đi tới không. `false` = có cảnh báo nhưng KHÔNG trang nào giúp được (dòng
   * hàng không rõ SKU: nguồn Pancake thiếu `display_id` nên không có Variant để sửa) ⇒ nhãn render
   * icon tĩnh thay vì link dẫn vào danh sách rỗng.
   */
  warnCoDich?: boolean;
  /** Dòng con: id của dòng cha (bảng thu/bung theo cha). Đi kèm `depth ≥ 1`. */
  parentId?: string;
  /**
   * Dòng GHI CHÚ đứng ngoài mọi phép tính (không cộng vào nhóm nào, không nằm
   * trên mạch chính). Thụt lề như dòng con nên PHẢI có dấu hiệu riêng ở lớp hiển
   * thị, nếu không người đọc tưởng nó là con của dòng phía trên rồi cộng tay vào.
   */
  aside?: boolean;
  /** Ghi chú giải thích, hiện dạng tooltip cạnh nhãn. */
  hint?: string;
  /**
   * Ghi chú hiện THẲNG dưới nhãn (không phải tooltip) — dành cho dòng mà hiểu
   * sai thì đọc sai tiền, vd khoản đã trừ ở chỗ khác hoặc khoản sàn trả thay.
   * Chủ shop không rê chuột từng dòng để đọc tooltip.
   */
  note?: string;
};

const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  shipping: "Vận chuyển",
  packaging: "Đóng gói",
  return_bom: "Hoàn/Bom hàng",
  fixed: "Mặt bằng - cố định",
  interest: "Lãi vay",
  other: "Khác",
};

/**
 * Dòng con của "Phí sàn" — từng khoản Pancake trả về (hoa hồng, phí giao dịch,
 * thuế…). Cam kết "Σ con = cha": phần tổng KHÔNG chia được thành khoản luôn hiện
 * thành dòng riêng, nên hai số không bao giờ lệch nhau mà im lặng.
 *
 * Phần chưa chia được tách làm HAI dòng vì hai nguyên nhân khác hẳn nhau, mà
 * gộp lại thì chủ shop tưởng app hỏng (đo prod 2026-08-06):
 *  - ĐƠN BÙ (96%): Pancake mất đơn gốc ở shop bán, app bù từ bản sao kho và tự
 *    ước tính phí ⇒ không tồn tại chi tiết để chia. Không chờ được, không sửa được.
 *  - PANCAKE CHƯA TRẢ (4%): đơn còn nguyên ở Pancake nhưng khối chi tiết rỗng —
 *    hầu hết là đơn CHƯA GIAO XONG (sàn chưa đối soát); đo được: đơn đã hoàn tất
 *    có chi tiết 307/309, đơn đang giao/chờ xử lý 0/5. Loại này tự đầy khi đơn xong.
 *
 * `components` rỗng VÀ không có phí đơn bù → KHÔNG sinh dòng con nào: dòng cha
 * giữ nguyên như cũ, không mọc mũi tên chỉ để xổ ra một dòng vô nghĩa. Riêng khi
 * CÓ `backfilledFee` thì vẫn phải tách dòng dù components rỗng — kỳ mà toàn bộ
 * phí là của đơn bù (Pancake mất sạch đơn gốc) chính là lúc caveat "phí ước
 * tính" cần hiện nhất, nuốt nó là trình bày phí ước y như phí thật.
 */
function buildPlatformFeeChildren(
  platformFee: number,
  components: PlatformFeeComponent[],
  backfilledFee: number
): PnlLineItem[] {
  if (components.length === 0 && backfilledFee === 0) return [];

  const con = (id: string, label: string, value: number, extra?: Partial<PnlLineItem>): PnlLineItem => ({
    id: `platformFee:${id}`,
    label,
    value,
    isDeduction: true,
    kind: "line",
    depth: 1,
    parentId: "platformFee",
    ...extra,
  });

  const children: PnlLineItem[] = components.map((c) => con(c.key, c.label, c.amount));

  const conLai = platformFee - components.reduce((s, c) => s + c.amount, 0);
  // Phí đơn bù nằm TRỌN trong phần chưa chia được (đơn bù không có khoản chi tiết
  // nào — query đã loại chúng khỏi `components`). Kẹp vào [0, conLai] để giữ
  // "Σ con = cha" trong mọi hoàn cảnh: cả hai đầu kẹp đều là DẤU HIỆU DỮ LIỆU LẠ
  // chứ không phải chuyện thường, nên phải gắn cờ cảnh báo thay vì nuốt im lặng
  // (kẹp mà im thì bảng vẫn cộng đúng nhưng giấu mất chỗ đang hỏng).
  const phiDonBu = Math.max(0, Math.min(backfilledFee, conLai));
  const donBuBiKep = backfilledFee !== phiDonBu;
  const phiPancakeThieu = conLai - phiDonBu;

  if (phiDonBu !== 0 || donBuBiKep) {
    children.push(
      con("don-bu", "Đơn bù — phí ước tính", phiDonBu, {
        warn: donBuBiKep,
        note: donBuBiKep
          ? `Số ghi nhận cho đơn bù (${formatVnd(backfilledFee)}) không khớp phần phí chưa chia được — đang hiện phần nằm lọt trong tổng để bảng không lệch. Cần kiểm tra dữ liệu đơn bù.`
          : "Sàn không còn giữ đơn gốc nên không có số phí thật; app ước theo tỉ lệ phí trung bình của kênh. Khoản này sẽ không bao giờ tách được thành từng loại phí.",
      })
    );
  }
  if (phiPancakeThieu !== 0) {
    // > 0 là ca thường gặp (đơn chưa giao xong nên sàn chưa đối soát, hoặc kênh
    // FB/website tính phí ước tính %). < 0 là bất thường (chi tiết vượt tổng) —
    // vẫn hiện để tổng khớp, kèm cờ cảnh báo.
    children.push(
      con(
        "chua-co-chi-tiet",
        phiPancakeThieu > 0 ? "Pancake chưa trả chi tiết" : "Chênh lệch chi tiết",
        phiPancakeThieu,
        {
          warn: phiPancakeThieu < 0,
          hint:
            phiPancakeThieu > 0
              ? "Pancake mới báo tổng phí, chưa báo từng loại. Thường gặp ở đơn chưa giao xong vì sàn còn chờ đối soát — giao xong là số chi tiết tự về."
              : "Cộng các loại phí lại đang vượt cả tổng phí sàn — dữ liệu Pancake có gì đó bất thường, cần kiểm tra.",
        }
      )
    );
  }
  return children;
}

/**
 * Đầu bảng: nhóm "Doanh thu" — dòng TỔNG đứng trước, bung ra là giá niêm yết và
 * phần shop giảm cho khách.
 *
 * Chỉ HAI khái niệm, phân theo AI BỎ TIỀN:
 *  - "Giảm giá do người bán" = shop chịu. Gộp cả hai hình thức shop dùng ở sàn
 *    (hạ giá trên từng sản phẩm + mã giảm giá cả đơn) vì với chủ shop chúng
 *    cùng là tiền mình bỏ ra, dù Pancake trừ chúng ở hai bước khác nhau.
 *  - "Sàn trợ giá" = sàn chịu, khách vẫn được giảm nhưng shop thu đủ ⇒ KHÔNG
 *    mang dấu trừ và KHÔNG là con của nhóm nào. Trừ nó lần nữa là bóp lãi xuống
 *    oan; cho vào nhóm Doanh thu thì Σ con lại khác dòng tổng.
 *
 * Cộng tay trên màn phải ra đúng, theo cả hai chiều:
 *   trong nhóm:  Giá niêm yết − Giảm giá do người bán = Doanh thu
 *   dọc bảng:    Doanh thu − Phí sàn = Thực nhận từ sàn
 *
 * `Doanh thu` ở đây = `revenue − voucher` của pnl.ts (Σ itemsTotal đã trừ sẵn
 * phần giảm giá trên sản phẩm, trừ tiếp voucher cả đơn) — KHÔNG phải một cách
 * tính doanh thu thứ hai. Giá niêm yết cũng suy ra từ chính các số đó, không
 * cộng lại từ payload.
 */
function buildDiscountLines(b: PnlBreakdown, v: VoucherBreakdown): PnlLineItem[] {
  const shopChiu = v.shopLineLevel + b.voucher;

  return [
    {
      id: "netOfDiscount",
      label: "Doanh thu",
      value: b.revenue - b.voucher,
      isDeduction: false,
      kind: "group",
      // Vẫn drill sang Đơn hàng được: ở đó "Doanh thu gộp" trừ "Voucher" ra
      // đúng số này — đường đối chiếu hai màn không bị đứt khi đổi cách bày.
      href: "/don-hang",
      hint: "Tiền hàng shop thực bán được, sau khi trừ mọi khoản shop giảm cho khách. Đây là gốc để tính mọi con số phía dưới.",
    },
    {
      id: "listPrice",
      label: "Giá niêm yết",
      value: b.revenue + v.shopLineLevel,
      isDeduction: false,
      kind: "line",
      depth: 1,
      parentId: "netOfDiscount",
      hint: "Tổng tiền hàng theo giá niêm yết, tính khi chưa trừ bất kỳ khuyến mãi nào.",
    },
    {
      id: "sellerDiscount",
      label: "Giảm giá do người bán",
      value: shopChiu,
      isDeduction: true,
      kind: "line",
      depth: 1,
      parentId: "netOfDiscount",
      href: "/don-hang",
      note: "Tiền shop tự bỏ ra giảm cho khách — gồm giảm giá trên từng sản phẩm và mã giảm giá cả đơn. Khoản này shop chịu, khác với phần sàn trợ giá.",
    },
    {
      id: "sellerDiscount:san-pham",
      label: "Giảm giá sản phẩm",
      value: v.shopLineLevel,
      isDeduction: true,
      kind: "line",
      depth: 2,
      parentId: "sellerDiscount",
      hint: "Phần hạ giá đặt trên từng sản phẩm khi lên đơn ở sàn.",
    },
    {
      id: "sellerDiscount:voucher-shop",
      label: "Voucher shop tạo",
      value: b.voucher,
      isDeduction: true,
      kind: "line",
      depth: 2,
      parentId: "sellerDiscount",
      hint: "Mã giảm giá áp cho CẢ ĐƠN do shop tự tạo — khác với giảm giá đặt trên từng sản phẩm.",
    },
    // Nằm TRONG khối Doanh thu và trông y hệt các dòng cùng bậc (cùng thụt lề, cùng
    // vạch dọc, thu/bung cùng nhóm) — nhưng KHÔNG mang dấu trừ và KHÔNG được tính
    // vào "Σ con = cha": khoản này sàn trả thay khách nên shop thu đủ. Xen nó vào
    // mạch cộng trừ như bản đầu làm người đọc cộng tay theo cột ra thừa đúng 3,8
    // triệu (6,5% doanh thu) — chính file này cam kết "cộng tay trên màn phải ra đúng".
    {
      id: "platformFunded",
      label: "Sàn trợ giá thêm",
      value: v.marketplaceFunded,
      isDeduction: false,
      kind: "line",
      depth: 1,
      parentId: "netOfDiscount",
      aside: true,
      note: "Khách được giảm thêm nhưng SÀN trả khoản này, shop vẫn thu đủ — nên nó không cộng cũng không trừ vào doanh thu.",
    },
  ];
}

/**
 * Nhóm "Chi phí vận hành" — mọi khoản trừ giữa LÃI GỘP và LÃI RÒNG gom về MỘT
 * dòng tổng, bung ra là từng khoản.
 *
 * Trước đây 7 khoản này nằm phẳng cạnh nhau, không có dòng tổng: muốn biết
 * "tháng này vận hành ngốn bao nhiêu" chủ shop phải tự cộng 7 số trên màn.
 *
 * Tổng lấy bằng HIỆU `grossProfit − netProfit` chứ không cộng lại 7 field — theo
 * đúng định nghĩa `netProfit` của `pnl.ts`. Cộng tay ở đây thì mai kia thêm một
 * khoản trừ vào `netProfit` mà quên sửa chỗ này, dòng tổng sẽ lệch Σ dòng con
 * mà không ai biết.
 */
function buildOpexGroup(b: PnlBreakdown, adsChildren: PnlLineItem[]): PnlLineItem[] {
  const child = (
    id: string,
    label: string,
    value: number,
    href: string,
    extra?: Partial<PnlLineItem>
  ): PnlLineItem => ({
    id,
    label,
    value,
    isDeduction: true,
    kind: "line",
    depth: 1,
    parentId: "opex",
    href,
    ...extra,
  });

  return [
    {
      id: "opex",
      label: "Chi phí vận hành",
      value: b.grossProfit + b.financialIncome - b.netProfit,
      isDeduction: true,
      kind: "group",
      hint: "Toàn bộ chi phí chạy shop trong kỳ: quảng cáo, vận chuyển, đóng gói, hoàn/bom, mặt bằng, lãi vay… Trừ nốt khoản này khỏi lãi gộp là ra lãi ròng.",
    },
    child("ads", "Quảng cáo", b.ads, "/tai-chinh?tab=so-chi-phi&danh_muc=ads"),
    ...adsChildren,
    child("shipping", EXPENSE_CATEGORY_LABEL.shipping, b.shipping, "/tai-chinh?tab=so-chi-phi&danh_muc=shipping"),
    child("packaging", EXPENSE_CATEGORY_LABEL.packaging, b.packaging, "/tai-chinh?tab=so-chi-phi&danh_muc=packaging"),
    child("returnBom", EXPENSE_CATEGORY_LABEL.return_bom, b.returnBom, "/tai-chinh?tab=so-chi-phi&danh_muc=return_bom"),
    child(
      "returnedOrderFee",
      "Phí sàn đơn hoàn/hủy",
      b.returnedOrderFee,
      `/don-hang?trang_thai=${EXCLUDED_ORDER_STATUS_SLUGS.join(",")}`,
      {
        hint: "Đơn bị hoàn hoặc hủy thì không tính doanh thu, nhưng phần phí sàn đã giữ lại thì shop vẫn mất — nên nó nằm ở đây.",
      }
    ),
    child("fixed", EXPENSE_CATEGORY_LABEL.fixed, b.fixed, "/tai-chinh?tab=so-chi-phi&danh_muc=fixed"),
    child("interest", EXPENSE_CATEGORY_LABEL.interest, b.interest, "/tai-chinh?tab=so-chi-phi&danh_muc=interest", {
      hint: "Tiền lãi trả cho khoản vay — là chi phí thật. Tiền GỐC vay/trả gốc không nằm ở đây (chỉ ở quỹ, tab Dòng tiền).",
    }),
    child("other", EXPENSE_CATEGORY_LABEL.other, b.other, "/tai-chinh?tab=so-chi-phi&danh_muc=other"),
  ];
}

/**
 * Nguồn DUY NHẤT cho thứ tự + nhãn dòng P&L.
 *
 * Hình dạng bảng: MẠCH CHÍNH chỉ còn 7 dòng đọc thẳng từ trên xuống, mỗi khối
 * rậm rạp được gói thành một NHÓM bung ra xem chi tiết —
 *
 *   Doanh thu − Phí sàn = Thực nhận từ sàn − COGS = LN gộp − Chi phí vận hành = LN ròng
 *
 * Hai cam kết phải giữ, đổi cách bày kiểu gì cũng không được phá:
 *  1. Σ dòng con (đã đổi dấu) = dòng nhóm, ở MỌI nhóm — KHÔNG kể dòng `aside`
 *     (xem `summableChildren`).
 *  2. Cộng trừ dọc mạch chính ra đúng dòng dưới.
 * Dòng `aside` duy nhất hiện nay là "Sàn trợ giá thêm": sàn trả thay khách nên
 * shop thu đủ, cộng vào tổng nhóm là vống lên đúng khoản sàn chịu.
 *
 * Ads expand ĐỘNG theo mọi key có
 * mặt trong `adsBySource` (kể cả SHOPEE_ADS hay nguồn mới chưa biết) —
 * `adsSourceLabel` tự lo nhãn, ở đây chỉ lặp `Object.entries` rồi sort,
 * TUYỆT ĐỐI không hardcode danh sách nguồn hay gộp bất kỳ key nào vào "Khác"
 * ngoài đúng key `"KHAC"`/`null` mà bản thân `adsSourceLabel` đã xử lý. Tổng
 * dòng con LUÔN khớp dòng cha "Quảng cáo" vì cả hai đọc thẳng từ cùng
 * `PnlBreakdown` (pnl.ts core) — không tự cộng lại ở đây.
 *
 * `feeComponents` (từ `computePlatformFeeComponents`) và `voucher` (từ
 * `computeVoucherBreakdown`) sinh dòng con cho "Phí sàn" / "Voucher". Vắng cả
 * hai → bảng y hệt trước đây. `backfilledFee` (từ `computeBackfilledPlatformFee`)
 * chỉ tách dòng con của "Phí sàn", không đổi tổng.
 */
const HINT_LN_RONG_GOC =
  "Lãi ròng = lãi gộp trừ toàn bộ chi phí vận hành. Đây là số tiền shop thực sự lãi trong kỳ. Gọi là tạm tính vì sàn có thể còn điều chỉnh phí sau đối soát.";

/**
 * Chú thích dòng LN ròng. Kỳ có thu nhập tài chính thì CÔNG THỨC KHÁC (thêm một vế cộng) và biên
 * ròng nhảy lên — không nói ra thì tháng đáo hạn sổ đọc như bán hàng đột nhiên lãi hơn.
 *
 * Đặt ở đây là CỐ Ý: `report-export-buttons.tsx` lấy cột "Ghi chú" của sheet Excel bằng
 * `note ?? hint`, nên sửa MỘT chỗ này là cả bảng trên màn lẫn file xuất ra cùng có câu đó — không
 * phải khai lần hai ở lớp export (đúng chỗ dễ lệch nếu hai nơi tự viết).
 */
function hintLnRong(b: PnlBreakdown): string {
  if (b.financialIncome <= 0) return HINT_LN_RONG_GOC;
  return `Lãi ròng = lãi gộp CỘNG thu nhập tài chính rồi trừ toàn bộ chi phí vận hành. Kỳ này có gồm thu nhập tài chính ${formatVnd(
    b.financialIncome
  )} — biên ròng vì thế cao hơn phần lãi từ bán hàng. Gọi là tạm tính vì sàn có thể còn điều chỉnh phí sau đối soát.`;
}

export function buildPnlLineItems(
  b: PnlBreakdown,
  feeComponents: PlatformFeeComponent[] = [],
  voucher?: VoucherBreakdown,
  backfilledFee = 0
): PnlLineItem[] {
  const adsChildren: PnlLineItem[] = Object.entries(b.adsBySource)
    .sort(([, a], [, x]) => x - a)
    .map(([key, amount]) => ({
      id: `ads:${key}`,
      label: adsSourceLabel(key),
      value: amount,
      isDeduction: true,
      kind: "line",
      depth: 2,
      parentId: "ads",
    }));

  const platformFeeChildren = buildPlatformFeeChildren(b.platformFee, feeComponents, backfilledFee);

  // Có `voucher` → mở đầu bằng mạch giảm giá (giá niêm yết → ai giảm → doanh
  // thu). Vắng (caller cũ, fixture test) → giữ nguyên hai dòng cũ để không phá
  // hợp đồng hiển thị của những nơi chưa truyền.
  const moDau: PnlLineItem[] = voucher
    ? buildDiscountLines(b, voucher)
    : [
        {
          id: "revenue",
          label: "Doanh thu gộp",
          value: b.revenue,
          isDeduction: false,
          kind: "line",
          href: "/don-hang",
        },
        { id: "voucher", label: "Voucher", value: b.voucher, isDeduction: true, kind: "line", href: "/don-hang" },
      ];

  return [
    ...moDau,
    {
      id: "platformFee",
      label: "Phí sàn",
      value: b.platformFee,
      isDeduction: true,
      kind: platformFeeChildren.length ? "group" : "line",
      href: "/don-hang",
      // KHÔNG được khẳng định "toàn bộ là số thật": chính dòng con "Đơn bù — phí
      // ước tính" ngay dưới là khoản app tự ước theo tỉ lệ phí của kênh (T3–T4/2026
      // ở mức đáng kể mỗi tháng). Nói quá về độ tin cậy rồi bung chi
      // tiết ra thấy ngược lại là mất niềm tin vào cả bảng.
      hint: "Tiền sàn giữ lại trên các đơn bán được: hoa hồng, phí giao dịch, phí dịch vụ, thuế sàn khấu trừ… Hầu hết là số thật sàn báo về; riêng phần đơn bù là app tự ước — bung ra xem chi tiết sẽ rõ khoản nào là khoản nào.",
    },
    ...platformFeeChildren,
    {
      id: "netRevenue",
      label: "Thực nhận từ sàn",
      value: b.netRevenue,
      isDeduction: false,
      kind: "subtotal",
      hint: "Doanh thu trừ phí sàn — tiền hàng còn lại sau khi sàn cắt phần của họ, chưa trừ giá vốn hay chi phí nào của shop.",
    },
    {
      id: "cogs",
      label: "COGS",
      value: b.cogs,
      isDeduction: true,
      kind: "line",
      href: "/bao-cao?tab=san-pham",
      warn: b.skuMissingCount > 0 || b.skuUnknownLineCount > 0,
      warnCoDich: b.skuMissingCount > 0,
      hint: "Giá vốn của hàng đã bán trong kỳ = số lượng × giá vốn đang khai ở mục Sản phẩm. Sửa giá vốn thì con số này đổi theo, kể cả kỳ cũ.",
    },
    {
      id: "grossProfit",
      label: "LN gộp",
      value: b.grossProfit,
      isDeduction: false,
      kind: "subtotal",
      hint: "Lãi gộp = thực nhận từ sàn trừ giá vốn hàng đã bán. Là phần lãi từ việc bán hàng, chưa trừ chi phí chạy shop.",
    },
    {
      id: "financialIncome",
      label: "Thu nhập tài chính",
      value: b.financialIncome,
      isDeduction: false,
      kind: "line",
      href: "/tai-chinh?tab=dong-tien#tiet-kiem",
      // LUÔN hiện kể cả bằng 0 — cùng quy ước "Phí sàn đơn hoàn/hủy". Dòng trên MẠCH CHÍNH mà
      // lúc có lúc không thì cột "so tháng trước" đứt đoạn (dòng mất = coi như Mới ở tháng sau)
      // và hình bảng đổi theo từng tháng, chủ shop mất mốc đọc quen.
      hint: "Lãi sổ tiết kiệm đã nhận về — ghi TRỌN vào tháng tất toán sổ, không chia đều các tháng gửi. Đây là thu nhập của cả shop nên bảng của từng kênh không có dòng này.",
    },
    ...buildOpexGroup(b, adsChildren),
    {
      id: "netProfit",
      label: "LN ròng",
      value: b.netProfit,
      isDeduction: false,
      kind: "total",
      hint: hintLnRong(b),
    },
  ];
}

/**
 * Giá trị hiển thị: dòng trừ luôn đổi dấu âm — quy ước DUY NHẤT dùng chung bảng
 * + export + tính %/delta.
 *
 * Khoản 0 trả về 0 CHỨ KHÔNG phải −0: `-0` lọt xuống cột phần trăm thành "-0%"
 * (JS giữ dấu của zero âm), đọc như một khoản chi tí xíu trong khi tháng đó
 * không tiêu đồng nào.
 */
export function displayValue(item: Pick<PnlLineItem, "value" | "isDeduction">): number {
  return item.isDeduction && item.value !== 0 ? -item.value : item.value;
}

/**
 * Tháng trống = không đơn (kể cả hoàn/hủy) VÀ không khoản chi nào VÀ không khoản thu ngoài bán
 * hàng nào phát sinh — hiện empty card thay vì bảng toàn số 0. Thiếu vế `financialIncome` thì
 * tháng chỉ tất toán sổ tiết kiệm (không bán đơn nào) sẽ bị nuốt trọn: cả bảng lẫn nút Xuất Excel.
 */
export function isPnlMonthEmpty(b: PnlBreakdown): boolean {
  return (
    b.orderCount === 0 &&
    b.returnBomOrderCount === 0 &&
    b.financialIncome === 0 &&
    b.ads + b.shipping + b.packaging + b.returnBom + b.fixed + b.interest + b.other === 0
  );
}

export type PnlLineDelta = { kind: "new" } | { kind: "flat" } | { kind: "change"; pct: number };

/**
 * So với dòng cùng id ở tháng trước, tính trên `displayValue()` (đã đổi dấu
 * dòng trừ) — nên "tăng" LUÔN nghĩa là dòng đó tốt lên (doanh thu tăng, hoặc
 * 1 khoản chi giảm), khớp quy ước màu ▲success/▼error đã dùng ở
 * `dashboard/kpi-cards.tsx`. `prev === 0` (tháng trước chưa phát sinh) →
 * "Mới", tránh chia cho 0.
 */
export function computePnlLineDelta(current: number, prev: number): PnlLineDelta {
  if (prev === 0) {
    return current === 0 ? { kind: "flat" } : { kind: "new" };
  }
  const pct = ((current - prev) / Math.abs(prev)) * 100;
  return pct === 0 ? { kind: "flat" } : { kind: "change", pct };
}
