import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/dem-gia-von/route";
import { thuGiuKhoaPhucHoi, traKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import {
  KEY_MOC_KIEM_GIA_VON,
  KEY_SO_LECH_GIA_VON,
} from "@/lib/gia-von/trang-thai-lech-gia-von";
import {
  KEY_MOC_KIEM_PHIEU_NHAP,
  KEY_SO_PHIEU_NHAP_CHUA_GHI,
  KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
} from "@/lib/nhap-hang/trang-thai-phieu-nhap";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * `POST /api/ingest/dem-gia-von` — bước đếm cho nút "Đồng bộ ngay".
 *
 * VÌ SAO CÓ: bước đếm vốn nằm ở cuối lượt đêm, mà nút "Đồng bộ ngay" chạy workflow khác. Chủ shop
 * nhập hàng xong bấm nút, giá vốn mới ĐÃ về app nhưng dải nhắc việc im tới 03:00 hôm sau ⇒ tưởng
 * nút không ăn. Endpoint này lấp đúng khe đó.
 *
 * Từ 07/10 nút đó kéo cả phiếu nhập (`purchases` shop kho) ⇒ endpoint đếm luôn phiếu nhập chưa ghi
 * Sổ chi phí — cùng hàm `capNhatSoPhieuNhapChuaGhi` lượt đêm dùng.
 */

/** Payload phiếu nhập THẬT (đã gột) — 4 phiếu sau D0 12/05/2026 là phiếu chờ duyệt. */
const PHIEU_THAT = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "tests/fixtures/pancake/phieu-nhap-sample.json"), "utf8"),
) as { id: string }[];
const D0 = new Date(2026, 4, 12);

async function landPhieuNhap(): Promise<void> {
  await prisma.rawPancakePurchase.createMany({
    data: PHIEU_THAT.map((p, i) => ({
      shopId: SHOP_KHO,
      externalId: p.id,
      payloadHash: `hash-pn-${i}`,
      payload: p as object,
    })),
  });
  // Dòng ghi tay đầu tiên = ngày mở sổ ⇒ chỉ phiếu từ D0 trở đi là việc cần duyệt.
  await prisma.cashMovement.create({
    data: { date: D0, kind: "CAPITAL_IN", amount: 500_000_000, description: "Góp vốn mở sổ" },
  });
}

const VARIATION_ID = "cc000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "dd000000-0000-4000-8000-000000000001";

/** `body` = chuỗi THÔ gửi kèm (workflow mới gửi tóm tắt lỗi kéo; bản cũ gửi `{}`/không gì). */
const post = (body?: string) =>
  POST(
    new Request("http://localhost/api/ingest/dem-gia-von", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body } : {}),
    }),
  );

const dongCuoi = () => prisma.syncLog.findFirstOrThrow({ where: { kind: "PANCAKE" }, orderBy: { startedAt: "desc" } });

async function landBronze(giaPancake: number): Promise<void> {
  await prisma.rawPancakeProduct.create({
    data: {
      shopId: SHOP_KHO,
      externalId: PRODUCT_ID,
      payloadHash: `hash-${giaPancake}`,
      payload: {
        id: PRODUCT_ID,
        name: "Áo Dài Lụa",
        variations: [
          {
            id: VARIATION_ID,
            display_id: "SP-DEM-1",
            retail_price: 300_000,
            remain_quantity: 10,
            average_imported_price: giaPancake,
            fields: [{ name: "Size", value: "M" }],
          },
        ],
      },
    },
  });
}

async function taoBienThe(costPrice: number): Promise<void> {
  const sp = await prisma.product.create({
    data: { pancakeId: PRODUCT_ID, name: "Áo Dài Lụa", status: "ACTIVE", syncedAt: new Date() },
  });
  await prisma.variant.create({
    data: {
      pancakeId: VARIATION_ID,
      productId: sp.id,
      sku: "SP-DEM-1",
      label: "M",
      sellPrice: 300_000,
      costPrice,
      syncedAt: new Date(),
    },
  });
}

const docSetting = (key: string) => prisma.setting.findUnique({ where: { key } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawPancakePurchase.deleteMany();
  // `Setting` không nằm trong `truncateBusinessTables` (dữ liệu cấu hình) ⇒ dọn tay để phép kiểm
  // "chưa đếm lần nào" nói đúng sự thật.
  await prisma.setting.deleteMany({
    where: {
      key: {
        in: [
          KEY_SO_LECH_GIA_VON,
          KEY_MOC_KIEM_GIA_VON,
          KEY_SO_PHIEU_NHAP_CHUA_GHI,
          KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
          KEY_MOC_KIEM_PHIEU_NHAP,
        ],
      },
    },
  });
});

afterAll(async () => {
  await prisma.rawPancakePurchase.deleteMany();
});

describe("POST /api/ingest/dem-gia-von", () => {
  it("từ chối khi thiếu bearer", async () => {
    const res = await POST(new Request("http://localhost/api/ingest/dem-gia-von", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("đếm đúng số mã lệch và chốt vào Setting", async () => {
    await taoBienThe(120_000);
    await landBronze(90_000); // Pancake 90.000 vs app 120.000 ⇒ 1 mã lệch

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats.soLechGiaVon).toBe(1);
    expect((await docSetting(KEY_SO_LECH_GIA_VON))?.value).toBe("1");
    expect((await docSetting(KEY_MOC_KIEM_GIA_VON))?.value).toBeTruthy();
  });

  it("app khớp Pancake ⇒ ghi 0 (KHÁC hẳn 'chưa đếm lần nào')", async () => {
    await taoBienThe(90_000);
    await landBronze(90_000);

    const res = await post();

    expect((await res.json()).stats.soLechGiaVon).toBe(0);
    expect((await docSetting(KEY_SO_LECH_GIA_VON))?.value).toBe("0");
  });

  it("TUYỆT ĐỐI không chạm giá vốn — chỉ đếm, không ghi", async () => {
    await taoBienThe(120_000);
    await landBronze(90_000);

    await post();

    const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
    expect(v.costPrice).toBe(120_000); // giá app giữ nguyên, endpoint không phải đường ghi
  });

  it("đếm phiếu nhập chưa ghi và chốt 3 ô Setting (nút Đồng bộ ngay kéo cả purchases)", async () => {
    await landPhieuNhap();

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats.soPhieuNhapChuaGhi).toBe(4);
    expect(body.stats.soViecHauKiemPhieuNhap).toBe(0);
    expect((await docSetting(KEY_SO_PHIEU_NHAP_CHUA_GHI))?.value).toBe("4");
    expect((await docSetting(KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP))?.value).toBe("0");
    expect((await docSetting(KEY_MOC_KIEM_PHIEU_NHAP))?.value).toBeTruthy();
  });

  it("bấm nhiều lần ⇒ cùng con số (tính lại, KHÔNG cộng dồn) và KHÔNG tự sinh Expense", async () => {
    await landPhieuNhap();

    await post();
    await post();
    const body = await (await post()).json();

    expect(body.stats.soPhieuNhapChuaGhi).toBe(4);
    expect((await docSetting(KEY_SO_PHIEU_NHAP_CHUA_GHI))?.value).toBe("4");
    // Ghi chi phí nhập hàng CHỈ qua lượt duyệt tay — bước đếm không phải đường ghi tiền.
    expect(await prisma.expense.count()).toBe(0);
  });

  it("workflow báo LỖI KÉO purchases ⇒ vẫn đếm + chốt ô, dòng bước cuối ERROR nêu purchases/kho, HTTP 200", async () => {
    await landPhieuNhap();
    const body = JSON.stringify({
      soLoiKeo: 1,
      loiKeo: [{ scope: "CA_STREAM_BI_BO", stream: "purchases", shop: "kho", lyDo: "Request failed with status code 429" }],
    });

    const res = await post(body);
    const json = await res.json();

    // 200: n8n đã tự đánh đỏ lượt của nó; 500 chỉ nhân đôi lỗi. Báo lỗi đi qua dòng SyncLog.
    expect(res.status).toBe(200);
    expect(json.loiSauKhiGhi).toContain("purchases/kho");
    // Phép đếm KHÔNG bị lỗi kéo làm hỏng.
    expect((await docSetting(KEY_SO_PHIEU_NHAP_CHUA_GHI))?.value).toBe("4");
    const log = await dongCuoi();
    expect(log.status).toBe("ERROR");
    expect(log.error).toContain("purchases/kho");
    expect(log.error).toContain("429");
    expect(log.stats).toMatchObject({ mode: "dem-gia-von", soLoiKeo: 1, soPhieuNhapChuaGhi: 4 });
  });

  it("body cũ `{}` (workflow trước khi PUT) ⇒ như trước: OK, không lỗi kéo", async () => {
    const res = await post("{}");

    expect(res.status).toBe(200);
    expect((await res.json()).loiSauKhiGhi).toBeUndefined();
    const log = await dongCuoi();
    expect(log.status).toBe("OK");
    expect(log.stats).toMatchObject({ mode: "dem-gia-von", soLoiKeo: 0 });
  });

  it.each([
    ["không phải JSON", "khong-phai-json{"],
    ["sai hình", JSON.stringify({ loiKeo: "purchases hỏng" })],
    ["quá nhiều dòng", JSON.stringify({ loiKeo: Array.from({ length: 21 }, () => ({ scope: "X", stream: "s", shop: "kho" })) })],
    ["quá lớn", JSON.stringify({ rac: "x".repeat(20_000) })],
  ])("body rác (%s) ⇒ bỏ qua + cảnh báo, phép đếm VẪN chạy và chốt ô", async (_ten, body) => {
    await landPhieuNhap();

    const res = await post(body);

    expect(res.status).toBe(200);
    expect((await docSetting(KEY_SO_PHIEU_NHAP_CHUA_GHI))?.value).toBe("4");
    const log = await dongCuoi();
    expect(log.status).toBe("OK");
    expect(JSON.stringify(log.stats)).toContain("Tóm tắt lỗi kéo bị bỏ qua");
  });

  it("đang PHỤC HỒI ⇒ từ chối, không ghi ô nào", async () => {
    await taoBienThe(120_000);
    await landBronze(90_000);

    const the = thuGiuKhoaPhucHoi();
    try {
      const res = await post();
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      if (the) traKhoaPhucHoi(the);
    }

    expect(await docSetting(KEY_SO_LECH_GIA_VON)).toBeNull();
    expect(await docSetting(KEY_SO_PHIEU_NHAP_CHUA_GHI)).toBeNull();
  });
});
