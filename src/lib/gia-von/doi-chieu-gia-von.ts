/**
 * Logic THUẦN cho việc đối chiếu giá vốn app ↔ giá vốn Pancake (Bronze products shop KHO).
 * Tách khỏi script để phần quyết định "đề xuất giá nào" có test, không lẫn phần đọc/ghi DB.
 *
 * Bối cảnh: luật ingest CẤM tự ghi đè `costPrice` (APP-OWNED — chủ shop sửa tay), nên giá vốn bên
 * Pancake không bao giờ tự chảy vào app sau lần CREATE đầu tiên. Hai kiểu lệch đã gặp:
 * - app để trống 0 trong khi Pancake đã có giá (đo 2026-07-27: 27/60 biến thể của 4 sản phẩm kho);
 * - app giữ số cũ trong khi chủ shop vừa chỉnh giá nhập bên Pancake (đo 2026-08-30: 91 biến thể,
 *   trong đó 85 dòng Pancake mới khai giá ngày 29/08).
 *
 * Script này KHÔNG phải ingest: nó là công cụ NHẬP TAY HÀNG LOẠT — chủ shop xem danh sách rồi
 * mới duyệt ghi. Vì thế không vi phạm bất biến #5.
 */

/** Một biến thể đọc từ payload products Bronze (shop KHO). */
export type BienTheKho = {
  pancakeId: string;
  sku: string | null;
  tenSanPham: string;
  /** `average_imported_price` — giá vốn trung bình Pancake tính. */
  giaTrungBinh: number;
  /** `last_imported_price` — giá nhập lần cuối; dùng khi trung bình chưa có. */
  giaNhapCuoi: number;
};

/** Biến thể trong app đem ra đối chiếu. */
export type BienTheApp = {
  id: string;
  pancakeId: string;
  sku: string;
  label: string;
  /** Giá vốn app đang giữ; 0 = chưa từng nhập. */
  costPrice: number;
};

/**
 * Chọn dòng nào đáng đề xuất sửa:
 * - `chi-thieu`: chỉ biến thể app còn để trống (costPrice = 0) — không đụng số chủ shop đã nhập.
 * - `theo-pancake`: MỌI biến thể app lệch giá Pancake, kể cả dòng app đã có số. Dùng khi chủ shop
 *   xác nhận Pancake là nguồn đúng sau một đợt chỉnh giá nhập bên đó.
 */
export type CheDoDoiChieu = "chi-thieu" | "theo-pancake";

export type DeXuatGiaVon = {
  variantId: string;
  pancakeId: string;
  sku: string;
  ten: string;
  /** Giá vốn app đang giữ lúc đọc — cũng là guard khi ghi (chỉ ghi nếu số chưa đổi). */
  giaHienTai: number;
  giaDeXuat: number;
  /** Nguồn số: giá trung bình Pancake hay giá nhập lần cuối. */
  nguon: "trung-binh" | "nhap-cuoi";
};

/**
 * Rút danh sách biến thể + giá vốn từ payload 1 sản phẩm Bronze.
 *
 * AN TOÀN int64: products Pancake dùng uuid CHUỖI cho `id` biến thể, không có số ≥16 chữ số
 * (đã verify khi dựng Bronze — xem ghi chú `latestPayloads` ở transform-raw-helpers.ts).
 */
export function rutBienTheTuPayload(payload: unknown): BienTheKho[] {
  if (payload === null || typeof payload !== "object") return [];
  const sp = payload as Record<string, unknown>;
  const tenSanPham = typeof sp.name === "string" ? sp.name : "(không tên)";
  const variations = Array.isArray(sp.variations) ? sp.variations : [];

  const ket: BienTheKho[] = [];
  for (const v of variations) {
    if (v === null || typeof v !== "object") continue;
    const bt = v as Record<string, unknown>;
    const pancakeId = typeof bt.id === "string" ? bt.id : null;
    if (!pancakeId) continue;
    ket.push({
      pancakeId,
      sku: bt.display_id == null ? null : String(bt.display_id),
      tenSanPham,
      giaTrungBinh: soDuong(bt.average_imported_price),
      giaNhapCuoi: soDuong(bt.last_imported_price),
    });
  }
  return ket;
}

/** Ép về số nguyên không âm; mọi thứ khác (null/chuỗi rác/âm) → 0 = "không có giá". */
function soDuong(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/**
 * Ghép biến thể app với giá vốn bên Pancake, trả về những dòng đáng sửa.
 *
 * Khớp theo `pancakeId` (uuid biến thể) — KHÔNG khớp theo SKU: Pancake cho phép SKU trùng nhau
 * giữa các sản phẩm (ghi chú sẵn ở `pancake-schemas.ts`), khớp nhầm là gán giá vốn của mặt hàng
 * khác vào ⇒ COGS sai mà không ai biết.
 *
 * Ưu tiên `average_imported_price`, thiếu thì `last_imported_price` — cùng thứ tự với luật prefill
 * lúc CREATE ở `pancake-mapping.ts` (một luật, hai chỗ dùng, không được lệch nhau).
 *
 * Biến thể Pancake chưa có giá (cả hai mức = 0) luôn bị bỏ qua ở MỌI chế độ: số 0 bên Pancake
 * nghĩa là "chưa khai", không phải "giá vốn bằng không" — ghi vào sẽ xoá trắng số app đang giữ.
 */
export function ghepDeXuat(
  bienTheApp: BienTheApp[],
  giaKho: BienTheKho[],
  cheDo: CheDoDoiChieu = "chi-thieu",
): DeXuatGiaVon[] {
  const theoPancakeId = new Map(giaKho.map((g) => [g.pancakeId, g]));
  const ket: DeXuatGiaVon[] = [];

  for (const bt of bienTheApp) {
    const kho = theoPancakeId.get(bt.pancakeId);
    if (!kho) continue;
    const giaDeXuat = kho.giaTrungBinh || kho.giaNhapCuoi;
    if (giaDeXuat <= 0) continue;
    if (cheDo === "chi-thieu" ? bt.costPrice !== 0 : bt.costPrice === giaDeXuat) continue;
    ket.push({
      variantId: bt.id,
      pancakeId: bt.pancakeId,
      sku: bt.sku,
      ten: `${kho.tenSanPham} · ${bt.label}`,
      giaHienTai: bt.costPrice,
      giaDeXuat,
      nguon: kho.giaTrungBinh > 0 ? "trung-binh" : "nhap-cuoi",
    });
  }
  // Chênh lệch lớn xếp trước: sửa vài dòng đầu là bịt được phần lớn sai lệch COGS.
  return ket.sort((a, b) => Math.abs(b.giaDeXuat - b.giaHienTai) - Math.abs(a.giaDeXuat - a.giaHienTai));
}

/**
 * DẤU VÂN TAY của một danh sách đề xuất — để "duyệt cái gì thì ghi đúng cái đó".
 *
 * Vì sao cần (review đối kháng 2026-09-07 bắt được, đo lệch 9,25 lần): màn duyệt đọc đề xuất lúc
 * render, còn lượt ghi đọc LẠI lúc bấm. Giữa hai mốc chỉ cần một ảnh Bronze mới land (lượt đêm,
 * hoặc nút "Đồng bộ ngay") là hai tập khác nhau — chủ shop xem bảng 8 mã rồi bấm, app ghi 74 mã,
 * không câu nào báo. Bảng ΔCOGS theo tháng khi đó cũng nói về một tập không còn tồn tại.
 *
 * Gọn nhưng đủ chặt: số dòng + tổng chênh/đơn vị + tổng bình phương chênh. Đổi tập mà giữ nguyên
 * cả ba là điều gần như không xảy ra với dữ liệu thật, và ta chỉ cần phát hiện "đã đổi" để bắt tải
 * lại trang — không cần chống giả mạo (danh sách do server tự đọc, client không soạn được).
 */
export function vanTayDeXuat(deXuat: DeXuatGiaVon[]): string {
  let tongChenh = 0;
  let tongBinhPhuong = 0;
  for (const d of deXuat) {
    const c = d.giaDeXuat - d.giaHienTai;
    tongChenh += c;
    tongBinhPhuong += c * c;
  }
  return `${deXuat.length}:${tongChenh}:${tongBinhPhuong}`;
}
