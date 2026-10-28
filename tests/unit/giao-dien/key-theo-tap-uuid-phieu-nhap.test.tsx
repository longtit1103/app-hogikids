// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/actions/phieu-nhap-no", () => ({
  ghiNhanPhieuVaoSoNo: vi.fn(),
  capNhatTongPhieu: vi.fn(),
  danhDauHuyPhieu: vi.fn(),
  capNhatDaTraTruoc: vi.fn(),
  boQuaLechDaGiaiThich: vi.fn(),
}));
vi.mock("@/lib/actions/chi-phi-nhap-hang", () => ({ ghiChiPhiNhapHang: vi.fn() }));

import { DuyetChiPhiNhapHang } from "@/components/nhap-hang/duyet-chi-phi-nhap-hang";
import { GhiNhanPhieuVaoSoNo } from "@/components/no-phai-tra/ghi-nhan-phieu-vao-so-no";
import type { PhieuChoGhiNo } from "@/lib/no-phai-tra/doc-phieu-cho-ghi-no";

afterEach(cleanup);

/**
 * Hai màn duyệt phiếu khởi tạo state theo từng phiếu MỘT lần từ props. "Đồng bộ ngay" +
 * `router.refresh()` mang phiếu mới về cùng instance ⇒ state thiếu khoá của phiếu mới. Caller bọc
 * `key` theo TẬP uuid để mỗi lần tập đổi, component dựng lại state từ props mới.
 */
const khoaTheoUuid = (ds: readonly { uuid: string }[]) => ds.map((p) => p.uuid).join("|");

const phieuNo = (uuid: string, displayId: number): PhieuChoGhiNo => ({
  uuid,
  displayId,
  ngay: new Date(2026, 9, 2),
  soTien: 10_000_000,
  nhaCungCap: "NCC A",
  ghiChu: null,
  soDongHang: 3,
  lechLuoiKiem: false,
  truocD0: false,
  soNguon: null,
});

const deXuat = (uuid: string, displayId: number, soTien: number) => ({
  uuid,
  displayId,
  ngay: new Date(2026, 8, 5),
  soTien,
  soLuong: 3,
  soDongHang: 1,
  nhaCungCap: "NCC",
  ghiChu: null,
  refId: `PN:${uuid}`,
  lechLuoiKiem: false,
});

function BocGhiNo({ phieu }: { phieu: readonly PhieuChoGhiNo[] }) {
  return (
    <GhiNhanPhieuVaoSoNo key={khoaTheoUuid(phieu)} phieu={phieu} mocM="2026-10-01" laChuShop={false} choPhepSua />
  );
}

function BocDuyet({ ds }: { ds: ReturnType<typeof deXuat>[] }) {
  return <DuyetChiPhiNhapHang key={khoaTheoUuid(ds)} deXuat={ds} vanTay="v" quyHomNay={null} choPhepSua />;
}

describe("GhiNhanPhieuVaoSoNo bọc key theo tập uuid", () => {
  it("rerender với phiếu mới (uuid mới) không ném và hiện cả phiếu mới", () => {
    const { rerender } = render(<BocGhiNo phieu={[phieuNo("u1", 1)]} />);
    expect(() => rerender(<BocGhiNo phieu={[phieuNo("u1", 1), phieuNo("u2", 2)]} />)).not.toThrow();
    expect(screen.getByRole("button", { name: /Ghi nhận 2 phiếu vào sổ nợ/ })).toBeTruthy();
  });
});

describe("DuyetChiPhiNhapHang bọc key theo tập uuid", () => {
  it("phiếu mới về: được tick sẵn và có số đề xuất trong ô tiền", () => {
    const { rerender } = render(<BocDuyet ds={[deXuat("u1", 1, 500_000)]} />);
    rerender(<BocDuyet ds={[deXuat("u1", 1, 500_000), deXuat("u2", 2, 750_000)]} />);
    // Checkbox base-ui là phần tử role=checkbox mang aria-checked.
    expect(screen.getByLabelText("Chọn phiếu #2").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByDisplayValue("750.000")).toBeTruthy();
  });
});

describe("caller của hai màn duyệt phiếu bọc key", () => {
  const goc = join(__dirname, "..", "..", "..", "src", "app", "(app)", "tai-chinh");
  const khoaDung = /<GhiNhanPhieuVaoSoNo\s+key=\{[^}]*map\(\(p\) => p\.uuid\)\.join\("\|"\)[^}]*\}/;

  it.each(["chi-phi-nhap-hang/page.tsx", "no-phai-tra/page.tsx"])("%s có key theo tập uuid", (tep) => {
    expect(readFileSync(join(goc, tep), "utf8")).toMatch(khoaDung);
  });

  it("chi-phi-nhap-hang: DuyetChiPhiNhapHang cũng có key theo tập uuid", () => {
    const nguon = readFileSync(join(goc, "chi-phi-nhap-hang", "page.tsx"), "utf8");
    expect(nguon).toMatch(/<DuyetChiPhiNhapHang\s+key=\{[^}]*map\(\(d\) => d\.uuid\)\.join\("\|"\)[^}]*\}/);
  });
});
