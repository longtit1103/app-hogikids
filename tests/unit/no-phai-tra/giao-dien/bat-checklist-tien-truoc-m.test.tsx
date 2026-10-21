// @vitest-environment jsdom
/**
 * Checklist tab Chuẩn bị — năm điều kiện tiền trước ngày bật: đạt ⇒ ✓; chưa ⇒ câu lý do server + link tới đúng
 * chỗ dọn (khối Khoản vay ở Sổ quỹ; Sổ chi phí đúng khoảng tháng thiếu định kỳ — mở là bộ sinh tự ghi bù). Có mục
 * tự kiểm dặn khai đủ khoản vay / thấu chi / sổ tiết kiệm có từ trước ngày bật.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BatChecklist } from "@/components/no-phai-tra/bat-checklist";
import type { LoiDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";

afterEach(() => cleanup());

const muc = (chu: string) => screen.getAllByRole("listitem").find((li) => li.textContent?.includes(chu));

describe("BatChecklist — tiền trước ngày bật", () => {
  it("không lỗi ⇒ bốn mục máy kiểm đều ✓, có mục tự kiểm khai khoản vay/thấu chi/sổ tiết kiệm", () => {
    render(<BatChecklist loi={[]} />);
    for (const chu of [
      "kỳ khoản vay / lãi thấu chi",
      "chưa tất toán tiền gửi bắt buộc",
      "Chi phí định kỳ đến hạn trước ngày bật",
      "sổ tiết kiệm đáo hạn trước ngày bật",
      "Thấu chi lãi nhập gốc",
    ]) {
      expect(muc(chu)?.textContent).toContain("✓");
    }
    expect(screen.queryByTestId("bat-nhac-truoc-bat")).toBeNull();
    expect(muc("ví Shopee")).toBeUndefined();
    expect(muc("thấu chi, sổ tiết kiệm đang có từ trước ngày bật")?.textContent).toContain("(tự kiểm)");
  });

  it("lỗi kỳ vay ⇒ ✗ + câu + link khối Khoản vay; lỗi định kỳ ⇒ link Sổ chi phí đúng khoảng tháng", () => {
    const loi: LoiDieuKienBat[] = [
      {
        code: "CON_KY_VAY_TRUOC_M",
        message: 'Khoản "Vay VPBank" còn kỳ 01/10/2026 chưa duyệt',
        kyVayTruocM: [{ loanId: "l1", ten: "Vay VPBank", khoaNgayKy: "2026-10-01" }],
      },
      {
        code: "CON_DINH_KY_CHUA_GHI_TRUOC_M",
        message: "2 lần chi định kỳ đến hạn trước ngày bật chưa ghi",
        dinhKyTruocM: { soKhoan: 2, thang: ["09/2026", "10/2026"], khoaTu: "2026-09-01", khoaDen: "2026-10-31" },
      },
      { code: "CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M", message: 'còn tiền gửi bắt buộc chưa tất toán: "Vay chính sách"' },
    ];
    render(<BatChecklist loi={loi} />);

    const kyVay = screen.getByTestId("bat-ly-do-CON_KY_VAY_TRUOC_M");
    expect(kyVay.textContent).toContain("còn kỳ 01/10/2026");
    expect(within(kyVay).getByRole("link").getAttribute("href")).toBe("/tai-chinh?tab=dong-tien#khoan-vay");
    expect(muc("kỳ khoản vay / lãi thấu chi")?.textContent).toContain("✗");

    const dinhKy = screen.getByTestId("bat-ly-do-CON_DINH_KY_CHUA_GHI_TRUOC_M");
    const link = within(dinhKy).getByRole("link");
    expect(link.getAttribute("href")).toBe("/tai-chinh?tab=so-chi-phi&tu=2026-09-01&den=2026-10-31");
    expect(link.textContent).toContain("09/2026, 10/2026");

    expect(muc("sổ tiết kiệm đáo hạn trước ngày bật")?.textContent).toContain("✓");

    const tienGui = screen.getByTestId("bat-ly-do-CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M");
    expect(tienGui.textContent).toContain("Vay chính sách");
    expect(within(tienGui).getByRole("link").getAttribute("href")).toBe("/tai-chinh?tab=dong-tien#khoan-vay");
    expect(muc("chưa tất toán tiền gửi bắt buộc")?.textContent).toContain("✗");
  });

  it("lỗi kỳ lãi thấu chi chưa nhập gốc ⇒ ✗ + câu server + link khối Khoản vay", () => {
    render(
      <BatChecklist
        loi={[
          {
            code: "CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M",
            message: 'khoản "Vay thấu chi" kỳ 01/10/2026 lãi 643.836 ₫ — chuyển kỳ đó sang lãi nhập gốc trước khi bật',
          },
        ]}
      />
    );
    const lyDo = screen.getByTestId("bat-ly-do-CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M");
    expect(lyDo.textContent).toContain("kỳ 01/10/2026 lãi 643.836");
    expect(within(lyDo).getByRole("link").getAttribute("href")).toBe("/tai-chinh?tab=dong-tien#khoan-vay");
    expect(muc("Thấu chi lãi nhập gốc")?.textContent).toContain("✗");
    expect(muc("kỳ khoản vay / lãi thấu chi")?.textContent).toContain("✓");
  });

  it("ví Shopee chưa phủ tới ngày bật ⇒ khối nhắc vàng, KHÔNG là mục ✗ và không có khối lỗi đỏ", () => {
    render(
      <BatChecklist
        loi={[]}
        nhac={[{ code: "VI_SHOPEE_CHUA_PHU_TOI_M", message: "Dữ liệu ví Shopee mới tới 28/10 — không chặn bật." }]}
      />
    );
    const khoi = screen.getByTestId("bat-nhac-truoc-bat");
    expect(khoi.textContent).toContain("mới tới 28/10 — không chặn bật");
    expect(khoi.className).toContain("border-warning");
    expect(screen.queryByTestId("bat-ly-do-VI_SHOPEE_CHUA_PHU_TOI_M")).toBeNull();
    expect(screen.queryByText("✗")).toBeNull();
  });
});
