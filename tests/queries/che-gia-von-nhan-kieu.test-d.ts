import { describe, it } from "vitest";

import type { KpiCardsDuLieu } from "@/components/dashboard/kpi-cards";
import type { SoSanhKenhDuLieu } from "@/components/kenh/channel-comparison-section";
import type { KpiKenhDuLieu } from "@/components/kenh/channel-kpi-cards";
import type { DailyPoint } from "@/lib/reports/daily-series";
import type { ChannelPnl, PnlBreakdown } from "@/lib/reports/pnl";
import {
  boChannelPnlTheoQuyen,
  boPnlTheoQuyen,
  cheChannelPnl,
  chePnl,
  cheDailySeries,
  type ChannelPnlChe,
  type DailyPointChe,
  type DailySeriesTheoQuyen,
  type PnlChe,
} from "@/lib/reports/pnl-che";

/**
 * Lưới KIỂU cho NHÃN "đã che": bản đầy đủ (`PnlBreakdown`, `ChannelPnl[]`, `DailyPoint[]`) KHÔNG được
 * vào chỗ của bản che ở props page → component. Không có nhãn, kiểu che chỉ là tập con cấu trúc và TS
 * nhận bản đầy đủ im lặng (không kiểm trường thừa với biến) — bỏ quên một lời gọi `che*` ở page là
 * COGS/LN đi thẳng xuống client mà tsc vẫn xanh.
 *
 * `tsc --noEmit` (gate bắt buộc) soát file này: mỗi `@ts-expect-error` mà dòng dưới HẾT lỗi (có người
 * gỡ nhãn khỏi kiểu che) ⇒ tsc đỏ. Ca đối chứng không có `@ts-expect-error` chứng minh bản đã qua
 * `che*` vẫn vào được.
 */

declare const pnl: PnlBreakdown;
declare const kenh: ChannelPnl[];
declare const diem: DailyPoint[];

describe("nhãn kiểu DTO che", () => {
  it("bản đầy đủ không vào được chỗ bản che; bản qua che* thì vào được", () => {
    // @ts-expect-error — PnlBreakdown thiếu nhãn che
    const a: PnlChe = pnl;
    // @ts-expect-error — ChannelPnl[] thiếu nhãn che
    const b: ChannelPnlChe[] = kenh;
    // @ts-expect-error — DailyPoint[] thiếu nhãn che
    const c: DailyPointChe[] = diem;

    // Đúng ba mẫu page từng viết tay — nay tsc đỏ nếu quên chiếu che.
    // @ts-expect-error — hàng KPI Dashboard nhánh che nhận P&L đầy đủ
    const kpi: KpiCardsDuLieu = { coQuyenGiaVon: false, today: pnl, thisMonth: pnl, lastMonthSameDays: pnl };
    // @ts-expect-error — so sánh kênh nhánh che nhận danh sách kênh đầy đủ
    const soSanh: SoSanhKenhDuLieu = { coQuyenGiaVon: false, channels: kenh, prevChannels: kenh };
    // @ts-expect-error — KPI một kênh nhánh che nhận P&L đầy đủ
    const kpiKenh: KpiKenhDuLieu = { coQuyenGiaVon: false, current: pnl, previous: pnl };
    // @ts-expect-error — biểu đồ ngày nhánh che nhận chuỗi có LN ròng
    const chuoi: DailySeriesTheoQuyen = { coQuyenGiaVon: false, points: diem };

    // Đối chứng: đi qua hàm che / helper theo quyền thì hợp lệ.
    const d: PnlChe = chePnl(pnl);
    const e: ChannelPnlChe[] = cheChannelPnl(kenh);
    const f: DailyPointChe[] = cheDailySeries(diem);
    const g: KpiCardsDuLieu = boPnlTheoQuyen({ today: pnl, thisMonth: pnl, lastMonthSameDays: pnl }, { coQuyenGiaVon: false });
    const h: SoSanhKenhDuLieu = boChannelPnlTheoQuyen({ channels: kenh, prevChannels: kenh }, { coQuyenGiaVon: false });
    const i: KpiKenhDuLieu = boPnlTheoQuyen({ current: pnl, previous: pnl }, { coQuyenGiaVon: true });

    void [a, b, c, kpi, soSanh, kpiKenh, chuoi, d, e, f, g, h, i];
  });
});
