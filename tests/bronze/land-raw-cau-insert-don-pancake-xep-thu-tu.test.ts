import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { landRaw } from "@/lib/bronze/land-raw";
import { prisma } from "@/lib/prisma";

import { SHOP_SHOPEE, SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Soi CÂU SQL THẬT mà `landRaw` phát ra (không soi mã nguồn): câu INSERT của đơn Pancake phải xếp `ORDER BY x.thu_tu`
 * — `landSeq` (DEFAULT nextval) chỉ được Postgres cấp theo thứ tự phần tử trong trang khi câu SELECT có `ORDER BY`
 * tường minh. Không có nó thì "thường vẫn đúng" nên test hành vi KHÔNG phân biệt được; chỉ soi câu thật mới bắt được
 * hai kiểu hỏng: mất mảnh `ORDER BY`, hoặc `ORDER BY` lọt vào sau chú thích `--` cùng dòng (bị comment mất, câu vẫn chạy).
 * Kèm chuỗi VÀNG câu INSERT của ĐỦ bốn dạng cho bảng khác (thường, có `ngay`, bảng lần thấy có/không `chupLuc`) — cam
 * kết "bảng khác giữ nguyên văn".
 */

/** Bọc client thật, ghi lại mọi câu `$queryRawUnsafe` rồi chuyển tiếp nguyên vẹn. */
function clientGhiCau(): { db: PrismaClient; cau: string[] } {
  const cau: string[] = [];
  const db = new Proxy(prisma, {
    get(dich, ten, nhan) {
      if (ten === "$queryRawUnsafe") {
        return (sql: string, ...thamSo: unknown[]) => {
          cau.push(sql);
          return dich.$queryRawUnsafe(sql, ...thamSo);
        };
      }
      const v = Reflect.get(dich, ten, nhan);
      return typeof v === "function" ? v.bind(dich) : v;
    },
  }) as PrismaClient;
  return { db, cau };
}

/** "YYYY-MM-DD" hôm qua theo giờ VN — `ngay` hợp lệ cho stream `chapNhanNgay` (giá trị là THAM SỐ, không vào chuỗi SQL). */
const homQuaGioVn = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - 86_400_000));

/** Bỏ chú thích `--` tới hết dòng rồi gộp khoảng trắng — đúng thứ Postgres thật sự thực thi. */
const thanCau = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

const DON = (id: string) =>
  JSON.stringify({ id, status: 3, inserted_at: "2026-07-01T03:00:00.000000", items: [] });

beforeAll(async () => {
  await seedReference();
}, 60_000);

const donKhoThoDaGhi = async () => {
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeCustomer.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawTiktokShopAnalyticsProduct.deleteMany();
};

beforeEach(async () => {
  await truncateBusinessTables();
  await donKhoThoDaGhi();
});

// Dọn cả SAU file: dòng `RawPancakeCustomer` mang shop id fixture mà các file khác không dọn bảng này (vd cổng chặn đổi
// shop id đếm MỌI bảng kho thô) — để lại là đỏ dây chuyền ở file chạy sau.
afterAll(donKhoThoDaGhi);

describe("câu INSERT thật của landRaw", () => {
  it("đơn Pancake: ORDER BY x.thu_tu nằm NGOÀI chú thích, ngay trước ON CONFLICT", async () => {
    const { db, cau } = clientGhiCau();
    await landRaw("orders", SHOP_SHOPEE, `{"data":[${DON("Q-2")},${DON("Q-1")}]}`, undefined, db);
    const insert = cau.filter((c) => /INSERT INTO "RawPancakeOrder"/.test(c));
    expect(insert).toHaveLength(1);
    const than = thanCau(insert[0]);
    expect(than).toMatch(/WITH ORDINALITY AS x\(elem, thu_tu\)/);
    expect(than).toMatch(/IS NOT NULL ORDER BY x\.thu_tu ON CONFLICT \("shopId", "externalId", "payloadHash"\) DO NOTHING/);
    const dong = await prisma.rawPancakeOrder.findMany({ orderBy: { landSeq: "asc" }, select: { externalId: true } });
    expect(dong.map((d) => d.externalId)).toEqual(["Q-2", "Q-1"]);
  });

  it("bảng khác — ĐỦ BỐN dạng câu INSERT của landRaw giữ NGUYÊN VĂN so với origin/main", async () => {
    const dang: [keyof typeof CAU_VANG, string, (db: PrismaClient) => Promise<unknown>][] = [
      ["thuong", "RawPancakeCustomer", (db) => landRaw("customers", SHOP_SHOPEE, `{"data":[{"id":"KH-1"}]}`, undefined, db)],
      [
        "co_ngay",
        "RawTiktokShopAnalyticsProduct",
        (db) =>
          landRaw("tiktok/analytics_products", SHOP_TIKTOK_SHOP, `{"code":0,"data":{"products":[{"id":"P-1"}]}}`,
            undefined, db, undefined, homQuaGioVn()),
      ],
      [
        "lan_thay_co_chupLuc",
        "RawPancakeProduct",
        (db) => landRaw("products", SHOP_SHOPEE, `{"data":[{"id":"SP-1","variations":[]}]}`, undefined, db, undefined,
          undefined, new Date(Date.now() - 60_000)),
      ],
      [
        "lan_thay_khong_chupLuc",
        "RawPancakeProduct",
        (db) => landRaw("products", SHOP_SHOPEE, `{"data":[{"id":"SP-2","variations":[]}]}`, undefined, db),
      ],
    ];
    for (const [ten, bang, chay] of dang) {
      const { db, cau } = clientGhiCau();
      await chay(db);
      const insert = cau.filter((c) => c.includes(`INSERT INTO "${bang}"`));
      expect(insert, ten).toHaveLength(1);
      expect(insert[0], ten).toBe(CAU_VANG[ten]);
      expect(thanCau(insert[0]), ten).not.toMatch(/thu_tu/);
    }
  });
});

/**
 * Câu INSERT thật của BỐN dạng `landRaw` cho bảng KHÁC đơn Pancake — chụp từ `origin/main` (trước landSeq) trên PG15 local
 * (`…/scratchpad/land-seq-thi-cong/vang/cau-origin-main.json`), đối chiếu ký tự một. Đổi một ký tự câu bảng khác ⇒ đỏ.
 */
const CAU_VANG = {
  "thuong": "\n    INSERT INTO \"RawPancakeCustomer\" (\"id\", \"shopId\", \"externalId\", \"payloadHash\", \"payload\", \"fetchedAt\", \"syncLogId\")\n    -- clock_timestamp() chứ KHÔNG phải now(): now() trả mốc MỞ transaction. Từ khi bước land nằm\n    -- trong transaction có khoá tư vấn (khoa-land-don.ts), lượt phải XẾP HÀNG chờ khoá vẫn mang mốc\n    -- BEGIN của nó — tức mốc TRƯỚC lượt đang giữ khoá — nên nó land SAU mà fetchedAt lại CŨ HƠN.\n    -- Transform chọn bản fetchedAt mới nhất ⇒ khoá tuần tự hoá xong vẫn chọn nhầm bản cũ, đúng\n    -- thứ mà khoá sinh ra để chặn. clock_timestamp() đọc đồng hồ NGAY LÚC INSERT nên phản ánh đúng\n    -- thứ tự land mà khoá vừa thiết lập.\n    SELECT gen_random_uuid()::text, $2, elem->>'id', md5(elem::text), elem, clock_timestamp(), $3\n    FROM jsonb_array_elements(($1::jsonb) #> $4::text[]) AS elem\n    WHERE elem->>'id' IS NOT NULL   -- không có khoá thì không dedupe được (cần externalId)\n    ON CONFLICT (\"shopId\", \"externalId\", \"payloadHash\") DO NOTHING\n    RETURNING \"externalId\"\n    ",
  "co_ngay": "\n    INSERT INTO \"RawTiktokShopAnalyticsProduct\" (\"id\", \"shopId\", \"externalId\", \"payloadHash\", \"payload\", \"fetchedAt\", \"syncLogId\")\n    -- clock_timestamp() chứ KHÔNG phải now(): now() trả mốc MỞ transaction. Từ khi bước land nằm\n    -- trong transaction có khoá tư vấn (khoa-land-don.ts), lượt phải XẾP HÀNG chờ khoá vẫn mang mốc\n    -- BEGIN của nó — tức mốc TRƯỚC lượt đang giữ khoá — nên nó land SAU mà fetchedAt lại CŨ HƠN.\n    -- Transform chọn bản fetchedAt mới nhất ⇒ khoá tuần tự hoá xong vẫn chọn nhầm bản cũ, đúng\n    -- thứ mà khoá sinh ra để chặn. clock_timestamp() đọc đồng hồ NGAY LÚC INSERT nên phản ánh đúng\n    -- thứ tự land mà khoá vừa thiết lập.\n    SELECT gen_random_uuid()::text, $2, (elem->>'_ngay') || ':' || (elem->>'id'), md5(elem::text), elem, clock_timestamp(), $3\n    FROM (\n      SELECT elem || jsonb_build_object('_ngay', $5::text) AS elem\n      FROM jsonb_array_elements(($1::jsonb) #> $4::text[]) AS elem\n    ) AS e\n    WHERE (elem->>'_ngay') || ':' || (elem->>'id') IS NOT NULL   -- không có khoá thì không dedupe được (cần externalId)\n    ON CONFLICT (\"shopId\", \"externalId\", \"payloadHash\") DO NOTHING\n    RETURNING \"externalId\"\n    ",
  "lan_thay_co_chupLuc": "\n    INSERT INTO \"RawPancakeProduct\" (\"id\", \"shopId\", \"externalId\", \"payloadHash\", \"payload\", \"fetchedAt\", \"syncLogId\", \"mocChup\")\n    -- clock_timestamp() chứ KHÔNG phải now(): now() trả mốc MỞ transaction. Từ khi bước land nằm\n    -- trong transaction có khoá tư vấn (khoa-land-don.ts), lượt phải XẾP HÀNG chờ khoá vẫn mang mốc\n    -- BEGIN của nó — tức mốc TRƯỚC lượt đang giữ khoá — nên nó land SAU mà fetchedAt lại CŨ HƠN.\n    -- Transform chọn bản fetchedAt mới nhất ⇒ khoá tuần tự hoá xong vẫn chọn nhầm bản cũ, đúng\n    -- thứ mà khoá sinh ra để chặn. clock_timestamp() đọc đồng hồ NGAY LÚC INSERT nên phản ánh đúng\n    -- thứ tự land mà khoá vừa thiết lập.\n    SELECT gen_random_uuid()::text, $2, elem->>'id', md5(elem::text), elem, clock_timestamp(), $3, $5::timestamptz\n    FROM jsonb_array_elements(($1::jsonb) #> $4::text[]) AS elem\n    WHERE elem->>'id' IS NOT NULL   -- không có khoá thì không dedupe được (cần externalId)\n    ON CONFLICT (\"shopId\", \"externalId\", \"payloadHash\") DO NOTHING\n    RETURNING \"externalId\"\n    ",
  "lan_thay_khong_chupLuc": "\n    INSERT INTO \"RawPancakeProduct\" (\"id\", \"shopId\", \"externalId\", \"payloadHash\", \"payload\", \"fetchedAt\", \"syncLogId\", \"mocChup\")\n    -- clock_timestamp() chứ KHÔNG phải now(): now() trả mốc MỞ transaction. Từ khi bước land nằm\n    -- trong transaction có khoá tư vấn (khoa-land-don.ts), lượt phải XẾP HÀNG chờ khoá vẫn mang mốc\n    -- BEGIN của nó — tức mốc TRƯỚC lượt đang giữ khoá — nên nó land SAU mà fetchedAt lại CŨ HƠN.\n    -- Transform chọn bản fetchedAt mới nhất ⇒ khoá tuần tự hoá xong vẫn chọn nhầm bản cũ, đúng\n    -- thứ mà khoá sinh ra để chặn. clock_timestamp() đọc đồng hồ NGAY LÚC INSERT nên phản ánh đúng\n    -- thứ tự land mà khoá vừa thiết lập.\n    SELECT gen_random_uuid()::text, $2, elem->>'id', md5(elem::text), elem, clock_timestamp(), $3, (\n      SELECT max(COALESCE(o.\"mocChup\", o.\"lanThayCuoi\", o.\"fetchedAt\")) - interval '1 millisecond'\n      FROM \"RawPancakeProduct\" o\n      WHERE o.\"shopId\" = $2 AND o.\"externalId\" = elem->>'id'\n      HAVING bool_or(o.\"mocChup\" IS NOT NULL)\n    )\n    FROM jsonb_array_elements(($1::jsonb) #> $4::text[]) AS elem\n    WHERE elem->>'id' IS NOT NULL   -- không có khoá thì không dedupe được (cần externalId)\n    ON CONFLICT (\"shopId\", \"externalId\", \"payloadHash\") DO NOTHING\n    RETURNING \"externalId\", (\"mocChup\" IS NOT NULL) AS \"duoiDau\"\n    "
} as const;
