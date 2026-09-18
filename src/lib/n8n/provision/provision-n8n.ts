import { createHash, randomBytes } from "node:crypto";

import { N8N_RO_ROLE } from "@/lib/n8n/role-doc-kho-khoa";
import { prisma } from "@/lib/prisma";

import {
  activateWorkflow,
  createCredential,
  createWorkflow,
  deactivateWorkflow,
  deleteCredential,
  getWorkflow,
  listWorkflows,
  taoN8nClient,
  updateWorkflow,
  type N8nClient,
} from "./n8n-api-client";
import {
  DANH_SACH_WORKFLOW,
  dongGoiWorkflow,
  SYNC_NOW_AUTH_HEADER,
  SYNC_NOW_WEBHOOK_PATH,
  type CredentialGan,
} from "./doc-goi-workflow-tu-repo";

/**
 * "Cài / cập nhật workflows" — đẩy 10 workflow từ repo vào n8n qua Public API. Fail-closed từng
 * bước: credential lỗi ⇒ DỪNG trước mọi PUT (đè workflow trỏ credential không tồn tại là 10
 * workflow mất quyền đọc kho khoá, chết câm); backup ghi lỗi ⇒ BỎ workflow đó, không PUT.
 *
 * Idempotency neo bằng ID lưu trong `Setting` (`n8nWorkflowIds`, `n8nCredentialId`…) — Public API
 * KHÔNG liệt kê được credential và không lọc workflow theo tên, nên tên chỉ là đường dò dự phòng
 * cho lượt đầu (trùng tên ⇒ dừng dòng đó, không đoán).
 */

/** Tên credential GIỮ NGUYÊN như bản đã cấu hình tay trên prod — đổi tên là đẻ bản mới gây nhiễu. */
const TEN_CRED_POSTGRES = "hogikids-config-ro (bảng Setting)";
const TEN_CRED_HEADER = "hogikids-sync-now (header auth)";
/** Mỗi tên workflow giữ tối đa N bản backup — đủ lần ra vài lượt Cài gần nhất, không phình DB. */
const GIU_BACKUP_MOI_TEN = 5;

export type DongKetQuaProvision = {
  slug: string;
  ten: string;
  hanhDong: "tao" | "cap-nhat" | "loi";
  active: boolean;
  loi?: string;
};

export type KetQuaProvision = {
  rows: DongKetQuaProvision[];
  /** Kết quả probe end-to-end (kích webhook Đồng bộ ngay rồi chờ SyncLog) — bằng chứng n8nAppUrl/secret đúng. */
  probe: { ok: boolean; thongDiep: string };
};

/**
 * Khóa hạ tầng trong `Setting` sắp bị GHI ĐÈ bằng giá trị KHÁC — bắt người bấm xác nhận thay vì
 * đè âm thầm (deploy quên env là phá prod đang chạy — nỗi sợ ghi trong catalog từ đầu).
 */
export class CanXacNhanDoiHaTang extends Error {
  constructor(public chiTiet: string[]) {
    super(`Khóa hạ tầng sẽ bị đổi: ${chiTiet.join("; ")}`);
  }
}

/**
 * Mọi lời gọi Prisma trong file này đi qua 2 wrapper dưới: message lỗi Prisma có thể chứa CHÍNH
 * giá trị đang ghi (n8nIngestSecret, mật khẩu role…) mà message của file này theo `err` lên tận
 * toast — cùng quy tắc đã chốt ở settings-khoa-ket-noi.ts. Chi tiết thật nằm ở log server.
 */
async function bocPrisma<T>(viec: string, chay: () => Promise<T>): Promise<T> {
  try {
    return await chay();
  } catch (e) {
    console.error(`provision n8n — lỗi ${viec}:`, e);
    throw new Error(`Lỗi khi ${viec} (chi tiết trong log server).`);
  }
}

function docSetting(keys: string[]): Promise<Map<string, string>> {
  return bocPrisma("đọc kho khoá", async () => {
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
    return new Map(rows.map((r) => [r.key, r.value]));
  });
}

function ghiSetting(key: string, value: string): Promise<void> {
  return bocPrisma(`ghi kho khoá (${key})`, async () => {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  });
}

/** Backup bản đang chạy TRƯỚC khi PUT — hiện vật khôi phục được (bảng, không phải log). */
function backupWorkflow(name: string, payload: unknown): Promise<void> {
  return bocPrisma(`ghi backup workflow "${name}"`, async () => {
    await prisma.n8nWorkflowBackup.create({ data: { name, payload: JSON.stringify(payload) } });
    const thua = await prisma.n8nWorkflowBackup.findMany({
      where: { name },
      orderBy: { createdAt: "desc" },
      skip: GIU_BACKUP_MOI_TEN,
      select: { id: true },
    });
    if (thua.length > 0) {
      await prisma.n8nWorkflowBackup.deleteMany({ where: { id: { in: thua.map((t) => t.id) } } });
    }
  });
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Credential Postgres (đọc view SettingN8n) + header auth cho webhook Đồng bộ ngay.
 *
 * Xoay khoá: n8n KHÔNG cho đọc lại `data` của credential, nên lưu VÂN TAY (sha256 mật khẩu) vào
 * `Setting` lúc tạo — lượt Cài sau thấy mật khẩu role đã đổi (setup --rotate-ro-password) thì tạo
 * credential MỚI, trả id mới cho 10 workflow trỏ sang, rồi xoá bản cũ. Không có vân tay thì rotate
 * xong hệ gãy im lặng (credential cũ giữ mật khẩu cũ) — đúng sự cố restore.sh từng ghi.
 *
 * Header auth: giá trị là KHOÁ RIÊNG `n8nSyncNowSecret` app tự sinh — KHÔNG dùng INGEST_SECRET.
 * Header của request đến nằm PLAINTEXT trong execution data của n8n (không được mã hoá như
 * credential); INGEST_SECRET còn mở được kho token Meta/TikTok qua /api/ingest/*-token, để nó
 * lộ qua log execution là trao cả kho token — khoá riêng chỉ mua được đúng một lượt "kích sync".
 */
async function chuanBiCredentials(client: N8nClient, cauHinh: Map<string, string>): Promise<{ creds: CredentialGan; xoaSauKhiPut: string[] }> {
  const xoaSauKhiPut: string[] = [];

  const password = cauHinh.get("n8nDbRoPassword") ?? "";
  let pgId = cauHinh.get("n8nCredentialId") ?? "";
  const vanTayCu = cauHinh.get("n8nCredPgHash") ?? "";
  const canTaoPg = !pgId || (password !== "" && vanTayCu !== "" && vanTayCu !== sha256(password));
  if (canTaoPg) {
    const host = cauHinh.get("n8nDbHost") ?? "";
    const database = cauHinh.get("n8nDbName") ?? "";
    if (!host || !database || !password) {
      throw new Error(
        "Chưa có credential Postgres cho n8n và thiếu n8nDbHost/n8nDbName/n8nDbRoPassword trong Setting — " +
          "chạy `npm run setup` (bước tạo role đọc kho khoá) trước."
      );
    }
    const idCu = pgId;
    const tao = await createCredential(client, {
      name: TEN_CRED_POSTGRES,
      type: "postgres",
      // Schema Public API của credential postgres là allOf CÓ ĐIỀU KIỆN (đo n8n thật 22/08):
      // `allowUnauthorizedCerts=false` ⇒ BẮT BUỘC có `ssl`; `sshTunnel=false` ⇒ các field ssh*
      // PHẢI VẮNG MẶT (gửi kèm — kể cả rỗng — là 400 "prohibited"). Gửi đúng bộ dưới, đừng thêm.
      data: {
        host,
        port: Number(cauHinh.get("n8nDbPort") ?? "5432"),
        database,
        user: cauHinh.get("n8nDbUser") ?? N8N_RO_ROLE,
        password,
        maxConnections: 100,
        allowUnauthorizedCerts: false,
        ssl: cauHinh.get("n8nDbSsl") === "require" ? "require" : "disable",
        sshTunnel: false,
      },
    });
    pgId = tao.id;
    await ghiSetting("n8nCredentialId", pgId);
    await ghiSetting("n8nCredPgHash", sha256(password));
    if (idCu) xoaSauKhiPut.push(idCu); // chỉ xoá SAU khi 10 workflow đã trỏ id mới
  } else if (password && !vanTayCu) {
    // Credential có sẵn từ trước khi có cơ chế vân tay (prod seed id) — ghi vân tay để lượt
    // rotate SAU phát hiện được. Giả định giá trị hiện hành trong credential khớp Setting.
    await ghiSetting("n8nCredPgHash", sha256(password));
  }

  let syncSecret = cauHinh.get("n8nSyncNowSecret") ?? "";
  let headerId = cauHinh.get("n8nHeaderCredentialId") ?? "";
  if (!syncSecret) {
    syncSecret = randomBytes(24).toString("base64url");
    await ghiSetting("n8nSyncNowSecret", syncSecret);
    headerId = ""; // secret mới ⇒ credential cũ (nếu có) vô dụng
  }
  if (!headerId) {
    const tao = await createCredential(client, {
      name: TEN_CRED_HEADER,
      type: "httpHeaderAuth",
      data: { name: SYNC_NOW_AUTH_HEADER, value: syncSecret },
    });
    headerId = tao.id;
    await ghiSetting("n8nHeaderCredentialId", headerId);
  }

  return {
    creds: {
      postgres: { id: pgId, name: TEN_CRED_POSTGRES },
      headerAuth: { id: headerId, name: TEN_CRED_HEADER },
    },
    xoaSauKhiPut,
  };
}

/** Kích webhook Đồng bộ ngay rồi chờ SyncLog PANCAKE mới — chứng minh cả vòng n8n→app thông. */
async function probeEndToEnd(client: N8nClient, syncNowSecret: string): Promise<KetQuaProvision["probe"]> {
  // Chụp dòng PANCAKE MỚI NHẤT trước khi kích: chỉ dòng có id KHÁC + startedAt sau mốc mới được
  // tính — bớt dương tính giả khi một lượt sync khác tình cờ chạy trùng cửa sổ chờ.
  const truoc = await prisma.syncLog.findFirst({ where: { kind: "PANCAKE" }, orderBy: { startedAt: "desc" }, select: { id: true } });
  const moc = new Date();
  try {
    const res = await fetch(`${client.base}/webhook/${SYNC_NOW_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { [SYNC_NOW_AUTH_HEADER]: syncNowSecret },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, thongDiep: `Kích webhook Đồng bộ ngay bị từ chối (HTTP ${res.status}).` };
  } catch {
    return { ok: false, thongDiep: "Không kích được webhook Đồng bộ ngay — kiểm tra n8n URL / workflow active." };
  }
  // Sync-now trả 200 ngay rồi chạy nền; trang đầu thường land trong 1–2s ⇒ poll 1s, trần 20s
  // (server action này còn nằm sau reverse proxy có ngưỡng cắt ~100s — không được chờ dài hơn).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const log = await prisma.syncLog.findFirst({
      where: { kind: "PANCAKE", startedAt: { gte: moc }, ...(truoc ? { id: { not: truoc.id } } : {}) },
    });
    if (log) return { ok: true, thongDiep: "Đồng bộ thử đã chạy về tới app (SyncLog có dòng mới) — dây n8n→app thông." };
  }
  return {
    ok: false,
    thongDiep:
      "Đã kích webhook nhưng sau 20s app chưa nhận được trang nào — kiểm tra n8nAppUrl/n8nIngestSecret " +
      "(xem execution của pancake-sync-now trong n8n để biết nó bắn đi đâu).",
  };
}

export async function provisionN8n(opts: { xacNhanDoiHaTang?: boolean } = {}): Promise<KetQuaProvision> {
  const cauHinh = await docSetting([
    "n8nBaseUrl", "n8nApiKey", "n8nAppUrl", "n8nIngestSecret",
    "n8nCredentialId", "n8nHeaderCredentialId", "n8nWorkflowIds",
    "n8nCredPgHash", "n8nSyncNowSecret",
    "n8nDbHost", "n8nDbPort", "n8nDbName", "n8nDbUser", "n8nDbSsl", "n8nDbRoPassword",
  ]);

  const baseUrl = cauHinh.get("n8nBaseUrl") ?? "";
  const apiKey = cauHinh.get("n8nApiKey") ?? "";
  if (!baseUrl || !apiKey) throw new Error("Chưa lưu n8n URL + API key — điền 2 ô phía trên rồi bấm Lưu trước.");

  // Khóa hạ tầng do app TỰ GHI (quyết định từ catalog: không có ô sửa tay) — fail-closed: env
  // APP_INTERNAL_URL không có default, thiếu là dừng ở đây thay vì ghi một giá trị đoán mò.
  const appUrl = process.env.APP_INTERNAL_URL ?? "";
  const ingestSecret = process.env.INGEST_SECRET ?? "";
  if (!appUrl) throw new Error("Thiếu env APP_INTERNAL_URL (URL nội bộ app mà n8n gọi tới, vd http://hogikids-app:3000) — thêm vào .env rồi khởi động lại app.");
  if (!ingestSecret) throw new Error("Thiếu env INGEST_SECRET.");

  const doi: string[] = [];
  const appUrlCu = cauHinh.get("n8nAppUrl") ?? "";
  const secretCu = cauHinh.get("n8nIngestSecret") ?? "";
  if (appUrlCu && appUrlCu !== appUrl) doi.push(`n8nAppUrl: "${appUrlCu}" → "${appUrl}"`);
  if (secretCu && secretCu !== ingestSecret) doi.push("n8nIngestSecret: (giá trị sẽ đổi)");
  if (doi.length > 0 && !opts.xacNhanDoiHaTang) throw new CanXacNhanDoiHaTang(doi);

  // GET danh sách TRƯỚC khi gửi bất kỳ secret nào — URL sai/không phải n8n thì dừng ở đây.
  const client = taoN8nClient(baseUrl, apiKey);
  const danhSachTrenN8n = await listWorkflows(client);

  await ghiSetting("n8nAppUrl", appUrl);
  await ghiSetting("n8nIngestSecret", ingestSecret);

  // Credential lỗi ⇒ ném thẳng ra ngoài — CHƯA có PUT nào chạy (fail-closed).
  const { creds, xoaSauKhiPut } = await chuanBiCredentials(client, cauHinh);

  let mapIds: Record<string, string> = {};
  try {
    mapIds = JSON.parse(cauHinh.get("n8nWorkflowIds") ?? "{}") as Record<string, string>;
  } catch {
    mapIds = {}; // giá trị hỏng thì dò lại theo tên — không chết cả lượt vì một key rác
  }

  const rows: DongKetQuaProvision[] = [];
  for (const wf of DANH_SACH_WORKFLOW) {
    const body = dongGoiWorkflow(wf.slug, creds);
    const dong: DongKetQuaProvision = { slug: wf.slug, ten: body.name, hanhDong: "loi", active: false };
    rows.push(dong);
    try {
      // Tìm bản đang chạy: ưu tiên id đã lưu; id bị xoá bên n8n ⇒ rơi về dò tên (lượt đầu cũng vậy).
      let id = mapIds[wf.slug] ?? "";
      let hienTai = id ? await getWorkflow(client, id) : null;
      if (!hienTai) {
        const trungTen = danhSachTrenN8n.filter((w) => w.name === body.name);
        if (trungTen.length > 1) {
          dong.loi = `n8n đang có ${trungTen.length} workflow cùng tên "${body.name}" — xoá/đổi tên bản thừa rồi Cài lại.`;
          continue;
        }
        if (trungTen.length === 1) {
          id = trungTen[0].id;
          hienTai = await getWorkflow(client, id);
        }
      }

      if (hienTai) {
        // Id map trỏ một workflow TÊN KHÁC (ai đó đổi tên trên n8n UI / map khôi phục từ dump
        // của instance khác) ⇒ DỪNG dòng này thay vì PUT đè mù lên workflow của người ta.
        if (hienTai.name !== body.name) {
          dong.loi =
            `id đã lưu (${hienTai.id}) đang trỏ workflow tên "${hienTai.name}", không phải "${body.name}" — ` +
            `xoá key "${wf.slug}" trong Setting.n8nWorkflowIds hoặc đổi tên trên n8n rồi Cài lại.`;
          continue;
        }
        // Backup là CỔNG CHẶN: ghi không được thì KHÔNG PUT (mất bản đang chạy là mất đường lui).
        await backupWorkflow(hienTai.name, hienTai);
        await updateWorkflow(client, hienTai.id, body);
        id = hienTai.id;
        dong.hanhDong = "cap-nhat";
      } else {
        const tao = await createWorkflow(client, body);
        id = tao.id;
        dong.hanhDong = "tao";
      }
      mapIds[wf.slug] = id;

      // Đọc LẠI sau ghi — lớp lỗi "PUT làm mất settings ⇒ cron sai giờ" (01/08) chỉ bắt được ở đây.
      const docLai = await getWorkflow(client, id);
      if (!docLai) throw new Error("vừa ghi xong nhưng đọc lại không thấy — kiểm tra quyền API key.");
      const tzMuon = body.settings.timezone;
      if (tzMuon && docLai.settings?.timezone !== tzMuon) {
        dong.hanhDong = "loi";
        dong.loi = `n8n không giữ settings.timezone (muốn ${String(tzMuon)}, còn ${String(docLai.settings?.timezone)}) — cron sẽ chạy sai giờ, không tính là thành công.`;
        continue;
      }
      // Credential ref phải SỐNG SÓT qua PUT: id lưu sẵn có thể đã bị xoá bên n8n — n8n lúc đó
      // strip ref khỏi node và workflow chết câm ở node lấy khoá dù bảng này báo ✓.
      const nodeThieuCred = (docLai.nodes as Array<{ type?: string; credentials?: { postgres?: { id?: string } } }>)
        .some((n) => n.type === "n8n-nodes-base.postgres" && n.credentials?.postgres?.id !== creds.postgres.id);
      if (nodeThieuCred) {
        dong.hanhDong = "loi";
        dong.loi =
          "node Postgres sau khi ghi KHÔNG mang credential vừa gắn — nhiều khả năng n8nCredentialId trong Setting " +
          "trỏ credential đã bị xoá bên n8n. Xoá key n8nCredentialId (+n8nCredPgHash) rồi Cài lại để tạo mới.";
        continue;
      }

      // Workflow đang active mà vừa bị PUT: n8n có versioning — bản ĐANG CHẠY có thể vẫn là bản
      // cũ. deactivate→activate ép nạp bản mới + đăng ký lại webhook. Với bản mới tạo chỉ cần activate.
      if (wf.tuDongBat) {
        if (dong.hanhDong === "cap-nhat" && docLai.active) await deactivateWorkflow(client, id);
        await activateWorkflow(client, id);
        dong.active = true;
      } else {
        dong.active = docLai.active;
      }
    } catch (e) {
      dong.hanhDong = "loi";
      dong.loi = e instanceof Error ? e.message : String(e);
    }
  }

  await ghiSetting("n8nWorkflowIds", JSON.stringify(mapIds));

  // Credential CŨ (vừa bị thay do xoay khoá) chỉ xoá SAU khi 10 workflow đã trỏ id mới — xoá
  // trước là khoảng chết. Xoá lỗi thì chỉ cảnh báo (bản rác vô hại, dọn tay được trên n8n UI).
  for (const idCu of xoaSauKhiPut) {
    try {
      await deleteCredential(client, idCu);
    } catch {
      console.warn(`provision n8n: không xoá được credential cũ ${idCu} — dọn tay trên n8n UI.`);
    }
  }

  // Probe chỉ có nghĩa khi sync-now đã lên và active. Khoá webhook đọc lại từ Setting (khoá
  // RIÊNG app sinh — không phải INGEST_SECRET).
  const syncNow = rows.find((r) => r.slug === "pancake-sync-now");
  const syncNowSecret = (await docSetting(["n8nSyncNowSecret"])).get("n8nSyncNowSecret") ?? "";
  const probe =
    syncNow && syncNow.hanhDong !== "loi" && syncNow.active
      ? await probeEndToEnd(client, syncNowSecret)
      : { ok: false, thongDiep: "Bỏ qua probe — pancake-sync-now chưa cài/chưa active." };

  return { rows, probe };
}
