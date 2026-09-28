"use client";

import { Input } from "@/components/ui/input";
import type { TrangThaiTruongKhoa } from "@/lib/ket-noi/doc-trang-thai-khoa-ket-noi";

/**
 * Một ô khóa kết nối. Trường bí mật là CHỈ-GHI: dòng trạng thái chỉ hiện đuôi …xxxx +
 * ngày cập nhật (server đã che, client không bao giờ có giá trị đầy đủ để mà lộ);
 * muốn đổi thì dán giá trị mới đè lên — bỏ trống nghĩa là giữ nguyên.
 */
export function ONhapKhoa({
  truong,
  value,
  onChange,
}: {
  truong: TrangThaiTruongKhoa;
  value: string;
  onChange: (v: string) => void;
}) {
  const inputId = `khoa-${truong.key}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <label className="text-xs font-medium text-ink" htmlFor={inputId}>
          {truong.nhan}
        </label>
        {truong.daLuu ? (
          <span className="text-xs text-muted-foreground">
            Đã lưu{truong.duoi ? ` • đuôi …${truong.duoi}` : ""}{truong.capNhat ? ` • cập nhật ${truong.capNhat}` : ""}
          </span>
        ) : (
          // Màu warning chứ không error: thiếu khóa là việc cần điền, không phải sự cố —
          // cả cột đỏ rực làm người đọc nhờn với màu báo lỗi thật.
          <span className="text-xs text-warning">Chưa có</span>
        )}
      </div>
      <Input
        id={inputId}
        type={truong.biMat ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={
          truong.biMat
            ? truong.daLuu
              ? "Dán khóa mới vào đây để thay (bỏ trống = giữ nguyên)"
              : "Dán khóa vào đây"
            : truong.giaTri ?? "Nhập giá trị"
        }
        onChange={(e) => onChange(e.target.value)}
      />
      {truong.goiY && <p className="text-xs text-muted-foreground">{truong.goiY}</p>}
    </div>
  );
}
