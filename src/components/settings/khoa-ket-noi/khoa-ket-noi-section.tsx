"use client";

import type { ReactNode } from "react";

import { DS_NGUON_KET_NOI, type NguonKetNoiId } from "@/lib/ket-noi/catalog-khoa-ket-noi";
import type { TrangThaiKhoaKetNoi } from "@/lib/ket-noi/doc-trang-thai-khoa-ket-noi";
import type { TrangThaiWebhookShop } from "@/lib/ket-noi/webhook-pancake-info";

import { DoiTokenMeta } from "./doi-token-meta";
import { TheNguonKhoa } from "./the-nguon-khoa";
import { WebhookPancakePanel } from "./webhook-pancake-panel";

/**
 * Khối "Khóa kết nối nguồn dữ liệu" — chủ shop tự điền/thay API key & token của 4 nguồn,
 * không cần dev sửa DB hay chạy script. Khóa nằm ở bảng `Setting`, n8n tự đọc giá trị mới
 * ở lượt chạy kế tiếp.
 */
export function KhoaKetNoiSection({
  trangThai,
  webhookPancake,
}: {
  trangThai: TrangThaiKhoaKetNoi;
  webhookPancake: TrangThaiWebhookShop[];
}) {
  // Khối riêng dưới các ô khóa của từng nguồn: Pancake có thêm webhook, Meta có luồng thay token.
  const khoiRieng: Partial<Record<NguonKetNoiId, ReactNode>> = {
    pancake: <WebhookPancakePanel danhSach={webhookPancake} />,
    meta: <DoiTokenMeta />,
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-ink">Khóa kết nối nguồn dữ liệu</h3>
        <p className="text-xs text-muted-foreground">
          Chìa khóa để hệ thống kéo dữ liệu về hằng đêm. Khóa đã lưu chỉ hiện 4 ký tự cuối — muốn đổi thì dán khóa mới
          đè lên rồi bấm Lưu; bỏ trống là giữ nguyên.
        </p>
      </div>
      {/* Một cột hàng gấp/mở thay vì lưới 2 cột: 4 thẻ cao thấp lệch nhau tạo khoảng trống xấu,
          còn hàng gấp thì nguồn đã cấu hình đủ chỉ chiếm đúng một dòng. */}
      <div className="flex flex-col gap-2">
        {DS_NGUON_KET_NOI.map((nguon) => (
          <TheNguonKhoa
            key={nguon.id}
            nguonId={nguon.id}
            ten={nguon.ten}
            moTa={nguon.moTa}
            truong={trangThai[nguon.id]}
          >
            {khoiRieng[nguon.id]}
          </TheNguonKhoa>
        ))}
      </div>
    </div>
  );
}
