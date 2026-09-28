import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureRecurringExpenses } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import { docCanhBaoSapCan, docDuBaoQuy, KEY_QUY_TOI_THIEU } from "@/lib/so-quy/du-bao-quy-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { docViTiktokConLaiToiThieu } from "@/lib/vi-san/vi-tiktok-con-lai-toi-thieu-queries";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Nhớ phần dự báo theo request (React `cache`) — layout (banner) và tab Sổ quỹ dùng chung một lượt đọc.
 *
 * Ngoài môi trường render server, `cache` của React là hàm chuyển thẳng (không nhớ) ⇒ ở đây thay bằng
 * một bản nhớ THẬT, xoá sau mỗi test (mỗi test = một "request"). Trọng tâm là ca bản nhớ CŨ hơn trang:
 * layout đọc trước, rồi trang chạy `ensureRecurringExpenses` sinh dòng, rồi mới đọc lịch sử — dự báo
 * phải tự đọc lại thay vì ném "cuối lịch sử ≠ quỹ hôm nay của dự báo".
 */
const nho = vi.hoisted(() => ({
  bang: new Map<unknown, unknown>(),
  soLanTinh: 0,
  /** D0 (`ngayMoSo`) cũng nhớ theo request — bảng riêng, không lẫn vào phép đếm phần dự báo. */
  bangD0: new Map<unknown, unknown>(),
}));

vi.mock("react", async (goc) => ({
  ...(await goc<typeof import("react")>()),
  cache: <A, R>(fn: (a: A) => R) => {
    const laD0 = fn.name === "ngayMoSo";
    return (a: A): R => {
      const bang = laD0 ? nho.bangD0 : nho.bang;
      if (!bang.has(a)) {
        if (!laD0) nho.soLanTinh += 1;
        bang.set(a, fn(a));
      }
      return bang.get(a) as R;
    };
  },
}));

const vn = (iso: string) => new Date(`${iso}+07:00`);
const HOM_NAY = vn("2026-09-24T09:00:00");

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  nho.bang.clear();
  nho.bangD0.clear();
  nho.soLanTinh = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOM_NAY);
  // Quỹ 100tr; mẫu "Điện" ngày 20, 600k, CHƯA sinh dòng tháng 9. Ngưỡng 99,5tr ⇒ chạm ngay điểm đầu.
  await prisma.cashMovement.create({
    data: { date: vn("2026-09-01T10:00:00"), kind: "CAPITAL_IN", amount: 100_000_000, description: "Mở sổ" },
  });
  await prisma.recurringExpense.create({
    data: { categoryId: "other", amount: 600_000, dayOfMonth: 20, description: "Điện" },
  });
  await prisma.setting.upsert({
    where: { key: KEY_QUY_TOI_THIEU },
    create: { key: KEY_QUY_TOI_THIEU, value: "99500000" },
    update: { value: "99500000" },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_QUY_TOI_THIEU } });
  await prisma.$disconnect();
});

describe("phần dự báo nhớ theo request", () => {
  it("banner + tab trong cùng request ⇒ phần dự báo tính ĐÚNG MỘT lần", async () => {
    // Mỗi lượt `docPhanDuBao` đọc ô ngưỡng đúng một lần ⇒ đếm lượt đọc THẬT, không chỉ lượt qua bản nhớ.
    const docNguong = vi.spyOn(prisma.setting, "findUnique");
    const banner = await docCanhBaoSapCan();
    expect(nho.soLanTinh).toBe(1); // banner đi QUA bản nhớ
    expect(nho.bang.has("2026-09-24")).toBe(true); // khoá = khoá ngày VN (chuỗi), không phải Date
    const tab = await docDuBaoQuy();
    expect(nho.soLanTinh).toBe(1); // tab dùng lại, không tính lần hai
    expect(docNguong.mock.calls.filter(([a]) => a.where.key === KEY_QUY_TOI_THIEU)).toHaveLength(1);
    docNguong.mockRestore();
    if (tab.trangThai !== "CO_SO") throw new Error("mong CO_SO");
    expect(banner).toEqual({ ngay: "2026-09-25", soDu: 99_400_000, nguong: 99_500_000, nguongDaDat: true });
    expect(tab.cham?.ngay).toBe(banner?.ngay);
    expect(tab.lichSu[tab.lichSu.length - 1].soDu).toBe(100_000_000);
  });

  it("🔴 bản nhớ CŨ hơn trang (layout đọc trước, trang sinh dòng định kỳ sau) ⇒ tab tự đọc lại, không nổ", async () => {
    expect(await docCanhBaoSapCan()).toEqual({ ngay: "2026-09-25", soDu: 99_400_000, nguong: 99_500_000, nguongDaDat: true });
    expect(await ensureRecurringExpenses(HOM_NAY)).toBe(1);

    const tab = await docDuBaoQuy();
    if (tab.trangThai !== "CO_SO") throw new Error("mong CO_SO");
    expect(tab.quyHomNay).toBe(99_400_000);
    expect(tab.lichSu[tab.lichSu.length - 1].soDu).toBe(99_400_000);
    expect(tab.khoanDuKien.some((k) => k.moTa.includes("đến hạn, chưa ghi sổ"))).toBe(false);
    // Điểm đầu dự báo y hệt bản banner đã thấy — cùng một sự thật, chỉ khác phía nào đang giữ khoản.
    expect(tab.duBao[0]).toEqual({ ngay: "2026-09-25", soDu: 99_400_000, duBao: true });
  });

  it("thẻ Quỹ + ô ví TikTok + banner cùng request ⇒ D0 (ngày mở sổ) đọc DB đúng MỘT lần", async () => {
    await prisma.tiktokSettlement.create({
      data: {
        statementId: "cache-s1",
        shopId: "100975192",
        statementTime: vn("2026-09-10T08:00:00"),
        paymentTime: vn("2026-09-10T08:00:00"),
        paymentStatus: "SETTLED",
        settlementAmount: 2_000_000,
        revenueAmount: 2_000_000,
        feeAmount: 0,
        adjustmentAmount: 0,
        netSalesAmount: 2_000_000,
        shippingCostAmount: 0,
      },
    });
    const docDb = vi.spyOn(prisma.cashMovement, "aggregate");
    const [the, viTiktok] = await Promise.all([
      tinhSoQuyThang({ from: vn("2026-09-01T00:00:00"), to: vn("2026-09-30T00:00:00") }),
      docViTiktokConLaiToiThieu(),
      docCanhBaoSapCan(),
    ]);
    // `ngayMoSo` là lượt DUY NHẤT gọi `aggregate` với `_min` trên bảng ghi tay.
    const luotDocD0 = docDb.mock.calls.filter(([a]) => a !== undefined && "_min" in a);
    docDb.mockRestore();
    expect(luotDocD0).toHaveLength(1);
    expect(the.d0).toEqual(vn("2026-09-01T00:00:00"));
    expect(viTiktok).toEqual({ b0ToiThieu: 0, viHienTai: 2_000_000, tangTuD0: 2_000_000 });
  });
});
