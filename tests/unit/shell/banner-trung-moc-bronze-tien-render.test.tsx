import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Banner đỏ "kho thô tiền TikTok trùng thứ tự phiên bản": hiện khi server truyền câu cảnh báo, không hiện khi null/vắng,
 * và đứng CUỐI thứ tự ưu tiên: backlog → đồng bộ lỗi chung → sao lưu → trùng mốc. Tín hiệu bền không có lối gỡ trong app
 * không được che lỗi đồng bộ / sao lưu xảy ra sau nó (một ca tồn tại lâu thành câu đỏ quen mắt).
 */
vi.mock("@/components/shell/sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/shell/topbar", () => ({ Topbar: () => null }));
vi.mock("@/components/shell/bottom-tab-bar", () => ({ BottomTabBar: () => null }));

import { ShellChrome } from "@/components/shell/shell-chrome";

const CAU = "Kho thô tiền TikTok có khoá trùng thứ tự phiên bản — RawTiktokBusinessCost: 1 trùng mốc bản đầu";

function ve(p: { trungMoc?: string | null; backlog?: boolean; loiDongBo?: boolean; saoLuu?: boolean }): string {
  return renderToStaticMarkup(
    <ShellChrome
      shopName="Shop"
      missingCostCount={0}
      lowStockWarning={false}
      dataSyncHasError={p.loiDongBo ?? false}
      syncHasBacklog={p.backlog ?? false}
      trungMocBronzeTien={p.trungMoc}
      saoLuuCoVanDe={p.saoLuu ?? false}
      lechGiaVon={{ soLech: 0, mocLuc: null, gioTruoc: null, muc: "khop" }}
      soKhoanVayCoKyCho={0}
      phieuNhapChuaGhi={{ soChoDuyet: 0, soViecHauKiem: 0, mocLuc: null, muc: "khop" }}
      canhBaoSapCanQuy={null}
      hrefDuocPhep={[]}
      nguoiDung={{ email: "a@b.c", tenHienThi: "" }}
    >
      <p>noi-dung</p>
    </ShellChrome>,
  );
}

describe("ShellChrome — banner trùng mốc phiên bản kho thô tiền", () => {
  it("có câu cảnh báo ⇒ hiện nguyên văn", () => {
    const html = ve({ trungMoc: CAU });
    expect(html).toContain("RawTiktokBusinessCost");
    expect(html).toContain("trùng thứ tự phiên bản");
  });

  it("null hoặc vắng ⇒ không banner (không cảnh báo giả)", () => {
    expect(ve({ trungMoc: null })).not.toContain("trùng thứ tự phiên bản");
    expect(ve({})).not.toContain("trùng thứ tự phiên bản");
  });

  it("có lỗi đồng bộ chung ⇒ hiện câu lỗi đồng bộ, KHÔNG hiện câu trùng mốc (không che tín hiệu mới)", () => {
    const html = ve({ trungMoc: CAU, loiDongBo: true });
    expect(html).toContain("Đồng bộ gần đây có lỗi");
    expect(html).not.toContain("trùng thứ tự phiên bản");
  });

  it("sao lưu có vấn đề ⇒ hiện câu sao lưu, KHÔNG hiện câu trùng mốc", () => {
    const html = ve({ trungMoc: CAU, saoLuu: true });
    expect(html).toContain("Sao lưu đang có vấn đề");
    expect(html).not.toContain("trùng thứ tự phiên bản");
  });

  it("lỗi đồng bộ đứng trên sao lưu (thứ tự cũ giữ nguyên)", () => {
    const html = ve({ trungMoc: CAU, loiDongBo: true, saoLuu: true });
    expect(html).toContain("Đồng bộ gần đây có lỗi");
    expect(html).not.toContain("Sao lưu đang có vấn đề");
  });

  it("chỉ có trùng mốc (không backlog / lỗi đồng bộ / sao lưu) ⇒ câu trùng mốc hiện", () => {
    const html = ve({ trungMoc: CAU, loiDongBo: false, saoLuu: false, backlog: false });
    expect(html).toContain("trùng thứ tự phiên bản");
    expect(html).not.toContain("Đồng bộ gần đây có lỗi");
    expect(html).not.toContain("Sao lưu đang có vấn đề");
  });

  it("backlog vẫn đứng đầu", () => {
    const html = ve({ trungMoc: CAU, backlog: true });
    expect(html).toContain("Bronze còn backlog");
    expect(html).not.toContain("trùng thứ tự phiên bản");
  });
});
