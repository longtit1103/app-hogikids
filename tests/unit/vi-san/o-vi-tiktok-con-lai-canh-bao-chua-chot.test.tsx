import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OViTiktokConLai } from "@/components/finance/o-vi-tiktok-con-lai";
import { formatVnd } from "@/lib/format";

/**
 * Ô "Còn ở ví TikTok": statement sàn CHƯA chốt (≠ SETTLED) bị loại khỏi số ví — đúng, vì chưa làm ví
 * đổi đồng nào. Nhưng statement kẹt trạng thái cũ ngoài cửa sổ kéo lại thì bị loại mãi; không có dòng
 * cảnh báo là chủ shop không bao giờ biết số trên đang thiếu một khoản. Cảnh báo KHÔNG đổi con số.
 */

const vi = (chuaChot: { soDong: number; tong: number }) => ({
  b0ToiThieu: 0,
  viHienTai: 10_000_000,
  tangTuD0: null,
  chuaChot,
});

describe("OViTiktokConLai — cảnh báo statement chưa chốt", () => {
  it("có statement chưa chốt ⇒ nêu số dòng + tổng, số ví giữ nguyên", () => {
    const html = renderToStaticMarkup(<OViTiktokConLai vi={vi({ soDong: 2, tong: -25_000_000 })} />);

    expect(html).toContain(formatVnd(10_000_000));
    expect(html).toContain("2 statement TikTok chưa chốt");
    expect(html).toContain(formatVnd(-25_000_000));
    expect(html).toContain("chưa tính vào số trên");
  });

  it("không có statement chưa chốt ⇒ không có dòng cảnh báo", () => {
    const html = renderToStaticMarkup(<OViTiktokConLai vi={vi({ soDong: 0, tong: 0 })} />);

    expect(html).toContain(formatVnd(10_000_000));
    expect(html).not.toContain("chưa chốt");
  });

  it("dữ liệu ví hỏng (số âm) ⇒ vẫn nêu statement chưa chốt bên cạnh cảnh báo hỏng", () => {
    const html = renderToStaticMarkup(
      <OViTiktokConLai vi={{ ...vi({ soDong: 1, tong: 3_000_000 }), viHienTai: -1 }} />
    );

    expect(html).toContain("dữ liệu ví không khớp");
    expect(html).toContain("1 statement TikTok chưa chốt");
  });
});
