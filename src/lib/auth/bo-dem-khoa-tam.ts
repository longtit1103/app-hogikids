/**
 * Bộ đếm lượt sai + khoá tạm trong bộ nhớ, dùng CHUNG cho khoá theo email (`login-lockout.ts`) và
 * lớp khoá theo IP (`khoa-dang-nhap-theo-ip.ts`). App chạy MỘT tiến trình Node ⇒ Map trong bộ nhớ
 * là đủ, không cần DB/Redis.
 *
 * Màn đăng nhập lộ công khai qua Cloudflare Tunnel — kẻ tấn công bơm khoá GIẢ liên tục (email không
 * tồn tại, IP đổi) để Map phình vô hạn (entry không tự biến mất khi hết hạn khoá). Chặn bằng 2 lớp,
 * cả hai chạy ngay trong `ghiLuotSai` (KHÔNG dùng `setInterval` — server Next.js, tránh treo timer):
 *   1. Dọn cơ hội: cứ mỗi `quetSauSoLanGhi` lượt ghi thì quét bỏ các entry đã hết hạn khoá VÀ không
 *      còn hoạt động (không quét ở MỌI lượt ghi để khỏi cộng thêm O(n) vào từng lần gọi).
 *   2. Trần cứng `tranSoKhoa`: chạm trần thì dọn ngay (không đợi mốc định kỳ); vẫn đầy thì loại
 *      entry KHÔNG khoá cũ nhất — xem `nhuongCho` cho luật bất di bất dịch.
 *
 * Mỗi lần gọi `taoBoDemKhoaTam` sinh MỘT Map riêng — hai bộ đếm không bao giờ đụng nhau.
 */

export type CauHinhBoDemKhoaTam = {
  /** Đủ số lượt sai LIÊN TIẾP này thì khoá. */
  soLanSaiToiDa: number;
  /** Độ dài một lần khoá; cũng là cửa sổ "im lặng" để coi entry là hết ý nghĩa. */
  thoiGianKhoaMs: number;
  /** Trần số khoá theo dõi cùng lúc. */
  tranSoKhoa: number;
  /** Quét dọn định kỳ sau mỗi bấy nhiêu lượt ghi. */
  quetSauSoLanGhi: number;
  /**
   * `true` ⇒ entry KHÔNG khoá mà im lặng ≥ `thoiGianKhoaMs` thì lượt sai kế tiếp đếm lại từ 1 (cửa sổ
   * trượt, tất định). `false` ⇒ bộ đếm chỉ về 0 khi hết một lần khoá, khi `xoa`, hoặc khi entry bị
   * dọn — đúng hành vi lịch sử của khoá theo email, giữ nguyên để không đổi ngữ nghĩa chốt đó.
   */
  quenKhiImLang: boolean;
};

export type BoDemKhoaTam = {
  /** Số giây còn khoá (làm tròn lên), 0 khi không khoá. */
  giayConKhoa(khoa: string, now?: number): number;
  /** Ghi một lượt sai; đủ `soLanSaiToiDa` lượt liên tiếp thì khoá `thoiGianKhoaMs`. */
  ghiLuotSai(khoa: string, now?: number): void;
  /** Xoá lịch sử của một khoá. */
  xoa(khoa: string): void;
};

type MucKhoa = {
  soLanSai: number;
  khoaDen: number | null; // epoch ms
  lanCuoi: number; // epoch ms — mốc hoạt động gần nhất, dùng để dọn
};

export function taoBoDemKhoaTam(cauHinh: CauHinhBoDemKhoaTam): BoDemKhoaTam {
  const { soLanSaiToiDa, thoiGianKhoaMs, tranSoKhoa, quetSauSoLanGhi, quenKhiImLang } = cauHinh;
  const theoKhoa = new Map<string, MucKhoa>();
  let soLanGhiTuLanQuet = 0;

  function dangKhoa(muc: MucKhoa, now: number): boolean {
    return muc.khoaDen !== null && muc.khoaDen > now;
  }

  /**
   * Entry hết ý nghĩa khi: không (còn) bị khoá VÀ không có lượt sai nào trong suốt một cửa sổ khoá
   * gần nhất. Entry đang khoá KHÔNG BAO GIỜ bị coi là hết hạn ở đây — dọn sớm là mở khoá trước hạn.
   */
  function hetYNghia(muc: MucKhoa, now: number): boolean {
    if (dangKhoa(muc, now)) return false;
    return now - muc.lanCuoi >= thoiGianKhoaMs;
  }

  function quetHetHan(now: number): void {
    for (const [khoa, muc] of theoKhoa) {
      if (hetYNghia(muc, now)) theoKhoa.delete(khoa);
    }
  }

  /**
   * Nhường chỗ cho 1 entry mới khi Map đã chạm trần.
   *
   * LUẬT BẤT DI BẤT DỊCH: **không bao giờ loại một entry đang bị khoá.** Chỉ được loại theo thứ tự:
   * (1) entry hết hạn/không còn hoạt động; (2) entry KHÔNG bị khoá, cũ nhất theo `lanCuoi`. Không còn
   * ứng viên nào hợp lệ thì **cho Map vượt trần**, không loại gì cả.
   *
   * Hai đường thua đã thử và đều SAI, ghi lại để đừng ai "tối ưu" lại:
   *  - *Loại entry đang khoá (dù chỉ là cái sắp hết hạn nhất):* kẻ tấn công khoá tài khoản chủ shop
   *    rồi bơm email giả cho tràn trần là ĐẨY được chính lệnh khoá đó ra ngoài — bộ đếm về 0, khoá
   *    biến mất trước hạn. Tái hiện thật: thời gian khoá còn lại của chủ shop rơi từ ~58 giây về 0.
   *  - *Từ chối ghi nhận entry mới khi hết chỗ:* khoá nào chưa nằm trong Map sẽ không bao giờ được
   *    đếm lượt sai ⇒ không bao giờ bị khoá. Kẻ tấn công chỉ cần bơm cho Map đầy rồi dò thoải mái.
   * Cả hai đều vô hiệu hoá đúng thứ chốt này sinh ra để bảo vệ.
   *
   * Vượt trần thì có phình bộ nhớ không? Không đáng kể, vì nó TỰ GIỚI HẠN: chỉ entry ĐANG KHOÁ mới giữ
   * được chỗ, mà muốn khoá một khoá phải trả đủ `soLanSaiToiDa` lượt scrypt (băm mật khẩu, cố ý nặng
   * CPU), và lệnh khoá tự hết sau `thoiGianKhoaMs`. Muốn giữ N entry khoá cùng lúc phải duy trì
   * N·soLanSaiToiDa lượt scrypt mỗi cửa sổ — chạm trần CPU máy chủ từ rất lâu trước khi bộ nhớ thành
   * vấn đề. Trần vì vậy chỉ cần chặn đúng thứ nó sinh ra để chặn: rác CHƯA bị khoá tích lại vô hạn.
   */
  function nhuongCho(now: number): void {
    if (theoKhoa.size < tranSoKhoa) return;

    quetHetHan(now);
    if (theoKhoa.size < tranSoKhoa) return;

    let khoaCuNhat: string | null = null;
    let mocCuNhat = Infinity;
    for (const [khoa, muc] of theoKhoa) {
      if (dangKhoa(muc, now)) continue; // entry đang khoá BẤT KHẢ XÂM PHẠM
      if (muc.lanCuoi < mocCuNhat) {
        mocCuNhat = muc.lanCuoi;
        khoaCuNhat = khoa;
      }
    }

    // Không có ứng viên nào chưa khoá ⇒ để Map vượt trần, KHÔNG đụng lệnh khoá nào.
    if (khoaCuNhat !== null) theoKhoa.delete(khoaCuNhat);
  }

  return {
    giayConKhoa(khoa, now = Date.now()) {
      const muc = theoKhoa.get(khoa);
      if (!muc?.khoaDen || muc.khoaDen <= now) return 0;
      return Math.ceil((muc.khoaDen - now) / 1000);
    },

    ghiLuotSai(khoa, now = Date.now()) {
      soLanGhiTuLanQuet += 1;
      if (soLanGhiTuLanQuet >= quetSauSoLanGhi) {
        soLanGhiTuLanQuet = 0;
        quetHetHan(now);
      }

      const daCo = theoKhoa.get(khoa);
      // Chỉ cần bảo đảm chỗ trống khi THÊM khoá mới — cập nhật khoá đã có không làm Map phình.
      if (!daCo) nhuongCho(now);

      const muc = daCo ?? { soLanSai: 0, khoaDen: null, lanCuoi: now };

      // Lần khoá trước đã hết hẳn ⇒ đếm lại từ đầu: khoá luôn phản ánh "N lượt sai liên tiếp".
      if (muc.khoaDen !== null && muc.khoaDen <= now) {
        muc.soLanSai = 0;
        muc.khoaDen = null;
      } else if (quenKhiImLang && daCo && hetYNghia(muc, now)) {
        muc.soLanSai = 0;
      }

      muc.soLanSai += 1;
      muc.lanCuoi = now;
      if (muc.soLanSai >= soLanSaiToiDa) muc.khoaDen = now + thoiGianKhoaMs;

      theoKhoa.set(khoa, muc);
    },

    xoa(khoa) {
      theoKhoa.delete(khoa);
    },
  };
}
