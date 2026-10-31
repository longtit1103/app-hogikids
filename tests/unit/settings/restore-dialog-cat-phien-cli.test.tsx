// @vitest-environment jsdom
/**
 * Modal phục hồi khi `/api/restore` trả 409 kèm `phienDangGiu` (script ngoài app còn giữ khoá ghi
 * chung): hiện danh sách phiên + nút "Cắt phiên" (xác nhận hai lần) gọi `/api/restore/cat-phien`.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/settings/backup-button", () => ({ BackupButton: () => null }));

import { RestoreDialog } from "@/components/settings/restore-dialog";

const TEN_SHOP = "HogiKids";
const PHIEN = {
  pid: 4242,
  applicationName: "hogikids-cli[261028001]",
  backendStart: "2026-10-28T01:00:00.000Z",
  mode: "ShareLock",
  usename: "hogikids_app",
  catDuoc: true,
};
/** Phiên role khác (vd script chạy bằng superuser) — Postgres giấu `backend_start` với role thường. */
const PHIEN_KHAC_ROLE = {
  pid: 5151,
  applicationName: "hogikids-cli[261028001]:tao-role-n8n-ro",
  backendStart: "",
  mode: "ShareLock",
  usename: "supabase_admin",
  catDuoc: false,
};

type Goi = { url: string; init?: RequestInit };
let cacLanGoi: Goi[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `fetch` giả theo URL: restore trả `traRestore`, cat-phien trả `traCatPhien`. */
function dungFetch(traRestore: () => Response, traCatPhien: () => Response = () => json(200, { ok: true })) {
  cacLanGoi = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      cacLanGoi.push({ url, init });
      return url === "/api/restore/cat-phien" ? traCatPhien() : traRestore();
    }),
  );
}

async function bamPhucHoi(): Promise<void> {
  render(<RestoreDialog shopName={TEN_SHOP} />);
  fireEvent.click(screen.getByRole("button", { name: "Phục hồi từ file" }));
  fireEvent.change(screen.getByLabelText("File backup"), { target: { files: [new File(["x"], "cu.dump")] } });
  fireEvent.click(screen.getByRole("button", { name: "Tiếp tục" }));
  fireEvent.change(screen.getByLabelText("Tên shop xác nhận"), { target: { value: TEN_SHOP } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Phục hồi" }));
  });
}

const goiCatPhien = () => cacLanGoi.filter((g) => g.url === "/api/restore/cat-phien");

beforeEach(() => {
  toast.error.mockClear();
  toast.success.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RestoreDialog — cắt phiên script giữ khoá", () => {
  it("409 kèm phienDangGiu ⇒ hiện pid + application_name và nút Cắt phiên", async () => {
    dungFetch(() => json(409, { error: "Đang có script chạy ngoài app giữ khoá.", phienDangGiu: [PHIEN] }));

    await bamPhucHoi();

    expect(screen.getByText(/pid 4242/)).toBeTruthy();
    expect(screen.getByText(/hogikids-cli\[261028001\]/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cắt phiên" })).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("Đang có script chạy ngoài app giữ khoá.");
  });

  it("bấm Cắt phiên lần 1 chỉ xin xác nhận — CHƯA gọi route; lần 2 mới POST đúng pid rồi bỏ dòng", async () => {
    dungFetch(() => json(409, { error: "Script giữ khoá.", phienDangGiu: [PHIEN] }));
    await bamPhucHoi();

    fireEvent.click(screen.getByRole("button", { name: "Cắt phiên" }));
    expect(goiCatPhien()).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Bấm lại để cắt" }));
    });

    expect(goiCatPhien()).toHaveLength(1);
    expect(goiCatPhien()[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(goiCatPhien()[0]!.init?.body))).toEqual({ pid: 4242, backendStart: PHIEN.backendStart });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/pid 4242/)).toBeNull();
  });

  it("route từ chối (500) ⇒ báo lỗi và GIỮ dòng để thử lại", async () => {
    dungFetch(
      () => json(409, { error: "Script giữ khoá.", phienDangGiu: [PHIEN] }),
      () => json(500, { error: "Không cắt được phiên — cơ sở dữ liệu không phản hồi." }),
    );
    await bamPhucHoi();

    fireEvent.click(screen.getByRole("button", { name: "Cắt phiên" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Bấm lại để cắt" }));
    });

    expect(toast.error).toHaveBeenLastCalledWith("Không cắt được phiên — cơ sở dữ liệu không phản hồi.");
    expect(screen.getByText(/pid 4242/)).toBeTruthy();
  });

  it("phiên không còn giữ khoá (409 từ route) ⇒ bỏ dòng, không bắt bấm vô ích", async () => {
    dungFetch(
      () => json(409, { error: "Script giữ khoá.", phienDangGiu: [PHIEN] }),
      () => json(409, { error: "Phiên 4242 không còn giữ khoá ghi chung." }),
    );
    await bamPhucHoi();

    fireEvent.click(screen.getByRole("button", { name: "Cắt phiên" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Bấm lại để cắt" }));
    });

    expect(screen.queryByText(/pid 4242/)).toBeNull();
  });

  it("409 có phiên role KHÁC ⇒ không nút cắt cho phiên đó, hiện role + lệnh superuser cắt tay", async () => {
    dungFetch(() => json(409, { error: "Script giữ khoá.", phienDangGiu: [PHIEN, PHIEN_KHAC_ROLE] }));

    await bamPhucHoi();

    expect(screen.getAllByRole("button", { name: "Cắt phiên" })).toHaveLength(1); // chỉ phiên cùng role
    expect(screen.getByText(/pid 5151 · role supabase_admin/)).toBeTruthy();
    expect(screen.getByText("SELECT pg_terminate_backend(5151);")).toBeTruthy();
  });

  it("route báo phiên thuộc role khác (409 khacRole) ⇒ GIỮ dòng, chuyển sang nhóm cắt tay, hiện đúng lý do", async () => {
    const loi = 'Phiên 4242 thuộc role "supabase_admin" — app chỉ cắt được phiên cùng role của app.';
    dungFetch(
      () => json(409, { error: "Script giữ khoá.", phienDangGiu: [PHIEN] }),
      () => json(409, { error: loi, khacRole: true, usename: "supabase_admin" }),
    );
    await bamPhucHoi();

    fireEvent.click(screen.getByRole("button", { name: "Cắt phiên" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Bấm lại để cắt" }));
    });

    expect(toast.error).toHaveBeenLastCalledWith(loi);
    expect(screen.getByText(/pid 4242 · role supabase_admin/)).toBeTruthy();
    expect(screen.getByText("SELECT pg_terminate_backend(4242);")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cắt phiên" })).toBeNull();
  });

  it("409 KHÔNG kèm phienDangGiu (lượt phục hồi khác / đang đồng bộ) ⇒ không có nút Cắt phiên", async () => {
    dungFetch(() => json(409, { error: "Đang có một lượt phục hồi khác chạy." }));

    await bamPhucHoi();

    expect(screen.queryByRole("button", { name: "Cắt phiên" })).toBeNull();
  });

  it("phần tử phienDangGiu sai hình bị bỏ — chỉ phần tử hợp lệ có nút", async () => {
    dungFetch(() =>
      json(409, { error: "Script giữ khoá.", phienDangGiu: [{ pid: "x" }, null, PHIEN, { pid: 1.5, applicationName: "", backendStart: "", mode: "" }] }),
    );

    await bamPhucHoi();

    expect(screen.getAllByRole("button", { name: "Cắt phiên" })).toHaveLength(1);
  });
});
