import { cauCapLaiQuyen, type TrangThaiQuyenN8n } from "@/lib/n8n/quyen-doc-kho-khoa";

/**
 * Ô cảnh báo "n8n mất quyền đọc kho khoá", đặt trong section Kết nối & Đồng bộ.
 *
 * Chỉ hiện khi ĐANG THIẾU quyền. Không có ô xanh "mọi thứ ổn": trang này vốn đã dài, và một dòng
 * xanh thường trực chỉ dạy người đọc lướt qua khu vực đó — đúng thứ làm cảnh báo thật chìm mất.
 *
 * Nói HẬU QUẢ trước, tên quyền sau: chủ shop không đọc `GRANT USAGE` ra thành "ingest sẽ tắt".
 */
export function CanhBaoQuyenN8n({ trangThai }: { trangThai: TrangThaiQuyenN8n }) {
  if (trangThai.trangThai !== "THIEU_QUYEN") return null;

  return (
    <div className="rounded-lg border border-error/40 bg-error/5 p-4">
      <p className="text-sm font-medium text-error">
        n8n KHÔNG đọc được kho khoá — các lượt đồng bộ tự động đang chết câm
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Mọi workflow n8n lấy khoá từ bảng <span className="text-ink">Setting</span> trước khi chạy. Thiếu
        quyền đọc thì chúng dừng ngay ở bước đó: đơn hàng, chi tiêu quảng cáo và webhook đều ngừng chảy
        về, trong khi app vẫn đăng nhập và vẽ biểu đồ bình thường — <span className="text-ink">không có
        lỗi nào tự nổi lên</span>. Thường gặp sau một lượt phục hồi dữ liệu chạy ngoài hai đường phục hồi
        của app (nạp tay bằng psql, hoặc dựng lại cụm theo runbook DR), vì quyền chết theo bảng/schema cũ.
      </p>

      <p className="mt-3 text-xs text-muted-foreground">Đang thiếu:</p>
      <ul className="mt-1 list-disc pl-5 text-xs text-ink">
        {trangThai.thieu.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-muted-foreground">
        Chạy hai câu này với quyền quản trị DB rồi tải lại trang:
      </p>
      <pre className="mt-1 overflow-x-auto rounded bg-surface-soft p-2 text-xs text-ink">
        {cauCapLaiQuyen(trangThai.schema)}
      </pre>
    </div>
  );
}
