// @vitest-environment jsdom
/**
 * Toast của modal phục hồi theo mã lỗi: 422 (dump đời trước phân quyền) bị route từ chối TRƯỚC khi
 * đụng bất cứ thứ gì ⇒ phải nói dữ liệu còn nguyên, KHÔNG được gợi ý "khôi phục thủ công/bản lùi"
 * như 500 — câu đó làm chủ shop tưởng dữ liệu đã hỏng và đi lùi về `pre-restore-*.dump` vô cớ.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
// Nút "Sao lưu ngay" kéo theo server action — không thuộc thứ cần đo ở đây.
vi.mock("@/components/settings/backup-button", () => ({ BackupButton: () => null }));

import { RestoreDialog } from "@/components/settings/restore-dialog";

const TEN_SHOP = "HogiKids";
const LOI_422 =
  "Bản backup chụp trước bản phân quyền (hoặc migration chưa hoàn tất) — phục hồi qua quy trình " +
  "trên host, mục 'Phục hồi dump đời trước phân quyền' của runbook";

async function bamPhucHoiVoiPhanHoi(status: number, body: unknown): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
  render(<RestoreDialog shopName={TEN_SHOP} />);
  fireEvent.click(screen.getByRole("button", { name: "Phục hồi từ file" }));
  fireEvent.change(screen.getByLabelText("File backup"), {
    target: { files: [new File(["x"], "cu.dump")] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Tiếp tục" }));
  fireEvent.change(screen.getByLabelText("Tên shop xác nhận"), { target: { value: TEN_SHOP } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Phục hồi" }));
  });
  expect(toast.error).toHaveBeenCalledTimes(1);
  return toast.error.mock.calls[0]![0] as string;
}

beforeEach(() => {
  toast.error.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RestoreDialog — toast theo mã lỗi", () => {
  it("422 ⇒ hiện đúng câu server + 'không bị đụng tới', KHÔNG gợi ý bản lùi", async () => {
    const cau = await bamPhucHoiVoiPhanHoi(422, { error: LOI_422 });

    expect(cau).toContain(LOI_422);
    expect(cau).toContain("Dữ liệu hiện tại không bị đụng tới");
    expect(cau).not.toMatch(/bản lùi|khôi phục thủ công/i);
  });

  it("500 ⇒ vẫn gợi ý khôi phục thủ công/bản lùi (không đổi)", async () => {
    const cau = await bamPhucHoiVoiPhanHoi(500, { error: "Phục hồi thất bại: pg_restore thất bại." });

    expect(cau).toContain("Khôi phục thủ công/bản lùi");
  });
});
