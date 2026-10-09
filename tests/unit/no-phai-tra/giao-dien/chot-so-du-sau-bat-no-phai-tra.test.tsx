// @vitest-environment jsdom
/**
 * Modal chốt số dư: TRƯỚC mốc bật nợ phải trả dặn "trừ dư nợ thẻ" (sổ đã trừ ads ngay ngày chạy); SAU mốc
 * thì câu đó sai (nợ thẻ ngoài quỹ) ⇒ bỏ, ô ngân hàng gõ đúng số thật. Có ví quảng cáo trả trước ⇒ thêm gợi
 * ý đọc chênh âm (lần nạp ví chưa ghi), không bảo cộng ví vào ô ngân hàng.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/actions/so-du-chot-thang", () => ({ luuSoDuChotThang: vi.fn() }));

import { SoDuChotThangFormModal } from "@/components/finance/so-du-chot-thang-form-modal";
import { CAU_TRUC_RONG, type NguCanhChot } from "@/lib/so-quy/doi-chieu-so-du-chot";

function mo(nguCanhChot?: NguCanhChot) {
  render(
    <SoDuChotThangFormModal
      open
      onOpenChange={() => {}}
      thangIso="2026-11-01T00:00:00.000Z"
      thangNhan="11/2026"
      chot={null}
      cauTruc={CAU_TRUC_RONG}
      nguCanhChot={nguCanhChot}
    />
  );
}

afterEach(cleanup);

describe("SoDuChotThangFormModal theo mốc bật nợ phải trả", () => {
  it("chưa bật (mặc định) ⇒ còn câu 'trừ dư nợ thẻ', không gợi ý ví", () => {
    mo();
    expect(screen.queryByTestId("so-du-chot-nhac-the-tin-dung")).not.toBeNull();
    expect(screen.queryByTestId("so-du-chot-sau-bat-no-phai-tra")).toBeNull();
    expect(screen.queryByTestId("so-du-chot-goi-y-vi-ads")).toBeNull();
  });

  it("tháng sau mốc bật ⇒ bỏ câu 'trừ dư nợ thẻ', dặn gõ đúng số thật", () => {
    mo({ sauBatNoPhaiTra: true, coHoSoViAds: false });
    expect(screen.queryByTestId("so-du-chot-nhac-the-tin-dung")).toBeNull();
    expect(screen.getByTestId("so-du-chot-sau-bat-no-phai-tra").textContent).toContain("KHÔNG trừ dư nợ thẻ");
  });

  it("có hồ sơ ví quảng cáo trả trước ⇒ gợi ý đọc chênh âm", () => {
    mo({ sauBatNoPhaiTra: true, coHoSoViAds: true });
    expect(screen.getByTestId("so-du-chot-goi-y-vi-ads").textContent).toContain("Nạp ví quảng cáo");
  });
});
