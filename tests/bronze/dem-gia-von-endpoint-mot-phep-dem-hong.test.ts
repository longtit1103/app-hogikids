import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

// Phép đếm GIÁ VỐN luôn ném. `vi.mock` hoist lên trước mọi import nên route nhận đúng bản giả ở
// import tĩnh của nó. File riêng vì mock áp cho cả file.
vi.mock("@/lib/gia-von/doc-de-xuat-gia-von", () => ({
  demLechGiaVon: vi.fn().mockRejectedValue(new Error("Bronze products không đọc được")),
  docDeXuatGiaVon: vi.fn(),
}));

import { POST } from "@/app/api/ingest/dem-gia-von/route";
import { KEY_SO_LECH_GIA_VON } from "@/lib/gia-von/trang-thai-lech-gia-von";
import {
  KEY_MOC_KIEM_PHIEU_NHAP,
  KEY_SO_PHIEU_NHAP_CHUA_GHI,
  KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
} from "@/lib/nhap-hang/trang-thai-phieu-nhap";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Bước đếm nhắc việc của nút "Đồng bộ ngay" làm HAI việc độc lập (lệch giá vốn · phiếu nhập chưa
 * ghi). Một cái hỏng KHÔNG được chặn cái kia chốt số: chủ shop vừa lập phiếu nhập bấm nút mà dải
 * phiếu nhập đứng số đêm trước chỉ vì Bronze products lỗi là hỏng lặng ở một tính năng không liên
 * quan. Nhưng endpoint vẫn phải trả lỗi THẬT (500 + SyncLog ERROR) — nuốt lỗi là vỏ luôn xanh.
 */

const PHIEU_THAT = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "tests/fixtures/pancake/phieu-nhap-sample.json"), "utf8"),
) as { id: string }[];

const post = () =>
  POST(
    new Request("http://localhost/api/ingest/dem-gia-von", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );

const docSetting = (key: string) => prisma.setting.findUnique({ where: { key } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakePurchase.deleteMany();
  await prisma.setting.deleteMany({
    where: {
      key: {
        in: [
          KEY_SO_LECH_GIA_VON,
          KEY_SO_PHIEU_NHAP_CHUA_GHI,
          KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
          KEY_MOC_KIEM_PHIEU_NHAP,
        ],
      },
    },
  });
  await prisma.rawPancakePurchase.createMany({
    data: PHIEU_THAT.map((p, i) => ({
      shopId: SHOP_KHO,
      externalId: p.id,
      payloadHash: `hash-pn-${i}`,
      payload: p as object,
    })),
  });
  await prisma.cashMovement.create({
    data: {
      date: new Date(2026, 4, 12),
      kind: "CAPITAL_IN",
      amount: 500_000_000,
      description: "Góp vốn mở sổ",
    },
  });
});

afterAll(async () => {
  await prisma.rawPancakePurchase.deleteMany();
});

describe("POST /api/ingest/dem-gia-von — đếm giá vốn HỎNG", () => {
  it("vẫn chốt số phiếu nhập, rồi trả lỗi THẬT nêu đúng phép hỏng", async () => {
    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).toContain("Đếm lệch giá vốn hỏng");
    expect(JSON.stringify(body)).not.toContain("Đếm phiếu nhập chưa ghi hỏng");

    // Phép đếm phiếu nhập vẫn chạy trọn.
    expect((await docSetting(KEY_SO_PHIEU_NHAP_CHUA_GHI))?.value).toBe("4");
    expect((await docSetting(KEY_MOC_KIEM_PHIEU_NHAP))?.value).toBeTruthy();
    // Giá vốn hỏng ⇒ KHÔNG ghi số (thà trống còn hơn số sai).
    expect(await docSetting(KEY_SO_LECH_GIA_VON)).toBeNull();
  });
});
