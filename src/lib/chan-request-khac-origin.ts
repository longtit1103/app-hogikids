/**
 * Cổng CHỐNG CSRF cho Route Handler có sức phá huỷ (`/api/restore`, `/api/backup`).
 *
 * VÌ SAO CẦN dù đã có cookie `sameSite=lax`:
 *  - Next.js tự so `Origin` với `Host` cho **Server Action**, nhưng **KHÔNG** làm điều đó cho
 *    Route Handler. Hai route này vì vậy chỉ còn đúng MỘT lớp bảo vệ: thuộc tính cookie.
 *  - Mà `SameSite=Lax` có ngoại lệ **"Lax-allowing-unsafe"**: Chrome vẫn gửi cookie kèm POST
 *    top-level nếu cookie **dưới 2 phút tuổi**. Tức ngay sau khi chủ shop đăng nhập, một trang
 *    bất kỳ có thể tự submit form POST sang `/api/backup` và lượt đó MANG THEO cookie hợp lệ —
 *    ép máy chủ chạy `pg_dump` (tốn tài nguyên) mà chủ shop không hề bấm gì.
 *    (`/api/restore` cần `multipart` có file, mà trang khác KHÔNG set được giá trị input file
 *    cross-site, nên cửa sổ này chỉ kích được `/api/backup` — vẫn gác cả hai: chi phí bằng 0 và
 *    không ai phải nhớ ngoại lệ đó khi sửa route sau này.)
 *
 * CÁCH GÁC — fail-OPEN có chủ đích khi VẮNG header, fail-CLOSED khi header KHÁC:
 *  - Có `Origin` và khác host của request ⇒ TỪ CHỐI. Đây là ca tấn công: trình duyệt LUÔN gắn
 *    `Origin` cho POST cross-site, không giả được từ JS.
 *  - VẮNG `Origin` ⇒ CHO QUA. Bắt buộc phải vậy: `curl`/script vận hành/cron nội bộ không gắn
 *    `Origin`, mà chúng là đường dùng hợp lệ (runbook DR gọi tay). Chặn ở đây là tự khoá đường
 *    phục hồi đúng lúc cần nhất. Lớp xác thực phiên vẫn đứng trước cổng này.
 *
 * So với `Host` của CHÍNH request (không phải hằng số cấu hình): sau Cloudflare Tunnel, `Host`
 * là domain thật người dùng gõ. Neo vào `NEXT_PUBLIC_APP_URL` sẽ gãy ở dev (`localhost:3000`),
 * ở preview, và ở lượt gọi nội bộ theo tên container — ba ca đều hợp lệ.
 */

/** Trả `Response` 403 khi request đến từ origin khác; `null` khi hợp lệ (cho đi tiếp). */
export function chanRequestKhacOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null; // không phải trình duyệt (curl/cron) — phiên đã gác ở trên

  // So với CẢ `host` LẪN `x-forwarded-host`, khớp một trong hai là đủ.
  //
  // VÌ SAO: app nằm sau Cloudflare Tunnel. `cloudflared` MẶC ĐỊNH giữ nguyên `Host`, nhưng chỉ cần
  // ai đó khai `httpHostHeader` trong cấu hình cloudflared (hoặc đổi sang một reverse
  // proxy khác) là `Host` biến thành `localhost:3000` trong khi trình duyệt vẫn gửi
  // `Origin` mang domain thật — lúc đó một cổng chỉ so `host` sẽ 403 **MỌI lượt hợp lệ**,
  // tức tự tay khoá đúng hai chức năng cứu hộ (sao lưu + phục hồi) vào đúng ngày cần chúng. Chấp
  // nhận thêm `x-forwarded-host` là đường tránh ca đó; Next.js cũng so Origin theo đúng cặp này
  // cho Server Action.
  //
  // Nhận `x-forwarded-host` có mở cửa cho kẻ tấn công không? KHÔNG, trong đúng mô hình đe doạ mà
  // cổng này sinh ra để chặn: một form POST cross-site **không đặt được header tuỳ ý** — đó là
  // giới hạn của chính trình duyệt, không phải của ta. Kẻ đặt được `X-Forwarded-Host` là kẻ đang
  // gửi request trực tiếp (curl), mà lượt đó không mang cookie phiên nên đã chết ở cổng xác thực
  // phía trên.
  const hostHople = [
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
  ].filter((h): h is string => h !== null && h.length > 0);

  // Không có header nào để so ⇒ không bịa ra kết luận (HTTP/1.0, hoặc proxy lạ).
  if (hostHople.length === 0) return null;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // `Origin` méo ⇒ không phải lượt hợp lệ của trình duyệt.
    return Response.json({ error: "Origin không hợp lệ." }, { status: 403 });
  }

  if (!hostHople.includes(originHost)) {
    return Response.json(
      { error: "Yêu cầu bị từ chối: khác origin." },
      { status: 403 }
    );
  }
  return null;
}
