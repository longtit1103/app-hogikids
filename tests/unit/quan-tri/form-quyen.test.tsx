// @vitest-environment jsdom
/**
 * Form quyền: tick Sửa kéo Xem; chọn mẫu điền đúng ô; Lãi/Lỗ thiếu giá vốn hiện lỗi và KHÔNG tự tick.
 * Component điều khiển (giá trị do cha giữ) nên test bọc bằng một cha giữ state thật.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FormQuyen } from "@/components/quan-tri/form-quyen";
import { batTatQuyen, loiToHopQuyen } from "@/components/quan-tri/quyen-form-logic";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

let cuoi: Quyen[] = [];

function Cha({ dau = [] as Quyen[] }: { dau?: Quyen[] }) {
  const [v, setV] = useState<Quyen[]>(dau);
  cuoi = v;
  return <FormQuyen giaTri={v} onChange={setV} />;
}

const o = (ten: string) => screen.getByRole("checkbox", { name: ten });

afterEach(() => {
  cleanup();
  cuoi = [];
});

describe("batTatQuyen / loiToHopQuyen (thuần)", () => {
  it("bật :sua kéo :xem; tắt :xem kéo tắt :sua", () => {
    const a = batTatQuyen([], "chi-phi:sua", true);
    expect(new Set(a)).toEqual(new Set(["chi-phi:sua", "chi-phi:xem"]));
    expect(batTatQuyen(a, "chi-phi:xem", false)).toEqual([]);
  });

  it("Lãi/Lỗ thiếu giá vốn ⇒ lỗi; có giá vốn ⇒ null", () => {
    expect(loiToHopQuyen(["tai-chinh-loi-lo:xem"])).toMatch(/giá vốn/i);
    expect(loiToHopQuyen(["tai-chinh-loi-lo:xem", "gia-von-loi-nhuan:xem"])).toBeNull();
  });
});

describe("FormQuyen", () => {
  it("tick Sửa của Sổ chi phí ⇒ Xem tự tick", () => {
    render(<Cha />);
    fireEvent.click(o("Sổ chi phí — Sửa"));
    expect(o("Sổ chi phí — Xem").getAttribute("aria-checked")).toBe("true");
    expect(o("Sổ chi phí — Sửa").getAttribute("aria-checked")).toBe("true");
  });

  it("chọn mẫu Kho ⇒ đúng 3 ô tick (Đơn hàng, Sản phẩm, Tồn kho — Xem)", () => {
    render(<Cha />);
    fireEvent.change(screen.getByLabelText("Áp dụng mẫu"), { target: { value: "kho" } });
    expect(new Set(cuoi)).toEqual(new Set(["don-hang:xem", "san-pham:xem", "ton-kho:xem"]));
    const dangTick = screen.getAllByRole("checkbox").filter((c) => c.getAttribute("aria-checked") === "true");
    expect(dangTick).toHaveLength(3);
  });

  it("tick Lãi/Lỗ không giá vốn ⇒ hiện lỗi, KHÔNG tự tick giá vốn; tick giá vốn ⇒ hết lỗi", () => {
    render(<Cha />);
    expect(screen.queryByTestId("loi-to-hop-quyen")).toBeNull();
    fireEvent.click(o("Tài chính — Lãi/Lỗ — Xem"));
    expect(screen.getByTestId("loi-to-hop-quyen").textContent).toMatch(/giá vốn/i);
    expect(o("Xem giá vốn & lợi nhuận").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(o("Xem giá vốn & lợi nhuận"));
    expect(screen.queryByTestId("loi-to-hop-quyen")).toBeNull();
  });

  it("module read-only (Đơn hàng) không có ô Sửa", () => {
    render(<Cha />);
    expect(screen.queryByRole("checkbox", { name: "Đơn hàng — Sửa" })).toBeNull();
  });
});
