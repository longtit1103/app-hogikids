/**
 * In-memory login lockout tracker, keyed by normalized (lowercased) EMAIL —
 * NOT by IP. The app sits behind a single Cloudflare Tunnel egress, so every
 * request shares one IP; an IP-keyed lockout would lock out the one real
 * user the moment anyone (or any bot) fails a login. A single-instance
 * in-memory Map is sufficient — this is a single-user, single-process app.
 *
 * App chỉ có 1 user thật, nhưng màn đăng nhập vẫn lộ công khai qua
 * Cloudflare Tunnel — kẻ tấn công có thể bơm liên tục các email GIẢ (không
 * tồn tại) để buộc `attemptsByEmail` phình vô hạn (rò rỉ bộ nhớ, vì entry
 * không tự biến mất khi hết hạn khoá). Chặn bằng 2 lớp, cả hai chạy ngay
 * trong `recordFailedAttempt` (KHÔNG dùng `setInterval` — server Next.js,
 * tránh treo timer nền):
 *   1. Dọn cơ hội: cứ mỗi SWEEP_INTERVAL_WRITES lượt ghi thì quét bỏ các
 *      entry đã hết hạn khoá VÀ không còn hoạt động (không quét ở MỌI lượt
 *      ghi để khỏi cộng thêm O(n) vào từng lần gọi).
 *   2. Trần cứng MAX_TRACKED_EMAILS: chạm trần thì dọn ngay (không đợi mốc
 *      định kỳ); nếu vẫn đầy sau khi dọn (toàn entry còn hoạt động thật)
 *      thì bỏ entry cũ nhất theo lần ghi gần nhất — thà mất lịch sử khoá
 *      của 1 email lâu không hoạt động còn hơn để Map phình vô hạn.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60_000;

/**
 * Trần số email được theo dõi cùng lúc. Export chỉ để test xác nhận việc
 * dọn/chặn trần hoạt động đúng — không phải để chỗ khác chỉnh ở runtime.
 */
export const MAX_TRACKED_EMAILS = 1000;

// Amortize chi phí quét: không quét toàn bộ Map ở MỌI lượt ghi, chỉ định kỳ.
const SWEEP_INTERVAL_WRITES = 100;

type LockoutEntry = {
  failedAttempts: number;
  lockedUntil: number | null; // epoch ms
  lastAttemptAt: number; // epoch ms — mốc hoạt động gần nhất, dùng để dọn
};

const attemptsByEmail = new Map<string, LockoutEntry>();
let writesSinceSweep = 0;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Entry hết ý nghĩa khi: không (còn) bị khoá VÀ không có lượt thất bại nào
 * trong suốt một cửa sổ khoá gần nhất. Entry đang khoá KHÔNG BAO GIỜ bị coi
 * là hết hạn ở đây — dọn sớm sẽ mở khoá tài khoản trước thời hạn quy định.
 */
function isStale(entry: LockoutEntry, now: number): boolean {
  const stillLocked = entry.lockedUntil !== null && entry.lockedUntil > now;
  if (stillLocked) return false;
  return now - entry.lastAttemptAt >= LOCKOUT_DURATION_MS;
}

/** Quét toàn bộ Map, bỏ mọi entry đã hết hạn/không còn hoạt động. */
function sweepExpired(now: number): void {
  for (const [key, entry] of attemptsByEmail) {
    if (isStale(entry, now)) {
      attemptsByEmail.delete(key);
    }
  }
}

/**
 * Nhường chỗ cho 1 entry mới khi Map đã chạm trần.
 *
 * LUẬT BẤT DI BẤT DỊCH: **không bao giờ loại một entry đang bị khoá.** Chỉ
 * được loại theo thứ tự: (1) entry hết hạn/không còn hoạt động; (2) entry
 * KHÔNG bị khoá, cũ nhất theo `lastAttemptAt`. Không còn ứng viên nào hợp lệ
 * thì **cho Map vượt trần**, không loại gì cả.
 *
 * Hai đường thua đã thử và đều SAI, ghi lại để đừng ai "tối ưu" lại:
 *  - *Loại entry đang khoá (dù chỉ là cái sắp hết hạn nhất):* kẻ tấn công
 *    khoá tài khoản chủ shop rồi bơm email giả cho tràn trần là ĐẨY được
 *    chính lệnh khoá đó ra ngoài — bộ đếm về 0, khoá biến mất trước hạn.
 *    Tái hiện thật: thời gian khoá còn lại của chủ shop rơi từ ~58 giây về 0.
 *  - *Từ chối ghi nhận entry mới khi hết chỗ:* email nào chưa nằm trong Map
 *    sẽ không bao giờ được đếm lượt sai ⇒ không bao giờ bị khoá. Kẻ tấn công
 *    chỉ cần bơm cho Map đầy rồi dò mật khẩu chủ shop thoải mái.
 * Cả hai đều vô hiệu hoá đúng thứ chốt này sinh ra để bảo vệ.
 *
 * Vượt trần thì có phình bộ nhớ không? Không đáng kể, vì nó TỰ GIỚI HẠN: chỉ
 * entry ĐANG KHOÁ mới giữ được chỗ, mà muốn khoá một email phải trả đủ
 * MAX_FAILED_ATTEMPTS lượt scrypt (băm mật khẩu, cố ý nặng CPU), và lệnh khoá
 * tự hết sau LOCKOUT_DURATION_MS. Muốn giữ N entry khoá cùng lúc, kẻ tấn công
 * phải duy trì 5N lượt scrypt mỗi 60 giây — chi phí đó chạm trần CPU máy chủ
 * từ rất lâu trước khi bộ nhớ thành vấn đề. Trần vì vậy chỉ cần chặn đúng thứ
 * nó sinh ra để chặn: rác email giả CHƯA bị khoá tích lại vô hạn.
 */
function enforceCapacity(now: number): void {
  if (attemptsByEmail.size < MAX_TRACKED_EMAILS) return;

  sweepExpired(now);
  if (attemptsByEmail.size < MAX_TRACKED_EMAILS) return;

  let oldestUnlockedKey: string | null = null;
  let oldestUnlockedAt = Infinity;

  for (const [key, entry] of attemptsByEmail) {
    const dangKhoa = entry.lockedUntil !== null && entry.lockedUntil > now;
    if (dangKhoa) continue; // entry đang khoá BẤT KHẢ XÂM PHẠM
    if (entry.lastAttemptAt < oldestUnlockedAt) {
      oldestUnlockedAt = entry.lastAttemptAt;
      oldestUnlockedKey = key;
    }
  }

  // Không có ứng viên nào chưa khoá ⇒ để Map vượt trần, KHÔNG đụng lệnh khoá nào.
  if (oldestUnlockedKey !== null) {
    attemptsByEmail.delete(oldestUnlockedKey);
  }
}

/** Seconds remaining in the current lockout window, or 0 when not locked. */
export function getLockoutSecondsRemaining(email: string, now: number = Date.now()): number {
  const entry = attemptsByEmail.get(normalizeEmail(email));
  if (!entry?.lockedUntil || entry.lockedUntil <= now) {
    return 0;
  }
  return Math.ceil((entry.lockedUntil - now) / 1000);
}

/**
 * Records a failed login attempt. Locks the account for LOCKOUT_DURATION_MS
 * once MAX_FAILED_ATTEMPTS consecutive failures are reached. If a previous
 * lockout window has already fully elapsed, the counter restarts fresh so
 * lockout always reflects "N consecutive failures", not a lifetime total.
 */
export function recordFailedAttempt(email: string, now: number = Date.now()): void {
  const key = normalizeEmail(email);

  writesSinceSweep += 1;
  if (writesSinceSweep >= SWEEP_INTERVAL_WRITES) {
    writesSinceSweep = 0;
    sweepExpired(now);
  }

  const existing = attemptsByEmail.get(key);
  if (!existing) {
    // Chỉ cần đảm bảo chỗ trống khi THÊM key mới — cập nhật key đã có
    // không làm Map phình thêm nên không cần enforceCapacity.
    enforceCapacity(now);
  }

  const entry = existing ?? { failedAttempts: 0, lockedUntil: null, lastAttemptAt: now };

  if (entry.lockedUntil && entry.lockedUntil <= now) {
    entry.failedAttempts = 0;
    entry.lockedUntil = null;
  }

  entry.failedAttempts += 1;
  entry.lastAttemptAt = now;
  if (entry.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
  }

  attemptsByEmail.set(key, entry);
}

/** Clears failure history for an email — call on successful login. */
export function resetAttempts(email: string): void {
  attemptsByEmail.delete(normalizeEmail(email));
}
