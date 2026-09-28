import { describe, expect, it } from "vitest";

import type { PnlLineItem } from "@/lib/reports/pnl-line-items";
import { expandableIds, summableChildren, visiblePnlItems } from "@/lib/reports/pnl-line-tree";

/**
 * Thu/bung cây P&L. Rủi ro thật: thu gọn dòng cha mà CHÁU vẫn hiện — bảng khi đó
 * có dòng thụt lề mồ côi, cộng theo cột ra số vô nghĩa.
 */

const line = (id: string, parentId?: string, depth?: number): PnlLineItem => ({
  id,
  label: id,
  value: 0,
  isDeduction: false,
  kind: "line",
  ...(parentId ? { parentId } : {}),
  ...(depth ? { depth } : {}),
});

const ITEMS: PnlLineItem[] = [
  { ...line("opex"), kind: "group" },
  line("ads", "opex", 1),
  line("ads:META", "ads", 2),
  line("ads:TIKTOK", "ads", 2),
  line("fixed", "opex", 1),
  line("netProfit"),
];

describe("expandableIds", () => {
  it("chỉ dòng CÓ con mới mọc mũi tên", () => {
    expect(expandableIds(ITEMS)).toEqual(new Set(["opex", "ads"]));
  });

  it("bảng phẳng (không dòng con) → không mũi tên nào", () => {
    expect(expandableIds([line("a"), line("b")]).size).toBe(0);
  });
});

describe("summableChildren", () => {
  const VOI_GHI_CHU: PnlLineItem[] = [
    { ...line("nhom"), kind: "group", value: 100 },
    { ...line("con-1", "nhom", 1), value: 70 },
    { ...line("con-2", "nhom", 1), value: 30 },
    // Dòng ghi chú: nằm trong nhóm, trông y hệt anh em, nhưng do bên khác chịu.
    { ...line("ghi-chu", "nhom", 1), value: 55, aside: true },
  ];

  it("bỏ dòng ghi chú ra khỏi phép cộng — nếu không tổng nhóm vống lên", () => {
    const tong = summableChildren(VOI_GHI_CHU, "nhom").reduce((s, i) => s + i.value, 0);
    expect(tong).toBe(100);
    expect(summableChildren(VOI_GHI_CHU, "nhom").map((i) => i.id)).toEqual(["con-1", "con-2"]);
  });

  it("chỉ lấy con TRỰC TIẾP, không lấy cháu", () => {
    expect(summableChildren(ITEMS, "opex").map((i) => i.id)).toEqual(["ads", "fixed"]);
  });

  it("cha không có con → mảng rỗng", () => {
    expect(summableChildren(ITEMS, "netProfit")).toEqual([]);
  });
});

describe("visiblePnlItems", () => {
  it("bung hết → hiện đủ mọi dòng", () => {
    expect(visiblePnlItems(ITEMS, new Set(["opex", "ads"])).map((i) => i.id)).toEqual(ITEMS.map((i) => i.id));
  });

  it("thu gọn cha → GIẤU CẢ CHÁU, không để lại dòng mồ côi", () => {
    const hien = visiblePnlItems(ITEMS, new Set(["ads"])).map((i) => i.id);
    expect(hien).toEqual(["opex", "netProfit"]);
  });

  it("thu gọn cấp giữa → cha vẫn hiện, cháu thì không", () => {
    const hien = visiblePnlItems(ITEMS, new Set(["opex"])).map((i) => i.id);
    expect(hien).toEqual(["opex", "ads", "fixed", "netProfit"]);
  });

  it("thu gọn tất cả → còn đúng mạch chính", () => {
    expect(visiblePnlItems(ITEMS, new Set()).map((i) => i.id)).toEqual(["opex", "netProfit"]);
  });
});
