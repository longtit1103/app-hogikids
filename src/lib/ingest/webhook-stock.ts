import { z } from "zod";

import { layCauHinhShop, layWarehouseKhoTong } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import { parseVnDate } from "./pancake-mapping";

/**
 * Tồn kho REALTIME từ sự kiện webhook Pancake `variations_warehouses`.
 *
 * Phân vai giữ nguyên như đơn hàng (user chốt 2026-07-27): **webhook làm TƯƠI, API là CHUẨN.**
 * Sự kiện chỉ được ghi khi nó mang trạng thái MỚI HƠN cái API đã khẳng định; mỗi lượt vá tồn từ
 * Bronze (`/api/ingest/resync-products`) trả quyền quyết định về cho API.
 *
 * VÌ SAO GHI THẲNG SILVER, KHÔNG QUA BRONZE (khác đường đơn hàng — cố ý):
 *  - Raw đã được giữ vĩnh viễn ở hộp thư `RawPancakeWebhookEvent` (payload nguyên xi, không hạn dọn)
 *    ⇒ Bronze không thêm được khả năng dựng lại nào.
 *  - Land vào Bronze sẽ tái tạo đúng quả mìn đã bắt được ở pha 2: dòng nội-dung-cũ mà `fetchedAt`
 *    mới THẮNG ở mọi lần `rebuild-from-raw` về sau. Tồn kho không có báo cáo nào đọc lịch sử ⇒ chịu
 *    rủi ro đó để đổi lấy 0 lợi ích.
 *  - Ta chỉ chạm ĐÚNG cột `stock` (+ mốc `stockUpdatedAt`), không upsert cả dòng, nên không dính
 *    bẫy "field vắng xoá mất số API" đã loại `products` khỏi phạm vi webhook.
 *
 * Toàn bộ hằng số + luật dưới đây rút từ số đo 114 sự kiện `variations_warehouses` thật trong hộp
 * thư prod (2026-07-27). CỠ MẪU THẬT SỰ CỦA SHOP KHO NHỎ: chỉ 9 sự kiện / 4 biến thể (105 sự kiện
 * còn lại là của shop bán, không dùng được) — đủ để chốt shape và ngữ nghĩa field, KHÔNG đủ để nói
 * "đã phủ mọi ca".
 *
 * PHIẾU NHẬP KHO: ĐÃ CÓ MẪU THẬT (2026-09-04, phiếu 8 mã × 30 cái). Pancake CÓ bắn, độ trễ 1 giây,
 * 8/8 mã ghi đúng, 0 ca `ton-kho-can-xem`. Shape khác sự kiện đơn hàng ở ba chỗ: **`order_id` vắng
 * hẳn**, `change_quantity` dương, `is_actual_remain_quantity` = `true` (`remain` vẫn khác `actual`
 * được khi có hàng đang giữ cho đơn chưa xuất). `order_id` là `nullish()` chính vì ca này — siết
 * thành bắt buộc là mọi phiếu nhập rơi vào `ton-kho-can-xem`; lưới giữ ở
 * `tests/bronze/webhook-ton-kho.test.ts` ("phiếu nhập kho").
 *
 * CHỈNH TỒN TAY: ĐÃ CÓ MẪU THẬT (đo hộp thư prod 2026-09-25, đối chiếu `RawPancakeInventoryHistory`
 * khớp tới micro-giây): "Điều chỉnh từ phiếu kiểm hàng" (4 sự kiện 21/08, `change_quantity=-5`) và
 * "Xuất kho" tay không đơn (20 sự kiện 09/09, `change_quantity=-30`) — cùng shape `order_id` vắng +
 * `change_quantity` ÂM. Hàm dưới KHÔNG rẽ nhánh theo `order_id`/`change_quantity` (chỉ ghi vào `note`),
 * mọi nguồn biến động đi chung một đường ghi `remain_quantity` ⇒ đúng-by-construction, không cần sửa.
 *
 * Ca CÒN chưa từng thấy trong mẫu: kho thứ hai (962/962 sự kiện shop Kho tới 25/09 đều 1 `warehouse_id`).
 */

/*
 * Kho hàng DUY NHẤT của shop Kho Tổng — đo 2026-07-27: mỗi shop Pancake có đúng 1 `warehouse_id`
 * và 3 shop là 3 kho khác nhau. Id nằm ở cấu hình `Setting` key `pancakeWarehouseIdKhoTong`
 * (clone-and-go 2026-08-21 — kho của bản clone mang uuid khác), đọc qua `layWarehouseKhoTong()`.
 *
 * Guard bắt buộc chứ không phải phòng xa: mở kho thứ hai thì `remain_quantity` trở thành tồn
 * TỪNG KHO, ghi thẳng vào `Variant.stock` sẽ báo thiếu hàng trong khi kho kia còn. Sự kiện mang
 * `warehouse_id` lạ được đẩy lên panel `/cai-dat#ket-noi` để chủ shop biết mà vào sửa, KHÔNG nuốt.
 */

/**
 * Shape sự kiện — đo 114/114 sự kiện đều có đủ 9 khoá này, không sự kiện nào thiếu.
 *
 * `remain_quantity` là field ĐÚNG, và lý do gốc KHÔNG phải "khớp 4/4" mà là BẢN CHẤT: hai số này
 * đo hai thứ khác nhau — `remain_quantity` là tồn KHẢ DỤNG (đã trừ hàng đang giữ cho đơn chưa xuất),
 * `actual_remain_quantity` là tồn VẬT LÝ còn trong kho (đo prod: 66/71 sự kiện hai số khác nhau, và
 * cờ `is_actual_remain_quantity` cho biết hai số đã bằng nhau chưa). App phải dùng KHẢ DỤNG vì màn
 * Tồn kho trả lời câu "còn bán được bao nhiêu". Đó cũng đúng field mà đường API đang map sang
 * `Variant.stock` (`pancake-mapping.ts`) ⇒ hai nguồn nói cùng một thứ tiếng, không lệch định nghĩa.
 * Đối chiếu số thật khớp `Variant.stock` 4/4 (remain) so với 3/4 (actual) — khớp với suy luận trên.
 *
 * `.passthrough()` theo lệ chung: Pancake thêm field không được làm vỡ nhánh xử lý.
 */
const suKienTonKhoSchema = z
  .object({
    variation_id: z.string().min(1),
    warehouse_id: z.string().min(1),
    remain_quantity: z.coerce.number().int(),
    /** Mốc Pancake tạo sự kiện, naive = giờ UTC (bất biến #3) — dùng làm số phiên bản. */
    inserted_at: z.string().min(1),
    /** Chỉ để ghi chú chẩn đoán (đơn nào làm tồn đổi), không tham gia quyết định. */
    order_id: z.string().nullish(),
  })
  .passthrough();

/**
 * Kết quả xử lý một sự kiện tồn kho — `note` hiện trên panel khi cần người xem.
 *
 * `chua-co-bien-the` tách RIÊNG khỏi `can-xem` có chủ đích: nó TỰ LÀNH (lượt API kế tiếp tạo biến
 * thể rồi tồn đúng theo API), nên gộp nó vào nhóm báo đỏ sẽ làm hộp đỏ kêu vì chuyện không cần ai
 * làm gì — đúng thói quen "đỏ mãi rồi thôi không xem" mà panel này sinh ra để chống.
 */
export type KetQuaTonKho = {
  ket: "ghi" | "cu-hon" | "bo-qua" | "chua-co-bien-the" | "chua-cau-hinh" | "can-xem";
  note?: string;
};

/**
 * Trần tồn hợp lệ. Tồn ÂM là HỢP LỆ (bán vượt — Pancake cho phép, đã đo), nên chỉ chặn giá trị
 * vô lý về ĐỘ LỚN: một con số rác lọt vào sẽ đẩy trang Tồn kho sang cảnh báo sai hàng loạt.
 */
const TON_TOI_DA = 1_000_000;

/**
 * Xử lý 1 sự kiện `variations_warehouses`.
 *
 * Không throw: mọi ca bất thường trả về kết cục có ghi chú để dòng hộp thư ghi lại được. Chuỗi
 * guard theo đúng thứ tự "rẻ trước, đụng DB sau".
 */
export async function xuLyTonKho(shopId: string, payload: string): Promise<KetQuaTonKho> {
  // 1. CHỈ shop Kho Tổng. Đo 2026-07-27: variation_id của shop bán khớp catalog app 0/29 (mỗi shop
  //    Pancake đánh UUID riêng cho cùng một món) ⇒ nhận sự kiện shop bán là ghi nhầm biến thể hoặc
  //    (thường hơn) không tra ra gì. Catalog app dựng từ shop Kho — bất biến #5.
  const { kho } = await layCauHinhShop();
  if (shopId !== kho) {
    return { ket: "bo-qua", note: "sự kiện shop bán — bộ mã biến thể riêng, không khớp catalog app" };
  }

  let duLieu: z.infer<typeof suKienTonKhoSchema>;
  try {
    const parsed = suKienTonKhoSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) {
      return { ket: "can-xem", note: `sự kiện tồn kho sai shape: ${parsed.error.issues[0]?.message}` };
    }
    duLieu = parsed.data;
  } catch {
    return { ket: "can-xem", note: "sự kiện tồn kho không phải JSON hợp lệ" };
  }

  // 2. Đúng kho. Kho lạ ⇒ `remain_quantity` không còn là tồn TOÀN SHOP (xem chú thích đầu file).
  //    Chưa cấu hình warehouse id ⇒ bỏ qua CÓ KẾT CỤC — nightly vẫn vá tồn từ API, không hỏng câm.
  const warehouseKhoTong = await layWarehouseKhoTong();
  if (!warehouseKhoTong) {
    // KHÔNG phải "can-xem": mỗi sự kiện một dòng đỏ sẽ ngập panel bằng cùng một thông điệp lặp
    // lại và che mất sự kiện lạ THẬT. Thiếu cấu hình đã lộ sẵn ở khối "Khóa kết nối" (ô
    // Warehouse ID trống) — kết cục riêng, không tính cần-xem (cùng lối với `chua-co-bien-the`).
    return {
      ket: "chua-cau-hinh",
      note: "chưa cấu hình pancakeWarehouseIdKhoTong (/cai-dat) — tồn kho realtime đang tắt, lượt API đêm vẫn vá",
    };
  }
  if (duLieu.warehouse_id !== warehouseKhoTong) {
    return {
      ket: "can-xem",
      note:
        `kho lạ ${duLieu.warehouse_id} (đang chỉ nhận ${warehouseKhoTong}) — ` +
        `shop có kho thứ hai thì tồn phải cộng theo từng kho, KHÔNG ghi thẳng số này`,
    };
  }

  // 3. Giá trị dùng được. Tồn âm HỢP LỆ (oversell) nên chỉ chặn độ lớn vô lý.
  const ton = duLieu.remain_quantity;
  if (!Number.isFinite(ton) || Math.abs(ton) > TON_TOI_DA) {
    return { ket: "can-xem", note: `remain_quantity vô lý: ${duLieu.remain_quantity}` };
  }

  const mocSuKien = mocTuInsertedAt(duLieu.inserted_at);
  if (Number.isNaN(mocSuKien.getTime())) {
    return { ket: "can-xem", note: `inserted_at sai định dạng: ${duLieu.inserted_at}` };
  }

  const bienThe = await prisma.variant.findUnique({
    where: { pancakeId: duLieu.variation_id },
    select: { id: true, sku: true, stock: true, syncedAt: true, stockUpdatedAt: true },
  });

  // 4. Chưa có biến thể trong app (sản phẩm mới, lượt API chưa kịp tạo). KHÔNG tự tạo: Variant mới
  //    kéo theo Product + `costPrice` APP-OWNED, mà sự kiện tồn kho không mang thông tin nào trong
  //    số đó — đẻ ra ở đây là lặp đúng lỗi đã loại `products` khỏi phạm vi webhook.
  if (!bienThe) {
    return {
      ket: "chua-co-bien-the",
      note: `chưa có biến thể ${duLieu.variation_id} trong app — chờ lượt API tạo rồi tồn sẽ tự đúng`,
    };
  }

  // 5. GUARD THỨ TỰ — API MẠNH HƠN WEBHOOK (luật user chốt 2026-07-27).
  //    `syncedAt`       = lần cuối API ghi biến thể này;
  //    `stockUpdatedAt` = mốc sự kiện webhook gần nhất đã ghi.
  //    Chỉ ghi khi sự kiện MỚI HƠN CẢ HAI: cũ hơn `syncedAt` nghĩa là API đã nhìn Pancake sau thời
  //    điểm sự kiện chụp (số API mới hơn); cũ hơn `stockUpdatedAt` nghĩa là hai sự kiện tới lệch
  //    thứ tự, ghi tiếp sẽ làm tồn lùi về quá khứ.
  const mocDangCo = mocMoiHon(bienThe.syncedAt, bienThe.stockUpdatedAt);
  if (mocSuKien.getTime() <= mocDangCo.getTime()) {
    return {
      ket: "cu-hon",
      note:
        `sự kiện chụp ${duLieu.inserted_at}, tồn hiện tại đã được xác nhận lúc ` +
        `${mocDangCo.toISOString()} — bỏ qua để tồn không thụt lùi`,
    };
  }

  // 6. GHI CÓ ĐIỀU KIỆN, một câu lệnh.
  //    Guard ở bước 5 đọc trước rồi mới ghi ⇒ hai sự kiện của cùng biến thể chạy song song (n8n
  //    bắn 2 execution cách nhau vài chục ms — đã thấy trong hộp thư) đều có thể đọc cùng một mốc
  //    cũ rồi lần lượt ghi, bản CŨ ghi sau sẽ thắng. Lặp lại điều kiện ngay trong WHERE khiến
  //    Postgres tự phân xử: chỉ đúng một bản thắng, và luôn là bản mới hơn.
  //    CHỈ 2 cột. TUYỆT ĐỐI không đụng `costPrice`/`lowStockThreshold` (APP-OWNED) và cũng không
  //    đụng `syncedAt` — mốc đó thuộc về API, giữ nguyên nghĩa "lần cuối API ghi".
  const soDongGhi = await prisma.variant.updateMany({
    where: {
      id: bienThe.id,
      syncedAt: { lt: mocSuKien },
      OR: [{ stockUpdatedAt: null }, { stockUpdatedAt: { lt: mocSuKien } }],
    },
    data: { stock: ton, stockUpdatedAt: mocSuKien },
  });
  if (soDongGhi.count === 0) {
    return { ket: "cu-hon", note: "một sự kiện mới hơn đã ghi trước (chạy song song) — bỏ qua bản này" };
  }

  if (bienThe.stock === ton) {
    return { ket: "ghi", note: `tồn không đổi (${ton}) — đã cập nhật mốc` };
  }
  const doDon = duLieu.order_id ? ` (đơn ${duLieu.order_id})` : "";
  return { ket: "ghi", note: `${bienThe.sku}: ${bienThe.stock} → ${ton}${doDon}` };
}

/**
 * `inserted_at` → instant, GIỮ phần mili giây.
 *
 * Dùng `parseVnDate` để thừa hưởng đúng luật neo UTC cho datetime naive (bất biến #3) và khả năng
 * chịu cả separator "T" lẫn khoảng trắng — TUYỆT ĐỐI không viết lại luật đó ở đây. Sự kiện tồn kho
 * có mốc tới micro-giây và hai sự kiện của CÙNG một biến thể có thể cách nhau dưới 1 giây (đo
 * prod: 10–60ms); mất phần lẻ ⇒ guard `<=` loại nhầm sự kiện đến sau, tồn kẹt ở giá trị cũ.
 * `parseVnDate` NAY tự giữ phần lẻ tới mili — bản cũ cắt mất nên hàm này từng phải cộng bù lại;
 * giữ lại wrapper để chỗ gọi nói rõ ý "mốc cần mili" và làm chỗ đứng nếu sau này cần tới micro.
 */
function mocTuInsertedAt(s: string): Date {
  return parseVnDate(s);
}

/** Mốc muộn hơn giữa "API ghi lần cuối" và "webhook ghi lần cuối". */
function mocMoiHon(syncedAt: Date, stockUpdatedAt: Date | null): Date {
  if (!stockUpdatedAt) return syncedAt;
  return stockUpdatedAt.getTime() > syncedAt.getTime() ? stockUpdatedAt : syncedAt;
}
