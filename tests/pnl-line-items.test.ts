import { describe, expect, it } from "vitest";

import { calcPnlCore, type PnlBreakdown } from "@/lib/reports/pnl";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";
import { buildPnlLineItems, displayValue, isPnlMonthEmpty } from "@/lib/reports/pnl-line-items";
import { summableChildren } from "@/lib/reports/pnl-line-tree";

/**
 * Nhãn + href waterfall P&L (Phương án A — chuẩn hóa TÊN, KHÔNG đổi số).
 * "Doanh thu"→"Doanh thu gộp", "DT thuần"→"Thực nhận từ sàn"; 7 dòng chi phí
 * trỏ hub Tài chính (tab sổ chi phí) thay `/chi-phi` cũ.
 */

const EMPTY: PnlBreakdown = {
  revenue: 0,
  platformFee: 0,
  returnedOrderFee: 0,
  voucher: 0,
  netRevenue: 0,
  cogs: 0,
  grossProfit: 0,
  ads: 0,
  adsBySource: {},
  shipping: 0,
  packaging: 0,
  returnBom: 0,
  fixed: 0,
  interest: 0,
  financialIncome: 0,
  other: 0,
  netProfit: 0,
  orderCount: 0,
  returnBomOrderCount: 0,
  skuMissingCount: 0,
  skuUnknownLineCount: 0,
};

describe("buildPnlLineItems — nhãn + href", () => {
  const byId = new Map(buildPnlLineItems(EMPTY).map((i) => [i.id, i]));

  it("nhãn chuẩn hóa Phương án A", () => {
    expect(byId.get("revenue")?.label).toBe("Doanh thu gộp");
    expect(byId.get("netRevenue")?.label).toBe("Thực nhận từ sàn");
  });

  it("7 dòng chi phí trỏ /tai-chinh?tab=so-chi-phi (không còn /chi-phi)", () => {
    for (const id of ["ads", "shipping", "packaging", "returnBom", "fixed", "interest", "other"]) {
      expect(byId.get(id)?.href).toContain("/tai-chinh?tab=so-chi-phi");
    }
  });

  it("COGS vẫn trỏ báo cáo sản phẩm; doanh thu gộp trỏ đơn hàng", () => {
    expect(byId.get("cogs")?.href).toBe("/bao-cao?tab=san-pham");
    expect(byId.get("revenue")?.href).toBe("/don-hang");
  });

  it("Lãi vay nằm giữa Mặt bằng và Khác, nhãn đúng", () => {
    const ids = buildPnlLineItems(EMPTY).filter((i) => i.parentId === "opex").map((i) => i.id);
    expect(ids.indexOf("interest")).toBe(ids.indexOf("fixed") + 1);
    expect(ids.indexOf("other")).toBe(ids.indexOf("interest") + 1);
    expect(byId.get("interest")?.label).toBe("Lãi vay");
  });

  it("tháng chỉ có lãi vay KHÔNG phải tháng trống", () => {
    // `isPnlMonthEmpty` là cổng render riêng với `hasData` ở /tai-chinh — quên một trong hai
    // là tháng không có đơn nhưng có lãi vay hiện empty card, "Lãi vay" tàng hình.
    expect(isPnlMonthEmpty({ ...EMPTY, interest: 5_000_000 })).toBe(false);
  });
});

describe("pnlPercentBase — mẫu số DUY NHẤT cho mọi '% / doanh thu' toàn app", () => {
  it("= doanh thu đã trừ voucher, ở MỌI nơi (bảng P&L, Excel, KPI, Xu hướng, so kênh)", () => {
    // Quyết định chủ shop 2026-08-07: một mẫu số duy nhất — không còn nơi chia doanh thu gộp
    // nơi chia doanh thu đã trừ voucher rồi cùng dán nhãn "Biên ròng".
    expect(pnlPercentBase({ ...EMPTY, revenue: 100, voucher: 30 })).toBe(70);
    expect(pnlPercentBase({ ...EMPTY, revenue: 100 })).toBe(100); // không voucher thì bằng doanh thu
  });

  it("voucher vượt doanh thu (dữ liệu dị) → 0 để cột % trống, không đảo dấu cả cột", () => {
    expect(pnlPercentBase({ ...EMPTY, revenue: 100, voucher: 150 })).toBe(0);
  });
});

describe("displayValue", () => {
  it("khoản trừ đổi dấu âm", () => {
    expect(displayValue({ value: 1_000, isDeduction: true })).toBe(-1_000);
  });

  it("khoản trừ bằng 0 KHÔNG ra −0 (cột % sẽ hiện '-0%')", () => {
    expect(Object.is(displayValue({ value: 0, isDeduction: true }), 0)).toBe(true);
  });
});

describe("buildPnlLineItems — dòng Phí sàn đơn hoàn/hủy (returnedOrderFee)", () => {
  it("có dòng returnedOrderFee (LUÔN hiện, là dòng trừ, drill sang đơn hoàn/hủy)", () => {
    const items = buildPnlLineItems({ ...EMPTY, returnedOrderFee: 1_620 });
    const line = items.find((i) => i.id === "returnedOrderFee");
    expect(line).toBeDefined();
    expect(line!.isDeduction).toBe(true);
    expect(line!.value).toBe(1_620);
    expect(line!.href).toContain("/don-hang?trang_thai=");
  });

  it("returnedOrderFee=0 vẫn hiện dòng (luôn hiện)", () => {
    const items = buildPnlLineItems({ ...EMPTY, returnedOrderFee: 0 });
    expect(items.some((i) => i.id === "returnedOrderFee")).toBe(true);
  });
});

/**
 * Dòng con "Phí sàn" — chỉ DIỄN GIẢI tổng của pnl.ts, không được đổi số. Cam kết
 * sống còn: Σ dòng con = dòng cha ở MỌI trường hợp, kể cả khi Pancake trả thiếu
 * chi tiết (7/303 đơn TikTok đo trên prod) hoặc trả dư — nếu không, chủ shop cộng
 * tay các dòng con sẽ ra số khác tổng và mất niềm tin vào cả bảng.
 */
describe("buildPnlLineItems — chi tiết phí sàn (dòng con)", () => {
  const B: PnlBreakdown = { ...EMPTY, revenue: 1_000_000, platformFee: 100_000 };
  const conCuaPhiSan = (items: ReturnType<typeof buildPnlLineItems>) =>
    items.filter((i) => i.parentId === "platformFee");

  it("không truyền chi tiết → bảng y như cũ (không dòng con nào)", () => {
    expect(conCuaPhiSan(buildPnlLineItems(B))).toHaveLength(0);
  });

  it("Σ dòng con = dòng cha khi chi tiết khớp đủ", () => {
    const items = buildPnlLineItems(B, [
      { key: "platform_commission", label: "Hoa hồng nền tảng", amount: 60_000 },
      { key: "payment_fee", label: "Phí giao dịch", amount: 40_000 },
    ]);
    const con = conCuaPhiSan(items);
    expect(con).toHaveLength(2); // không đẻ thêm dòng chênh
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(B.platformFee);
  });

  it("Pancake trả thiếu chi tiết → dòng 'Pancake chưa trả chi tiết' gánh phần còn lại", () => {
    const items = buildPnlLineItems(B, [
      { key: "platform_commission", label: "Hoa hồng nền tảng", amount: 70_000 },
    ]);
    const con = conCuaPhiSan(items);
    const conLai = con.find((i) => i.id === "platformFee:chua-co-chi-tiet");
    expect(conLai?.label).toBe("Pancake chưa trả chi tiết");
    expect(conLai?.value).toBe(30_000);
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(B.platformFee);
  });

  /**
   * Phần chưa chia được tách theo NGUYÊN NHÂN: đơn bù thì vĩnh viễn không có chi
   * tiết (app tự ước phí), còn đơn Pancake trả rỗng thì tự đầy khi đơn giao xong.
   * Gộp chung là đọc sai bản chất — và ngược lại, tách sai thì Σ con lệch cha.
   */
  it("có đơn bù → tách 2 dòng, Σ vẫn = tổng phí sàn", () => {
    const items = buildPnlLineItems(
      B,
      [{ key: "platform_commission", label: "Hoa hồng nền tảng", amount: 70_000 }],
      undefined,
      20_000
    );
    const con = conCuaPhiSan(items);
    expect(con.find((i) => i.id === "platformFee:don-bu")?.value).toBe(20_000);
    expect(con.find((i) => i.id === "platformFee:chua-co-chi-tiet")?.value).toBe(10_000);
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(B.platformFee);
  });

  it("components RỖNG nhưng có đơn bù → vẫn tách dòng 'Đơn bù', không nuốt caveat", () => {
    // Kỳ mà TOÀN BỘ phí là của đơn bù (không kênh nào có chi tiết thật): guard "components rỗng
    // thì thôi" cũ nuốt luôn nhánh đơn bù — 100% phí ước tính bị trình bày y như phí thật, mất
    // caveat ở cả màn hình lẫn Excel.
    const items = buildPnlLineItems(B, [], undefined, 100_000);
    const con = conCuaPhiSan(items);
    expect(con.find((i) => i.id === "platformFee:don-bu")?.value).toBe(100_000);
    expect(con.some((i) => i.id === "platformFee:chua-co-chi-tiet")).toBe(false); // không đẻ dòng rỗng
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(B.platformFee);
  });

  it("components rỗng + đơn bù chỉ MỘT PHẦN phí → phần còn lại vẫn là 'Pancake chưa trả'", () => {
    const items = buildPnlLineItems(B, [], undefined, 60_000);
    const con = conCuaPhiSan(items);
    expect(con.find((i) => i.id === "platformFee:don-bu")?.value).toBe(60_000);
    expect(con.find((i) => i.id === "platformFee:chua-co-chi-tiet")?.value).toBe(40_000);
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(B.platformFee);
  });

  it("đơn bù gánh TRỌN phần chưa chia được → không đẻ dòng rỗng", () => {
    const items = buildPnlLineItems(
      B,
      [{ key: "platform_commission", label: "Hoa hồng nền tảng", amount: 70_000 }],
      undefined,
      30_000
    );
    const con = conCuaPhiSan(items);
    expect(con.some((i) => i.id === "platformFee:chua-co-chi-tiet")).toBe(false);
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(B.platformFee);
  });

  it("phí đơn bù vượt phần chưa chia được (dữ liệu lạ) → kẹp lại, KHÔNG ra dòng âm", () => {
    const items = buildPnlLineItems(
      B,
      [{ key: "platform_commission", label: "Hoa hồng nền tảng", amount: 70_000 }],
      undefined,
      999_999
    );
    const con = conCuaPhiSan(items);
    expect(con.every((i) => i.value >= 0)).toBe(true);
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(B.platformFee);
  });

  /**
   * Kẹp giữ được "Σ con = cha" nhưng bản thân việc PHẢI kẹp là dấu hiệu dữ liệu
   * lạ. Kẹp mà im lặng thì bảng vẫn cộng đúng trong khi đang giấu chỗ hỏng — đúng
   * kiểu lỗi không ai phát hiện cho tới lúc đối soát tiền.
   */
  it("bị kẹp thì phải GẮN CỜ cảnh báo, không nuốt im lặng", () => {
    const items = buildPnlLineItems(
      B,
      [{ key: "platform_commission", label: "Hoa hồng nền tảng", amount: 70_000 }],
      undefined,
      999_999
    );
    const donBu = conCuaPhiSan(items).find((i) => i.id === "platformFee:don-bu")!;
    expect(donBu.warn).toBe(true);
    expect(donBu.note).toContain("999.999");
  });

  it("không bị kẹp thì KHÔNG cảnh báo (tránh cờ đỏ kêu suốt)", () => {
    const items = buildPnlLineItems(
      B,
      [{ key: "platform_commission", label: "Hoa hồng nền tảng", amount: 70_000 }],
      undefined,
      20_000
    );
    expect(conCuaPhiSan(items).find((i) => i.id === "platformFee:don-bu")!.warn).toBeFalsy();
  });

  it("không có chi tiết nào → Phí sàn vẫn là dòng thường, không mọc mũi tên rỗng", () => {
    const item = buildPnlLineItems(B).find((i) => i.id === "platformFee")!;
    expect(item.kind).toBe("line");
    expect(buildPnlLineItems(B, [{ key: "payment_fee", label: "Phí giao dịch", amount: 100_000 }]).find(
      (i) => i.id === "platformFee"
    )!.kind).toBe("group");
  });

  it("không có đơn bù → chỉ một dòng như trước, không đẻ dòng 'Đơn bù' rỗng", () => {
    const con = conCuaPhiSan(
      buildPnlLineItems(B, [{ key: "platform_commission", label: "Hoa hồng nền tảng", amount: 70_000 }])
    );
    expect(con.some((i) => i.id === "platformFee:don-bu")).toBe(false);
  });

  it("chi tiết vượt tổng → vẫn khớp tổng, kèm cờ cảnh báo", () => {
    const items = buildPnlLineItems(B, [
      { key: "platform_commission", label: "Hoa hồng nền tảng", amount: 130_000 },
    ]);
    const con = conCuaPhiSan(items);
    const lech = con.find((i) => i.id === "platformFee:chua-co-chi-tiet");
    expect(lech?.label).toBe("Chênh lệch chi tiết");
    expect(lech?.warn).toBe(true);
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(B.platformFee);
  });

  it("dòng con là khoản TRỪ, thụt lề, và nằm ngay sau dòng cha", () => {
    const items = buildPnlLineItems(B, [
      { key: "platform_commission", label: "Hoa hồng nền tảng", amount: 100_000 },
    ]);
    const viTriCha = items.findIndex((i) => i.id === "platformFee");
    expect(items[viTriCha].kind).toBe("group"); // có con ⇒ là nhóm bung được
    expect(items[viTriCha + 1].parentId).toBe("platformFee");
    for (const c of conCuaPhiSan(items)) {
      expect(c.isDeduction).toBe(true);
      expect(c.depth).toBe(1);
    }
  });

  it("dòng con Quảng cáo cũng khai parentId (bung/thu cùng cơ chế)", () => {
    const items = buildPnlLineItems({ ...B, ads: 50_000, adsBySource: { META: 50_000 } });
    const con = items.filter((i) => i.parentId === "ads");
    expect(con).toHaveLength(1);
    expect(con[0].value).toBe(50_000);
    expect(con[0].depth).toBe(2); // cháu của nhóm "Chi phí vận hành"
  });
});

/**
 * Nhóm "Chi phí vận hành" gom mọi khoản giữa LÃI GỘP và LÃI RÒNG. Rủi ro thật
 * của nhóm này: mai kia `pnl.ts` thêm một khoản trừ vào `netProfit` mà quên khai
 * dòng con ở đây — dòng tổng vẫn đúng (lấy theo hiệu) nhưng Σ con thì hụt, chủ
 * shop bung ra cộng tay lại ra số khác. Test dưới canh đúng chỗ đó.
 */
/**
 * Dòng "Thu nhập tài chính" — khoản CỘNG duy nhất trên mạch chính ngoài doanh thu bán hàng.
 * Vị trí (sau LN gộp, trước nhóm Chi phí vận hành) là điều kiện để cộng tay dọc cột ra đúng:
 *   LN gộp + Thu nhập tài chính − Chi phí vận hành = LN ròng.
 */
describe("buildPnlLineItems — dòng Thu nhập tài chính", () => {
  const B: PnlBreakdown = {
    ...EMPTY,
    revenue: 30_000_000,
    netRevenue: 25_000_000,
    cogs: 15_000_000,
    grossProfit: 10_000_000,
    financialIncome: 2_000_000,
    netProfit: 12_000_000, // không chi phí vận hành nào trong kỳ
  };

  it("đứng NGAY SAU LN gộp và TRƯỚC nhóm Chi phí vận hành", () => {
    const ids = buildPnlLineItems(B).map((i) => i.id);
    expect(ids.indexOf("financialIncome")).toBe(ids.indexOf("grossProfit") + 1);
    expect(ids.indexOf("opex")).toBe(ids.indexOf("financialIncome") + 1);
  });

  it("là khoản CỘNG (không mang dấu trừ), nằm trên mạch chính, drill về khối Sổ tiết kiệm", () => {
    const line = buildPnlLineItems(B).find((i) => i.id === "financialIncome")!;
    expect(line.label).toBe("Thu nhập tài chính");
    expect(line.value).toBe(2_000_000);
    expect(line.isDeduction).toBe(false);
    expect(line.parentId).toBeUndefined(); // không phải con của nhóm nào
    expect(line.href).toBe("/tai-chinh?tab=dong-tien#tiet-kiem");
    expect(displayValue(line)).toBe(2_000_000); // KHÔNG đổi dấu
  });

  it("hint nói rõ lãi ghi TRỌN vào tháng tất toán, không chia đều các tháng", () => {
    const line = buildPnlLineItems(B).find((i) => i.id === "financialIncome")!;
    expect(line.hint).toContain("tất toán");
    expect(line.hint).toMatch(/không chia đều/i);
  });

  it("LUÔN hiện kể cả bằng 0 — mạch chính không đổi hình theo tháng", () => {
    expect(buildPnlLineItems(EMPTY).some((i) => i.id === "financialIncome")).toBe(true);
  });

  it("dòng LN ròng mang chú thích 'có gồm thu nhập tài chính' khi khoản này > 0", () => {
    const ln = buildPnlLineItems(B).find((i) => i.id === "netProfit")!;
    expect(ln.hint).toContain("thu nhập tài chính");
    expect(ln.hint).toContain("2.000.000");
  });

  it("thu nhập = 0 thì LN ròng KHÔNG mọc chú thích thừa", () => {
    const ln = buildPnlLineItems(EMPTY).find((i) => i.id === "netProfit")!;
    expect(ln.hint).not.toContain("thu nhập tài chính");
  });

  it("tháng chỉ có thu nhập tài chính KHÔNG phải tháng trống", () => {
    // Cổng render riêng với `hasData` ở /tai-chinh: quên field này là tháng tất toán sổ mà không
    // có đơn nào sẽ hiện empty card, dòng "Thu nhập tài chính" tàng hình.
    expect(isPnlMonthEmpty({ ...EMPTY, financialIncome: 2_000_000 })).toBe(false);
    expect(isPnlMonthEmpty(EMPTY)).toBe(true);
  });
});

describe("buildPnlLineItems — nhóm Chi phí vận hành", () => {
  const B: PnlBreakdown = {
    ...EMPTY,
    revenue: 50_000_000,
    grossProfit: 20_000_000,
    // Thu nhập tài chính ≠ 0 là ĐIỀU KIỆN SỐNG CÒN của khối test này: để 0 thì công thức sai
    // (`grossProfit − netProfit`) và công thức đúng (`grossProfit + financialIncome − netProfit`)
    // cho CÙNG một số, mọi ca dưới đây thành lưới rỗng.
    financialIncome: 2_000_000,
    ads: 5_000_000,
    adsBySource: { META: 3_000_000, TIKTOK_ADS: 2_000_000 },
    shipping: 1_200_000,
    packaging: 300_000,
    returnBom: 100_000,
    returnedOrderFee: 400_000,
    fixed: 2_000_000,
    other: 500_000,
    // 20.000.000 + 2.000.000 − 9.500.000 (Σ 8 khoản con) = 12.500.000 — fixture TỰ NHẤT QUÁN với
    // định nghĩa netProfit của pnl.ts, nếu không hai ca dưới mâu thuẫn nhau.
    netProfit: 12_500_000,
  };

  it("dòng tổng = Σ dòng con trực tiếp", () => {
    const items = buildPnlLineItems(B);
    const nhom = items.find((i) => i.id === "opex")!;
    const con = items.filter((i) => i.parentId === "opex");
    expect(nhom.kind).toBe("group");
    expect(nhom.isDeduction).toBe(true);
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(nhom.value);
  });

  it("dòng tổng = LN gộp + Thu nhập tài chính − LN ròng (đúng định nghĩa netProfit của pnl.ts)", () => {
    const nhom = buildPnlLineItems(B).find((i) => i.id === "opex")!;
    expect(nhom.value).toBe(B.grossProfit + B.financialIncome - B.netProfit);
    // Non-vacuity: công thức CŨ (`grossProfit − netProfit`) phải cho số KHÁC, nếu không ca này
    // không chứng minh được gì.
    expect(nhom.value).not.toBe(B.grossProfit - B.netProfit);
  });

  it("gom đủ 8 khoản, không bỏ sót khoản nào của netProfit", () => {
    const con = buildPnlLineItems(B)
      .filter((i) => i.parentId === "opex")
      .map((i) => i.id);
    expect(con).toEqual([
      "ads",
      "shipping",
      "packaging",
      "returnBom",
      "returnedOrderFee",
      "fixed",
      "interest",
      "other",
    ]);
  });

  /**
   * Các test trên dùng `PnlBreakdown` VIẾT TAY nên tự nhất quán: `netProfit` do
   * chính fixture khai, thêm một khoản trừ thứ 8 vào `calcPnlCore` thì fixture
   * không biết mà bảng thật thì lệch — test vẫn xanh (đúng bẫy parity của PR #71).
   *
   * Test này đi qua `calcPnlCore` THẬT: khoản trừ mới nào vào `netProfit` mà quên
   * khai dòng con ở `buildOpexGroup` sẽ làm Σ con ≠ dòng nhóm ngay tại đây.
   */
  it("qua calcPnlCore THẬT: Σ dòng con = dòng nhóm (bắt được khoản trừ mới quên khai)", () => {
    const b = calcPnlCore(
      [
        {
          status: "COMPLETED",
          channelId: "tiktok",
          itemsTotal: 5_000_000,
          discount: 100_000,
          platformFeeEst: 500_000,
          items: [{ sku: "SKU-1", quantity: 2, costPrice: 300_000 }],
        },
        {
          status: "RETURNED",
          channelId: "tiktok",
          itemsTotal: 900_000,
          discount: 0,
          platformFeeEst: 90_000,
          returnedFee: 45_000,
          items: [],
        },
      ],
      [
        { categoryId: "ads", adsSource: "META", channelId: null, amount: 700_000 },
        { categoryId: "shipping", adsSource: null, channelId: null, amount: 120_000 },
        { categoryId: "packaging", adsSource: null, channelId: null, amount: 80_000 },
        { categoryId: "return_bom", adsSource: null, channelId: null, amount: 60_000 },
        { categoryId: "fixed", adsSource: null, channelId: null, amount: 2_000_000 },
        { categoryId: "interest", adsSource: null, channelId: null, amount: 300_000 },
        { categoryId: "other", adsSource: null, channelId: null, amount: 40_000 },
        // "Nhập hàng" là dòng tiền, KHÔNG bao giờ vào P&L — nếu lọt sẽ làm lệch ngay.
        { categoryId: "purchase", adsSource: null, channelId: null, amount: 9_000_000 },
      ],
      // Thu nhập tài chính đi qua LÕI THẬT — ca này là chỗ duy nhất trong file chứng minh dòng nhóm
      // vẫn khớp Σ con khi `netProfit` có vế cộng, chứ không phải fixture tự khai số.
      { incomes: [{ amount: 3_000_000 }] }
    );

    const items = buildPnlLineItems(b);
    const nhom = items.find((i) => i.id === "opex")!;
    expect(summableChildren(items, "opex").reduce((s, i) => s + i.value, 0)).toBe(nhom.value);
    expect(nhom.value).toBe(b.grossProfit + b.financialIncome - b.netProfit);
    expect(b.financialIncome).toBe(3_000_000); // non-vacuity: lõi thật sự nhận thu nhập
    // Non-vacuity: kỳ này thật sự có chi phí, không phải so 0 với 0.
    expect(nhom.value).toBeGreaterThan(0);
  });

  it("nguồn ads là CHÁU (con của Quảng cáo), không cộng thẳng vào nhóm", () => {
    const items = buildPnlLineItems(B);
    const con = items.filter((i) => i.parentId === "opex");
    expect(con.some((i) => i.id.startsWith("ads:"))).toBe(false);
    expect(items.filter((i) => i.parentId === "ads")).toHaveLength(2);
  });
});

/**
 * Mạch chính (các dòng không phải con) phải cộng trừ ra đúng dòng dưới. Đây là
 * điều chủ shop làm đầu tiên khi mở bảng: lấy bút cộng theo cột.
 */
describe("buildPnlLineItems — mạch chính cộng dọc", () => {
  const B: PnlBreakdown = {
    ...EMPTY,
    revenue: 59_077_432,
    voucher: 7_902,
    platformFee: 14_792_857,
    netRevenue: 44_276_673,
    cogs: 20_000_000,
    grossProfit: 24_276_673,
    // ≠ 0 bắt buộc: để 0 thì ca cộng dọc dưới đây không phân biệt được công thức cũ với mới.
    financialIncome: 1_000_000,
    ads: 5_000_000,
    adsBySource: { META: 5_000_000 },
    fixed: 2_000_000,
    // 24.276.673 + 1.000.000 − 7.000.000 (ads + fixed) = 18.276.673
    netProfit: 18_276_673,
  };
  const V = { shopLineLevel: 14_223_568, marketplaceFunded: 3_835_735 };

  it("8 dòng mạch chính, đúng thứ tự đọc", () => {
    const ids = buildPnlLineItems(B, [], V)
      .filter((i) => !i.parentId && i.id !== "platformFunded")
      .map((i) => i.id);
    expect(ids).toEqual([
      "netOfDiscount",
      "platformFee",
      "netRevenue",
      "cogs",
      "grossProfit",
      "financialIncome",
      "opex",
      "netProfit",
    ]);
  });

  it("cộng tay theo cột: Doanh thu − Phí sàn − COGS − Chi phí vận hành = LN ròng", () => {
    const m = new Map(buildPnlLineItems(B, [], V).map((i) => [i.id, i]));
    const v = (id: string) => m.get(id)!.value;
    expect(v("netOfDiscount") - v("platformFee")).toBe(v("netRevenue"));
    expect(v("netRevenue") - v("cogs")).toBe(v("grossProfit"));
    expect(v("grossProfit") + v("financialIncome") - v("opex")).toBe(v("netProfit"));
    // Non-vacuity: chặng cuối theo công thức CŨ phải SAI, nếu không ca này khoá nhầm công thức.
    expect(v("grossProfit") - v("opex")).not.toBe(v("netProfit"));
  });
});

/**
 * Mạch giảm giá đứng trước "Doanh thu gộp". Chốt quan trọng nhất: cộng trừ trên
 * MÀN phải ra đúng — Giá niêm yết − Giảm giá sản phẩm = Doanh thu gộp, rồi trừ
 * tiếp Voucher (Shop tài trợ) và Phí sàn ra Thực nhận từ sàn. Chủ shop cộng tay
 * mà lệch là mất niềm tin vào cả bảng.
 *
 * Và "Voucher (Sàn tài trợ)" KHÔNG được là khoản trừ — sàn trả thay khách nên
 * trừ nó lần nữa là bóp lãi hiển thị xuống oan.
 */
describe("buildPnlLineItems — mạch giảm giá đầu bảng", () => {
  const B: PnlBreakdown = {
    ...EMPTY,
    revenue: 59_077_432,
    voucher: 7_902,
    platformFee: 14_792_857,
    netRevenue: 44_276_673,
  };
  const V = { shopLineLevel: 14_223_568, marketplaceFunded: 3_835_735 };
  const byId = (items: ReturnType<typeof buildPnlLineItems>) => new Map(items.map((i) => [i.id, i]));

  it("không truyền chi tiết → giữ nguyên hai dòng cũ", () => {
    const ids = buildPnlLineItems(B).map((i) => i.id);
    expect(ids.slice(0, 2)).toEqual(["revenue", "voucher"]);
    expect(ids).not.toContain("listPrice");
  });

  it("Giá niêm yết − Giảm giá do người bán = Doanh thu", () => {
    const m = byId(buildPnlLineItems(B, [], V));
    expect(m.get("listPrice")!.value).toBe(73_301_000);
    expect(m.get("sellerDiscount")!.value).toBe(14_231_470);
    expect(m.get("netOfDiscount")!.value).toBe(59_069_530);
    expect(m.get("listPrice")!.value - m.get("sellerDiscount")!.value).toBe(m.get("netOfDiscount")!.value);
  });

  it("Doanh thu − Phí sàn = Thực nhận từ sàn (chặng thứ hai cũng khớp)", () => {
    const m = byId(buildPnlLineItems(B, [], V));
    expect(m.get("netOfDiscount")!.value - m.get("platformFee")!.value).toBe(B.netRevenue);
  });

  it("Giảm giá do người bán = giảm giá sản phẩm + voucher shop tạo", () => {
    const m = byId(buildPnlLineItems(B, [], V));
    expect(m.get("sellerDiscount:san-pham")!.value).toBe(14_223_568);
    expect(m.get("sellerDiscount:voucher-shop")!.value).toBe(7_902);
    expect(m.get("sellerDiscount:san-pham")!.value + m.get("sellerDiscount:voucher-shop")!.value).toBe(
      m.get("sellerDiscount")!.value
    );
  });

  it("Sàn trợ giá đứng SAU dòng Doanh thu và không mang dấu — cộng tay không lệch", () => {
    const items = buildPnlLineItems(B, [], V);
    const san = byId(items).get("platformFunded")!;
    expect(san.value).toBe(3_835_735);
    expect(san.isDeduction).toBe(false); // không phải khoản trừ
    // `aside` = cờ để lớp hiển thị đánh dấu "dòng này đứng ngoài mọi phép tính";
    // thiếu nó thì trên màn nó trông y hệt một khoản con của nhóm Doanh thu.
    expect(san.aside).toBe(true);
    expect(san.note).toBeTruthy();
    // Phải nằm SAU kết quả: xen vào giữa mạch −/= thì người đọc cộng theo cột ra thừa đúng số này.
    const viTriSan = items.findIndex((i) => i.id === "platformFunded");
    const viTriDoanhThu = items.findIndex((i) => i.id === "netOfDiscount");
    expect(viTriSan).toBeGreaterThan(viTriDoanhThu);
  });

  it("dòng tổng đứng TRƯỚC, chi tiết bung ra ở dưới", () => {
    const ids = buildPnlLineItems(B, [], V)
      .slice(0, 6)
      .map((i) => i.id);
    expect(ids).toEqual([
      "netOfDiscount",
      "listPrice",
      "sellerDiscount",
      "sellerDiscount:san-pham",
      "sellerDiscount:voucher-shop",
      "platformFunded",
    ]);
  });

  it("Sàn trợ giá nằm trong nhóm Doanh thu nhưng KHÔNG cộng vào tổng nhóm", () => {
    const items = buildPnlLineItems(B, [], V);
    const san = items.find((i) => i.id === "platformFunded")!;
    // Thu/bung cùng nhóm và trông y hệt anh em cùng bậc…
    expect(san.parentId).toBe("netOfDiscount");
    // …nhưng bị loại khỏi phép cộng, nếu không tổng nhóm vống lên đúng khoản sàn chịu.
    expect(san.aside).toBe(true);
    const tongCon = summableChildren(items, "netOfDiscount").reduce(
      (s, i) => s + (i.isDeduction ? -i.value : i.value),
      0
    );
    expect(tongCon).toBe(items.find((i) => i.id === "netOfDiscount")!.value);
  });

  it("không còn dòng 'Doanh thu gộp'/'Voucher' cũ khi đã có mạch mới (tránh hai chỗ cùng nghĩa)", () => {
    const ids = buildPnlLineItems(B, [], V).map((i) => i.id);
    expect(ids).not.toContain("revenue");
    expect(ids).not.toContain("voucher");
  });

  it("kỳ không giảm giá gì → mạch vẫn đúng, các dòng bằng 0", () => {
    const m = byId(buildPnlLineItems({ ...B, voucher: 0 }, [], { shopLineLevel: 0, marketplaceFunded: 0 }));
    expect(m.get("listPrice")!.value).toBe(B.revenue);
    expect(m.get("sellerDiscount")!.value).toBe(0);
    expect(m.get("netOfDiscount")!.value).toBe(B.revenue);
  });
});
