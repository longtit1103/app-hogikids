import { MUI_GIO_PHAM_VI_HOA_DON, type PhamViHoaDon } from "@/lib/no-phai-tra/dau-luot-hoa-don-tiktok";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

const NGAY_MS = 24 * 3600 * 1000;

/**
 * Phạm vi thời gian dấu lượt hoá đơn mang khi n8n hỏi TikTok `[hôm nay − tuNgayLui, hôm nay − denNgayLui]` (00:00 giờ
 * VN, theo giờ thật lúc chạy test). Mặc định 40 ngày tới 00:00 hôm nay — phủ mọi ngày sao kê các suite dùng (D = hôm
 * nay − 5 …) để lượt đủ vẫn là bằng chứng như trước khi cổng xét phạm vi.
 */
export function phamViLui(tuNgayLui = 40, denNgayLui = 0): PhamViHoaDon {
  const ngay = (lui: number) => khoaNgayVn(new Date(Date.now() - lui * NGAY_MS));
  return { startTime: `${ngay(tuNgayLui)} 00:00:00`, endTime: `${ngay(denNgayLui)} 00:00:00`, muiGio: MUI_GIO_PHAM_VI_HOA_DON };
}
