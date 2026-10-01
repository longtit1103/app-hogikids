/**
 * Banner ĐỎ "DB đang ở trạng thái sau lùi bản phân quyền" — chỉ chủ shop thấy (layout chỉ đọc dấu cho
 * OWNER). Không phải link: việc phải làm nằm trên máy chủ (script SQL + deploy lại), trong app không có
 * nút nào xử lý được.
 */
export function BannerLuiBan({ tu }: { tu: string }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-0.5 rounded-lg border border-error bg-error p-3 text-sm text-white shadow-sm"
    >
      <span className="font-semibold">
        Đang ở trạng thái sau lùi bản (từ {tu}) — chạy deploy/tien-lai-phan-quyen-m1.sql trên máy chủ.
      </span>
      <span className="text-white/85">
        Làm theo runbook §2c &quot;Tiến lại&quot;: dừng app, chạy script, rồi deploy lại. Chưa chạy thì thông tin
        shop sửa trong lúc lùi không hiện, và nhân sự vẫn bị khoá đăng nhập.
      </span>
    </div>
  );
}
