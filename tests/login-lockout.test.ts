import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_TRACKED_EMAILS,
  getLockoutSecondsRemaining,
  recordFailedAttempt,
  resetAttempts,
} from "@/lib/login-lockout";

const EMAIL = "khoa-test@hogikids.test";

describe("login lockout", () => {
  beforeEach(() => {
    resetAttempts(EMAIL);
    resetAttempts(EMAIL.toUpperCase());
  });

  it("does not lock before the 5th consecutive failed attempt", () => {
    for (let i = 0; i < 4; i += 1) {
      recordFailedAttempt(EMAIL);
    }
    expect(getLockoutSecondsRemaining(EMAIL)).toBe(0);
  });

  it("locks for 60s after the 5th consecutive failed attempt, then unlocks", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordFailedAttempt(EMAIL, now);
    }
    expect(getLockoutSecondsRemaining(EMAIL, now)).toBe(60);
    expect(getLockoutSecondsRemaining(EMAIL, now + 59_000)).toBe(1);
    expect(getLockoutSecondsRemaining(EMAIL, now + 60_000)).toBe(0);
  });

  it("keys the lockout by normalized (lowercased) email, not by case-sensitive string", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordFailedAttempt(EMAIL.toUpperCase(), now);
    }
    expect(getLockoutSecondsRemaining(EMAIL, now)).toBeGreaterThan(0);
  });

  it("clears the failure count on a successful login (resetAttempts)", () => {
    const now = Date.now();
    for (let i = 0; i < 4; i += 1) {
      recordFailedAttempt(EMAIL, now);
    }
    resetAttempts(EMAIL);
    recordFailedAttempt(EMAIL, now);
    expect(getLockoutSecondsRemaining(EMAIL, now)).toBe(0);
  });

  it("restarts the failure counter once a previous lockout window fully elapses", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordFailedAttempt(EMAIL, now);
    }
    expect(getLockoutSecondsRemaining(EMAIL, now + 60_000)).toBe(0);

    // A single new failure right after expiry should not immediately re-lock.
    recordFailedAttempt(EMAIL, now + 60_000);
    expect(getLockoutSecondsRemaining(EMAIL, now + 60_000)).toBe(0);
  });

  // Chống rò rỉ bộ nhớ: kẻ tấn công bơm email GIẢ liên tục (không tồn tại)
  // không được làm Map phình vô hạn. Ghi MAX_TRACKED_EMAILS + 5 email mới
  // trong một khoảng thời gian ngắn (không email nào "hết hạn" — chênh
  // lệch thời gian < 60s) để ép nhánh dọn-entry-cũ-nhất (fallback) chạy,
  // thay vì nhánh dọn-hết-hạn (cả 2 nhánh đều nằm trong enforceCapacity).
  it("chặn trần MAX_TRACKED_EMAILS bằng cách bỏ entry cũ nhất khi chạm trần", () => {
    const overflow = 5;
    const totalKeys = MAX_TRACKED_EMAILS + overflow;
    for (let i = 0; i < totalKeys; i += 1) {
      recordFailedAttempt(`cap-test-${i}@hogikids.test`, i);
    }

    // overflow email được ghi ĐẦU TIÊN (cũ nhất theo lastAttemptAt) phải đã
    // bị dọn để nhường chỗ: nếu bị dọn thì bộ đếm coi như về 0, 4 lần ghi
    // thất bại tiếp theo chỉ đưa lên 4 (< 5) chứ không khoá; nếu KHÔNG bị
    // dọn (Map phình vô hạn) thì 1 (đã có) + 4 (mới) = 5 sẽ bị khoá.
    const laterNow = totalKeys + 100_000;
    for (let i = 0; i < overflow; i += 1) {
      const email = `cap-test-${i}@hogikids.test`;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        recordFailedAttempt(email, laterNow);
      }
      expect(getLockoutSecondsRemaining(email, laterNow)).toBe(0);
    }

    // Dọn sạch key vừa tạo — attemptsByEmail là state module-level dùng
    // chung xuyên suốt file test này, không tự dọn theo test.
    for (let i = 0; i < totalKeys; i += 1) {
      resetAttempts(`cap-test-${i}@hogikids.test`);
    }
  });

  it("dọn entry đã hết hạn/không còn hoạt động trước, giữ lại entry còn hoạt động, khi chạm trần", () => {
    // 1 entry "cũ" chỉ có 1 lượt thất bại tại t=0 rồi im lặng — sau khi
    // vượt quá LOCKOUT_DURATION_MS (60s) mà không có hoạt động mới, entry
    // này hết ý nghĩa (không khoá, không hoạt động) nên phải bị dọn TRƯỚC
    // khi cần đụng đến entry còn đang hoạt động (fallback).
    recordFailedAttempt("stale-cap-test@hogikids.test", 0);

    // Lấp đầy phần còn lại của trần bằng các entry "mới" (cùng mốc t=1,
    // còn trong cửa sổ 60s nên KHÔNG hết hạn) — các entry này phải được giữ.
    for (let i = 0; i < MAX_TRACKED_EMAILS - 1; i += 1) {
      recordFailedAttempt(`fresh-cap-test-${i}@hogikids.test`, 1);
    }

    // Ghi thêm 1 entry mới tại t=60_000 (đủ xa t=0 để entry "cũ" hết hạn —
    // diff đúng bằng LOCKOUT_DURATION_MS, nhưng vẫn rất gần t=1 nên các
    // entry "mới" còn nguyên, diff=59.999s < 60s) — chạm trần, buộc
    // enforceCapacity chạy sweepExpired trước khi cần đến fallback.
    recordFailedAttempt("trigger-sweep@hogikids.test", 60_000);

    // Kiểm entry "mới" TRƯỚC (cập nhật key đã tồn tại — không tự kích thêm
    // vòng dọn nào) để chắc chắn phép đo không bị nhiễu bởi lượt kiểm entry
    // "cũ" bên dưới (lượt đó tạo key MỚI, có thể tự kích thêm 1 vòng dọn
    // khác). Entry "mới" phải CÒN NGUYÊN: 1 (đã có) + 4 (mới) = 5 → khoá.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      recordFailedAttempt("fresh-cap-test-0@hogikids.test", 60_000);
    }
    expect(getLockoutSecondsRemaining("fresh-cap-test-0@hogikids.test", 60_000)).toBeGreaterThan(
      0
    );

    // Entry "cũ" (stale) đã bị dọn thật: tạo lại từ đầu chỉ đưa lên 4 lượt
    // (< 5), không khoá — nếu KHÔNG bị dọn thì 1 (cũ) + 4 = 5 sẽ khoá.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      recordFailedAttempt("stale-cap-test@hogikids.test", 60_000);
    }
    expect(getLockoutSecondsRemaining("stale-cap-test@hogikids.test", 60_000)).toBe(0);

    // Dọn sạch key vừa tạo.
    resetAttempts("stale-cap-test@hogikids.test");
    resetAttempts("trigger-sweep@hogikids.test");
    for (let i = 0; i < MAX_TRACKED_EMAILS - 1; i += 1) {
      resetAttempts(`fresh-cap-test-${i}@hogikids.test`);
    }
  });

  it("bơm email giả cho tràn trần KHÔNG gỡ được lệnh khoá đang có hiệu lực", () => {
    // Khe hở đã tái hiện được: khi chạm trần mà cứ bỏ entry "cũ nhất" vô điều
    // kiện thì entry ĐANG BỊ KHOÁ của chủ shop chính là nạn nhân — mọi email
    // giả bơm sau đều có mốc mới hơn. Khoá biến mất trước hạn ⇒ chốt 5-lần-
    // sai/60-giây vô hiệu, kẻ tấn công dò mật khẩu không giới hạn.
    const moc = 5_000_000;
    const chuShop = "nan-nhan-bi-day@hogikids.test";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedAttempt(chuShop, moc);
    }
    expect(getLockoutSecondsRemaining(chuShop, moc)).toBeGreaterThan(0);

    // Bơm quá trần, mốc tăng dần ⇒ entry chủ shop luôn là "cũ nhất".
    const soEmailGia = MAX_TRACKED_EMAILS + 50;
    for (let i = 0; i < soEmailGia; i += 1) {
      recordFailedAttempt(`bom-${i}@hogikids.test`, moc + 1 + i);
    }

    // Vẫn trong cửa sổ khoá 60s của chủ shop → khoá PHẢI còn nguyên.
    const mocSau = moc + soEmailGia + 60;
    expect(getLockoutSecondsRemaining(chuShop, mocSau)).toBeGreaterThan(0);

    resetAttempts(chuShop);
    for (let i = 0; i < soEmailGia; i += 1) {
      resetAttempts(`bom-${i}@hogikids.test`);
    }
  });

  it("kể cả khi TOÀN BỘ entry đều đang khoá, lệnh khoá của chủ shop vẫn không bị đẩy", async () => {
    // Ca hiểm hơn: kẻ tấn công không bơm email giả cho có, mà khoá HẲN từng email giả (đủ 5 lượt
    // sai mỗi email) để Map đầy toàn entry đang khoá — lúc đó không còn ứng viên "chưa khoá" nào
    // để loại. Nếu chốt nhường chỗ chịu đụng vào entry đang khoá (dù chỉ cái sắp hết hạn nhất)
    // thì khoá của chủ shop bay ngay: đo thật thấy rơi từ ~58 giây về 0.
    const moc = 9_000_000;
    const chuShop = "nan-nhan-toan-bo-khoa@hogikids.test";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedAttempt(chuShop, moc);
    }
    expect(getLockoutSecondsRemaining(chuShop, moc)).toBeGreaterThan(0);

    // Khoá HẲN từng email giả (5 lượt/email), mốc mới hơn ⇒ chủ shop là entry cũ nhất.
    const soEmailGia = MAX_TRACKED_EMAILS + 20;
    for (let i = 0; i < soEmailGia; i += 1) {
      const mocGia = moc + 1 + i;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        recordFailedAttempt(`khoa-het-${i}@hogikids.test`, mocGia);
      }
    }

    // Vẫn trong cửa sổ khoá 60 giây của chủ shop → khoá PHẢI còn nguyên.
    const mocSau = moc + soEmailGia + 60;
    expect(getLockoutSecondsRemaining(chuShop, mocSau)).toBeGreaterThan(0);

    resetAttempts(chuShop);
    for (let i = 0; i < soEmailGia; i += 1) {
      resetAttempts(`khoa-het-${i}@hogikids.test`);
    }
  });

  it("Map đầy KHÔNG được làm email mới mất quyền bị khoá", () => {
    // Đường thua đối xứng với ca trên: nếu hết chỗ mà chốt chọn cách "không ghi nhận entry mới"
    // thì email nào chưa nằm trong Map sẽ không bao giờ được đếm lượt sai ⇒ không bao giờ bị
    // khoá. Kẻ tấn công chỉ cần bơm cho Map đầy rồi dò mật khẩu chủ shop thoải mái. Bất biến này
    // trước chỉ nằm trong comment, không test nào canh — biến thể "từ chối ghi key mới" vẫn xanh
    // trọn bộ test.
    const moc = 12_000_000;
    const soEmailGia = MAX_TRACKED_EMAILS + 20;
    for (let i = 0; i < soEmailGia; i += 1) {
      const mocGia = moc + i;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        recordFailedAttempt(`lap-day-${i}@hogikids.test`, mocGia);
      }
    }

    // Email HOÀN TOÀN MỚI, xuất hiện khi Map đã đầy ắp entry đang khoá.
    const chuShop = "den-sau-khi-day@hogikids.test";
    const mocSau = moc + soEmailGia;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedAttempt(chuShop, mocSau);
    }
    expect(getLockoutSecondsRemaining(chuShop, mocSau)).toBeGreaterThan(0);

    resetAttempts(chuShop);
    for (let i = 0; i < soEmailGia; i += 1) {
      resetAttempts(`lap-day-${i}@hogikids.test`);
    }
  });
});
