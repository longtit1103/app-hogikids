/**
 * Ước lượng tiền CÒN NẰM TRONG VÍ TikTok Shop (sàn đã chốt, chủ shop chưa rút về tài khoản) — số
 * THÔNG TIN cho một ô chỉ đọc cạnh thẻ Quỹ. TUYỆT ĐỐI KHÔNG cộng vào số dư quỹ / dự báo / Excel Sổ quỹ:
 * quỹ là tiền THẬT đã về tài khoản, tiền trong ví sàn chưa phải của quỹ (cộng vào là đếm 2 lần với
 * lệnh rút `TiktokPayment` PAID mà quỹ đã tính khi tiền về bank).
 *
 * VÌ SAO FILE NẰM NGOÀI `src/lib/so-quy/`: lưới `tests/unit/so-quy/khong-dung-tien-du-kien.test.ts`
 * cấm cả thư mục đó đọc bảng statement TikTok (net sàn chốt) — đúng ý đồ, vì con số này không được
 * chạm công thức quỹ. Để ở thư mục riêng `vi-san/` thì lưới vẫn nguyên vẹn, và chính lưới đó còn
 * cấm thư mục `so-quy/` import ngược module này.
 *
 * Mô hình ví (đo prod 25/09, khớp từng đồng các tháng có đủ dữ liệu):
 *   ví(T) = B0 + Σ tiền VÀO ví (statement SETTLED: `settlementAmount` tại coalesce(paymentTime, statementTime))
 *              − Σ tiền RÚT khỏi ví (payment ≠ FAILED: `settlementValue` tại thời điểm tạo lệnh)
 * Ads sàn trừ ví ĐÃ nằm trong `settlementAmount` (qua `adjustmentAmount`) — KHÔNG trừ thêm bảng ads
 * trừ ví (đếm 2 lần). Lệnh rút đang xử lý (≠ FAILED) cũng trừ: tiền đã rời số dư khả dụng.
 *
 * B0 (số dư ví trước statement đầu tiên có trong dữ liệu — backfill chỉ phủ từ 15/01/2026) KHÔNG
 * biết được. Lấy CẬN DƯỚI: B0 nhỏ nhất để ví không bao giờ âm = max(0, −min cộng dồn). Số thật trên
 * Seller Center ≥ số này; chủ shop chốt 25/09 dùng cận dưới, gắn nhãn "≈ tối thiểu".
 */

export type TienVaoVi = { thoiDiem: Date; soTien: number };

export type LenhRutVi = {
  thoiDiem: Date;
  soTien: number;
  /** Trạng thái lệnh rút phía sàn. `FAILED` ⇒ tiền không rời ví, bỏ qua. */
  trangThai: string;
};

export type ViTiktokConLaiToiThieu = {
  /** Số dư ví tối thiểu trước sự kiện đầu tiên để chuỗi cộng dồn không bao giờ âm. */
  b0ToiThieu: number;
  /** = b0ToiThieu + Σ vào − Σ rút. Không âm theo cấu trúc; UI vẫn canh (dữ liệu hỏng ⇒ cảnh báo). */
  viHienTai: number;
  /** Σ vào − Σ rút kể từ ngày mở sổ quỹ (tính cả đúng mốc D0); null khi chưa mở sổ. */
  tangTuD0: number | null;
};

const TRANG_THAI_BO_QUA = "FAILED";

/**
 * Trộn hai chuỗi sự kiện rồi cộng dồn theo thời gian. Tự sắp lại (không tin thứ tự người gọi) — sai
 * thứ tự làm lệch đáy chuỗi, tức lệch B0. Cùng thời điểm thì tiền VÀO đứng trước lệnh RÚT: chọn thứ
 * tự cho đáy cao nhất ⇒ B0 nhỏ nhất vẫn hợp lệ, đúng tinh thần "cận dưới". Các khoản cùng thời điểm
 * cùng chiều được cộng GỘP trước khi so đáy (một lô ghi có là một biến động duy nhất của ví).
 *
 * Trả `null` khi chưa có statement nào (chưa đồng bộ ví TikTok) — UI ẩn ô thay vì in "0 ₫" như thật.
 */
export function tinhViTiktokConLaiToiThieu(
  vao: readonly TienVaoVi[],
  rut: readonly LenhRutVi[],
  d0: Date | null
): ViTiktokConLaiToiThieu | null {
  if (vao.length === 0) return null;

  const suKien = [
    ...vao.map((v) => ({ t: v.thoiDiem.getTime(), delta: v.soTien, uuTien: 0 })),
    ...rut
      .filter((r) => r.trangThai !== TRANG_THAI_BO_QUA)
      .map((r) => ({ t: r.thoiDiem.getTime(), delta: -r.soTien, uuTien: 1 })),
  ].sort((a, b) => a.t - b.t || a.uuTien - b.uuTien);

  const mocD0 = d0 === null ? null : d0.getTime();
  let congDon = 0;
  let day = 0; // tính cả điểm xuất phát 0 (trước sự kiện đầu tiên)
  let tangTuD0 = 0;
  suKien.forEach((s, i) => {
    congDon += s.delta;
    if (mocD0 !== null && s.t >= mocD0) tangTuD0 += s.delta;
    // Chỉ xét đáy ở CUỐI mỗi nhóm cùng (thời điểm, chiều): sàn ghi có cả lô statement ĐÚNG CÙNG một
    // giây (đo prod: lô 18/03 01:10:25 trộn dòng âm lẫn dương), thứ tự trong lô là tuỳ ý của DB. Xét
    // từng dòng thì đáy phụ thuộc thứ tự đó — prod lệch ~2 triệu giữa hai lượt đọc cùng dữ liệu.
    const ke = suKien[i + 1];
    const hetNhom = ke === undefined || ke.t !== s.t || ke.uuTien !== s.uuTien;
    if (hetNhom && congDon < day) day = congDon;
  });

  const b0ToiThieu = day < 0 ? -day : 0; // tránh −0 khi chuỗi chưa từng âm
  return {
    b0ToiThieu,
    viHienTai: b0ToiThieu + congDon,
    tangTuD0: mocD0 === null ? null : tangTuD0,
  };
}
