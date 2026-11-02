import { describe, it } from "vitest";

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
import type { DuLieuTheVaBieuDo, SoSanh, TheoKenh } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

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
    const h: SoSanhKenhDuLieu = boChannelPnlTheoQuyen({ channels: kenh, prevChannels: kenh }, { coQuyenGiaVon: false });
    const i: KpiKenhDuLieu = boPnlTheoQuyen({ current: pnl, previous: pnl }, { coQuyenGiaVon: true });

    void [a, b, c, soSanh, kpiKenh, chuoi, d, e, f, h, i];
  });
});

declare const so: SoSanh;
declare const theVaBieuDo: DuLieuTheVaBieuDo;
declare const theoKenh: TheoKenh;

describe("trang chủ — nhánh che không mang chi phí / lợi nhuận ở kiểu", () => {
  it("thẻ + biểu đồ ngày: chỉ đọc được chiPhi / loiNhuan sau khi narrow coQuyenGiaVon", () => {
    // @ts-expect-error — chưa narrow: nhánh che không có chiPhi
    const chuaNarrow = theVaBieuDo.the.chiPhi;

    if (theVaBieuDo.coQuyenGiaVon) {
      const day: SoSanh = theVaBieuDo.the.chiPhi;
      const diemDay: number = theVaBieuDo.bieuDo[0].hienTai.loiNhuan;
      void [day, diemDay];
    } else {
      // @ts-expect-error — nhánh che không có chiPhi
      const a = theVaBieuDo.the.chiPhi;
      // @ts-expect-error — nhánh che không có loiNhuan ở thẻ
      const b = theVaBieuDo.the.loiNhuan;
      // @ts-expect-error — điểm biểu đồ nhánh che không có loiNhuan
      const c = theVaBieuDo.bieuDo[0].hienTai.loiNhuan;
      void [a, b, c];
    }

    // Dựng nhánh che có thêm chiPhi ở thẻ ⇒ lỗi trường thừa.
    const thua: DuLieuTheVaBieuDo = {
      nhanKySoSanh: "x",
      motNgay: false,
      coQuyenGiaVon: false,
      the: {
        doanhSo: so,
        donHang: so,
        tbMoiDon: null,
        tyLeHoanHuy: null,
        // @ts-expect-error — nhánh che không được mang chiPhi
        chiPhi: so,
      },
      bieuDo: [],
    };
    void [chuaNarrow, thua];
  });

  it("theo kênh: lợi nhuận kênh chỉ có ở nhánh đủ quyền", () => {
    // @ts-expect-error — chưa narrow: dòng kênh nhánh che không có loiNhuan
    const chuaNarrow = theoKenh.rows[0].loiNhuan;
    if (theoKenh.coQuyenGiaVon) {
      const ln: number = theoKenh.rows[0].loiNhuan;
      void ln;
    } else {
      // @ts-expect-error — nhánh che không có loiNhuan
      const ln = theoKenh.rows[0].loiNhuan;
      void ln;
    }
    void chuaNarrow;
  });
});
