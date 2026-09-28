import type { PnlLineItem } from "@/lib/reports/pnl-line-items";
import type { QuyetToanDon } from "@/lib/reports/tiktok-quyet-toan-don";

/**
 * DÒNG KHOẢN MỤC CỦA MỘT ĐƠN — cùng kiểu cây với bảng Lãi/Lỗ, để hai màn đọc
 * giống hệt nhau (cùng `PnlLineItem`, cùng component nhãn, cùng cách thu/bung).
 *
 * Module THUẦN, không đụng DB — mọi số truyền vào từ ngoài để test được bằng
 * vitest và để lớp gọi chịu trách nhiệm lấy dữ liệu.
 *
 * Hai mạch RIÊNG BIỆT, cố ý không trộn:
 *  1. `lai` — app tính: doanh thu → phí sàn → giá vốn → lãi đơn.
 *  2. `doiChieu` — số SÀN quyết toán trả về, đặt CẠNH để so, TUYỆT ĐỐI không sửa
 *     mạch (1). Trộn hai nguồn vào một phép tính là đường dẫn tới đếm hai lần —
 *     bất biến #7.
 *
 * Cam kết giữ nguyên như bảng Lãi/Lỗ: Σ dòng con (đã đổi dấu) = dòng nhóm, trừ
 * dòng `aside`; và cộng dọc mạch chính ra đúng dòng dưới.
 */

export type OrderDetailLineInput = {
  itemsTotal: number;
  /** Voucher mức CẢ ĐƠN shop chịu (`Order.discount`). */
  discount: number;
  platformFeeEst: number;
  /** Σ giá vốn dòng — tính sẵn bằng `calcOrderCogs`. */
  cogs: number;
  items: { sku: string; productName: string; quantity: number; lineDiscount: number; costPrice: number | null }[];
  /** Chi tiết phí sàn của ĐƠN NÀY, đọc `Order.raw->'advanced_platform_fee'`. Rỗng → dòng Phí sàn không bung. */
  feeComponents: { key: string; label: string; amount: number }[];
  /** Voucher SÀN tài trợ đã kẹp — sàn trả thay khách, KHÔNG trừ vào doanh thu. */
  marketplaceFunded: number;
};

/** Mạch app tính: doanh thu → phí sàn → giá vốn → lãi đơn. */
export function buildOrderProfitLines(i: OrderDetailLineInput): PnlLineItem[] {
  const giamGiaDong = i.items.reduce((s, it) => s + it.lineDiscount, 0);
  const shopChiu = giamGiaDong + i.discount;
  const doanhThu = i.itemsTotal - i.discount;
  const thucNhan = doanhThu - i.platformFeeEst;

  const conPhiSan: PnlLineItem[] = i.feeComponents.map((c) => ({
    id: `platformFee:${c.key}`,
    label: c.label,
    value: c.amount,
    isDeduction: true,
    kind: "line",
    depth: 1,
    parentId: "platformFee",
  }));
  // Phần Pancake không trả chi tiết — hiện thành dòng riêng để Σ con luôn = cha,
  // đúng cách bảng Lãi/Lỗ làm. Đơn chưa giao xong hầu như luôn rơi vào đây.
  const conLaiPhi = i.platformFeeEst - i.feeComponents.reduce((s, c) => s + c.amount, 0);
  if (conPhiSan.length && conLaiPhi !== 0) {
    conPhiSan.push({
      id: "platformFee:chua-co-chi-tiet",
      label: conLaiPhi > 0 ? "Pancake chưa trả chi tiết" : "Chênh lệch chi tiết",
      value: conLaiPhi,
      isDeduction: true,
      kind: "line",
      depth: 1,
      parentId: "platformFee",
      warn: conLaiPhi < 0,
      hint:
        conLaiPhi > 0
          ? "Sàn chưa đối soát xong đơn này nên Pancake mới có tổng phí, chưa có từng loại. Giao xong là số chi tiết tự về."
          : "Cộng các loại phí lại đang vượt cả tổng phí sàn — dữ liệu Pancake bất thường.",
    });
  }

  return [
    {
      id: "netOfDiscount",
      label: "Doanh thu đơn",
      value: doanhThu,
      isDeduction: false,
      kind: "group",
      hint: "Tiền hàng của đơn này sau khi trừ mọi khoản shop giảm cho khách.",
    },
    {
      id: "listPrice",
      label: "Giá niêm yết",
      value: i.itemsTotal + giamGiaDong,
      isDeduction: false,
      kind: "line",
      depth: 1,
      parentId: "netOfDiscount",
      hint: "Tổng tiền hàng theo giá niêm yết, khi chưa trừ khuyến mãi nào.",
    },
    {
      id: "sellerDiscount",
      label: "Giảm giá do người bán",
      value: shopChiu,
      isDeduction: true,
      kind: "line",
      depth: 1,
      parentId: "netOfDiscount",
      note: "Tiền shop tự bỏ ra giảm cho khách — khác với phần sàn trợ giá.",
    },
    {
      id: "sellerDiscount:san-pham",
      label: "Giảm giá sản phẩm",
      value: giamGiaDong,
      isDeduction: true,
      kind: "line",
      depth: 2,
      parentId: "sellerDiscount",
    },
    {
      id: "sellerDiscount:voucher-shop",
      label: "Voucher shop tạo",
      value: i.discount,
      isDeduction: true,
      kind: "line",
      depth: 2,
      parentId: "sellerDiscount",
    },
    {
      id: "platformFunded",
      label: "Sàn trợ giá thêm",
      value: i.marketplaceFunded,
      isDeduction: false,
      kind: "line",
      depth: 1,
      parentId: "netOfDiscount",
      aside: true,
      note: "Khách được giảm thêm nhưng SÀN trả khoản này, shop vẫn thu đủ — nên nó không cộng cũng không trừ vào doanh thu.",
    },
    {
      id: "platformFee",
      label: "Phí sàn",
      value: i.platformFeeEst,
      isDeduction: true,
      kind: conPhiSan.length ? "group" : "line",
      hint: "Tiền sàn giữ lại trên đơn này: hoa hồng, phí giao dịch, phí dịch vụ, thuế sàn khấu trừ…",
    },
    ...conPhiSan,
    {
      id: "netRevenue",
      label: "Thực nhận từ sàn",
      value: thucNhan,
      isDeduction: false,
      kind: "subtotal",
      hint: "Doanh thu trừ phí sàn — tiền hàng còn lại sau khi sàn cắt phần của họ, chưa trừ giá vốn.",
    },
    {
      id: "cogs",
      label: "Giá vốn",
      value: i.cogs,
      isDeduction: true,
      kind: i.items.length ? "group" : "line",
      warn: i.items.some((it) => !it.costPrice),
      hint: "Giá vốn của hàng trong đơn = số lượng × giá vốn đang khai ở mục Sản phẩm.",
    },
    ...i.items.map((it, idx) => ({
      id: `cogs:${it.sku}:${idx}`,
      label: `${it.productName} × ${it.quantity}`,
      value: (it.costPrice ?? 0) * it.quantity,
      isDeduction: true,
      kind: "line" as const,
      depth: 1,
      parentId: "cogs",
      warn: !it.costPrice,
      hint: it.costPrice ? undefined : `SKU ${it.sku} chưa khai giá vốn nên đang tính 0 — lãi đơn đang cao hơn thực tế.`,
    })),
    {
      id: "profit",
      label: "Lãi đơn",
      value: thucNhan - i.cogs,
      isDeduction: false,
      kind: "total",
      hint: "Thực nhận từ sàn trừ giá vốn. Chưa gồm chi phí chung của shop (quảng cáo, vận chuyển, đóng gói…).",
    },
  ];
}

/**
 * Mạch ĐỐI CHIẾU: số sàn thật sự quyết toán cho đơn này.
 *
 * Đẳng thức đã chứng minh trên toàn bộ 9067 giao dịch prod (khớp tuyệt đối):
 *   settlement = doanh thu + phí&thuế + vận chuyển + điều chỉnh
 *   vận chuyển = phí thực tế + sàn chiết khấu + phí ship hoàn + sàn bù + khách trả
 *
 * Mọi số ở đây ĐÃ mang dấu sẵn từ sàn (phí là số âm) nên không dùng `isDeduction`
 * — cứ cộng thẳng là ra dòng cha.
 *
 * `thucNhanApp` để tính dòng chênh lệch: sàn trả về so với số app tính ra. Lệch
 * nhỏ là bình thường (làm tròn, đơn còn đang quyết toán); lệch lớn và dai dẳng
 * mới là dấu hiệu công thức sai.
 *
 * Truyền `null` khi đơn KHÔNG tính vào P&L (hoàn/hủy): app cố tình không tính
 * "thực nhận" cho những đơn đó, nên đem trừ là so với số không tồn tại — mọi đơn
 * hoàn/hủy sẽ đỏ rực dòng chênh bằng đúng toàn bộ giá trị đơn (đo: 73/73 đơn
 * hoàn/hủy, ca tệ nhất là một khoản âm lớn) ngay dưới dòng chữ "đơn không tính vào P&L".
 * Khi đó khối vẫn hiện đủ số sàn trả về, chỉ bỏ dòng so sánh.
 */
export function buildSettlementLines(q: QuyetToanDon, thucNhanApp: number | null): PnlLineItem[] {
  const chenh = thucNhanApp === null ? null : q.settlement - thucNhanApp;

  return [
    {
      id: "settlement",
      label: "Sàn quyết toán",
      value: q.settlement,
      isDeduction: false,
      kind: "group",
      hint:
        q.soGiaoDich > 1
          ? `Số TikTok thật sự trả về cho đơn này, cộng từ ${q.soGiaoDich} giao dịch quyết toán (sàn tách riêng mỗi lần điều chỉnh).`
          : "Số TikTok thật sự trả về cho đơn này. Đặt cạnh số app tính để đối chiếu — hai bên độc lập, không cái nào sửa cái nào.",
    },
    { id: "settlement:revenue", label: "Doanh thu", value: q.doanhThu, isDeduction: false, kind: "line", depth: 1, parentId: "settlement" },
    { id: "settlement:fee", label: "Phí & thuế", value: q.phiVaThue, isDeduction: false, kind: "line", depth: 1, parentId: "settlement" },
    {
      id: "settlement:ship",
      label: "Vận chuyển",
      value: q.shipNet,
      isDeduction: false,
      kind: "line",
      depth: 1,
      parentId: "settlement",
      hint: "Thường bằng 0 vì sàn trợ giá bù đúng bằng phí ship — bung ra sẽ thấy cả hai vế.",
    },
    { id: "settlement:ship:actual", label: "Phí vận chuyển thực tế", value: q.ve.phiThucTe, isDeduction: false, kind: "line", depth: 2, parentId: "settlement:ship" },
    { id: "settlement:ship:discount", label: "Sàn chiết khấu vận chuyển", value: q.ve.sanChietKhau, isDeduction: false, kind: "line", depth: 2, parentId: "settlement:ship" },
    { id: "settlement:ship:customer", label: "Khách trả phí vận chuyển", value: q.ve.khachTra, isDeduction: false, kind: "line", depth: 2, parentId: "settlement:ship" },
    { id: "settlement:ship:return", label: "Phí vận chuyển đơn hoàn", value: q.ve.phiShipHoan, isDeduction: false, kind: "line", depth: 2, parentId: "settlement:ship" },
    { id: "settlement:ship:reimburse", label: "Sàn bù phí đơn hoàn", value: q.ve.sanBuShipHoan, isDeduction: false, kind: "line", depth: 2, parentId: "settlement:ship" },
    { id: "settlement:adjustment", label: "Điều chỉnh", value: q.dieuChinh, isDeduction: false, kind: "line", depth: 1, parentId: "settlement" },
    ...(chenh === null || thucNhanApp === null
      ? []
      : [
          {
            id: "settlement:chenh",
            label: "Chênh với số app tính",
            value: chenh,
            isDeduction: false,
            kind: "subtotal" as const,
            warn: thucNhanApp !== 0 && Math.abs(chenh / thucNhanApp) > 0.05,
            hint: "Sàn quyết toán trừ đi 'Thực nhận từ sàn' của app. Lệch khác 0 là đáng xem — khối Đối soát ở tab Dòng tiền nêu mọi mức. Đơn CHƯA hoàn tất thì phí sàn app còn là số tạm tính nên lệch lớn là bình thường, sửa bằng cách cập nhật trạng thái đơn bên Pancake.",
          },
        ]),
  ];
}
