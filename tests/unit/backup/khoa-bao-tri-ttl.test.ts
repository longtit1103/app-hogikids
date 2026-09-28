import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TONG_HAN_LENH_TOI_DA_MS,
  TTL_KHOA_PHUC_HOI_MS,
} from "@/lib/backup/han-chay-lenh-pg";
import {
  chanRouteKhiDangPhucHoi,
  dangPhucHoi,
  giaHanKhoaPhucHoi,
  laChuKhoaPhucHoi,
  thuGiuKhoaPhucHoi,
  traKhoaPhucHoi,
} from "@/lib/backup/khoa-bao-tri";
import { donKhoaPhucHoi } from "../../helpers/khoa-bao-tri-reset";

/**
 * TTL của cờ khoá bảo trì — LƯỚI CUỐI khi `finally` của `POST /api/restore` không bao giờ tới.
 *
 * Không có TTL thì một lệnh pg treo là cả app kẹt chế độ chỉ-đọc trong im lặng (n8n 503, sao lưu
 * đêm 503, mọi nút ghi tay lỗi), chỉ khởi động lại container mới gỡ. Nhưng nhả SỚM còn tệ hơn: hai
 * lượt phục hồi cùng drop + nạp một schema. Suite này chốt cả hai phía.
 *
 * Đồng hồ giả bằng cách chặn `performance.now()` — cờ đo tuổi bằng đồng hồ đơn điệu, nên không
 * dùng được `vi.setSystemTime`.
 */

describe("cờ khoá phục hồi có hạn (TTL)", () => {
  let dongHoMs = 0;

  beforeEach(() => {
    donKhoaPhucHoi();
    dongHoMs = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => dongHoMs);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    donKhoaPhucHoi();
  });

  /** Đẩy đồng hồ đơn điệu tới sát/quá hạn. */
  function troiQua(ms: number): void {
    dongHoMs += ms;
  }

  it("TTL phải LỚN HƠN tổng hạn của cả chuỗi lệnh — nhả giữa lượt đang chạy là hỏng nặng hơn cờ kẹt", () => {
    expect(TTL_KHOA_PHUC_HOI_MS).toBeGreaterThan(TONG_HAN_LENH_TOI_DA_MS);
  });

  it("chưa tới hạn thì cờ vẫn chặn — đúng một giây trước TTL vẫn là 'đang phục hồi'", () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    troiQua(TTL_KHOA_PHUC_HOI_MS - 1_000);

    expect(dangPhucHoi()).toBe(true);
    expect(thuGiuKhoaPhucHoi()).toBeNull(); // lượt thứ hai vẫn bị loại
    const res = chanRouteKhiDangPhucHoi();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it("quá hạn thì thông đường ghi VÀ để lại dấu vết trong log — không bao giờ nhả im lặng", () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    troiQua(TTL_KHOA_PHUC_HOI_MS + 1);

    expect(dangPhucHoi()).toBe(false);
    expect(chanRouteKhiDangPhucHoi()).toBeNull();

    expect(console.error).toHaveBeenCalledTimes(1);
    const cau = vi.mocked(console.error).mock.calls[0]!.join(" ");
    expect(cau).toContain("quá hạn");
    expect(cau).toContain("TỰ NHẢ");
  });

  it("kêu ĐÚNG MỘT LẦN — hàm này chạy ở 34 điểm ghi, kêu mỗi lượt là ngập log", () => {
    thuGiuKhoaPhucHoi();
    troiQua(TTL_KHOA_PHUC_HOI_MS + 1);

    dangPhucHoi();
    dangPhucHoi();
    dangPhucHoi();

    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("cờ quá hạn KHÔNG chặn lượt phục hồi mới, và lượt mới được tính hạn lại từ đầu", () => {
    thuGiuKhoaPhucHoi();
    troiQua(TTL_KHOA_PHUC_HOI_MS + 1);

    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
    expect(dangPhucHoi()).toBe(true);

    troiQua(TTL_KHOA_PHUC_HOI_MS - 1_000);
    expect(dangPhucHoi()).toBe(true); // vẫn trong hạn của LƯỢT MỚI, không cộng dồn lượt cũ
  });

  it("trả khoá tay thì hết hiệu lực ngay, không phải chờ TTL", () => {
    const the = thuGiuKhoaPhucHoi()!;
    traKhoaPhucHoi(the);

    expect(dangPhucHoi()).toBe(false);
    expect(console.error).not.toHaveBeenCalled(); // đường về bình thường, không phải sự cố
  });

  it("đồng hồ hệ thống nhảy về tương lai KHÔNG làm cờ hết hạn sớm giữa lượt phục hồi thật", () => {
    thuGiuKhoaPhucHoi();

    // Máy chủ đồng bộ NTP nhảy 3 ngày; đồng hồ ĐƠN ĐIỆU không nhúc nhích.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 24 * 60 * 60 * 1000);

    expect(dangPhucHoi()).toBe(true);
  });

  /**
   * Đường hỏng mà chính TTL đẻ ra: hạn chỉ chặn được lệnh pg, còn `coLuotDangChay()` /
   * `thuHoiMoiPhien()` là truy vấn Prisma không hạn — nên một lượt vẫn có thể treo QUÁ TTL rồi mới
   * tỉnh và chạy `finally`. Thẻ phiên là thứ duy nhất chặn nó cướp cờ của lượt đang chạy.
   */
  it("lượt CŨ về muộn sau khi TTL nhả KHÔNG được xoá cờ của lượt MỚI đang drop + nạp schema", () => {
    const theCu = thuGiuKhoaPhucHoi()!;

    troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
    expect(dangPhucHoi()).toBe(false); // TTL tự nhả

    const theMoi = thuGiuKhoaPhucHoi()!; // chủ shop bấm phục hồi lại
    expect(theMoi).not.toBe(theCu);

    traKhoaPhucHoi(theCu); // lượt #1 chợt tỉnh, chạy `finally` của nó

    // Cờ của lượt #2 phải còn nguyên, nếu không thì webhook/n8n/nút ghi tay lại ghi được vào đúng
    // lúc schema đang bị xoá + nạp lại.
    expect(dangPhucHoi()).toBe(true);
    expect(chanRouteKhiDangPhucHoi()).not.toBeNull();
    expect(thuGiuKhoaPhucHoi()).toBeNull(); // và lượt thứ ba vẫn bị loại
  });

  it("lượt cũ về muộn phải KÊU LÊN — nuốt im lặng là mất manh mối duy nhất về hai lượt chồng nhau", () => {
    const theCu = thuGiuKhoaPhucHoi()!;
    troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
    thuGiuKhoaPhucHoi(); // lượt mới giành cờ
    vi.mocked(console.error).mockClear(); // bỏ câu log của chính TTL

    traKhoaPhucHoi(theCu);

    expect(console.error).toHaveBeenCalledTimes(1);
    const cau = vi.mocked(console.error).mock.calls[0]!.join(" ");
    expect(cau).toContain("về muộn");
    expect(cau).toContain("KHÔNG đụng vào cờ");
  });

  it("lượt cũ về muộn khi KHÔNG còn ai giữ cờ → dọn im lặng, không kêu oan", () => {
    const the = thuGiuKhoaPhucHoi()!;
    troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
    expect(dangPhucHoi()).toBe(false); // TTL đã nhả, chưa lượt nào giành lại
    vi.mocked(console.error).mockClear();

    traKhoaPhucHoi(the);

    expect(dangPhucHoi()).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("trả khoá hai lần bằng cùng một thẻ không làm hỏng lượt sau", () => {
    const the = thuGiuKhoaPhucHoi()!;
    traKhoaPhucHoi(the);
    traKhoaPhucHoi(the);

    expect(dangPhucHoi()).toBe(false);
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
  });

  /**
   * KIỂM QUYỀN SỞ HỮU — câu hỏi SUÔNG "tôi còn giữ khoá không", dùng khi mọi việc đã xong và không
   * còn lệnh nào phía sau (vd chọn câu cảnh báo trả về).
   *
   * KHÔNG phải cổng fencing: đặt nó trước một lệnh phá huỷ rồi gia hạn ở câu sau chính là mẫu đã
   * gây lỗi thật. Cổng là `giaHanKhoaPhucHoi` — xem `restore-cong-fencing-nguyen-tu.test.ts`.
   */
  describe("laChuKhoaPhucHoi", () => {
    it("đang giữ cờ và còn trong hạn → đúng là chủ khoá", () => {
      const the = thuGiuKhoaPhucHoi()!;

      troiQua(TTL_KHOA_PHUC_HOI_MS - 1_000);

      expect(laChuKhoaPhucHoi(the)).toBe(true);
    });

    it("quá TTL thì chính chủ cũng MẤT quyền — cờ đã nhả, mọi đường ghi khác đã mở lại", () => {
      const the = thuGiuKhoaPhucHoi()!;

      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);

      expect(laChuKhoaPhucHoi(the)).toBe(false);
    });

    it("thẻ lượt CŨ không qua mặt được khi lượt MỚI đang giữ cờ", () => {
      const theCu = thuGiuKhoaPhucHoi()!;
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
      const theMoi = thuGiuKhoaPhucHoi()!;

      expect(laChuKhoaPhucHoi(theCu)).toBe(false);
      expect(laChuKhoaPhucHoi(theMoi)).toBe(true);
    });

    it("đã trả khoá tay rồi thì hết quyền ngay", () => {
      const the = thuGiuKhoaPhucHoi()!;
      traKhoaPhucHoi(the);

      expect(laChuKhoaPhucHoi(the)).toBe(false);
    });
  });

  /** GIA HẠN — để fencing không quay ra giết oan một lượt phục hồi đang tiến triển thật. */
  describe("giaHanKhoaPhucHoi", () => {
    it("mỗi bước xong là đẩy mốc, nên lượt chậm mà vẫn tiến triển KHÔNG bị TTL nhả oan", () => {
      const the = thuGiuKhoaPhucHoi()!;

      troiQua(TTL_KHOA_PHUC_HOI_MS - 1_000); // bước 1 chạy sát hạn nhưng XONG
      expect(giaHanKhoaPhucHoi(the)).toBe(true);
      troiQua(TTL_KHOA_PHUC_HOI_MS - 1_000); // bước 2 cũng vậy — tổng đã vượt xa TTL

      expect(dangPhucHoi()).toBe(true);
      expect(laChuKhoaPhucHoi(the)).toBe(true);
    });

    it("cờ đã bị TTL nhả thì KHÔNG hồi sinh được — mất khoá là lượt đó phải chết hẳn", () => {
      const the = thuGiuKhoaPhucHoi()!;
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);

      expect(giaHanKhoaPhucHoi(the)).toBe(false);
      expect(dangPhucHoi()).toBe(false); // không dựng lại cờ đã nhả
      expect(thuGiuKhoaPhucHoi()).not.toBeNull(); // lượt mới vẫn vào được
    });

    it("thẻ lượt cũ KHÔNG gia hạn hộ được cờ của lượt đang chạy", () => {
      const theCu = thuGiuKhoaPhucHoi()!;
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
      thuGiuKhoaPhucHoi(); // lượt mới giành cờ

      troiQua(TTL_KHOA_PHUC_HOI_MS - 1_000);
      expect(giaHanKhoaPhucHoi(theCu)).toBe(false);

      // Cờ của lượt mới phải hết hạn theo đúng lịch của nó, không được kéo dài thêm.
      troiQua(2_000);
      expect(dangPhucHoi()).toBe(false);
    });
  });
});
