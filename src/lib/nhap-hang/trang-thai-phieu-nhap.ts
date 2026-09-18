import {
  trangThaiLechGiaVon,
  type MucLechGiaVon,
} from "@/lib/gia-von/trang-thai-lech-gia-von";

/**
 * Trạng thái "phiếu nhập Pancake còn việc gì chưa xử lý không" — số do lượt đêm chốt, màn hình chỉ
 * ĐỌC.
 *
 * VÌ SAO CẦN: chủ shop nhập hàng trên Pancake, app không tự ghi (Pancake không có field "đã trả bao
 * nhiêu" — phiếu có thể còn nợ NCC) nên khoản tiền hàng chục triệu nằm ngoài quỹ cho tới khi có
 * người nhớ ra. Đúng cái bẫy "quy trình dựa vào trí nhớ" mà dải nhắc việc giá vốn đã dựng ra để
 * chống.
 *
 * HAI LOẠI VIỆC, hai con số RIÊNG — cố ý không gộp thành một:
 * - `soChoDuyet`: phiếu Pancake chưa vào Sổ chi phí ⇒ quỹ đang NHIỀU hơn thực tế.
 * - `soViecHauKiem`: phiếu ĐÃ ghi nay bị huỷ / đổi số tiền / mang trạng thái lạ ⇒ quỹ đang lệch
 *   theo chiều NGƯỢC LẠI hoặc chưa rõ chiều.
 * Gộp một số rồi in "N phiếu nhập chưa vào Sổ chi phí" là nói SAI việc: duyệt hết phiếu chờ rồi mà
 * banner vẫn kêu thì chủ shop bấm vào không thấy gì để duyệt, lần sau bỏ qua banner. Ngược lại, đếm
 * mỗi phiếu chờ thì lúc duyệt hết banner TẮT trong khi cảnh báo "phiếu đã ghi nay bị huỷ" vẫn còn
 * nằm im trong màn — ca đã xảy ra thật 2 lần trên prod (#173, #179).
 *
 * Phép đếm phải quét trọn Bronze `RawPancakePurchase` (luật lọc nằm trong payload) nên TUYỆT ĐỐI
 * không chạy ở layout — layout chỉ đọc 3 ô `Setting` dưới đây.
 */

/** Key trong bảng `Setting`. Đặt cùng lối `costPriceMismatchCount`/`costPriceCheckedAt`. */
export const KEY_SO_PHIEU_NHAP_CHUA_GHI = "purchaseUnbookedCount";
export const KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP = "purchaseFollowUpCount";
export const KEY_MOC_KIEM_PHIEU_NHAP = "purchaseCheckedAt";

export type TrangThaiPhieuNhap = {
  /** Phiếu Pancake chưa vào Sổ chi phí (chờ chủ shop duyệt). */
  soChoDuyet: number;
  /** Phiếu đã ghi nay bị huỷ / đổi số tiền / trạng thái lạ, và phiếu trạng thái lạ chưa ghi. */
  soViecHauKiem: number;
  mocLuc: Date | null;
  muc: MucLechGiaVon;
};

/**
 * TÁI DÙNG NGUYÊN TRẠNG hàm thuần của giá vốn cho phần khó: nó nhận CHUỖI THÔ (số đếm + mốc ISO) và
 * lo trọn chuyện "chưa kiểm / trễ quá 26 giờ / có việc / sạch", gồm cả luật "trễ THẮNG có việc" và
 * cách đọc số rác. Chép lại logic đó ở đây là đẻ ra bản thứ hai sẽ lệch lúc nào không hay.
 *
 * Gọi HAI lượt (một cho mỗi loại việc) rồi hoà kết quả, thay vì cộng hai số rồi gọi một lượt: cộng
 * trước là mất luôn khả năng phân biệt "3 phiếu chờ" với "3 phiếu đã ghi cần kiểm lại" ở câu banner.
 */
export function trangThaiPhieuNhapChuaGhi(
  soChoDuyetTho: string | null | undefined,
  soViecHauKiemTho: string | null | undefined,
  mocTho: string | null | undefined,
  bayGio = new Date(),
): TrangThaiPhieuNhap {
  const choDuyet = trangThaiLechGiaVon(soChoDuyetTho, mocTho, bayGio);
  const hauKiem = trangThaiLechGiaVon(soViecHauKiemTho, mocTho, bayGio);

  // `chua-kiem` THẮNG hết: một trong hai ô thiếu/rác nghĩa là con số đang cầm không đáng tin, mà im
  // lặng vì chưa đo ≠ im lặng vì khớp. Ô hậu kiểm VẮNG ngay sau deploy (key mới) cũng rơi vào đây —
  // đúng ý: lượt đêm chưa hậu kiểm lần nào thật.
  const muc: MucLechGiaVon =
    choDuyet.muc === "chua-kiem" || hauKiem.muc === "chua-kiem"
      ? "chua-kiem"
      : choDuyet.muc === "tre"
        ? "tre"
        : choDuyet.soLech + hauKiem.soLech > 0
          ? "co-lech"
          : "khop";

  return {
    soChoDuyet: choDuyet.soLech,
    soViecHauKiem: hauKiem.soLech,
    mocLuc: choDuyet.mocLuc,
    muc,
  };
}

/**
 * Câu cho banner nhắc việc ở mức `co-lech` — hàm THUẦN để kiểm được bằng test, vì đây là chỗ dễ nói
 * sai việc nhất: "3 phiếu nhập chờ ghi" và "1 phiếu đã ghi nay bị huỷ bên Pancake" là hai việc
 * KHÁC nhau, và hai chiều lệch quỹ NGƯỢC nhau.
 */
export function cauNhacPhieuNhap(t: Pick<TrangThaiPhieuNhap, "soChoDuyet" | "soViecHauKiem">): string {
  const { soChoDuyet, soViecHauKiem } = t;
  if (soViecHauKiem === 0) {
    return `${soChoDuyet} phiếu nhập hàng bên Pancake chưa vào Sổ chi phí — quỹ đang nhiều hơn thực tế.`;
  }
  if (soChoDuyet === 0) {
    return (
      `${soViecHauKiem} phiếu nhập đã ghi sổ nay không khớp Pancake (bị huỷ, đổi số tiền hoặc ` +
      `trạng thái lạ) — Sổ chi phí đang giữ số cũ.`
    );
  }
  // Hai chiều lệch ngược nhau ⇒ KHÔNG khẳng định quỹ đang nhiều hay ít, chỉ nói là lệch.
  return (
    `${soChoDuyet} phiếu nhập chưa vào Sổ chi phí và ${soViecHauKiem} phiếu đã ghi nay không khớp ` +
    `Pancake — quỹ đang lệch với thực tế.`
  );
}
