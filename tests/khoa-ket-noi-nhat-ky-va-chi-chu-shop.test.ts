import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
// Prisma giả: `$transaction(fn)` chạy callback với CHÍNH client giả ⇒ dòng nhật ký trong transaction
// và dòng LOI (client gốc) cùng rơi vào một `auditLog.create` — phân biệt bằng `ketQua`.
vi.mock("@/lib/prisma", () => {
  const client = {
    setting: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (fn: (tx: typeof client) => unknown) => fn(client));
  return { prisma: client };
});
vi.mock("@/lib/tokens/meta-doi-token-dai-han", () => ({ doiTokenMetaDaiHan: vi.fn() }));
vi.mock("@/lib/tokens/luu-token-meta", () => ({ luuTokenMetaVaoKho: vi.fn() }));
vi.mock("@/lib/n8n/provision/provision-n8n", async (goc) => ({
  ...(await goc<typeof import("@/lib/n8n/provision/provision-n8n")>()),
  provisionN8n: vi.fn(),
}));
vi.mock("@/lib/n8n/provision/kiem-tra-va-trang-thai-n8n", () => ({ kiemTraN8n: vi.fn() }));
vi.mock("@/lib/ket-noi/kiem-tra-pancake", () => ({ kiemTraPancake: vi.fn() }));

import { caiWorkflowsN8n, kiemTraKetNoiN8n, luuKetNoiN8n } from "@/lib/actions/n8n-ket-noi";
import { doiVaLuuTokenMeta, kiemTraKetNoiNguon, luuKhoaKetNoi } from "@/lib/actions/settings-khoa-ket-noi";
import { provisionN8n } from "@/lib/n8n/provision/provision-n8n";
import { prisma } from "@/lib/prisma";
import { DANH_MUC_QUYEN } from "@/lib/quyen/danh-muc-quyen";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { doiTokenMetaDaiHan } from "@/lib/tokens/meta-doi-token-dai-han";
import { luuTokenMetaVaoKho } from "@/lib/tokens/luu-token-meta";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";

/**
 * Khoá kết nối + kết nối n8n là OWNER-ONLY (spec phân quyền §1.1): tài khoản phụ có ĐỦ mọi quyền
 * cấp được vẫn bị từ chối ở cả đường ghi lẫn đường "kiểm tra" (đọc kho khoá rồi gọi nguồn ngoài).
 * Chủ shop ghi ⇒ có dòng nhật ký, và dòng đó KHÔNG mang giá trị khoá.
 */
const STAFF_DU_QUYEN = nguoiDungGia({ id: "staff-1", role: "STAFF", quyen: new Set(DANH_MUC_QUYEN) });

type DongNhatKy = { data: { hanhDong: string; ketQua: string; actorId: string | null; ghiChu?: unknown } };
const dongNhatKy = (): DongNhatKy["data"][] =>
  vi.mocked(prisma.auditLog.create).mock.calls.map((c) => (c[0] as DongNhatKy).data);

beforeEach(() => {
  vi.mocked(prisma.auditLog.create).mockReset().mockResolvedValue({} as never);
  vi.mocked(prisma.setting.upsert).mockReset().mockResolvedValue({} as never);
  vi.mocked(prisma.setting.findUnique).mockReset().mockResolvedValue(null);
  vi.mocked(prisma.setting.findMany).mockReset().mockResolvedValue([]);
  vi.mocked(provisionN8n).mockReset();
});

describe("tài khoản phụ đủ mọi quyền cấp được ⇒ KHONG_CO_QUYEN, không ghi, không gọi nguồn ngoài", () => {
  it.each([
    ["luuKhoaKetNoi", () => luuKhoaKetNoi("pancake", { pancakeApiKeyKho: "khoa-moi" })],
    ["kiemTraKetNoiNguon", () => kiemTraKetNoiNguon("pancake")],
    ["doiVaLuuTokenMeta", () => doiVaLuuTokenMeta("gia-tri-tuoi")],
    ["luuKetNoiN8n", () => luuKetNoiN8n({ n8nApiKey: "khoa-n8n" })],
    ["kiemTraKetNoiN8n", () => kiemTraKetNoiN8n()],
    ["caiWorkflowsN8n", () => caiWorkflowsN8n()],
  ] as const)("%s", async (_ten, goi) => {
    vi.mocked(docNguoiDungPhien).mockResolvedValueOnce(STAFF_DU_QUYEN);

    const r = await goi();

    expect(r).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
    expect(prisma.setting.findMany).not.toHaveBeenCalled();
    expect(provisionN8n).not.toHaveBeenCalled();
    expect(dongNhatKy()).toEqual([
      expect.objectContaining({ hanhDong: "TU_CHOI_QUYEN", ketQua: "LOI", actorId: "staff-1", ghiChu: { quyenThieu: "chu-shop" } }),
    ]);
  });
});

describe("chủ shop ghi ⇒ dòng nhật ký OK trong transaction, không mang giá trị khoá", () => {
  it("luuKhoaKetNoi ⇒ KHOA_KET_NOI_LUU, chỉ nguồn + số ô", async () => {
    const r = await luuKhoaKetNoi("pancake", { pancakeApiKeyKho: "gia-tri-khoa-bi-mat" });

    expect(r).toEqual({ ok: true, data: { daLuu: 1 } });
    expect(dongNhatKy()).toEqual([
      expect.objectContaining({ hanhDong: "KHOA_KET_NOI_LUU", ketQua: "OK", doiTuongId: "pancake", ghiChu: { soDong: 1 } }),
    ]);
    expect(JSON.stringify(dongNhatKy())).not.toContain("gia-tri-khoa-bi-mat");
  });

  it("luuKhoaKetNoi: nhật ký ném ⇒ báo lỗi lưu (transaction rollback), không báo thành công", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(new Error("nhat-ky-hong"));

    const r = await luuKhoaKetNoi("pancake", { pancakeApiKeyKho: "khoa" });

    expect(r).toEqual({ ok: false, error: "Lỗi khi lưu khóa vào kho" });
  });

  it("doiVaLuuTokenMeta ⇒ KHOA_KET_NOI_THAY_META sau khi lưu xong", async () => {
    vi.mocked(prisma.setting.findMany).mockResolvedValue([
      { key: "metaAdsAppId", value: "app" },
      { key: "metaAdsAppSecret", value: "secret" },
    ] as never);
    vi.mocked(doiTokenMetaDaiHan).mockResolvedValue({
      tokenMoi: "gia-tri-dai-han-bi-mat",
      conSong: true,
      hetHanEpoch: null,
      dataAccessHetHanEpoch: null,
    } as never);
    vi.mocked(luuTokenMetaVaoKho).mockResolvedValue(1);

    const r = await doiVaLuuTokenMeta("gia-tri-tuoi");

    expect(r.ok).toBe(true);
    expect(dongNhatKy()).toEqual([expect.objectContaining({ hanhDong: "KHOA_KET_NOI_THAY_META", ketQua: "OK" })]);
    expect(JSON.stringify(dongNhatKy())).not.toContain("bi-mat");
  });

  it("luuKetNoiN8n ⇒ N8N_LUU_KET_NOI kèm số ô", async () => {
    const r = await luuKetNoiN8n({ n8nApiKey: "khoa-n8n-bi-mat" });

    expect(r).toEqual({ ok: true, data: { daLuu: 1 } });
    expect(dongNhatKy()).toEqual([
      expect.objectContaining({ hanhDong: "N8N_LUU_KET_NOI", ketQua: "OK", ghiChu: { soDong: 1 } }),
    ]);
    expect(JSON.stringify(dongNhatKy())).not.toContain("bi-mat");
  });

  it("caiWorkflowsN8n xong ⇒ N8N_CAI_WORKFLOWS (OK); hỏng ⇒ dòng LOI", async () => {
    vi.mocked(provisionN8n).mockResolvedValueOnce({} as never);
    expect((await caiWorkflowsN8n()).ok).toBe(true);
    vi.mocked(provisionN8n).mockRejectedValueOnce(new Error("n8n từ chối"));
    expect(await caiWorkflowsN8n()).toEqual({ ok: false, error: "n8n từ chối" });

    expect(dongNhatKy()).toEqual([
      expect.objectContaining({ hanhDong: "N8N_CAI_WORKFLOWS", ketQua: "OK" }),
      expect.objectContaining({ hanhDong: "N8N_CAI_WORKFLOWS", ketQua: "LOI", ghiChu: { lyDo: "that-bai" } }),
    ]);
  });
});
