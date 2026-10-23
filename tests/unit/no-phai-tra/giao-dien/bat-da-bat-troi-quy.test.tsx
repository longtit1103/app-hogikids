// @vitest-environment jsdom
/**
 * Khối "Đã bật" — cảnh báo trôi quỹ trước ngày bật: null (bật trước khi lưu vân tay) hoặc trôi 0 ⇒ không hiện;
 * ≠ 0 ⇒ nêu số chênh SO VỚI LÚC BẬT (không khẳng định quỹ cao/thấp hơn tiền thật — bật để lại phần chưa giải thích
 * thì phần trôi có thể chính là phần khớp lại) + gợi ý đối chiếu + dòng về muộn (nếu dò được) + cách sửa dòng điều
 * chỉnh ngày bật khi đối chiếu thấy lệch thật. Dòng bù của lối "Sửa số tiền trước mốc" hiện ở nhóm riêng, không gộp
 * vào số dòng / tổng tác động của bước bật.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BatDaBatTomTat } from "@/components/no-phai-tra/bat-da-bat-tom-tat";
import { formatVnd } from "@/lib/format";
import type { TroiQuyHienThi } from "@/lib/no-phai-tra/doc-trang-no-phai-tra";

afterEach(() => cleanup());

const troiMau = (p: Partial<TroiQuyHienThi>): TroiQuyHienThi => ({
  troi: 0,
  quyLucBat: 150_000_000,
  quyHienTai: 150_000_000,
  dongNoiBat: [],
  soDongVeMuon: 0,
  tacDongVeMuon: 0,
  chamTran: false,
  ...p,
});

const ve = (troi: TroiQuyHienThi | null) =>
  render(<BatDaBatTomTat nhanM="01/11/2026" dieuChinh={[]} troi={troi} />);

describe("BatDaBatTomTat — cảnh báo trôi quỹ trước ngày bật", () => {
  it("null hoặc trôi 0 ⇒ không có khối cảnh báo", () => {
    ve(null);
    expect(screen.queryByTestId("no-phai-tra-troi-quy")).toBeNull();
    cleanup();
    ve(troiMau({ troi: 0 }));
    expect(screen.queryByTestId("no-phai-tra-troi-quy")).toBeNull();
    cleanup();
    render(<BatDaBatTomTat nhanM="01/11/2026" dieuChinh={[]} />);
    expect(screen.queryByTestId("no-phai-tra-troi-quy")).toBeNull();
  });

  it("trôi dương ⇒ nêu chênh so với lúc bật (không khẳng định lệch tiền thật), liệt kê dòng về muộn, lệch thật thì GIẢM điều chỉnh", () => {
    ve(
      troiMau({
        troi: 3_000_000,
        quyHienTai: 153_000_000,
        soDongVeMuon: 1,
        tacDongVeMuon: 3_000_000,
        dongNoiBat: [{ nhanNguon: "Ví Shopee rút về ngân hàng", ngayNhan: "25/10/2026", tacDong: 3_000_000, moTa: "rút ví" }],
      })
    );
    const khoi = screen.getByTestId("no-phai-tra-troi-quy");
    expect(khoi.textContent).toContain(`chênh +${formatVnd(3_000_000)} so với lúc bật`);
    expect(khoi.textContent).not.toContain("tiền thật " + formatVnd(3_000_000));
    expect(khoi.textContent).not.toMatch(/(cao|thấp) hơn tiền thật/);
    expect(khoi.textContent).toContain("Đối chiếu Sổ quỹ với sao kê ngân hàng");
    expect(khoi.textContent).toContain(`giảm tổng tác động ${formatVnd(3_000_000)}`);
    expect(screen.getByTestId("no-phai-tra-troi-quy-dong").textContent).toContain("25/10/2026 · Ví Shopee rút về ngân hàng · rút ví");
  });

  it("trôi âm, không dò được dòng ⇒ chênh âm so với lúc bật, câu hướng dẫn đối chiếu, lệch thật thì TĂNG điều chỉnh", () => {
    ve(troiMau({ troi: -750_000, quyHienTai: 149_250_000 }));
    const khoi = screen.getByTestId("no-phai-tra-troi-quy");
    expect(khoi.textContent).toContain(`chênh −${formatVnd(750_000)} so với lúc bật`);
    expect(khoi.textContent).not.toMatch(/(cao|thấp) hơn tiền thật/);
    expect(khoi.textContent).toContain(`tăng tổng tác động ${formatVnd(750_000)}`);
    expect(khoi.textContent).toContain("Không thấy dòng nào");
    expect(screen.queryByTestId("no-phai-tra-troi-quy-dong")).toBeNull();
  });

  it("chạm trần đọc ⇒ số dòng ghi 'Ít nhất'", () => {
    ve(
      troiMau({
        troi: 1,
        soDongVeMuon: 200,
        tacDongVeMuon: 1,
        chamTran: true,
        dongNoiBat: [{ nhanNguon: "Sổ chi phí", ngayNhan: "01/10/2026", tacDong: 1, moTa: "" }],
      })
    );
    expect(screen.getByTestId("no-phai-tra-troi-quy").textContent).toContain("Ít nhất 200 dòng");
  });

  it("dòng bù sửa số tiền trước mốc (yeuCauId null) hiện ở nhóm riêng, không gộp vào số dòng / tổng của bước bật", () => {
    render(
      <BatDaBatTomTat
        nhanM="01/11/2026"
        dieuChinh={[
          { id: "a", vao: false, soTien: 2_000_000, moTa: "Chênh chưa giải thích", ngayNhan: "01/11/2026", cuaBuocBat: true },
          { id: "b", vao: true, soTien: 500_000, moTa: "Bù sửa chi phí 15/10/2026", ngayNhan: "01/11/2026", cuaBuocBat: false },
        ]}
      />
    );
    const khoi = screen.getByTestId("no-phai-tra-da-bat");
    expect(khoi.textContent).toContain("Điều chỉnh quỹ ngày bật (1 dòng)");
    const buocBat = screen.getByTestId("no-phai-tra-lich-su-dieu-chinh");
    expect(buocBat.textContent).toContain("Chênh chưa giải thích");
    expect(buocBat.textContent).not.toContain("Bù sửa chi phí");
    expect(buocBat.textContent).toContain(`Tổng tác động lên quỹ−${formatVnd(2_000_000)}`);
    expect(khoi.textContent).toContain("Bù sửa số tiền trước ngày bật (1 dòng)");
    const bu = screen.getByTestId("no-phai-tra-bu-sua-tien");
    expect(bu.textContent).toContain("Bù sửa chi phí 15/10/2026");
    expect(bu.textContent).toContain(`Tổng bù+${formatVnd(500_000)}`);
  });

  it("chưa có dòng bù nào ⇒ không hiện nhóm bù", () => {
    render(
      <BatDaBatTomTat
        nhanM="01/11/2026"
        dieuChinh={[{ id: "a", vao: true, soTien: 1_000, moTa: "Chênh", ngayNhan: "01/11/2026", cuaBuocBat: true }]}
      />
    );
    expect(screen.queryByTestId("no-phai-tra-bu-sua-tien")).toBeNull();
  });
});

describe("BatDaBatTomTat — thẻ đã đóng còn dư nợ", () => {
  it("vắng/rỗng ⇒ không chỉ báo; có thẻ ⇒ nêu tên + số còn nợ", () => {
    render(<BatDaBatTomTat nhanM="01/11/2026" dieuChinh={[]} />);
    expect(screen.queryByTestId("the-dong-con-no")).toBeNull();
    cleanup();
    render(
      <BatDaBatTomTat nhanM="01/11/2026" dieuChinh={[]} theDongConNo={[{ id: "a", ten: "Thẻ cũ", duNo: 2_000_000 }]} />,
    );
    const khoi = screen.getByTestId("the-dong-con-no");
    expect(khoi.textContent).toContain("Thẻ cũ");
    expect(khoi.textContent).toContain(formatVnd(2_000_000));
  });
});
