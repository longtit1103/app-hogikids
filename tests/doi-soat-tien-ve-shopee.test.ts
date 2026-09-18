import { beforeAll, describe, expect, it } from "vitest";

import { doiSoatTienVeShopee } from "@/lib/reports/doi-soat-tien-ve-shopee";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Lưới cho đối soát tiền về Shopee (nguồn: ví `ShopeeSettlement`).
 *
 * Mỗi test dưới đây khoá ĐÚNG MỘT ràng buộc, và ràng buộc nào cũng có ca hỏng thật đứng sau:
 *
 * - Gom NET theo `orderCode`: đơn có dòng trả rồi dòng hoàn phải ra MỘT kết luận, không phải hai.
 * - Loại `WITHDRAWAL` + dòng không mã đơn: tiền rút về ngân hàng không thuộc đơn nào.
 * - Nhóm mirror lịch sử: phải ra ô RIÊNG, tuyệt đối không rơi vào "chưa thấy quyết toán".
 *
 * Test dùng dữ liệu tự dựng (mã đơn giả) — KHÔNG chép số liệu thật của shop vào repo.
 */

/** Dọn sạch RỒI gieo lại ref-data: `truncateBusinessTables` xoá cả `Channel`, mà `Order.channelId` là FK. */
async function lamSach() {
  await truncateBusinessTables();
  await seedReference();
}

const KY = { from: new Date("2026-04-01T00:00:00+07:00"), to: new Date("2026-04-30T23:59:59+07:00") };
/** Ngoài cửa sổ chờ 30 ngày ⇒ vắng tiền là kết luận được, không phải "đang chờ". */
const DAT_LAU = new Date("2026-04-10T10:00:00+07:00");

async function themDon(opts: {
  ma: string;
  code: string;
  status?: "COMPLETED" | "RETURNED" | "CANCELLED" | "SHIPPING";
  itemsTotal: number;
  platformFeeEst: number;
  mirror?: boolean;
}) {
  await prisma.order.create({
    data: {
      pancakeId: opts.ma,
      code: opts.code,
      channelId: "shopee",
      status: opts.status ?? "COMPLETED",
      orderedAt: DAT_LAU,
      itemsTotal: opts.itemsTotal,
      discount: 0,
      platformFeeEst: opts.platformFeeEst,
      returnedFee: 0,
      syncedAt: new Date("2026-04-21T00:00:00+07:00"),
      backfilledFromMirror: opts.mirror ?? false,
    },
  });
}

async function themDongVi(opts: {
  ma: string | null;
  amount: number;
  type: "REVENUE" | "ADJUSTMENT" | "WITHDRAWAL";
  khac?: string;
}) {
  await prisma.shopeeSettlement.create({
    data: {
      externalId: `${opts.ma ?? "none"}|${opts.type}|${opts.amount}|${opts.khac ?? ""}`,
      shopId: "1942992175",
      txnTime: new Date("2026-04-20T10:00:00+07:00"),
      type: opts.type,
      orderCode: opts.ma,
      amount: opts.amount,
      status: "Giao dịch thành công",
      runningBalance: 0,
      raw: "{}",
    },
  });
}

describe("đối soát tiền về Shopee từ ví", () => {
  beforeAll(lamSach);

  it("gom NET theo mã đơn: dòng trả + dòng hoàn ra MỘT kết luận, không phải hai", async () => {
    await lamSach();
    // Ca thật đã đo trên prod: sàn trả trước rồi đòi lại sau, net âm nhỏ.
    await themDon({ ma: "TEST-NET-01", code: "9001", itemsTotal: 100_000, platformFeeEst: 0 });
    await themDongVi({ ma: "TEST-NET-01", amount: 100_000, type: "REVENUE" });
    await themDongVi({ ma: "TEST-NET-01", amount: -100_000, type: "ADJUSTMENT" });

    const kq = await doiSoatTienVeShopee(KY);
    // Net = 0, app tính nhận 100.000 ⇒ đúng MỘT đơn lệch, delta = -100.000.
    expect(kq.khop + kq.lech).toBe(1);
    expect(kq.lech).toBe(1);
    expect(kq.danhSachLech[0]?.delta).toBe(-100_000);
    expect(kq.danhSachLech[0]?.soGiaoDich).toBe(2);
  });

  it("đơn khớp từng đồng khi net ví bằng số app tính", async () => {
    await lamSach();
    await themDon({ ma: "TEST-KHOP-01", code: "9002", itemsTotal: 200_000, platformFeeEst: 50_000 });
    await themDongVi({ ma: "TEST-KHOP-01", amount: 150_000, type: "REVENUE" });

    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.khop).toBe(1);
    expect(kq.lech).toBe(0);
  });

  it("BỎ dòng WITHDRAWAL: tiền rút về ngân hàng không được gán cho đơn nào", async () => {
    await lamSach();
    await themDon({ ma: "TEST-WD-01", code: "9003", itemsTotal: 100_000, platformFeeEst: 0 });
    await themDongVi({ ma: "TEST-WD-01", amount: 100_000, type: "REVENUE" });
    // Dòng rút tiền LỠ mang mã đơn (phòng ca dữ liệu bẩn): vẫn phải bị loại theo TYPE.
    await themDongVi({ ma: "TEST-WD-01", amount: -500_000, type: "WITHDRAWAL" });

    const kq = await doiSoatTienVeShopee(KY);
    // Bỏ WITHDRAWAL ⇒ net = 100.000 = app tính ⇒ khớp. Không bỏ ⇒ net âm ⇒ lệch.
    expect(kq.khop).toBe(1);
    expect(kq.lech).toBe(0);
  });

  // ⚠️ Test này KHOÁ HÀNH VI, không khoá dòng WHERE. Mutation 2026-08-20: bỏ `orderCode IS NOT NULL`
  // khỏi truy vấn thì test vẫn xanh — thứ thật sự chặn là ngữ nghĩa LEFT JOIN (`NULL = x` ra NULL).
  // Giữ test vì hành vi vẫn phải đúng nếu ai đó đổi cách join; đừng đọc nó như bằng chứng cho vế WHERE.
  it("dòng ví không mang mã đơn không được ảnh hưởng đơn nào", async () => {
    await lamSach();
    await themDon({ ma: "TEST-NULL-01", code: "9004", itemsTotal: 100_000, platformFeeEst: 0 });
    await themDongVi({ ma: "TEST-NULL-01", amount: 100_000, type: "REVENUE" });
    await themDongVi({ ma: null, amount: -1_620, type: "ADJUSTMENT" });

    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.khop).toBe(1);
    expect(kq.lech).toBe(0);
  });

  it("đơn mirror lịch sử vào ô RIÊNG, KHÔNG rơi vào 'chưa thấy quyết toán'", async () => {
    await lamSach();
    await themDon({
      ma: "AF1942992175O99",
      code: "9005",
      itemsTotal: 100_000,
      platformFeeEst: 0,
      mirror: true,
    });

    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.khongDuKhoa).toBe(1);
    // Đây là điều kiện SỐNG CÒN: nhóm này mà rơi vào chuaThay thì đẻ vệt đỏ vĩnh viễn.
    expect(kq.chuaThay).toBe(0);
    expect(kq.khop).toBe(0);
    expect(kq.lech).toBe(0);
    expect(kq.dangCho).toBe(0);
  });

  it("đơn mã sàn thật, đã giao xong, quá cửa sổ mà vắng tiền ⇒ chuaThay (cảnh báo THẬT vẫn nổi)", async () => {
    await lamSach();
    await themDon({ ma: "TEST-VANG-01", code: "9006", itemsTotal: 100_000, platformFeeEst: 0 });
    // Phải có ví phủ kỳ này, nếu không đơn rơi vào "chưa nhập file ví" — đúng thiết kế, nhưng khi đó
    // test không còn kiểm được nhánh chuaThay nữa.
    for (const [i, t] of ["2026-04-01T00:00:00+07:00", "2026-04-25T00:00:00+07:00"].entries()) {
      await prisma.shopeeSettlement.create({
        data: {
          externalId: `bao-vung-${i}|REVENUE|1|`, shopId: "1942992175", txnTime: new Date(t),
          type: "REVENUE", orderCode: `DON-KHAC-${i}`, amount: 1, status: "ok",
          runningBalance: 0, raw: "{}",
        },
      });
    }

    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.chuaThay).toBe(1);
    expect(kq.khongDuKhoa).toBe(0);
  });

  it("đơn hoàn có net ÂM là bình thường — không vào nhóm 'hoàn mà còn tiền'", async () => {
    await lamSach();
    await themDon({
      ma: "TEST-HOAN-01",
      code: "9007",
      status: "RETURNED",
      itemsTotal: 100_000,
      platformFeeEst: 0,
    });
    await themDongVi({ ma: "TEST-HOAN-01", amount: 100_000, type: "REVENUE" });
    await themDongVi({ ma: "TEST-HOAN-01", amount: -101_620, type: "ADJUSTMENT" });

    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.hoanConTien).toHaveLength(0);
    // Và tuyệt đối không được đếm vào bảng lệch — app cố ý không tính "thực nhận" cho đơn hoàn.
    expect(kq.lech).toBe(0);
  });

  it("đơn hoàn mà sàn VẪN giữ tiền dương ⇒ phải nêu", async () => {
    await lamSach();
    await themDon({
      ma: "TEST-HOAN-02",
      code: "9008",
      status: "RETURNED",
      itemsTotal: 100_000,
      platformFeeEst: 0,
    });
    await themDongVi({ ma: "TEST-HOAN-02", amount: 100_000, type: "REVENUE" });

    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.hoanConTien).toHaveLength(1);
    expect(kq.tongTienVeDonHoan).toBe(100_000);
  });

  // ⬇️ Bốn test dưới đây bù đúng những nhánh mà review đối kháng chỉ ra là vô hiệu hoá được mà lưới
  // vẫn xanh — tức trước đó chúng là phantom.

  it("đơn còn trong cửa sổ chờ mà vắng tiền ⇒ dangCho, KHÔNG phải chuaThay", async () => {
    await lamSach();
    // Đặt hôm nay ⇒ chắc chắn trong cửa sổ 30 ngày. Phải có dòng ví ở kỳ khác để vùng phủ tồn tại,
    // nếu không đơn rơi vào nhóm "chưa nhập file ví".
    const homNay = new Date();
    await prisma.order.create({
      data: {
        pancakeId: "TEST-CHO-01", code: "9010", channelId: "shopee", status: "COMPLETED",
        orderedAt: homNay, itemsTotal: 100_000, discount: 0, platformFeeEst: 0, returnedFee: 0,
        syncedAt: homNay, backfilledFromMirror: false,
      },
    });
    // Vùng phủ phải BAO đơn: một dòng trước và một dòng sau mốc đặt.
    for (const [i, t] of [homNay.getTime() - 86_400_000, homNay.getTime() + 3_600_000].entries()) {
      await prisma.shopeeSettlement.create({
        data: {
          externalId: `phu-vung-${i}|REVENUE|1|`, shopId: "1942992175",
          txnTime: new Date(t), type: "REVENUE",
          orderCode: `KHONG-KHOP-DON-NAO-${i}`, amount: 1, status: "ok", runningBalance: 0, raw: "{}",
        },
      });
    }
    const kq = await doiSoatTienVeShopee({ from: new Date(homNay.getTime() - 86_400_000), to: homNay });
    expect(kq.dangCho).toBe(1);
    expect(kq.chuaThay).toBe(0);
  });

  it("TRỪ discount khi tính số app nhận — bỏ vế đó là đơn khớp thành lệch", async () => {
    await lamSach();
    await prisma.order.create({
      data: {
        pancakeId: "TEST-DISC-01", code: "9011", channelId: "shopee", status: "COMPLETED",
        orderedAt: DAT_LAU, itemsTotal: 200_000, discount: 20_000, platformFeeEst: 30_000,
        returnedFee: 0, syncedAt: DAT_LAU, backfilledFromMirror: false,
      },
    });
    // 200.000 − 20.000 − 30.000 = 150.000
    await themDongVi({ ma: "TEST-DISC-01", amount: 150_000, type: "REVENUE" });
    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.khop).toBe(1);
    expect(kq.lech).toBe(0);
  });

  it("hai đơn lệch NGƯỢC CHIỀU: tổng có dấu ≠ tổng tuyệt đối", async () => {
    await lamSach();
    await themDon({ ma: "TEST-BU-01", code: "9012", itemsTotal: 100_000, platformFeeEst: 0 });
    await themDongVi({ ma: "TEST-BU-01", amount: 150_000, type: "REVENUE" });
    await themDon({ ma: "TEST-BU-02", code: "9013", itemsTotal: 100_000, platformFeeEst: 0 });
    await themDongVi({ ma: "TEST-BU-02", amount: 50_000, type: "REVENUE" });
    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.lech).toBe(2);
    expect(kq.tongDelta).toBe(0); // +50k và −50k triệt tiêu
    expect(kq.tongLechTuyetDoi).toBe(100_000); // quy mô lệch THẬT
  });

  it("đơn ngoài vùng file ví đã nhập ⇒ 'chưa nhập file', KHÔNG phải 'chưa thấy quyết toán'", async () => {
    await lamSach();
    await themDon({ ma: "TEST-NGOAI-01", code: "9014", itemsTotal: 100_000, platformFeeEst: 0 });
    // Ví chỉ phủ tháng 7 — đơn đặt 10/04 nằm ngoài vùng phủ.
    await prisma.shopeeSettlement.create({
      data: {
        externalId: "thang7|REVENUE|1|", shopId: "1942992175",
        txnTime: new Date("2026-07-15T10:00:00+07:00"), type: "REVENUE",
        orderCode: "DON-KHAC", amount: 1, status: "ok", runningBalance: 0, raw: "{}",
      },
    });
    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.chuaNhapVi).toBe(1);
    expect(kq.chuaThay).toBe(0);
  });

  it("KHÔNG đụng kênh khác: đơn TikTok không lọt vào phép đo Shopee", async () => {
    await lamSach();
    await prisma.order.create({
      data: {
        pancakeId: "TIKTOK-01",
        code: "9009",
        channelId: "tiktok",
        status: "COMPLETED",
        orderedAt: DAT_LAU,
        itemsTotal: 100_000,
        discount: 0,
        platformFeeEst: 0,
        returnedFee: 0,
        syncedAt: new Date("2026-04-21T00:00:00+07:00"),
      },
    });

    const kq = await doiSoatTienVeShopee(KY);
    expect(kq.khop + kq.lech + kq.chuaThay + kq.treoChuaGiao + kq.dangCho + kq.khongDuKhoa).toBe(0);
  });
});
