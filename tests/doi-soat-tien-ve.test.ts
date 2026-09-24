import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { CUA_SO_CHO_QUYET_TOAN_NGAY, doiSoatTienVe } from "@/lib/reports/doi-soat-tien-ve";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Đối soát tiền về cấp đơn (`hogikids_test`).
 *
 * Lưới này phải chứng minh nó BẮT ĐƯỢC đơn lệch chứ không chỉ đếm không lỗi:
 * cái nó canh là "P&L ghi doanh thu mà tiền không bao giờ về" — đo prod
 * 2026-08-18 thấy 7 đơn như vậy, Σ −1.140.163đ, im lặng suốt 4 tháng.
 *
 * Ba ca then chốt được ép riêng: khử trùng giao dịch bắn lại (cộng nhầm là số
 * sàn phồng lên mà nhìn vẫn hợp lý), cửa sổ chờ quyết toán (đơn mới không được
 * nhuộm đỏ), và đơn hoàn/hủy (app không tính "thực nhận" nên không được so).
 */

const RANGE = { from: new Date("2026-01-01T00:00:00+07:00"), to: new Date("2026-12-31T00:00:00+07:00") };

/** Cũ hơn cửa sổ chờ ⇒ đã tới lúc kết luận được. */
const DA_QUA_CUA_SO = new Date(Date.now() - (CUA_SO_CHO_QUYET_TOAN_NGAY + 10) * 86_400_000);
/** Mới hơn cửa sổ chờ ⇒ chưa kết luận. */
const CON_TRONG_CUA_SO = new Date(Date.now() - 3 * 86_400_000);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  // Suite đọc thẳng Bronze — `truncateBusinessTables` cố ý không đụng kho thô.
  await prisma.rawTiktokShopTransaction.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function taoDon(opts: {
  pancakeId: string;
  code: string;
  status: string;
  itemsTotal: number;
  discount?: number;
  platformFeeEst?: number;
  orderedAt?: Date;
  /**
   * Mốc đơn VÀO trạng thái hiện tại. CỐ Ý không phải đồng hồ của phép đảo — đồng hồ
   * neo `orderedAt`, vì mốc này bị đẩy lùi mỗi lượt sửa Pancake. Giữ trong helper để
   * dựng được ca "đơn cũ vừa sửa trạng thái hôm nay".
   */
  statusChangedAt?: Date;
  channelId?: string;
}): Promise<void> {
  await prisma.order.create({
    data: {
      pancakeId: opts.pancakeId,
      code: opts.code,
      channelId: opts.channelId ?? "tiktok",
      status: opts.status as never,
      orderedAt: opts.orderedAt ?? DA_QUA_CUA_SO,
      statusChangedAt: opts.statusChangedAt ?? null,
      syncedAt: new Date(),
      itemsTotal: opts.itemsTotal,
      discount: opts.discount ?? 0,
      platformFeeEst: opts.platformFeeEst ?? 0,
    },
  });
}

/** Một giao dịch quyết toán TikTok trong kho thô. */
async function taoGiaoDich(opts: {
  orderId: string;
  externalId: string;
  settlement: number;
  /** revenue_amount sàn ghi nhận. Mặc định = settlement (đơn thường). */
  revenue?: number;
  fetchedAt?: Date;
  type?: string | null;
}): Promise<void> {
  await prisma.rawTiktokShopTransaction.create({
    data: {
      shopId: "100975192",
      externalId: opts.externalId,
      payloadHash: `h-${opts.externalId}-${opts.settlement}`,
      fetchedAt: opts.fetchedAt ?? new Date(),
      payload: {
        id: opts.externalId,
        order_id: opts.orderId,
        settlement_amount: String(opts.settlement),
        revenue_amount: String(opts.revenue ?? opts.settlement),
        ...(opts.type === null ? {} : { type: opts.type ?? "ORDER" }),
      },
    },
  });
}

describe("doiSoatTienVe — đối soát tiền về cấp đơn (TikTok)", () => {
  it("khớp từng đồng thì vào ô Khớp, không sinh dòng lệch nào", async () => {
    // thực nhận app = 500.000 − 20.000 − 30.000 = 450.000
    await taoDon({ pancakeId: "T1", code: "1", status: "COMPLETED", itemsTotal: 500_000, discount: 20_000, platformFeeEst: 30_000 });
    await taoGiaoDich({ orderId: "T1", externalId: "gd-1", settlement: 450_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.khop).toBe(1);
    expect(r.lech).toBe(0);
    expect(r.tongDelta).toBe(0);
    expect(r.danhSachLech).toHaveLength(0);
  });

  it("BẮT được đơn tiền về hụt — đúng lớp lỗi đã gặp thật trên prod", async () => {
    // App tưởng nhận 439.760 nhưng sàn trả về ÂM (đơn bị hoàn sau khi quyết toán).
    await taoDon({ pancakeId: "T7", code: "7", status: "PENDING", itemsTotal: 460_000, platformFeeEst: 20_240 });
    await taoGiaoDich({ orderId: "T7", externalId: "gd-7a", settlement: 439_760 });
    await taoGiaoDich({ orderId: "T7", externalId: "gd-7b", settlement: -443_431 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.lech).toBe(1);
    expect(r.khop).toBe(0);
    const d = r.danhSachLech[0];
    expect(d.code).toBe("7");
    expect(d.thucNhanApp).toBe(439_760);
    expect(d.sanTra).toBe(-3_671);
    expect(d.delta).toBe(-443_431);
    expect(d.soGiaoDich).toBe(2);
    expect(r.tongDelta).toBe(-443_431);
  });

  it("giao dịch BẮN LẠI chỉ tính bản mới nhất — cộng cả hai là số sàn phồng lên", async () => {
    // Bronze khử trùng theo NỘI DUNG nên bản bắn lại là DÒNG MỚI cùng externalId.
    // Cộng thẳng ⇒ 300.000 + 450.000 = 750.000, khớp giả với một đơn sai.
    await taoDon({ pancakeId: "T2", code: "2", status: "COMPLETED", itemsTotal: 450_000 });
    await taoGiaoDich({ orderId: "T2", externalId: "gd-2", settlement: 300_000, fetchedAt: new Date("2026-06-01") });
    await taoGiaoDich({ orderId: "T2", externalId: "gd-2", settlement: 450_000, fetchedAt: new Date("2026-06-02") });

    const r = await doiSoatTienVe(RANGE);

    expect(r.khop).toBe(1);
    expect(r.lech).toBe(0);
    expect(r.danhSachLech).toHaveLength(0);
  });

  it("bản bắn lại RỚT field type vẫn được nhận (lọc cứng 'ORDER' sẽ vứt đúng bản mới nhất)", async () => {
    await taoDon({ pancakeId: "T3", code: "3", status: "COMPLETED", itemsTotal: 200_000 });
    await taoGiaoDich({ orderId: "T3", externalId: "gd-3", settlement: 200_000, type: null });

    const r = await doiSoatTienVe(RANGE);

    expect(r.khop).toBe(1);
    expect(r.chuaThay).toBe(0);
  });

  it("đơn còn trong cửa sổ chờ KHÔNG bị tính lệch dù chưa có quyết toán", async () => {
    await taoDon({
      pancakeId: "T4", code: "4", status: "COMPLETED", itemsTotal: 300_000,
      orderedAt: CON_TRONG_CUA_SO,
    });

    const r = await doiSoatTienVe(RANGE);

    expect(r.dangCho).toBe(1);
    expect(r.chuaThay).toBe(0);
    expect(r.lech).toBe(0);
  });

  it("quá cửa sổ chờ mà sàn vẫn im thì vào ô Chưa thấy, không lẫn vào Lệch", async () => {
    await taoDon({ pancakeId: "T5", code: "5", status: "COMPLETED", itemsTotal: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.chuaThay).toBe(1);
    expect(r.lech).toBe(0);
    expect(r.khop).toBe(0);
  });

  it("nhánh đơn HỢP LỆ vẫn neo NGÀY ĐẶT, không mượn mốc đổi trạng thái", async () => {
    // Chiều ngược của quy tắc mốc: nhánh đơn hợp lệ cũng phải neo NGÀY ĐẶT. Thiếu ca
    // này thì ai đó neo nhánh này sang mốc đổi trạng thái vẫn xanh hết, và đơn đã
    // giao xong quá hạn mà sàn im sẽ bị hạ xuống "đang chờ" — mất cảnh báo.
    await taoDon({
      pancakeId: "TQ", code: "Q", status: "COMPLETED", itemsTotal: 300_000,
      orderedAt: DA_QUA_CUA_SO, statusChangedAt: new Date(),
    });

    const r = await doiSoatTienVe(RANGE);

    expect(r.chuaThay).toBe(1);
    expect(r.dangCho).toBe(0);
  });

  it("đơn hoàn/hủy bị loại — app không tính 'thực nhận' nên đem so là đỏ oan", async () => {
    await taoDon({ pancakeId: "T6", code: "6", status: "RETURNED", itemsTotal: 400_000 });
    await taoDon({ pancakeId: "T6b", code: "6b", status: "CANCELLED", itemsTotal: 400_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.khop + r.lech + r.chuaThay + r.dangCho).toBe(0);
  });

  it("chỉ soi kênh TikTok — đơn Shopee không lọt vào (ví Shopee chưa đủ chi tiết cấp đơn)", async () => {
    await taoDon({ pancakeId: "S1", code: "S1", status: "COMPLETED", itemsTotal: 300_000, channelId: "shopee" });

    const r = await doiSoatTienVe(RANGE);

    expect(r.khop + r.lech + r.chuaThay + r.dangCho).toBe(0);
  });

  it("danh sách lệch xếp theo TIỀN lệch giảm dần, Σ delta cộng đúng", async () => {
    await taoDon({ pancakeId: "A", code: "A", status: "COMPLETED", itemsTotal: 100_000 });
    await taoGiaoDich({ orderId: "A", externalId: "gd-a", settlement: 90_000 }); // −10.000
    await taoDon({ pancakeId: "B", code: "B", status: "COMPLETED", itemsTotal: 100_000 });
    await taoGiaoDich({ orderId: "B", externalId: "gd-b", settlement: 50_000 }); // −50.000
    await taoDon({ pancakeId: "C", code: "C", status: "COMPLETED", itemsTotal: 100_000 });
    await taoGiaoDich({ orderId: "C", externalId: "gd-c", settlement: 120_000 }); // +20.000

    const r = await doiSoatTienVe(RANGE);

    expect(r.lech).toBe(3);
    expect(r.danhSachLech.map((d) => d.code)).toEqual(["B", "C", "A"]);
    expect(r.tongDelta).toBe(-40_000);
  });

  it("đơn TRONG cửa sổ chờ mà sàn ĐÃ trả số lệch: phải vào Lệch NGAY, không bị giấu", async () => {
    // Lỗi cũ: cửa sổ chờ chặn CẢ phép so ⇒ đơn lệch nặng trong tháng hiện tại bị
    // giấu tới 30 ngày. Mà kỳ mặc định của tab Dòng tiền CHÍNH LÀ tháng hiện tại
    // ⇒ khối câm đúng lúc cần nhất. Cửa sổ chỉ được quyết định "vắng quyết toán là
    // bình thường hay bất thường", không được chặn số đã có.
    await taoDon({
      pancakeId: "TM", code: "M", status: "PENDING", itemsTotal: 460_000, platformFeeEst: 20_240,
      orderedAt: CON_TRONG_CUA_SO,
    });
    await taoGiaoDich({ orderId: "TM", externalId: "gd-m", settlement: -3_671 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.lech).toBe(1);
    expect(r.dangCho).toBe(0);
    expect(r.danhSachLech[0].delta).toBe(-443_431);
  });

  it("đơn trong cửa sổ chờ mà sàn ĐÃ trả đúng số: vào Khớp, không nằm ở Đang chờ", async () => {
    await taoDon({
      pancakeId: "TK", code: "K", status: "COMPLETED", itemsTotal: 300_000,
      orderedAt: CON_TRONG_CUA_SO,
    });
    await taoGiaoDich({ orderId: "TK", externalId: "gd-k", settlement: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.khop).toBe(1);
    expect(r.dangCho).toBe(0);
  });

  it("quá hạn mà CHƯA giao xong đếm riêng 'treo chưa giao', không lẫn vào 'chưa thấy'", async () => {
    // Hai việc phải làm khác hẳn nhau: đơn đã giao xong mà sàn im = bất thường thật;
    // đơn chưa giao xong = Pancake chưa cập nhật trạng thái.
    await taoDon({ pancakeId: "TP", code: "P", status: "PENDING", itemsTotal: 300_000 });
    await taoDon({ pancakeId: "TC", code: "C", status: "COMPLETED", itemsTotal: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.treoChuaGiao).toBe(1);
    expect(r.chuaThay).toBe(1);
  });

  it("Σ lệch tuyệt đối KHÔNG bị bù trừ dấu — hai đơn ngược chiều không thành 'hoà'", async () => {
    await taoDon({ pancakeId: "TD1", code: "D1", status: "COMPLETED", itemsTotal: 500_000 });
    await taoGiaoDich({ orderId: "TD1", externalId: "gd-d1", settlement: 0 }); // −500.000
    await taoDon({ pancakeId: "TD2", code: "D2", status: "COMPLETED", itemsTotal: 500_000 });
    await taoGiaoDich({ orderId: "TD2", externalId: "gd-d2", settlement: 1_000_000 }); // +500.000

    const r = await doiSoatTienVe(RANGE);

    expect(r.lech).toBe(2);
    expect(r.tongDelta).toBe(0);
    expect(r.tongLechTuyetDoi).toBe(1_000_000);
  });

  it("đơn phí sàn TẠM TÍNH được đánh dấu — lệch vì chưa có phí thật, không phải mất tiền", async () => {
    // Phí 11.450/259.000 = 4,4% < ngưỡng 10% ⇒ isProvisionalPlatformFee = true.
    await taoDon({ pancakeId: "TT", code: "T", status: "PENDING", itemsTotal: 259_000, platformFeeEst: 11_450 });
    await taoGiaoDich({ orderId: "TT", externalId: "gd-t", settlement: 201_252 });
    // Đối chứng: đơn phí thật ~22% KHÔNG được đánh dấu.
    await taoDon({ pancakeId: "TR", code: "R", status: "COMPLETED", itemsTotal: 259_000, platformFeeEst: 57_748 });
    await taoGiaoDich({ orderId: "TR", externalId: "gd-r", settlement: 150_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.danhSachLech.find((d) => d.code === "T")!.phiTamTinh).toBe(true);
    expect(r.danhSachLech.find((d) => d.code === "R")!.phiTamTinh).toBe(false);
  });

  it("sàn trả ĐÚNG 0đ khác hẳn 'chưa thấy quyết toán'", async () => {
    await taoDon({ pancakeId: "TZ", code: "Z", status: "COMPLETED", itemsTotal: 300_000 });
    await taoGiaoDich({ orderId: "TZ", externalId: "gd-z", settlement: 0 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.chuaThay).toBe(0);
    expect(r.lech).toBe(1);
    expect(r.danhSachLech[0].sanTra).toBe(0);
    expect(r.danhSachLech[0].soGiaoDich).toBe(1);
  });

  it("giao dịch KHÔNG có order_id (quảng cáo/điều chỉnh) không lọt vào tiền đơn", async () => {
    await taoDon({ pancakeId: "TA", code: "A", status: "COMPLETED", itemsTotal: 300_000 });
    await taoGiaoDich({ orderId: "TA", externalId: "gd-a", settlement: 300_000 });
    await prisma.rawTiktokShopTransaction.create({
      data: {
        shopId: "100975192", externalId: "gd-ads", payloadHash: "h-ads", fetchedAt: new Date(),
        payload: {
          id: "gd-ads", adjustment_id: "adj-1", type: "GMV_PAYMENT_FOR_TIKTOK_ADS",
          settlement_amount: "-9999999",
        },
      },
    });

    const r = await doiSoatTienVe(RANGE);

    expect(r.khop).toBe(1);
    expect(r.lech).toBe(0);
  });

  it("đơn HOÀN mà sàn vẫn ghi nhận doanh thu: vào lưới cảnh báo, KHÔNG vào bảng lệch", async () => {
    // Lỗ mù của chính phép đối soát: đơn hoàn/hủy bị loại khỏi bảng lệch, nên trạng
    // thái đánh sai thì không lưới nào bắt. Ca thật 19/08: 3 đơn tháng 3 đánh hoàn
    // trong khi sàn vẫn ghi doanh thu ĐỦ và đã trả 610.487đ.
    await taoDon({ pancakeId: "H1", code: "H1", status: "RETURNED", itemsTotal: 259_000 });
    await taoGiaoDich({ orderId: "H1", externalId: "gd-h1", settlement: 201_252, revenue: 259_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.lech).toBe(0);
    // Phải chắc đơn hoàn KHÔNG lọt xuống nhánh so: nếu lọt, ca sanTra == thucNhan
    // sẽ rơi vào `khop` mà test vẫn xanh.
    expect(r.khop).toBe(0);
    expect(r.hoanConTien).toHaveLength(1);
    const d = r.hoanConTien[0];
    expect(d.code).toBe("H1");
    expect(d.doanhThuSan).toBe(259_000);
    expect(d.sanTra).toBe(201_252);
    expect(d.choGiaoDichDao).toBe(false); // đơn cũ ⇒ "cần kiểm tra trạng thái"
    expect(r.tongTienVeDonHoan).toBe(201_252);
  });

  it("đơn HỦY mà sàn đã đảo xong (doanh thu 0, net âm) KHÔNG bị nêu", async () => {
    // Đây là đơn hoàn ĐÚNG — sàn đã thu ngược. Nêu nó lên là báo động giả.
    await taoDon({ pancakeId: "H2", code: "H2", status: "CANCELLED", itemsTotal: 460_000 });
    await taoGiaoDich({ orderId: "H2", externalId: "gd-h2", settlement: -3_671, revenue: 0 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien).toHaveLength(0);
    expect(r.tongTienVeDonHoan).toBe(0);
  });

  it("đơn hoàn MỚI mang nhãn 'chờ giao dịch đảo', hiện NGAY chứ không bị giấu 30 ngày", async () => {
    await taoDon({
      pancakeId: "H3", code: "H3", status: "RETURNED", itemsTotal: 300_000,
      orderedAt: CON_TRONG_CUA_SO,
    });
    await taoGiaoDich({ orderId: "H3", externalId: "gd-h3", settlement: 250_000, revenue: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien).toHaveLength(1);
    expect(r.hoanConTien[0].choGiaoDichDao).toBe(true);
  });

  it("đơn hoàn CŨ xếp TRƯỚC đơn hoàn mới; tổng tiền về chỉ cộng phần DƯƠNG", async () => {
    await taoDon({ pancakeId: "HM", code: "HM", status: "RETURNED", itemsTotal: 100_000, orderedAt: CON_TRONG_CUA_SO });
    await taoGiaoDich({ orderId: "HM", externalId: "gd-hm", settlement: 900_000, revenue: 100_000 });
    await taoDon({ pancakeId: "HC", code: "HC", status: "RETURNED", itemsTotal: 100_000 });
    await taoGiaoDich({ orderId: "HC", externalId: "gd-hc", settlement: 100_000, revenue: 100_000 });
    // Đơn hoàn có doanh thu sàn > 0 nhưng net ÂM: vẫn nêu, nhưng không kéo tổng xuống.
    await taoDon({ pancakeId: "HN", code: "HN", status: "RETURNED", itemsTotal: 100_000 });
    await taoGiaoDich({ orderId: "HN", externalId: "gd-hn", settlement: -50_000, revenue: 100_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien.map((d) => d.code)).toEqual(["HC", "HN", "HM"]);
    // Chỉ cộng phần DƯƠNG: HC 100.000 + HM 900.000. HN có net âm nên bị kẹp về 0,
    // KHÔNG được kéo tổng xuống che mất tiền thật đang treo ở hai đơn kia.
    expect(r.tongTienVeDonHoan).toBe(1_000_000);
  });

  it("đơn CŨ vừa sửa trạng thái hôm nay VẪN 'cần kiểm tra' — sửa Pancake không reset đồng hồ", async () => {
    // Quy tắc chủ shop chốt 19/08. `statusChangedAt` có đường rơi về `updated_at`,
    // mà cái đó nhảy mỗi lượt sửa tay lẫn mỗi lượt sàn đối soát phí — neo một mình
    // nó thì mỗi lần chạm đơn là đẩy lùi hạn 30 ngày, cảnh báo không bao giờ leo lên.
    // Ca thật: ba đơn tháng 3, sàn vẫn ghi doanh thu đủ, vừa đánh hoàn hôm nay.
    await taoDon({
      pancakeId: "HD", code: "HD", status: "RETURNED", itemsTotal: 259_000,
      orderedAt: DA_QUA_CUA_SO, statusChangedAt: new Date(),
    });
    await taoGiaoDich({ orderId: "HD", externalId: "gd-hd", settlement: 201_252, revenue: 259_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien).toHaveLength(1);
    expect(r.hoanConTien[0].choGiaoDichDao).toBe(false);
  });

  it("đơn ĐẶT trong hạn mới được 'chờ giao dịch đảo'", async () => {
    await taoDon({
      pancakeId: "HN2", code: "HN2", status: "RETURNED", itemsTotal: 300_000,
      orderedAt: CON_TRONG_CUA_SO, statusChangedAt: new Date(),
    });
    await taoGiaoDich({ orderId: "HN2", externalId: "gd-hn2", settlement: 250_000, revenue: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien).toHaveLength(1);
    expect(r.hoanConTien[0].choGiaoDichDao).toBe(true);
  });

  it("đơn đánh hoàn ĐÃ LÂU mà sàn chưa đảo: 'cần kiểm tra trạng thái'", async () => {
    await taoDon({
      pancakeId: "HL", code: "HL", status: "RETURNED", itemsTotal: 320_000,
      orderedAt: DA_QUA_CUA_SO, statusChangedAt: DA_QUA_CUA_SO,
    });
    await taoGiaoDich({ orderId: "HL", externalId: "gd-hl", settlement: 239_697, revenue: 320_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien[0].choGiaoDichDao).toBe(false);
  });

  it("sàn TRẢ TIỀN dương nhưng CHƯA ghi doanh thu: vẫn phải nêu", async () => {
    // Nhánh `|| sanTra > 0`. Ca thật: có đơn settlement chỉ mang dòng phí, chưa
    // từng có revenue_amount > 0. Thiếu ca này thì bỏ hẳn nhánh đó test vẫn xanh.
    await taoDon({ pancakeId: "HR", code: "HR", status: "RETURNED", itemsTotal: 300_000 });
    await taoGiaoDich({ orderId: "HR", externalId: "gd-hr", settlement: 150_000, revenue: 0 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien).toHaveLength(1);
    expect(r.hoanConTien[0].doanhThuSan).toBe(0);
    expect(r.hoanConTien[0].sanTra).toBe(150_000);
    expect(r.tongTienVeDonHoan).toBe(150_000);
  });

  it("đơn ĐẶT trong hạn nhưng mốc trạng thái BẨN (cũ hơn ngày đặt) vẫn 'chờ giao dịch đảo'", async () => {
    // Ca DUY NHẤT mà việc bỏ vế COALESCE đổi hành vi: trước ra "cần kiểm tra", nay ra
    // "chờ giao dịch đảo". Kết quả mới ĐÚNG theo quy tắc đã chốt (neo ngày đặt), nên
    // ghim lại để lượt sau không lặng lẽ dựng lại vế đó.
    await taoDon({
      pancakeId: "HB", code: "HB", status: "RETURNED", itemsTotal: 300_000,
      orderedAt: CON_TRONG_CUA_SO, statusChangedAt: DA_QUA_CUA_SO,
    });
    await taoGiaoDich({ orderId: "HB", externalId: "gd-hb", settlement: 250_000, revenue: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien).toHaveLength(1);
    expect(r.hoanConTien[0].choGiaoDichDao).toBe(true);
  });

  it("đơn hoàn KHÔNG có giao dịch quyết toán nào thì không nêu", async () => {
    await taoDon({ pancakeId: "H4", code: "H4", status: "RETURNED", itemsTotal: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.hoanConTien).toHaveLength(0);
  });

  it("giá trị tiền DỊ DẠNG bị coi là 0, KHÔNG làm văng cả truy vấn", async () => {
    // Hàm chạy trong Promise.all của trang Tài chính nên một giá trị dị lọt qua hàng
    // rào rồi chết ở ::numeric sẽ hạ NGUYÊN TRANG. Regex phải chặn ĐÚNG dấu chấm:
    // viết '\.' trong template literal bị nuốt gạch thành '.' = ký tự bất kỳ, nên
    // "1a5" lọt rào. Chuẩn đúng nằm ở tiktok-quyet-toan-don.ts.
    await taoDon({ pancakeId: "TX", code: "X", status: "COMPLETED", itemsTotal: 100_000 });
    await prisma.rawTiktokShopTransaction.create({
      data: {
        shopId: "100975192", externalId: "gd-di", payloadHash: "h-di", fetchedAt: new Date(),
        payload: { id: "gd-di", order_id: "TX", type: "ORDER", settlement_amount: "1a5", revenue_amount: "2b7" },
      },
    });

    await expect(doiSoatTienVe(RANGE)).resolves.toBeDefined();
    const r = await doiSoatTienVe(RANGE);
    expect(r.danhSachLech[0].sanTra).toBe(0);
  });

  it("lệch MỘT ĐỒNG cũng nêu — không có ngưỡng bỏ qua", async () => {
    await taoDon({ pancakeId: "T8", code: "8", status: "COMPLETED", itemsTotal: 1_000_000 });
    await taoGiaoDich({ orderId: "T8", externalId: "gd-8", settlement: 999_999 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.lech).toBe(1);
    expect(r.danhSachLech[0].delta).toBe(-1);
  });
});

describe("doiSoatTienVe — nhóm BỔ SUNG 'sàn chưa ghi doanh thu' (chủ shop chốt 2026-09-03)", () => {
  it("(a) đơn COMPLETED có giao dịch nhưng revenue = 0 ⇒ vào nhóm, tuổi đơn đúng", async () => {
    // Ca thật đo prod 2026-09-18: 583439857821976265 — 1 dòng chỉ ghi PHÍ, chưa từng
    // ghi doanh thu.
    await taoDon({
      pancakeId: "SD1", code: "SD1", status: "COMPLETED", itemsTotal: 241_000,
      orderedAt: DA_QUA_CUA_SO,
    });
    await taoGiaoDich({ orderId: "SD1", externalId: "gd-sd1", settlement: -7_087, revenue: 0 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.sanChuaGhiDoanhThu).toHaveLength(1);
    const d = r.sanChuaGhiDoanhThu[0];
    expect(d.code).toBe("SD1");
    expect(d.doanhThuApp).toBe(241_000);
    expect(d.sanTra).toBe(-7_087);
    expect(d.soGiaoDich).toBe(1);
    expect(d.tuoiNgay).toBe(CUA_SO_CHO_QUYET_TOAN_NGAY + 10);
    expect(d.conTrongCuaSoCho).toBe(false);
    expect(r.tongDoanhThuSanChuaGhi).toBe(241_000);
  });

  it("(b) đơn sàn ĐÃ ghi doanh thu dương ⇒ không vào nhóm", async () => {
    await taoDon({ pancakeId: "SD2", code: "SD2", status: "COMPLETED", itemsTotal: 300_000 });
    await taoGiaoDich({ orderId: "SD2", externalId: "gd-sd2", settlement: 300_000, revenue: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.sanChuaGhiDoanhThu).toHaveLength(0);
  });

  it("(c) đơn không có giao dịch quyết toán nào ⇒ không vào nhóm", async () => {
    await taoDon({ pancakeId: "SD3", code: "SD3", status: "COMPLETED", itemsTotal: 300_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.sanChuaGhiDoanhThu).toHaveLength(0);
  });

  it("(d) đơn RETURNED revenue 0 ⇒ không vào nhóm (dù vẫn lọt lưới 'hoàn còn tiền' riêng)", async () => {
    // Hai lưới độc lập: RETURNED/CANCELLED bị loại khỏi lưới NÀY hoàn toàn (bởi vì app
    // cố ý không tính "doanh thu đang tính" cho đơn hoàn/hủy), nhưng vẫn được lưới
    // `hoanConTien` soi riêng. "Loại khỏi lưới A" không được hiểu nhầm thành "loại
    // khỏi mọi lưới".
    await taoDon({ pancakeId: "SD4", code: "SD4", status: "RETURNED", itemsTotal: 300_000 });
    await taoGiaoDich({ orderId: "SD4", externalId: "gd-sd4", settlement: 100_000, revenue: 0 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.sanChuaGhiDoanhThu).toHaveLength(0);
    expect(r.hoanConTien).toHaveLength(1);
  });

  it("(e) đơn PENDING revenue 0 ⇒ vẫn vào nhóm — ca PENDING chưa quyết toán xong", async () => {
    await taoDon({ pancakeId: "SD5", code: "SD5", status: "PENDING", itemsTotal: 460_000 });
    await taoGiaoDich({ orderId: "SD5", externalId: "gd-sd5", settlement: -3_671, revenue: 0 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.sanChuaGhiDoanhThu).toHaveLength(1);
    expect(r.sanChuaGhiDoanhThu[0].status).toBe("PENDING");
  });

  it("(f) đơn vừa LỆCH vừa thuộc nhóm mới: khop/lech/tongDelta/danhSachLech KHÔNG đổi", async () => {
    // Hai ca thật đo prod 2026-09-18 (583439857821976265 + 583442948484400557): cả
    // hai đều LỆCH bình thường ở nhánh so sánh hiện có VÀ đều rơi vào nhóm cảnh báo
    // mới. Nhóm mới là BỔ SUNG — không được rẽ nhánh làm hụt danh sách lệch cũ.
    await taoDon({ pancakeId: "SD6", code: "SD6", status: "COMPLETED", itemsTotal: 241_000 });
    await taoGiaoDich({ orderId: "SD6", externalId: "gd-sd6", settlement: -7_087, revenue: 0 });

    // Đơn "bán rồi đảo ngược sạch": 2 dòng, net doanh thu = 0.
    await taoDon({ pancakeId: "SD7", code: "SD7", status: "COMPLETED", itemsTotal: 320_000 });
    await taoGiaoDich({ orderId: "SD7", externalId: "gd-sd7a", settlement: 320_000, revenue: 320_000 });
    await taoGiaoDich({ orderId: "SD7", externalId: "gd-sd7b", settlement: -327_087, revenue: -320_000 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.khop).toBe(0);
    expect(r.lech).toBe(2);
    expect(r.tongDelta).toBe(-575_174); // −248.087 + −327.087
    expect(r.danhSachLech.map((d) => d.code).sort()).toEqual(["SD6", "SD7"]);
    expect(r.danhSachLech.find((d) => d.code === "SD6")!.delta).toBe(-248_087);
    expect(r.danhSachLech.find((d) => d.code === "SD7")!.delta).toBe(-327_087);
    // Cùng hai đơn đó cũng có mặt ở nhóm cảnh báo mới — chứng minh KHÔNG rẽ nhánh.
    expect(r.sanChuaGhiDoanhThu.map((d) => d.code).sort()).toEqual(["SD6", "SD7"]);
  });

  it("(g) đơn ĐẶT còn trong cửa sổ chờ ⇒ conTrongCuaSoCho = true, tuổi đơn đúng", async () => {
    await taoDon({
      pancakeId: "SD8", code: "SD8", status: "PENDING", itemsTotal: 300_000,
      orderedAt: CON_TRONG_CUA_SO,
    });
    await taoGiaoDich({ orderId: "SD8", externalId: "gd-sd8", settlement: 0, revenue: 0 });

    const r = await doiSoatTienVe(RANGE);

    expect(r.sanChuaGhiDoanhThu).toHaveLength(1);
    expect(r.sanChuaGhiDoanhThu[0].conTrongCuaSoCho).toBe(true);
    expect(r.sanChuaGhiDoanhThu[0].tuoiNgay).toBe(3);
  });

  it("sắp xếp: đơn quá cửa sổ trước đơn còn trong cửa sổ, trong mỗi nhóm tuổi cao trước", async () => {
    await taoDon({
      pancakeId: "SO1", code: "SO1", status: "COMPLETED", itemsTotal: 100_000,
      orderedAt: CON_TRONG_CUA_SO,
    });
    await taoGiaoDich({ orderId: "SO1", externalId: "gd-so1", settlement: 0, revenue: 0 });

    const cuHon = new Date(Date.now() - (CUA_SO_CHO_QUYET_TOAN_NGAY + 50) * 86_400_000);
    await taoDon({ pancakeId: "SO2", code: "SO2", status: "COMPLETED", itemsTotal: 100_000, orderedAt: cuHon });
    await taoGiaoDich({ orderId: "SO2", externalId: "gd-so2", settlement: 0, revenue: 0 });

    await taoDon({ pancakeId: "SO3", code: "SO3", status: "COMPLETED", itemsTotal: 100_000, orderedAt: DA_QUA_CUA_SO });
    await taoGiaoDich({ orderId: "SO3", externalId: "gd-so3", settlement: 0, revenue: 0 });

    const r = await doiSoatTienVe(RANGE);

    // SO2 (60 ngày) và SO3 (40 ngày) đều đã QUA cửa sổ ⇒ lên trước, SO2 tuổi cao hơn
    // nên đứng trước SO3. SO1 còn TRONG cửa sổ ⇒ xuống cuối dù tuổi không liên quan.
    expect(r.sanChuaGhiDoanhThu.map((d) => d.code)).toEqual(["SO2", "SO3", "SO1"]);
  });
});
