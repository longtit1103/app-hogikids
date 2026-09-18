/**
 * GHÉP BIẾN THỂ THỦ CÔNG — bảng dữ liệu TƯỜNG MINH, dùng làm nhánh CUỐI khi Pancake không
 * trả khoá nào để tra biến thể.
 *
 * VÌ SAO CẦN: listing sàn chưa ghép sản phẩm kho thì Pancake chụp dòng hàng thành sản phẩm
 * tạo-nhanh riêng của đơn (`one_time_product: true`) với `variation_id` = null VÀ
 * `variation_info.display_id` = null. Mất cả hai khoá ⇒ `OrderItem.variantId` = null ⇒ COGS của
 * dòng đó bằng 0 vĩnh viễn, mà màn Sản phẩm KHÔNG chứa dòng này nên chủ shop cũng không có ô nào
 * để nhập giá vốn. Ghép listing bên Pancake chỉ chữa được đơn MỚI — đo thật hai lần (22/08 11:2x
 * và 14:51, sau khi chủ shop nối lại) đều thấy dòng hàng CŨ vẫn null: Pancake đóng băng dòng hàng
 * lúc tạo đơn, không hồi tố.
 *
 * PHẠM VI CỐ Ý HẸP — đây KHÔNG phải cơ chế dò tên:
 *  - Khoá gồm ĐỦ BA phần và so khớp BẰNG NHAU TUYỆT ĐỐI (không lowercase, không trim, không
 *    `includes`/`ilike`): `pancakeId` của đơn + tên sản phẩm + phân loại, đúng như payload trả về.
 *  - Khoá đơn dùng `pancakeId` chứ KHÔNG dùng `code`: mã đơn đã có ca trùng nhau trong cùng một
 *    kênh, nên `code` không định danh được đơn.
 *  - Chỉ chạy khi CẢ HAI khoá của Pancake đều trượt. Dòng có `display_id` hay `variation_id` bình
 *    thường không bao giờ đi qua đây, nên bảng này không thể đổi số của đơn khác.
 *
 * TRỎ BẰNG `Variant.pancakeId`, KHÔNG PHẢI `sku` HAY `id`:
 *  - `Variant.id` là cuid do DB sinh — dựng lại sản phẩm là đổi, ghim vào đây sẽ chết câm.
 *  - `Variant.sku` = `display_id` bên Pancake, KHÔNG unique (đã đo trên prod — số liệu ở
 *    `docs/tu-dien-du-lieu-bronze.md` §2b) và bị lượt ingest products GHI ĐÈ mỗi đêm. Pancake đổi
 *    `display_id` của một biến thể là ghim nhảy sang biến thể khác, COGS đổi số mà cảnh báo vẫn y
 *    hệt lúc đúng.
 *  - `Variant.pancakeId` là UUID Pancake, `@unique`, và chính là khoá upsert của biến thể nên sống
 *    qua mọi lượt dựng lại.
 *
 * ĐỐI CHỨNG BẮT BUỘC — HAI phần, phải khớp CẢ HAI mới ghép:
 *  - `nhanBienThe` = `Variant.label` mong đợi. MỘT MÌNH nó KHÔNG đủ: rất nhiều biến thể trong kho
 *    dùng chung một nhãn phân loại (đo prod — số ở `docs/tu-dien-du-lieu-bronze.md` §2b), nên chép
 *    nhầm UUID sang một sản phẩm KHÁC cùng phân loại vẫn lọt nếu chỉ so nhãn.
 *  - `sanPhamPancakeId` = `Product.pancakeId` của sản phẩm chứa biến thể. Đây là phần chặn đúng ca
 *    trên: hai biến thể cùng nhãn mà khác sản phẩm thì lệch ngay.
 * Lệch bất kỳ phần nào ⇒ TỪ CHỐI ghép và kêu to. Không có đối chứng thì ca "UUID vẫn còn nhưng đã
 * trỏ sang hàng khác" sẽ sửa COGS trong im lặng.
 *
 * ⚠️ RỦI RO CÓ CHỦ ĐÍCH — nhãn là dữ liệu Pancake, bị ingest products ghi đè MỖI ĐÊM. Chủ shop dọn
 * lại tên phân loại bên Pancake ⇒ lượt dựng lại kế tiếp `nhanLech` ⇒ TỪ CHỐI ghép ⇒ COGS tụt về 0.
 * Hướng đổ là AN TOÀN cho tiền (thà 0 còn hơn sai) nhưng người dùng chỉ thấy qua warning trong
 * SyncLog. Chấp nhận trong lượt này; muốn hết thì phải đưa cảnh báo ra UI /cai-dat.
 *
 * THÊM DÒNG MỚI: chỉ khi đã xác minh dòng hàng đó bán đúng biến thể nào (chủ shop xác nhận trên
 * listing sàn) VÀ Pancake không còn đường nào trả khoá về. Ghép sai = COGS sai = lãi sai.
 */

export type GhepVariantThuCong = {
  /** `RawPancakeOrder.payload.id` = `Order.pancakeId`. Định danh đơn thật (mã đơn có ca trùng). */
  pancakeId: string;
  /** `items[].variation_info.name` — SO KHỚP TUYỆT ĐỐI, giữ nguyên từng ký tự payload trả. */
  productName: string;
  /** `items[].variation_info.detail` — phân loại. SO KHỚP TUYỆT ĐỐI. */
  variantDetail: string;
  /** `Variant.pancakeId` (UUID Pancake, unique, sống qua dựng lại) của biến thể kho tương ứng. */
  variantPancakeId: string;
  /** `Variant.label` mong đợi — ĐỐI CHỨNG 1/2. Lệch ⇒ từ chối ghép (xem docblock đầu file). */
  nhanBienThe: string;
  /**
   * `Product.pancakeId` của sản phẩm chứa biến thể — ĐỐI CHỨNG 2/2. Bắt buộc vì nhãn dùng chung
   * giữa nhiều sản phẩm, một mình nhãn không phân biệt được.
   */
  sanPhamPancakeId: string;
  /** `Variant.sku` lúc khai — chỉ để người đọc tra tay, KHÔNG dùng làm khoá (sku không unique). */
  skuKho: string;
  /** Vì sao ghép như vậy — để người sau kiểm lại được, không phải tin suông. */
  canCu: string;
};

export const GHEP_VARIANT_THU_CONG: readonly GhepVariantThuCong[] = [
  {
    pancakeId: "MAU-DON-0001", // dòng 1 — hồ sơ ở docs/tu-dien-du-lieu-bronze.md §2b
    productName: "LISTING-01 - Sản phẩm mẫu A",
    variantDetail: "Phân loại A,Cỡ 1",
    variantPancakeId: "00000000-0000-4000-8000-000000000001",
    nhanBienThe: "Phân loại A / Cỡ 1",
    sanPhamPancakeId: "00000000-0000-4000-8000-00000000000a",
    skuKho: "SP-MAU-01",
    canCu: "Căn cứ nghiệp vụ (bản public đã lược).",
  },
  {
    pancakeId: "MAU-DON-0002", // dòng 2 — hồ sơ ở docs/tu-dien-du-lieu-bronze.md §2b
    productName: "LISTING-02 - Sản phẩm mẫu B",
    variantDetail: "Phân loại B,Cỡ 2",
    variantPancakeId: "00000000-0000-4000-8000-000000000002",
    nhanBienThe: "Phân loại B / Cỡ 2",
    sanPhamPancakeId: "00000000-0000-4000-8000-00000000000b",
    skuKho: "SP-MAU-02",
    canCu: "Căn cứ nghiệp vụ (bản public đã lược).",
  },
];

/**
 * Tra dòng bảng cho một dòng hàng. Trả `undefined` khi không có dòng nào khớp ĐỦ ba phần.
 * So sánh bằng `===` trên chuỗi thô — mọi khác biệt dù chỉ một khoảng trắng đều là KHÔNG khớp,
 * đúng chủ đích: thà không ghép (có cảnh báo) còn hơn ghép nhầm biến thể (im lặng, sai tiền).
 */
export function ghepVariantThuCong(dong: {
  pancakeId: string;
  productName: string;
  variantDetail: string;
}): GhepVariantThuCong | undefined {
  return GHEP_VARIANT_THU_CONG.find(
    (g) =>
      g.pancakeId === dong.pancakeId &&
      g.productName === dong.productName &&
      g.variantDetail === dong.variantDetail
  );
}
