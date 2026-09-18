"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import type { KetQuaKiemTra } from "@/lib/ket-noi/kiem-tra-types";
import { kiemTraN8n } from "@/lib/n8n/provision/kiem-tra-va-trang-thai-n8n";
import { CanXacNhanDoiHaTang, provisionN8n, type KetQuaProvision } from "@/lib/n8n/provision/provision-n8n";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

// ---- Cài đặt › Kết nối & Đồng bộ › Kết nối n8n -------------------------------
//
// Bất biến của cả file (giống settings-khoa-ket-noi.ts): KHÔNG BAO GIỜ đưa giá trị khóa vào
// message lỗi hay kết quả — mọi chuỗi trả về hiện nguyên văn trên UI.

/** URL http/https một dòng — n8nBaseUrl là đích mà lượt Cài sẽ GỬI credential tới, sai là gửi nhầm chỗ. */
const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "phải là URL http:// hoặc https://");

const apiKeySchema = z.string().trim().min(1).max(1000).refine((v) => !/[\r\n]/.test(v), "không được xuống dòng");

/**
 * Lưu 3 ô của khối Kết nối n8n. Ô bỏ trống = GIỮ NGUYÊN (API key là chỉ-ghi, không hiện lại
 * giá trị cũ nên "trống" không thể hiểu là "xóa") — cùng hợp đồng với khối Khóa kết nối.
 */
export async function luuKetNoiN8n(values: {
  n8nBaseUrl?: string;
  n8nWebhookPublicBase?: string;
  n8nApiKey?: string;
}): Promise<ActionResult<{ daLuu: number }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const canGhi: Array<[string, string]> = [];
  for (const key of ["n8nBaseUrl", "n8nWebhookPublicBase"] as const) {
    const tho = values[key];
    if (tho === undefined || tho.trim() === "") continue;
    const parsed = urlSchema.safeParse(tho);
    if (!parsed.success) return { ok: false, error: `Ô ${key} không hợp lệ — ${parsed.error.issues[0]?.message}`, field: key };
    // Chuẩn hoá NGAY LÚC GHI: bỏ userinfo/query/fragment, một dạng duy nhất trong kho — URL này
    // là ĐÍCH mà lượt Cài gửi credential tới, chuỗi lạ lưu vào là gửi nhầm chỗ về sau.
    const u = new URL(parsed.data);
    canGhi.push([key, `${u.origin}${u.pathname.replace(/\/+$/, "")}`]);
  }
  if (values.n8nApiKey !== undefined && values.n8nApiKey.trim() !== "") {
    const parsed = apiKeySchema.safeParse(values.n8nApiKey);
    if (!parsed.success) return { ok: false, error: "API key không hợp lệ (một dòng, tối đa 1000 ký tự)", field: "n8nApiKey" };
    canGhi.push(["n8nApiKey", parsed.data]);
  }
  if (canGhi.length === 0) return { ok: false, error: "Chưa nhập giá trị nào để lưu" };

  try {
    await prisma.$transaction(
      canGhi.map(([key, value]) =>
        prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
      )
    );
  } catch {
    return { ok: false, error: "Lỗi khi lưu vào kho" };
  }

  revalidatePath("/cai-dat");
  return { ok: true, data: { daLuu: canGhi.length } };
}

/** Chỉ ĐỌC kho + GET danh sách workflow — không ghi gì nên không chặn lúc phục hồi. */
export async function kiemTraKetNoiN8n(): Promise<ActionResult<KetQuaKiemTra>> {
  await requireUser();
  try {
    return { ok: true, data: await kiemTraN8n() };
  } catch {
    return { ok: false, error: "Kiểm tra thất bại vì lỗi không lường trước — thử lại sau ít phút" };
  }
}

export type KetQuaCaiWorkflows =
  | { loai: "xong"; ketQua: KetQuaProvision }
  | { loai: "can-xac-nhan"; chiTiet: string[] };

/**
 * "Cài / cập nhật workflows vào n8n" — đường GHI nặng: ghi `Setting` (khóa hạ tầng + id map),
 * bảng backup, và ghi/kích hoạt workflow bên n8n. Khi khóa hạ tầng sắp bị đổi (deploy đổi env),
 * trả `can-xac-nhan` để UI hỏi lại thay vì đè âm thầm.
 */
export async function caiWorkflowsN8n(opts?: { xacNhanDoiHaTang?: boolean }): Promise<ActionResult<KetQuaCaiWorkflows>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    const ketQua = await provisionN8n({ xacNhanDoiHaTang: opts?.xacNhanDoiHaTang });
    revalidatePath("/cai-dat");
    return { ok: true, data: { loai: "xong", ketQua } };
  } catch (e) {
    if (e instanceof CanXacNhanDoiHaTang) {
      return { ok: true, data: { loai: "can-xac-nhan", chiTiet: e.chiTiet } };
    }
    // Message của tầng provision/client cam kết không chứa secret — hiện nguyên văn để lần được lỗi.
    return { ok: false, error: e instanceof Error ? e.message : "Cài workflows thất bại" };
  }
}
