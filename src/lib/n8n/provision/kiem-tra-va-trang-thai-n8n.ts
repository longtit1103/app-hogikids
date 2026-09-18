import { gopKetQua, type KetQuaKiemTra } from "@/lib/ket-noi/kiem-tra-types";
import { prisma } from "@/lib/prisma";

import { DANH_SACH_WORKFLOW } from "./doc-goi-workflow-tu-repo";
import { listWorkflows, taoN8nClient } from "./n8n-api-client";

/**
 * Nút "Kiểm tra n8n" + trạng thái hiển thị cho khối "Kết nối n8n" ở /cai-dat.
 * Probe CHỈ ĐỌC (GET danh sách workflow) — chưa gửi secret nào đi đâu.
 */

export async function kiemTraN8n(): Promise<KetQuaKiemTra> {
  const rows = await prisma.setting.findMany({ where: { key: { in: ["n8nBaseUrl", "n8nApiKey"] } } });
  const theoKey = new Map(rows.map((r) => [r.key, r.value]));
  const baseUrl = theoKey.get("n8nBaseUrl") ?? "";
  const apiKey = theoKey.get("n8nApiKey") ?? "";
  if (!baseUrl || !apiKey) {
    return gopKetQua([{ nhan: "Cấu hình", ok: false, chiTiet: "Chưa lưu đủ n8n URL + API key." }]);
  }

  try {
    const client = taoN8nClient(baseUrl, apiKey);
    const danhSach = await listWorkflows(client);
    const tenTrenN8n = new Set(danhSach.map((w) => w.name));
    const daCo = DANH_SACH_WORKFLOW.filter((w) => tenTrenN8n.has(w.ten)).length;
    return gopKetQua([
      {
        nhan: "n8n",
        ok: true,
        chiTiet: `Nối được (${danhSach.length} workflow trên n8n, ${daCo}/${DANH_SACH_WORKFLOW.length} workflow của app đã có mặt).`,
      },
    ]);
  } catch (e) {
    // Message của client API cam kết không chứa API key — hiện nguyên văn được.
    return gopKetQua([{ nhan: "n8n", ok: false, chiTiet: e instanceof Error ? e.message : "Kiểm tra thất bại." }]);
  }
}

export type TrangThaiKetNoiN8n = {
  /** Giá trị hiện của 2 ô KHÔNG mật. */
  n8nBaseUrl: string;
  n8nWebhookPublicBase: string;
  /** API key là CHỈ-GHI: chỉ đuôi 4 ký tự (null = chưa lưu / quá ngắn). */
  apiKeyDuoi: string | null;
  apiKeyDaLuu: boolean;
  /** Số workflow đã từng được lượt Cài ghi id — 0 = chưa Cài lần nào. */
  soWorkflowDaCai: number;
};

const DO_DAI_TOI_THIEU_HIEN_DUOI = 8;

export async function docTrangThaiKetNoiN8n(): Promise<TrangThaiKetNoiN8n> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["n8nBaseUrl", "n8nWebhookPublicBase", "n8nApiKey", "n8nWorkflowIds"] } },
  });
  const theoKey = new Map(rows.map((r) => [r.key, r.value]));
  const apiKey = theoKey.get("n8nApiKey") ?? "";
  let soDaCai = 0;
  try {
    soDaCai = Object.keys(JSON.parse(theoKey.get("n8nWorkflowIds") ?? "{}") as Record<string, string>).length;
  } catch {
    soDaCai = 0;
  }
  return {
    n8nBaseUrl: theoKey.get("n8nBaseUrl") ?? "",
    n8nWebhookPublicBase: theoKey.get("n8nWebhookPublicBase") ?? "",
    apiKeyDaLuu: apiKey.length > 0,
    apiKeyDuoi: apiKey.length >= DO_DAI_TOI_THIEU_HIEN_DUOI ? apiKey.slice(-4) : null,
    soWorkflowDaCai: soDaCai,
  };
}
