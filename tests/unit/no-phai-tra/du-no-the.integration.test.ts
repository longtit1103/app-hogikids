import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docDuNoCacThe, docGiaoDichThe, docKyNeoThe } from "@/lib/no-phai-tra/du-no-the";
import { duNo } from "@/lib/no-phai-tra/ky-sao-ke";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Gom giao dịch thẻ từ DB thật (`hogikids_test`) — spec §5.5 + fixture §6 (M = 01/11/2026, đơn vị triệu).
 *
 * Thẻ A gánh META từ 01/11, đổi META → thẻ C từ 01/12; thẻ B gánh TIKTOK_ADS từ 01/11. Kiểm 3 nguồn
 * (Expense theo luật thẻ duy nhất + ADS_TOPUP nạp bằng thẻ · ví TikTok CÓ DẤU · CARD_PAY), neo mới không
 * đếm lại giao dịch đúng ngày chốt, và xem lại ngày cũ vẫn dùng neo cũ.
 */

const tr = (n: number) => Math.round(n * 1_000_000);
const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);

type The = { A: string; B: string; C: string };

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterEach(async () => {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

let soRef = 0;
async function ads(nenTang: string, ngay: string, trieu: number, gio = "00:00:00") {
  soRef += 1;
  await prisma.expense.create({
    data: {
      date: vn(ngay, gio),
      categoryId: "ads",
      adsSource: nenTang,
      amount: tr(trieu),
      description: `ads ${nenTang} ${ngay}`,
      source: "ADS_API",
      refId: `${nenTang}:${ngay}:test-${soRef}`,
    },
  });
}

async function traThe(cardId: string, ngay: string, trieu: number) {
  await prisma.cashMovement.create({
    data: { date: vn(ngay, "10:00:00"), kind: "CARD_PAY", amount: tr(trieu), cardId, description: "Trả thẻ" },
  });
}

async function seedFixture(): Promise<The> {
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
  const [A, B, C] = await Promise.all(
    ["Thẻ A", "Thẻ B", "Thẻ C"].map((ten) =>
      prisma.theTinDung.create({ data: { ten, ngayChotSaoKe: 25, ngayHanTra: 10 } }).then((t) => t.id)
    )
  );
  await prisma.ganNenTangThe.createMany({
    data: [
      { cardId: A, nenTang: "META", tuNgay: vn("2026-11-01") },
      { cardId: B, nenTang: "TIKTOK_ADS", tuNgay: vn("2026-11-01") },
      { cardId: C, nenTang: "META", tuNgay: vn("2026-12-01") },
    ],
  });
  await prisma.kySaoKeThe.createMany({
    data: [
      // (i) sao kê cuối trước M + (ii) neo mở sổ cuối ngày M − 1.
      { cardId: A, ngayChot: vn("2026-10-25"), soDu: tr(12), hanTra: vn("2026-11-10"), daTraTruocMoSo: tr(5) },
      { cardId: A, ngayChot: vn("2026-10-31"), soDu: tr(9), laNeoMoSo: true },
      { cardId: B, ngayChot: vn("2026-10-31"), soDu: tr(6), laNeoMoSo: true },
      { cardId: C, ngayChot: vn("2026-11-30"), soDu: 0, laNeoMoSo: true },
    ],
  });

  // META (thẻ A tới 30/11, thẻ C từ 01/12).
  await ads("META", "2026-11-02", 1);
  await ads("META", "2026-11-03", 1);
  await ads("META", "2026-11-24", 1);
  await ads("META", "2026-11-25", 1, "23:59:00");
  await ads("META", "2026-12-02", 1);
  // Phí thẻ A ghi tay "trừ vào thẻ".
  await prisma.expense.create({
    data: { date: vn("2026-12-02"), categoryId: "other", amount: tr(0.4), description: "Phí thẻ A", cardId: A },
  });
  await traThe(A, "2026-11-08", 7);
  await traThe(A, "2026-11-25", 2);
  await traThe(A, "2026-11-26", 1);

  // TikTok ads 30 (01–25/11) về B; ví TikTok tự trừ 18.
  for (const [ngay, trieu] of [["2026-11-01", 10], ["2026-11-12", 10], ["2026-11-25", 10]] as const) {
    await ads("TIKTOK_ADS", ngay, trieu);
  }
  await prisma.tiktokAdsSettlement.createMany({
    data: [
      { transactionId: "tx-1", shopId: "s", orderCreateTime: vn("2026-11-10", "12:00:00"), settlementAmount: -tr(10) },
      { transactionId: "tx-2", shopId: "s", orderCreateTime: vn("2026-11-20", "12:00:00"), settlementAmount: -tr(8) },
      // TRƯỚC M (31/10 23:59 VN) — không có thẻ nào gánh, không được trừ vào B.
      { transactionId: "tx-0", shopId: "s", orderCreateTime: vn("2026-10-31", "23:59:00"), settlementAmount: -tr(3) },
    ],
  });
  return { A, B, C };
}

async function duNoTai(cardId: string, ngay: string): Promise<number | null> {
  const t = vn(ngay, "12:00:00");
  return duNo(await docKyNeoThe(cardId), await docGiaoDichThe(cardId, t), t);
}

describe("docGiaoDichThe + duNo — fixture §6", () => {
  it("A trước kỳ 25/11: 02/11 = neo 9 + ads 1 = 10", async () => {
    const { A } = await seedFixture();
    expect(await duNoTai(A, "2026-11-02")).toBe(tr(10));
  });

  it("cuối 25/11 khi CHƯA chốt: 9 + 4 ads − 7 − 2 = 4,0", async () => {
    const { A } = await seedFixture();
    expect(await duNoTai(A, "2026-11-25")).toBe(tr(4));
  });

  describe("sau khi chốt A 25/11 soDu 4,4 hạn 10/12", () => {
    async function chot(): Promise<The> {
      const the = await seedFixture();
      await prisma.kySaoKeThe.create({
        data: { cardId: the.A, ngayChot: vn("2026-11-25"), soDu: tr(4.4), hanTra: vn("2026-12-10") },
      });
      return the;
    }

    it("26/11 = 4,4 − 1 = 3,4 (ads 23:59 + CARD_PAY ngày 25 KHÔNG đếm lại)", async () => {
      const { A } = await chot();
      expect(await duNoTai(A, "2026-11-26")).toBe(tr(3.4));
    });

    it("02/12 = 3,8: phí thẻ cộng vào A, ads META 02/12 đã sang C", async () => {
      const { A, C } = await chot();
      expect(await duNoTai(A, "2026-12-02")).toBe(tr(3.8));
      expect(await duNoTai(C, "2026-12-02")).toBe(tr(1));
    });

    it("xem lại 02/11 sau chốt vẫn dùng neo 31/10 ⇒ 10", async () => {
      const { A } = await chot();
      expect(await duNoTai(A, "2026-11-02")).toBe(tr(10));
    });

    it("docDuNoCacThe 26/11: A 3,4 · phần phải trả 3,4 hạn 10/12; C chưa có neo", async () => {
      const { A, B, C } = await chot();
      const ds = await docDuNoCacThe(vn("2026-11-26", "09:00:00"));
      const theo = new Map(ds.map((d) => [d.cardId, d]));
      expect(theo.get(A)?.duNo).toBe(tr(3.4));
      expect(theo.get(A)?.phaiTra).toMatchObject({ nghiaVuKy: tr(3.4), phanTruoc: null, phanMoi: { soTien: tr(3.4) } });
      expect(theo.get(B)?.duNo).toBe(tr(6 + 30 - 18));
      expect(theo.get(C)?.duNo).toBeNull();
    });
  });

  it("B 30/11 = neo 6 + ads 30 − ví 18 (dòng ví trước M không trừ)", async () => {
    const { B } = await seedFixture();
    expect(await duNoTai(B, "2026-11-30")).toBe(tr(6 + 30 - 18));
  });

  it("ví TikTok có dòng HOÀN +2 ⇒ nợ B tăng lại đúng 2 (VI_TRU có dấu, không abs)", async () => {
    const { B } = await seedFixture();
    await prisma.tiktokAdsSettlement.create({
      data: { transactionId: "tx-hoan", shopId: "s", orderCreateTime: vn("2026-11-21"), settlementAmount: tr(2) },
    });
    expect(await duNoTai(B, "2026-11-30")).toBe(tr(6 + 30 - 18 + 2));
  });

  it("ads MANUAL adsSource=META + cardId=B ⇒ CHỈ nợ B tăng, A không (cardId thắng)", async () => {
    const { A, B } = await seedFixture();
    const truocA = await duNoTai(A, "2026-11-06");
    const truocB = await duNoTai(B, "2026-11-06");
    await prisma.expense.create({
      data: { date: vn("2026-11-05"), categoryId: "ads", adsSource: "META", amount: tr(1), description: "ads tay", cardId: B },
    });
    expect(await duNoTai(A, "2026-11-06")).toBe(truocA);
    expect(await duNoTai(B, "2026-11-06")).toBe((truocB ?? 0) + tr(1));
  });

  it("ADS_TOPUP nạp ví bằng thẻ A 5tr ⇒ A +5 (nạp từ ngân hàng thì không)", async () => {
    const { A } = await seedFixture();
    const truoc = await duNoTai(A, "2026-11-06");
    const vi = await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-10-31") } });
    await prisma.cashMovement.createMany({
      data: [
        { date: vn("2026-11-05", "09:00:00"), kind: "ADS_TOPUP", amount: tr(5), viAdsId: vi.id, cardId: A, description: "Nạp thẻ" },
        { date: vn("2026-11-05", "10:00:00"), kind: "ADS_TOPUP", amount: tr(3), viAdsId: vi.id, description: "Nạp NH" },
      ],
    });
    expect(await duNoTai(A, "2026-11-06")).toBe((truoc ?? 0) + tr(5));
  });

  it("M chưa bật ⇒ không Expense/ví nào về thẻ (hồ sơ chuẩn bị không đổi gì)", async () => {
    const { A } = await seedFixture();
    await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
    const gd = await docGiaoDichThe(A, vn("2026-12-31"));
    expect(gd.filter((g) => g.loai !== "TRA")).toEqual([]);
  });
});
