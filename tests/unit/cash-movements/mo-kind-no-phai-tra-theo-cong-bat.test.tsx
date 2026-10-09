// @vitest-environment jsdom
/**
 * MỞ kind nợ phải trả cho đường ghi tay THƯỜNG — theo CỔNG BẬT, không theo enum (sửa CÓ CHỦ Ý từ bản
 * "trạng thái sau P1", nơi mọi kind mới bị zod chặn). Bốn điều:
 *  1. `CUTOVER_*` vẫn bị zod chặn ở ô "kind" trên CẢ tạo lẫn sửa — không câu DB nào chạy (chỉ bước bật tạo).
 *  2. 4 kind `CARD_PAY`/`SUPPLIER_PAY`/`SUPPLIER_REFUND`/`ADS_TOPUP` QUA zod và việc đầu tiên chạm DB là đọc
 *     công tắc (`Setting`) — cổng `daBatNoPhaiTra`, không phải câu ghi.
 *  3. Form KHÔNG có `noPhaiTra` (chưa bật) ⇒ không option nào là kind mới, kể cả người có quyền Sổ quỹ.
 *  4. Form CÓ `noPhaiTra` ⇒ đúng 4 kind mới, chỉ khi có quyền Sổ quỹ; `CUTOVER_*` không bao giờ.
 *
 * Không DB: `prisma` bị thay bằng proxy ghi lại MỌI lần chạm — zod phải chặn trước khi tới đó.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const chamPrisma: string[] = [];

vi.mock("@/lib/prisma", () => {
  const ghi = (duong: string): unknown =>
    new Proxy(() => {}, {
      get: (_t, k) => (typeof k === "string" ? ghi(`${duong}.${k}`) : undefined),
      apply: () => {
        chamPrisma.push(duong);
        throw new Error(`Không được chạm DB: ${duong}`);
      },
    });
  return { prisma: ghi("prisma") };
});
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("@/components/ui/select", () => {
  const Bo = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Bo,
    SelectContent: Bo,
    SelectGroup: Bo,
    SelectLabel: Bo,
    SelectTrigger: Bo,
    SelectValue: () => null,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
      <div role="option" aria-selected={false} data-value={value}>
        {children}
      </div>
    ),
  };
});

import { CashMovementFormModal } from "@/components/finance/cash-movement-form-modal";
import { createCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";

const KIND_GHI_TAY = ["CARD_PAY", "SUPPLIER_PAY", "SUPPLIER_REFUND", "ADS_TOPUP"] as const;
const KIND_CUTOVER = ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] as const;
const KIND_MOI = [...KIND_GHI_TAY, ...KIND_CUTOVER];

const hopLe = (kind: string) => ({ date: "2026-10-01", kind, amount: 1_000_000, description: "x" });
const ID = "ckabcdefghijklmnopqrstuvw";
const khoaTheoKind: Record<string, object> = {
  CARD_PAY: { cardId: ID },
  SUPPLIER_PAY: { phieuNhapId: ID },
  SUPPLIER_REFUND: { phieuNhapId: ID },
  ADS_TOPUP: { viAdsId: ID },
};

const noPhaiTra = {
  mocM: new Date("2026-11-01T00:00:00+07:00"),
  the: [{ id: ID, ten: "Thẻ A", dong: false }],
  phieu: [],
  vi: [],
};

afterEach(cleanup);

describe("action ghi tay thường — kind nợ phải trả mở theo cổng bật", () => {
  it.each(KIND_CUTOVER)("createCashMovement %s (có mô tả) ⇒ zod từ chối ô kind, không chạm DB", async (kind) => {
    chamPrisma.length = 0;
    const res = await createCashMovement({ ...hopLe(kind), description: "Điều chỉnh mở sổ" });
    expect(res).toEqual({ ok: false, error: "Chọn loại khoản", field: "kind" });
    expect(chamPrisma).toEqual([]);
  });

  it.each(KIND_CUTOVER)("updateCashMovement đổi sang %s ⇒ zod từ chối trước khi đọc dòng cũ", async (kind) => {
    chamPrisma.length = 0;
    const res = await updateCashMovement("cm-bat-ky", hopLe(kind));
    expect(res).toEqual({ ok: false, error: "Chọn loại khoản", field: "kind" });
    expect(chamPrisma).toEqual([]);
  });

  it.each(KIND_GHI_TAY)("createCashMovement %s qua zod ⇒ lần chạm DB ĐẦU TIÊN là đọc công tắc bật", async (kind) => {
    chamPrisma.length = 0;
    await createCashMovement({ ...hopLe(kind), ...khoaTheoKind[kind] }).catch(() => undefined);
    expect(chamPrisma[0]).toBe("prisma.setting.findUnique");
  });
});

describe("form + Nhập quỹ — kind nợ phải trả theo trạng thái bật", () => {
  const hien = () => screen.getAllByRole("option").map((o) => o.getAttribute("data-value"));

  it.each([false, true])("chưa bật (không noPhaiTra), choPhepLoaiSoQuy=%s ⇒ không option nào là kind mới", (choPhepLoaiSoQuy) => {
    render(
      <CashMovementFormModal open onOpenChange={() => {}} loans={[]} soTietKiem={[]} d0={null} choPhepLoaiSoQuy={choPhepLoaiSoQuy} />,
    );
    expect(hien().length).toBeGreaterThan(0);
    for (const k of KIND_MOI) expect(hien()).not.toContain(k);
  });

  it("đã bật + quyền Sổ quỹ ⇒ đủ 4 kind ghi tay, không CUTOVER_*", () => {
    render(
      <CashMovementFormModal open onOpenChange={() => {}} loans={[]} soTietKiem={[]} d0={null} choPhepLoaiSoQuy noPhaiTra={noPhaiTra} />,
    );
    for (const k of KIND_GHI_TAY) expect(hien()).toContain(k);
    for (const k of KIND_CUTOVER) expect(hien()).not.toContain(k);
  });

  it("đã bật nhưng thiếu quyền Sổ quỹ ⇒ không kind nợ nào", () => {
    render(
      <CashMovementFormModal
        open
        onOpenChange={() => {}}
        loans={[]}
        soTietKiem={[]}
        d0={null}
        choPhepLoaiSoQuy={false}
        noPhaiTra={noPhaiTra}
      />,
    );
    for (const k of KIND_MOI) expect(hien()).not.toContain(k);
  });
});
