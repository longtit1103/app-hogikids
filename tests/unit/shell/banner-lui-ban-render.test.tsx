import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * ShellChrome hiện banner "sau lùi bản" khi server truyền mốc, và KHÔNG hiện khi prop null/vắng.
 * Sidebar/Topbar/thanh tab được thay bằng khung rỗng — thứ cần đo là vùng banner.
 */
vi.mock("@/components/shell/sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/shell/topbar", () => ({ Topbar: () => null }));
vi.mock("@/components/shell/bottom-tab-bar", () => ({ BottomTabBar: () => null }));

import { ShellChrome } from "@/components/shell/shell-chrome";

function ve(dangLuiBanTu?: string | null): string {
  return renderToStaticMarkup(
    <ShellChrome
      shopName="Shop"
      missingCostCount={0}
      lowStockWarning={false}
      dataSyncHasError={false}
      syncHasBacklog={false}
      saoLuuCoVanDe={false}
      lechGiaVon={{ soLech: 0, mocLuc: null, gioTruoc: null, muc: "khop" }}
      soKhoanVayCoKyCho={0}
      phieuNhapChuaGhi={{ soChoDuyet: 0, soViecHauKiem: 0, mocLuc: null, muc: "khop" }}
      canhBaoSapCanQuy={null}
      hrefDuocPhep={[]}
      nguoiDung={{ email: "a@b.c", tenHienThi: "" }}
      dangLuiBanTu={dangLuiBanTu}
    >
      <p>noi-dung</p>
    </ShellChrome>,
  );
}

describe("ShellChrome — banner sau lùi bản", () => {
  it("có mốc ⇒ banner nói rõ chạy tien-lai-phan-quyen-m1.sql, kèm mốc", () => {
    const html = ve("10:00 01/10/2026");
    expect(html).toContain("trạng thái sau lùi bản");
    expect(html).toContain("tien-lai-phan-quyen-m1.sql");
    expect(html).toContain("10:00 01/10/2026");
    expect(html).toContain("noi-dung");
  });

  it("null hoặc vắng ⇒ không banner", () => {
    expect(ve(null)).not.toContain("lùi bản");
    expect(ve()).not.toContain("lùi bản");
  });
});
