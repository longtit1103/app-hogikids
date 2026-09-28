/**
 * Next.js instrumentation — `register()` được Next tự gọi MỘT LẦN khi server
 * khởi động (Next.js bật sẵn, không cần `experimental.instrumentationHook` — vẫn đúng ở 16.3.1).
 *
 * Chốt fail-loud cho bất biến #3 (CLAUDE.md): toàn app neo `Asia/Ho_Chi_Minh`.
 * Biên ngày/tháng của P&L, daily-series, chi phí định kỳ đều dựa NGẦM vào TZ
 * của process (date-fns dùng local time) — nếu container thiếu `TZ` thì số
 * liệu lệch âm thầm theo UTC. Thà crash lúc boot còn hơn báo cáo sai.
 */
// ICU canonicalize "Asia/Ho_Chi_Minh" về alias tzdb cũ "Asia/Saigon" (đã kiểm
// chứng trên Node 25: TZ=Asia/Ho_Chi_Minh → resolvedOptions().timeZone =
// "Asia/Saigon"). Hai tên là CÙNG MỘT zone — chấp nhận cả hai, nếu chỉ so
// strict "Asia/Ho_Chi_Minh" thì boot crash oan dù TZ đã đặt đúng.
const VN_TZ_ALIASES = ["Asia/Ho_Chi_Minh", "Asia/Saigon"];

export function register(): void {
  // Chỉ assert ở runtime Node.js (server thật) — bỏ qua edge/browser build pass.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!VN_TZ_ALIASES.includes(timeZone)) {
    throw new Error(
      `Sai múi giờ: process đang chạy "${timeZone}" thay vì "Asia/Ho_Chi_Minh". ` +
        "Biên ngày/tháng của P&L, báo cáo và chi phí định kỳ sẽ lệch âm thầm — " +
        "đặt env TZ=Asia/Ho_Chi_Minh (Dockerfile/docker-compose) rồi khởi động lại.",
    );
  }
}
