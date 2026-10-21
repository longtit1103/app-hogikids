import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Ngữ cảnh người dùng giả (mặc định chủ shop) — action đi qua `congAction`, không có cookie trong vitest.
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});

import { importShopeeWallet } from "@/lib/actions/shopee-wallet-import";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { khoaViShopee } from "@/lib/import/shopee-wallet-khoa-phan-biet";
import { parseShopeeWalletFile } from "@/lib/import/shopee-wallet-xlsx";
import { prisma } from "@/lib/prisma";
import { dungFileViShopee, tomTatTuDong } from "../helpers/file-vi-shopee-tong-hop";
import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";

/**
 * Import file ví Shopee có dòng VA CHẠM khoá — đi trọn action → Bronze → Silver → dựng lại từ Bronze,
 * trên DB test (vitest ép TEST_DATABASE_URL).
 *
 * Ca thật file 01/01 (báo cáo 13/10): 2 điều chỉnh phí ship khác đơn, cùng giây, cùng −1.620, "Mã đơn
 * hàng" = "-" ⇒ trước bản vá cổng DUPLICATE_KEY chặn oan cả file. Khoá idempotent phải: không ghi đôi khi
 * nhập lại / đảo thứ tự / file chỉ chứa một dòng của cặp, và dựng lại từ Bronze ra đúng externalId.
 */

const GOC = "2026-01-25T09:09:52+07:00|ADJUSTMENT|-|-1620";

type Dong = (string | number)[];
const DONG_TRUOC: Dong = ["2026-01-25 10:00:00", "Doanh Thu Đơn Hàng", "Doanh thu", "260120REV00001", "Tiền vào", "100000", "Giao dịch thành công", "296760"];
const DONG_A: Dong = ["2026-01-25 09:09:52", "Điều chỉnh", "Điều chỉnh phí vận chuyển đơn hàng 260121KK741DX4", "-", "Tiền ra", "-1620", "Giao dịch thành công", "196760"];
const DONG_B: Dong = ["2026-01-25 09:09:52", "Điều chỉnh", "Điều chỉnh phí vận chuyển đơn hàng 260116805KMNGF", "-", "Tiền ra", "-1620", "Giao dịch thành công", "198380"];
const DONG_SAU: Dong = ["2026-01-24 08:00:00", "Doanh Thu Đơn Hàng", "Doanh thu", "260120REV00002", "Tiền vào", "200000", "Giao dịch thành công", "200000"];

const FILE_CO_CAP = [DONG_TRUOC, DONG_A, DONG_B, DONG_SAU];
const KHOA_FILE_CO_CAP = [
  "2026-01-24T08:00:00+07:00|REVENUE|260120REV00002|200000",
  "2026-01-25T10:00:00+07:00|REVENUE|260120REV00001|100000",
  GOC,
  `${GOC}|260121KK741DX4`,
].sort();

function form(rows: Dong[]): FormData {
  const fd = new FormData();
  fd.set("file", new File([dungFileViShopee(rows, tomTatTuDong(rows))], "vi-shopee.xlsx"));
  return fd;
}

async function khoaSilver(): Promise<string[]> {
  return (await prisma.shopeeSettlement.findMany({ select: { externalId: true } })).map((r) => r.externalId).sort();
}

async function tongSilver(): Promise<number | null> {
  return (await prisma.shopeeSettlement.aggregate({ _sum: { amount: true } }))._sum.amount;
}

async function donDb(): Promise<void> {
  await prisma.shopeeSettlement.deleteMany();
  await prisma.rawShopeeWalletTxn.deleteMany({ where: { shopId: SHOP_SHOPEE } });
}

beforeEach(donDb);
afterAll(async () => {
  await donDb();
  await prisma.$disconnect();
});

describe("import ví Shopee — dòng va chạm khoá khác Chi tiết", () => {
  it("file có cặp va chạm ⇒ import ĐỦ 2 dòng, Σ khớp file, cảnh báo nêu nhóm", async () => {
    const res = await importShopeeWallet(form(FILE_CO_CAP));

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.landed).toBe(4);
      expect(res.data.warnings.some((w) => w.includes(GOC))).toBe(true);
    }
    expect(await khoaSilver()).toEqual(KHOA_FILE_CO_CAP);
    expect(await tongSilver()).toBe(100000 - 1620 - 1620 + 200000);
    const cap = await prisma.shopeeSettlement.findMany({ where: { type: "ADJUSTMENT" }, orderBy: { runningBalance: "asc" } });
    expect(cap.map((r) => [r.externalId, r.runningBalance])).toEqual([
      [`${GOC}|260121KK741DX4`, 196760],
      [GOC, 198380],
    ]);
  });

  it("nhập lại cùng file, rồi file ĐẢO NGƯỢC thứ tự ⇒ 0 dòng mới, Silver giữ nguyên", async () => {
    expect((await importShopeeWallet(form(FILE_CO_CAP))).ok).toBe(true);

    const lai = await importShopeeWallet(form(FILE_CO_CAP));
    expect(lai.ok && lai.data.landed).toBe(0);

    const dao = await importShopeeWallet(form([...FILE_CO_CAP].reverse()));
    expect(dao.ok && dao.data.landed).toBe(0);

    expect(await prisma.rawShopeeWalletTxn.count({ where: { shopId: SHOP_SHOPEE } })).toBe(4);
    expect(await khoaSilver()).toEqual(KHOA_FILE_CO_CAP);
    expect(await tongSilver()).toBe(296760);
  });

  it("Chi tiết giống hệt ⇒ VẪN chặn DUPLICATE_KEY trước khi land", async () => {
    const b = [...DONG_B];
    b[2] = DONG_A[2];
    const res = await importShopeeWallet(form([DONG_TRUOC, DONG_A, b, DONG_SAU]));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("DUPLICATE_KEY");
      expect(res.error).toContain(GOC);
    }
    expect(await prisma.rawShopeeWalletTxn.count({ where: { shopId: SHOP_SHOPEE } })).toBe(0);
  });

  it("dựng lại Silver TOÀN BỘ từ Bronze (đường rebuild) ⇒ đúng externalId lúc import", async () => {
    expect((await importShopeeWallet(form(FILE_CO_CAP))).ok).toBe(true);
    await prisma.shopeeSettlement.deleteMany();

    const w: string[] = [];
    const stats = await transformFromRaw("shopee/wallet", w); // không externalIds = quét toàn bộ như rebuild
    expect(stats.shopeeUpserted).toBe(4);
    expect(await khoaSilver()).toEqual(KHOA_FILE_CO_CAP);
    expect(await tongSilver()).toBe(296760);
  });

  it("khoá SQL idExpr (Bronze) = gương JS khoaViShopee, cả dòng thường lẫn dòng hậu tố", async () => {
    const rows = parseShopeeWalletFile(dungFileViShopee(FILE_CO_CAP, tomTatTuDong(FILE_CO_CAP))).rows;
    const res = await landRaw("shopee/wallet", SHOP_SHOPEE, JSON.stringify({ data: rows }));
    expect(res.landedIds.sort()).toEqual(rows.map(khoaViShopee).sort());
    expect(res.landedIds.sort()).toEqual(KHOA_FILE_CO_CAP);
  });

  it("file KHÔNG va chạm ⇒ khoá Bronze + payload y như trước bản vá (không có field khoaPhu)", async () => {
    // Số dư dòng trước chỉnh cho liền mạch khi không có cặp điều chỉnh (cổng số dư ví).
    const truoc = [...DONG_TRUOC];
    truoc[7] = "300000";
    expect((await importShopeeWallet(form([truoc, DONG_SAU]))).ok).toBe(true);
    const bronze = await prisma.rawShopeeWalletTxn.findMany({ where: { shopId: SHOP_SHOPEE }, orderBy: { externalId: "asc" } });
    expect(bronze.map((b) => b.externalId)).toEqual([
      "2026-01-24T08:00:00+07:00|REVENUE|260120REV00002|200000",
      "2026-01-25T10:00:00+07:00|REVENUE|260120REV00001|100000",
    ]);
    for (const b of bronze) {
      expect(Object.keys(b.payload as object).sort()).toEqual(
        ["amount", "orderCode", "runningBalance", "status", "txnTime", "type"],
      );
    }
  });

  // File chỉ chứa MỘT dòng của cặp: thực tế không xuất được theo khoảng ngày (cặp cùng GIÂY). Phạm vi
  // bảo đảm: CÙNG luật hậu tố (hậu tố tính theo từng dòng, chỉ phụ thuộc Chi tiết của chính dòng đó) và
  // Chi tiết của mỗi giao dịch không đổi giữa các lần xuất. Khi đó dòng lẻ không va chạm ⇒ khoá gốc; ô
  // khoá gốc chỉ một dòng chiếm ⇒ số dòng + tổng tiền của cặp đúng. Đổi luật hậu tố / Shopee đổi chữ
  // Chi tiết thì KHÔNG còn bảo đảm (xem test vàng ở `tests/shopee-wallet-khoa-trung-oan.test.ts`).
  it.each([
    ["dòng giữ khoá gốc (B) đến trước", [DONG_B]],
    ["dòng mang hậu tố (A) đến trước", [DONG_A]],
  ])("%s, rồi file có cặp ⇒ đúng 2 dòng cho cặp, không đếm 2 lần", async (_ten, le) => {
    expect((await importShopeeWallet(form(le))).ok).toBe(true);
    expect((await importShopeeWallet(form(FILE_CO_CAP))).ok).toBe(true);

    expect(await khoaSilver()).toEqual(KHOA_FILE_CO_CAP);
    expect(await tongSilver()).toBe(296760);
  });

  it("file có cặp trước, rồi file chỉ chứa dòng A ⇒ vẫn đúng 2 dòng, Σ không đổi", async () => {
    expect((await importShopeeWallet(form(FILE_CO_CAP))).ok).toBe(true);
    expect((await importShopeeWallet(form([DONG_A]))).ok).toBe(true);

    expect(await khoaSilver()).toEqual(KHOA_FILE_CO_CAP);
    expect(await tongSilver()).toBe(296760);
  });
});
