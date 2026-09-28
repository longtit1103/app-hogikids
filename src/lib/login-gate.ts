/**
 * Cổng nối tiếp theo email cho MỌI đường kiểm mật khẩu (đăng nhập, đổi mật khẩu).
 *
 * VÌ SAO CẦN: chốt khoá ở `login-lockout.ts` là chuỗi ĐỌC-RỒI-GHI vắt qua hai lệnh `await`
 * (truy vấn DB, rồi `verifyPassword` ~36ms): đọc trạng thái khoá ở đầu, ghi lượt sai ở cuối.
 * Bắn song song thì TẤT CẢ request đều đọc "chưa khoá" trước khi request đầu tiên kịp ghi. Đo
 * thật: 1000 request đồng thời ⇒ **1000 lượt đoán mật khẩu, 0 bị chặn**, trong khi chạy tuần tự
 * thì đúng 5 — tức vượt 200 lần mức thiết kế. Chốt 5-lần-sai/60-giây chỉ có nghĩa khi các lượt
 * thử KHÔNG chồng lấn nhau.
 *
 * CÁCH LÀM: mỗi email có một hàng đợi riêng; các lượt thử của cùng email chạy NỐI TIẾP, mỗi lúc
 * đúng một lượt. Nhờ vậy nguyên khối "kiểm khoá → tra DB → so mật khẩu → ghi kết quả" trở thành
 * bất khả phân với chính email đó, không còn khe để chen vào giữa.
 *
 * VÌ SAO KHÔNG chọn cách rẻ hơn là "tăng bộ đếm sai NGAY khi nhận request, trước mọi await":
 * cách đó đóng được khe đua nhưng phá lập luận an toàn bộ nhớ của `enforceCapacity` — kẻ tấn
 * công tạo được hàng nghìn entry ĐANG KHOÁ ở tốc độ nhận request mà chưa trả một đồng chi phí
 * scrypt nào, mà entry đang khoá thì `enforceCapacity` bị CẤM loại. Nó cũng làm sai ngữ nghĩa
 * "5 lần thất bại" (đếm cả lượt chưa biết đúng hay sai). Hàng đợi giữ được cả hai: bộ đếm vẫn
 * chỉ nhích khi mật khẩu THỰC SỰ sai, và chi phí scrypt vẫn là thứ chặn nhịp tấn công.
 *
 * TRẦN HÀNG ĐỢI: tối đa `MAX_LUOT_CHO_MOI_EMAIL` lượt cùng lúc cho một email, dư thì TỪ CHỐI
 * NGAY (fail-closed). Quá 5 lượt chờ là vô nghĩa — tới lượt thứ 5 tài khoản đã khoá, các lượt
 * sau chỉ tổ xếp hàng ăn bộ nhớ. Bản thân hàng đợi KHÔNG phải chỗ tích trạng thái lâu dài: mục
 * của một email bị xoá ngay khi lượt cuối cùng của nó rời đi, nên số mục tối đa bằng số request
 * ĐANG BAY, không phải thứ kẻ tấn công tích luỹ được.
 */

/** Trần số lượt cùng lúc cho MỘT email (đang chạy + đang chờ). Dư ⇒ từ chối ngay. */
export const MAX_LUOT_CHO_MOI_EMAIL = 5;

/** Ném ra khi email đã chạm trần hàng đợi. Caller dịch thành thông báo cho người dùng. */
export class QuaNhieuLuotDangNhap extends Error {
  constructor(email: string) {
    super(`Quá nhiều lượt đăng nhập cùng lúc cho "${email}"`);
    this.name = "QuaNhieuLuotDangNhap";
  }
}

type MucHangDoi = {
  /** Số lượt đang chạy + đang chờ. Về 0 ⇒ xoá mục khỏi Map. */
  soLuot: number;
  /** Lượt cuối cùng đã xếp hàng — lượt mới nối đuôi vào đây. */
  duoiHang: Promise<void>;
};

const hangDoiTheoEmail = new Map<string, MucHangDoi>();

/** Cùng cách chuẩn hoá với `login-lockout.ts` — hai bên PHẢI khoá theo cùng một chuỗi. */
function chuanHoaEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Số email đang có lượt bay — chỉ dùng cho test, không phải API cho mã chạy thật. */
export function demEmailDangCoLuot(): number {
  return hangDoiTheoEmail.size;
}

/**
 * Chạy `viec` sao cho các lượt của CÙNG một email không bao giờ chồng lấn.
 *
 * Ném `QuaNhieuLuotDangNhap` khi email đã chạm trần. Lỗi từ `viec` (DB sập, scrypt hỏng) được
 * ném nguyên vẹn ra ngoài NHƯNG không được làm kẹt hàng đợi: mục luôn được trả chỗ trong
 * `finally`, và chuỗi nối đuôi cố ý nuốt lỗi để lượt sau vẫn tới lượt. Một lượt hỏng chỉ hỏng
 * mình nó.
 */
export async function chayNoiTiepTheoEmail<T>(email: string, viec: () => Promise<T>): Promise<T> {
  const khoa = chuanHoaEmail(email);
  const dangCo = hangDoiTheoEmail.get(khoa);

  if (dangCo && dangCo.soLuot >= MAX_LUOT_CHO_MOI_EMAIL) {
    throw new QuaNhieuLuotDangNhap(khoa);
  }

  const muc: MucHangDoi = dangCo ?? { soLuot: 0, duoiHang: Promise.resolve() };
  muc.soLuot += 1;
  hangDoiTheoEmail.set(khoa, muc);

  // Nối đuôi: chạy sau khi lượt trước KẾT THÚC, dù lượt trước thành công hay lỗi.
  const luotNay = muc.duoiHang.then(viec, viec);
  // Đuôi mới nuốt lỗi — nếu để nguyên, một lượt lỗi sẽ làm mọi lượt sau bị từ chối lây.
  muc.duoiHang = luotNay.then(
    () => {},
    () => {}
  );

  try {
    return await luotNay;
  } finally {
    muc.soLuot -= 1;
    // Xoá khi hết lượt để Map không tích mục rỗng. So sánh tham chiếu phòng trường hợp mục đã bị
    // thay bằng mục khác giữa chừng.
    if (muc.soLuot === 0 && hangDoiTheoEmail.get(khoa) === muc) {
      hangDoiTheoEmail.delete(khoa);
    }
  }
}
