import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GHEP_VARIANT_THU_CONG,
  ghepVariantThuCong,
  type GhepVariantThuCong,
} from "@/lib/ingest/ghep-variant-thu-cong";
import { mapPancakeOrder } from "@/lib/ingest/pancake-mapping";
import { upsertOneOrder, type UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

import BIEN_THE_KHO_THAT from "../fixtures/pancake/bien-the-kho-cho-ghep-thu-cong.json";
import PAYLOAD_THAT from "../fixtures/pancake/don-shopee-one-time-product-thieu-khoa-bien-the.json";

/**
 * GHÉP BIẾN THỂ THỦ CÔNG — bảng này sửa THẲNG vào COGS nên phải bị khoá chặt cả hai phía:
 * PHẢI khớp đúng dòng đã khai, và PHẢI KHÔNG chạm được vào bất kỳ dòng nào khác.
 *
 * Bối cảnh: listing sàn chưa ghép sản phẩm kho ⇒ Pancake chụp dòng hàng thành `one_time_product`,
 * `variation_id` và `display_id` cùng null ⇒ COGS = 0 vĩnh viễn. Ghép listing bên Pancake chỉ chữa
 * đơn MỚI (đo 22/08 hai lần, đơn cũ vẫn null), nên đơn cũ phải ghép tay.
 *
 * ⚠️ HAI FIXTURE ĐỀU LÀ DỮ LIỆU THẬT, và đó là điểm mấu chốt:
 *  - `don-shopee-one-time-product-…json` = payload Pancake THẬT của chính hai đơn (gột sạch dữ
 *    liệu cá nhân bằng whitelist trường) ⇒ khoá bên TRÁI của bảng (đơn/tên/phân loại) bị ép chứng
 *    minh khớp thứ Pancake thực sự trả về.
 *  - `bien-the-kho-cho-ghep-thu-cong.json` = danh tính biến thể kho THẬT (pancakeId/sku/label đo
 *    từ prod) ⇒ khoá bên PHẢI của bảng cũng bị ép chứng minh.
 *
 * Không có fixture thứ hai thì test vẫn "xanh" khi bảng trỏ sai biến thể: helper dựng biến thể từ
 * chính bảng nên bảng luôn khớp chính nó. Đã kiểm bằng phép đột biến — đổi `variantPancakeId` hoặc
 * `nhanBienThe` của một dòng bảng PHẢI làm suite ĐỎ.
 */

type PancakeOrderThat = {
  id: string;
  items: { variation_info: { name: string; detail?: string | null } }[];
  [k: string]: unknown;
};

const DON_THAT = PAYLOAD_THAT as unknown as PancakeOrderThat[];

/** Bản sao sâu để mỗi ca tự do sửa payload mà không rò sang ca khác. */
function donThat(pancakeId: string): PancakeOrderThat {
  const d = DON_THAT.find((o) => o.id === pancakeId);
  if (!d) throw new Error(`Fixture thiếu đơn ${pancakeId}`);
  return JSON.parse(JSON.stringify(d)) as PancakeOrderThat;
}

type BienTheKhoThat = {
  variantPancakeId: string;
  sku: string;
  label: string;
  productPancakeId: string;
  productName: string;
};

const BIEN_THE_THAT = BIEN_THE_KHO_THAT as unknown as BienTheKhoThat[];

/**
 * Dựng biến thể kho TỪ FIXTURE THẬT — KHÔNG lấy giá trị từ bảng ghép tay (nếu lấy thì bảng luôn
 * khớp chính nó và mọi sai sót trong bảng đều vô hình).
 * `doi.label` để dựng ca "UUID còn nhưng đã trỏ hàng khác".
 */
async function taoVariantThat(
  variantPancakeId: string,
  doi?: { label?: string; costPrice?: number; sku?: string; sanPhamPancakeId?: string }
): Promise<string> {
  const bt = BIEN_THE_THAT.find((b) => b.variantPancakeId === variantPancakeId);
  if (!bt) throw new Error(`Fixture biến thể kho thiếu ${variantPancakeId}`);
  const nowD = new Date();
  const p = await prisma.product.create({
    data: { pancakeId: doi?.sanPhamPancakeId ?? bt.productPancakeId, name: bt.productName, syncedAt: nowD },
  });
  const v = await prisma.variant.create({
    data: {
      productId: p.id,
      pancakeId: bt.variantPancakeId,
      sku: doi?.sku ?? bt.sku,
      label: doi?.label ?? bt.label,
      sellPrice: 350000,
      stock: 5,
      costPrice: doi?.costPrice ?? 120000,
      syncedAt: nowD,
    },
  });
  return v.id;
}

/** Biến thể "của Pancake" — danh tính bịa, cố ý KHÔNG dính fixture, để phân biệt với bảng ghép tay. */
async function taoVariantPancakeThat(): Promise<string> {
  const nowD = new Date();
  const p = await prisma.product.create({
    data: { pancakeId: "P-PANCAKE-THAT", name: "SP có khoá Pancake", syncedAt: nowD },
  });
  const v = await prisma.variant.create({
    data: {
      productId: p.id,
      pancakeId: "uuid-pancake-that",
      sku: "SKU-PANCAKE-THAT",
      label: "Nhãn Pancake thật",
      sellPrice: 350000,
      stock: 5,
      costPrice: 999000,
      syncedAt: nowD,
    },
  });
  return v.id;
}

function statsRong(): UpsertStats {
  return {
    ordersUpserted: 0,
    productsUpserted: 0,
    variantsUpserted: 0,
    ordersSkippedMirror: 0,
    ordersSkippedStale: 0,
    ordersDiscardedGiuaChung: 0,
    skipped: 0,
    boQuaCoChuDich: 0,
    unknownStatusOrders: 0,
    settlementsUpserted: 0,
    adsUpserted: 0,
    paymentsUpserted: 0,
    shopeeUpserted: 0,
    adsExpensesUpserted: 0,
  };
}

async function ghiDon(raw: Record<string, unknown>): Promise<{
  dong: { variantId: string | null; sku: string; productName: string }[];
  canhBao: string[];
}> {
  const canhBao: string[] = [];
  const mo = mapPancakeOrder(raw as never, { channels: {} });
  await upsertOneOrder(mo, raw, statsRong(), canhBao);
  const dong = await prisma.orderItem.findMany({
    where: { order: { pancakeId: String(raw.id) } },
    select: { variantId: true, sku: true, productName: true },
    orderBy: { productName: "asc" },
  });
  return { dong, canhBao };
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

describe("bảng ghép tay phải khớp PAYLOAD THẬT, không tự khẳng định", () => {
  it("mỗi dòng bảng có payload thật kèm theo — thêm dòng mà không kèm bằng chứng là ĐỎ", () => {
    for (const g of GHEP_VARIANT_THU_CONG) {
      const d = DON_THAT.find((o) => o.id === g.pancakeId);
      expect(d, `fixture thiếu payload thật cho đơn ${g.pancakeId}`).toBeDefined();
      const khop = d!.items.some(
        (it) => it.variation_info.name === g.productName && (it.variation_info.detail ?? "") === g.variantDetail
      );
      expect(khop, `payload thật của ${g.pancakeId} không có dòng khớp tên+phân loại đã khai`).toBe(true);
    }
  });

  it("mỗi dòng bảng trỏ vào biến thể kho CÓ THẬT, khớp cả nhãn lẫn sku", () => {
    for (const g of GHEP_VARIANT_THU_CONG) {
      const bt = BIEN_THE_THAT.find((b) => b.variantPancakeId === g.variantPancakeId);
      expect(bt, `không có biến thể kho nào mang pancakeId ${g.variantPancakeId}`).toBeDefined();
      expect(bt!.label, `nhãn khai lệch nhãn kho thật (đơn ${g.pancakeId})`).toBe(g.nhanBienThe);
      expect(bt!.sku, `sku khai lệch sku kho thật (đơn ${g.pancakeId})`).toBe(g.skuKho);
      expect(bt!.productPancakeId, `sản phẩm khai lệch sản phẩm kho thật (đơn ${g.pancakeId})`).toBe(
        g.sanPhamPancakeId
      );
    }
  });

  it("mỗi khoá chỉ khai MỘT lần — hai dòng cùng khoá là bảng hỏng, ghép ra kết quả tuỳ thứ tự", () => {
    const khoa = GHEP_VARIANT_THU_CONG.map((g) => `${g.pancakeId}|${g.productName}|${g.variantDetail}`);
    expect(new Set(khoa).size).toBe(khoa.length);
  });

  it("mọi dòng đều khai căn cứ — không cho ghép suông", () => {
    for (const g of GHEP_VARIANT_THU_CONG) expect(g.canCu.trim().length).toBeGreaterThan(0);
  });
});

describe("ghepVariantThuCong — so khớp BẰNG NHAU TUYỆT ĐỐI, không dò tên", () => {
  const G = GHEP_VARIANT_THU_CONG[0];

  it("khớp đủ ba phần → trả đúng dòng bảng", () => {
    expect(
      ghepVariantThuCong({ pancakeId: G.pancakeId, productName: G.productName, variantDetail: G.variantDetail })
    ).toEqual(G);
  });

  // Lệch một mẩu ở BẤT KỲ phần nào của khoá đều phải trượt. Thà bỏ sót (COGS 0, có cảnh báo) còn
  // hơn ghép nhầm biến thể — ghép nhầm là COGS sai mà không cảnh báo nào kêu.
  it.each([
    ["đơn khác", { pancakeId: "MAU-DON-0009" }],
    ["tên thiếu một ký tự", { productName: G.productName.slice(0, -1) }],
    ["tên thừa khoảng trắng", { productName: `${G.productName} ` }],
    ["tên khác hoa/thường", { productName: G.productName.toLowerCase() }],
    ["phân loại khác", { variantDetail: "Phân loại A,Cỡ 9" }],
    ["phân loại thêm khoảng trắng sau dấu phẩy", { variantDetail: G.variantDetail.replace(",", ", ") }],
    ["phân loại rỗng", { variantDetail: "" }],
  ])("KHÔNG khớp khi %s", (_ten, doi) => {
    expect(
      ghepVariantThuCong({
        pancakeId: G.pancakeId,
        productName: G.productName,
        variantDetail: G.variantDetail,
        ...doi,
      })
    ).toBeUndefined();
  });
});

describe("upsert trên PAYLOAD THẬT — mọi dòng bảng đều bị ép chứng minh", () => {
  it.each(GHEP_VARIANT_THU_CONG.map((g) => [g.pancakeId, g] as const))(
    "đơn %s: ghép đúng biến thể, ghi sku làm dấu vết, để lại cảnh báo",
    async (_id, g) => {
      const variantId = await taoVariantThat(g.variantPancakeId);

      const { dong, canhBao } = await ghiDon(donThat(g.pancakeId) as unknown as Record<string, unknown>);

      const d = dong.find((x) => x.productName === g.productName);
      expect(d, "không tìm thấy dòng hàng vừa ghi").toBeDefined();
      expect(d!.variantId).toBe(variantId);
      // Dấu vết BỀN: đọc được bằng SQL sau khi log đã trôi.
      expect(d!.sku).toBe(g.skuKho);
      expect(canhBao.some((c) => c.includes("THỦ CÔNG") && c.includes(g.pancakeId))).toBe(true);
      // Ghép xong rồi mà vẫn kêu "không khớp variant" là báo động giả.
      expect(canhBao.some((c) => c.includes("không khớp variant"))).toBe(false);
    }
  );

  it("sku kho ĐÃ ĐỔI → ghi sku HIỆN HÀNH vào OrderItem, không ghi bản khai trong bảng", async () => {
    // `Variant.sku` bị lượt ingest products ghi đè mỗi đêm, nên `skuKho` trong bảng có thể cũ.
    // Dấu vết phải trỏ đúng chỗ hiện tại, nếu không nó dẫn người đọc tới sku không còn tồn tại.
    const g = GHEP_VARIANT_THU_CONG[0];
    const variantId = await taoVariantThat(g.variantPancakeId, { sku: "SKU-DA-DOI-SAU-KHI-KHAI" });

    const { dong, canhBao } = await ghiDon(donThat(g.pancakeId) as unknown as Record<string, unknown>);

    const d = dong.find((x) => x.productName === g.productName)!;
    expect(d.variantId).toBe(variantId); // khoá chọn vẫn là pancakeId ⇒ vẫn ghép được
    expect(d.sku).toBe("SKU-DA-DOI-SAU-KHI-KHAI");
    expect(d.sku).not.toBe(g.skuKho);
    expect(canhBao.some((c) => c.includes("SKU-DA-DOI-SAU-KHI-KHAI"))).toBe(true);
  });

  it("nhãn biến thể LỆCH khai báo → TỪ CHỐI ghép (UUID còn nhưng đã trỏ hàng khác)", async () => {
    const g = GHEP_VARIANT_THU_CONG[0];
    await taoVariantThat(g.variantPancakeId, { label: "Phân loại A / Cỡ 9" });

    const { dong, canhBao } = await ghiDon(donThat(g.pancakeId) as unknown as Record<string, unknown>);

    const d = dong.find((x) => x.productName === g.productName)!;
    expect(d.variantId).toBeNull();
    // sku PHẢI rỗng: từ chối ghép mà vẫn ghi sku kho thì P&L xếp dòng vào rổ "sửa được ở màn Sản
    // phẩm" trong khi màn đó (lọc theo variantId) không hề có nó — đúng nghịch lý đang tránh.
    expect(d.sku).toBe("");
    expect(canhBao.some((c) => c.includes("TỪ CHỐI ghép thủ công"))).toBe(true);
  });

  it("SẢN PHẨM lệch khai báo (nhãn vẫn khớp) → TỪ CHỐI ghép", async () => {
    // Nhãn phân loại dùng chung giữa nhiều sản phẩm, nên chép nhầm UUID sang SP khác cùng nhãn sẽ
    // lọt nếu chỉ đối chứng nhãn. Ca này khoá phần đối chứng thứ hai.
    const g = GHEP_VARIANT_THU_CONG[0];
    await taoVariantThat(g.variantPancakeId, { sanPhamPancakeId: "SP-KHAC-HOAN-TOAN" });

    const { dong, canhBao } = await ghiDon(donThat(g.pancakeId) as unknown as Record<string, unknown>);

    const d = dong.find((x) => x.productName === g.productName)!;
    expect(d.variantId).toBeNull();
    expect(d.sku).toBe("");
    expect(canhBao.some((c) => c.includes("TỪ CHỐI ghép thủ công"))).toBe(true);
  });

  it("bảng trỏ biến thể không tồn tại → kêu ĐÚNG là bảng hỏng, không lẫn lỗi thiếu dữ liệu", async () => {
    const g = GHEP_VARIANT_THU_CONG[0];
    // KHÔNG tạo biến thể nào.
    const { dong, canhBao } = await ghiDon(donThat(g.pancakeId) as unknown as Record<string, unknown>);

    expect(dong.find((x) => x.productName === g.productName)!.variantId).toBeNull();
    expect(canhBao.some((c) => c.includes("kiểm lại ghep-variant-thu-cong.ts"))).toBe(true);
  });
});

describe("bảng ghép tay KHÔNG với tới dòng Pancake còn khoá", () => {
  const G = GHEP_VARIANT_THU_CONG[0];

  it("dòng CÓ display_id → theo Pancake, bảng tay không đè", async () => {
    await taoVariantThat(G.variantPancakeId);
    const variantThat = await taoVariantPancakeThat();

    const raw = donThat(G.pancakeId);
    (raw.items[0].variation_info as Record<string, unknown>).display_id = "SKU-PANCAKE-THAT";

    const { dong, canhBao } = await ghiDon(raw as unknown as Record<string, unknown>);

    expect(dong[0].variantId).toBe(variantThat);
    expect(canhBao.some((c) => c.includes("THỦ CÔNG"))).toBe(false);
  });

  it("dòng CÓ variation_id → theo Pancake, bảng tay không đè", async () => {
    await taoVariantThat(G.variantPancakeId);
    const variantThat = await taoVariantPancakeThat();

    const raw = donThat(G.pancakeId);
    (raw.items[0] as Record<string, unknown>).variation_id = "uuid-pancake-that";

    const { dong, canhBao } = await ghiDon(raw as unknown as Record<string, unknown>);

    expect(dong[0].variantId).toBe(variantThat);
    expect(canhBao.some((c) => c.includes("THỦ CÔNG"))).toBe(false);
  });

  /**
   * ĐƠN NHIỀU DÒNG — bắt lỗi lệch pha chỉ số. Nếu ai đó đổi `map` thành `filter().map()` khi tính
   * bảng ghép tay thì biến thể sẽ dán sang NHẦM DÒNG của cùng đơn. Prod CÓ shape này thật (đơn
   * MAU-DON-0003 3 dòng mất khoá), và đơn 1 dòng không bao giờ lộ ra.
   */
  it("đơn 2 dòng: dòng có khoá Pancake và dòng ghép tay không dán nhầm nhau", async () => {
    const variantTay = await taoVariantThat(G.variantPancakeId);
    const variantThat = await taoVariantPancakeThat();

    const raw = donThat(G.pancakeId);
    const dongCoKhoa = JSON.parse(JSON.stringify(raw.items[0])) as Record<string, unknown>;
    dongCoKhoa.variation_id = "uuid-pancake-that";
    (dongCoKhoa.variation_info as Record<string, unknown>).name = "SP KHÁC có khoá Pancake";
    // Dòng có khoá đứng TRƯỚC dòng ghép tay ⇒ chỉ số của dòng ghép tay là 1, không phải 0.
    raw.items = [dongCoKhoa as never, raw.items[0]];

    const { dong } = await ghiDon(raw as unknown as Record<string, unknown>);

    expect(dong.find((x) => x.productName === "SP KHÁC có khoá Pancake")!.variantId).toBe(variantThat);
    expect(dong.find((x) => x.productName === G.productName)!.variantId).toBe(variantTay);
  });

  it("dòng không khoá và KHÔNG có trong bảng vẫn để variantId null + kêu như cũ", async () => {
    const raw = donThat(G.pancakeId);
    (raw.items[0].variation_info as Record<string, unknown>).name = "SP lạ không khai trong bảng";

    const { dong, canhBao } = await ghiDon(raw as unknown as Record<string, unknown>);

    expect(dong[0].variantId).toBeNull();
    expect(canhBao.some((c) => c.includes("không khớp variant"))).toBe(true);
    expect(canhBao.some((c) => c.includes("THỦ CÔNG"))).toBe(false);
  });
});
