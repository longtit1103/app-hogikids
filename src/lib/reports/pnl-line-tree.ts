import type { PnlLineItem } from "@/lib/reports/pnl-line-items";

/**
 * Cây thu/bung của bảng P&L — tách khỏi component để logic ẩn/hiện dòng có test
 * riêng (bảng tiền mà ẩn nhầm một dòng thì người đọc cộng tay ra số khác tổng).
 *
 * Danh sách dòng là PHẲNG, quan hệ cha–con nằm ở `parentId`; cây sâu tối đa 3
 * bậc (nhóm → khoản → chi tiết khoản, vd Chi phí vận hành → Quảng cáo → Meta).
 */

/** Id của mọi dòng CÓ con — dòng mọc mũi tên thu/bung. */
export function expandableIds(items: PnlLineItem[]): Set<string> {
  return new Set(items.map((i) => i.parentId).filter((id): id is string => Boolean(id)));
}

/**
 * Các dòng con GÓP VÀO TỔNG của một dòng cha — tức bỏ dòng ghi chú (`aside`).
 *
 * Dòng `aside` nằm trong khối và trông y hệt anh em cùng bậc, nhưng nó là khoản
 * do bên khác chịu nên cộng vào là tổng vống lên. Gom quy tắc vào một chỗ để
 * không ai phải nhớ ngoại lệ này mỗi lần đụng bảng.
 */
export function summableChildren(items: PnlLineItem[], parentId: string): PnlLineItem[] {
  return items.filter((i) => i.parentId === parentId && !i.aside);
}

/**
 * Dòng còn hiện với tập `expanded` hiện tại: con chỉ hiện khi MỌI tổ tiên của nó
 * đang mở. Kiểm cả chuỗi tổ tiên chứ không chỉ cha trực tiếp — thu gọn "Chi phí
 * vận hành" mà vẫn để lọt các nguồn ads (cháu) là bảng tự mâu thuẫn.
 */
export function visiblePnlItems(items: PnlLineItem[], expanded: Set<string>): PnlLineItem[] {
  const parentOf = new Map(items.map((i) => [i.id, i.parentId]));

  return items.filter((item) => {
    let cha = item.parentId;
    while (cha) {
      if (!expanded.has(cha)) return false;
      cha = parentOf.get(cha);
    }
    return true;
  });
}
