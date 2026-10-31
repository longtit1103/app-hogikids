/**
 * Nạp / xoay đường dẫn (path) 3 webhook Pancake → n8n vào `Setting` (`n8nWebhookPath.kho|shopee|tiktok`).
 *
 * VÌ SAO CẦN: path thật đã rời khỏi repo — file `n8n/pancake-webhook-*.json` chỉ còn placeholder, path
 * là dữ liệu của từng instance trong `Setting`. Ngay sau khi deploy bản này, `Setting` CHƯA có path:
 * trang Cài đặt báo thiếu URL và nút "Cài / cập nhật workflows" từ chối chạy (đúng ý — đẩy tiếp là
 * n8n đăng ký path placeholder, Pancake bắn vào 404). Script này nạp ĐÚNG path n8n đang chạy để hành
 * vi không đổi.
 *
 *   Lượt thử (MẶC ĐỊNH, chỉ đọc):     npx tsx scripts/nap-duong-dan-webhook-n8n.ts
 *   Nạp path n8n đang chạy:           npx tsx scripts/nap-duong-dan-webhook-n8n.ts --apply
 *   Bản clone MỚI (chưa có webhook):  npx tsx scripts/nap-duong-dan-webhook-n8n.ts --nguon=ngau-nhien [--apply]
 *                                     (TỪ CHỐI nếu Setting đã có path, hoặc n8n có workflow webhook Pancake đang bật /
 *                                     không đọc được n8n — chỉ vượt bằng --xac-nhan-ban-clone-moi)
 *   Xoay path (ghi ĐÈ path mới):      npx tsx scripts/nap-duong-dan-webhook-n8n.ts --xoay=kho,shopee,tiktok [--apply]
 *                                     (BẮT BUỘC một lần sau lượt nạp đầu: path cũ từng nằm trong lịch sử git)
 *   Trên minipc (không TTY):          docker compose run --rm app npx --no-install tsx \
 *                                       scripts/nap-duong-dan-webhook-n8n.ts --apply --xac-nhan-db=<tên DB>
 *
 * Nguồn `n8n` (mặc định): đọc workflow `pancake-webhook-<vai>` qua n8n Public API (n8n URL + API key
 * trong `Setting`, id theo `Setting.n8nWorkflowIds`, không có thì dò theo TÊN — trùng tên ⇒ bỏ vai đó),
 * rút path của node webhook. Workflow đang TẮT ⇒ bỏ vai đó (path của workflow tắt không chứng minh
 * Pancake đang bắn vào đó).
 *
 * AN TOÀN:
 *  - Nạp CHỈ ghi khoá còn TRỐNG; khoá đã có giá trị khác ⇒ báo LỆCH, KHÔNG ghi đè (idempotent, chạy
 *    lại được). Đổi path có chủ đích chỉ qua `--xoay`.
 *  - `--nguon=ngau-nhien` chỉ dành cho bản clone MỚI: bản đang chạy mà sinh path mới là đổi path dưới chân
 *    Pancake (Pancake vẫn bắn path cũ ⇒ 404, realtime chết im). Script vẫn đọc n8n ở nhánh này và từ chối
 *    khi không chứng minh được "chưa có webhook nào đang chạy".
 *  - `--xoay` CHỈ đổi `Setting`, KHÔNG gọi n8n: path mới có hiệu lực ở lượt "Cài / cập nhật workflows"
 *    kế tiếp, và đúng lúc đó path CŨ ngừng nhận — làm theo checklist xoay path ở
 *    `n8n/huong-dan-cai-dat-workflows.md` (giữ path cũ chạy song song tới khi Pancake đã trỏ path mới).
 *    Sau khi xoay, script in VÂN TAY sha256 của path mới (không in path) để dán vào `VAN_TAY_PATH_WEBHOOK`
 *    của `scripts/publish-public-snapshot.sh`.
 *  - Không bao giờ in trọn path: chỉ đuôi 4 ký tự (log terminal hay bị chép vào báo cáo/ticket).
 *  - Máy dev: `DATABASE_URL` trong `.env` trỏ THẲNG DB PROD ⇒ in `host/db` (không credential) và đòi gõ
 *    lại tên DB trước khi ghi. Không TTY ⇒ bắt buộc `--xac-nhan-db=<tên DB>`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

// Module thuần (không nạp Prisma lúc import) ⇒ import tĩnh được, không đụng thứ tự nạp .env bên dưới.
import * as dd from "@/lib/n8n/provision/duong-dan-webhook-pancake";
import type { DuongDanWebhookPancake, VaiWebhookPancake } from "@/lib/n8n/provision/duong-dan-webhook-pancake";

// Script standalone không đi qua Next auto-load .env → nạp bằng loader built-in của Node (≥20.6). Biến môi trường
// ĐÃ set (vd DATABASE_URL của container prod) được ưu tiên.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const VAI = dd.VAI_WEBHOOK_PANCAKE;

type ThamSo = {
  apply: boolean;
  nguon: "n8n" | "ngau-nhien";
  xoay: VaiWebhookPancake[];
  xacNhanDb: string | undefined;
  xacNhanBanCloneMoi: boolean;
};

/** Cờ gõ sai mà im lặng thành lượt thử = người chạy tưởng đã ghi ⇒ báo lỗi cờ lạ. */
function docThamSo(): ThamSo {
  let apply = false;
  let nguon: ThamSo["nguon"] = "n8n";
  let xoay: VaiWebhookPancake[] = [];
  let xacNhanDb: string | undefined;
  let coNguon = false;
  let xacNhanBanCloneMoi = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") continue;
    if (a === "--apply") apply = true;
    else if (a.startsWith("--nguon=")) {
      const v = a.slice("--nguon=".length);
      if (v !== "n8n" && v !== "ngau-nhien") throw new Error(`--nguon chỉ nhận n8n | ngau-nhien (được "${v}").`);
      nguon = v;
      coNguon = true;
    } else if (a.startsWith("--xoay=")) {
      const ds = a
        .slice("--xoay=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const v of ds) {
        if (!(VAI as readonly string[]).includes(v)) throw new Error(`--xoay chỉ nhận kho,shopee,tiktok (được "${v}").`);
      }
      if (ds.length === 0) throw new Error("--xoay cần ít nhất một vai: --xoay=kho,shopee,tiktok");
      xoay = [...new Set(ds)] as VaiWebhookPancake[];
    } else if (a.startsWith("--xac-nhan-db=")) xacNhanDb = a.slice("--xac-nhan-db=".length);
    else if (a === "--xac-nhan-ban-clone-moi") xacNhanBanCloneMoi = true;
    else {
      throw new Error(
        `Cờ không nhận ra: ${a}. Chỉ có --dry-run · --apply · --nguon=n8n|ngau-nhien · --xoay=kho,shopee,tiktok · ` +
          "--xac-nhan-db=<tên DB> · --xac-nhan-ban-clone-moi"
      );
    }
  }
  if (process.argv.includes("--dry-run") && apply) throw new Error("--dry-run và --apply loại trừ nhau.");
  if (xoay.length > 0 && coNguon) throw new Error("--xoay và --nguon loại trừ nhau (xoay luôn sinh path ngẫu nhiên mới).");
  if (xacNhanBanCloneMoi && nguon !== "ngau-nhien") throw new Error("--xac-nhan-ban-clone-moi chỉ đi cùng --nguon=ngau-nhien.");
  return { apply, nguon, xoay, xacNhanDb, xacNhanBanCloneMoi };
}

/** Định danh DB đích KHÔNG kèm credential: host + tên DB (+ schema, vì app/test chung DB `postgres`). */
function docDbDich(): { moTa: string; tenDb: string } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết đọc/ghi vào đâu.");
  const u = new URL(url);
  const tenDb = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const schema = u.searchParams.get("schema") || "public";
  return { moTa: `${u.host}/${tenDb} schema=${schema}`, tenDb };
}

/** Đòi gõ lại ĐÚNG tên DB đích. Không TTY ⇒ phải truyền `--xac-nhan-db`. */
async function xacNhanTenDb(tenDb: string, xacNhanDb: string | undefined): Promise<boolean> {
  if (xacNhanDb !== undefined) return xacNhanDb === tenDb;
  if (!process.stdin.isTTY) {
    console.error("Không phải TTY (container/CI) — chạy lại kèm --xac-nhan-db=<tên DB đích>.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const tl = await rl.question(`Gõ lại tên DB đích ("${tenDb}") để xác nhận ghi: `);
    return tl.trim() === tenDb;
  } finally {
    rl.close();
  }
}

type KetQuaDocN8n = {
  /** Path hợp lệ của workflow ĐANG BẬT, theo vai. */
  nguon: Partial<DuongDanWebhookPancake>;
  /** Vai bị bỏ + lý do (hiện trong bảng). */
  lyDoBo: Map<VaiWebhookPancake, string>;
  trangThai: Record<VaiWebhookPancake, dd.TrangThaiWebhookTrenN8n>;
};

/**
 * Đọc workflow `pancake-webhook-<vai>` qua n8n Public API (n8n URL + API key trong `Setting`, id theo
 * `Setting.n8nWorkflowIds`, không có thì dò theo TÊN). Ném khi thiếu cấu hình n8n hoặc n8n không trả lời —
 * người gọi quyết định đó là lỗi (nạp) hay bằng chứng "không chứng minh được" (sinh ngẫu nhiên).
 */
async function docPathTuN8n(
  prisma: (typeof import("@/lib/prisma"))["prisma"],
  danhSachWorkflow: (typeof import("@/lib/n8n/provision/doc-goi-workflow-tu-repo"))["DANH_SACH_WORKFLOW"],
  n8n: typeof import("@/lib/n8n/provision/n8n-api-client")
): Promise<KetQuaDocN8n> {
  const cfg = new Map(
    (await prisma.setting.findMany({ where: { key: { in: ["n8nBaseUrl", "n8nApiKey", "n8nWorkflowIds"] } } })).map((r) => [
      r.key,
      r.value,
    ])
  );
  const baseUrl = cfg.get("n8nBaseUrl") ?? "";
  const apiKey = cfg.get("n8nApiKey") ?? "";
  if (!baseUrl || !apiKey) {
    throw new Error("Setting chưa có n8nBaseUrl/n8nApiKey — không đọc được workflow từ n8n (điền ở Cài đặt → Kết nối n8n).");
  }
  let mapIds: Record<string, string> = {};
  try {
    mapIds = JSON.parse(cfg.get("n8nWorkflowIds") ?? "{}") as Record<string, string>;
  } catch {
    mapIds = {}; // map hỏng ⇒ dò theo tên
  }
  const client = n8n.taoN8nClient(baseUrl, apiKey);
  let danhSach: Awaited<ReturnType<typeof n8n.listWorkflows>> | null = null;
  const nguon: Partial<DuongDanWebhookPancake> = {};
  const lyDoBo = new Map<VaiWebhookPancake, string>();
  const trangThai = { kho: "khong-ro", shopee: "khong-ro", tiktok: "khong-ro" } as Record<VaiWebhookPancake, dd.TrangThaiWebhookTrenN8n>;

  // Đọc từ n8n CẢ vai đã có Setting — để báo KHỚP/LỆCH (lệch = Setting trỏ path n8n không chạy).
  for (const vai of VAI) {
    const slug = `pancake-webhook-${vai}`;
    const ten = danhSachWorkflow.find((w) => w.slug === slug)?.ten;
    if (!ten) {
      lyDoBo.set(vai, `repo không có workflow ${slug}`);
      continue;
    }
    let wf = mapIds[slug] ? await n8n.getWorkflow(client, mapIds[slug]) : null;
    if (wf && wf.name !== ten) wf = null; // id trỏ workflow tên khác ⇒ không tin, dò theo tên
    if (!wf) {
      danhSach ??= await n8n.listWorkflows(client);
      const trung = danhSach.filter((w) => w.name === ten);
      if (trung.length === 0) trangThai[vai] = "khong-co";
      if (trung.length !== 1) {
        lyDoBo.set(vai, `n8n có ${trung.length} workflow tên "${ten}" (cần đúng 1)`);
        continue;
      }
      wf = await n8n.getWorkflow(client, trung[0].id);
    }
    if (!wf) {
      lyDoBo.set(vai, `không đọc được workflow "${ten}"`);
      continue;
    }
    if (!wf.active) {
      trangThai[vai] = "tat";
      lyDoBo.set(vai, `workflow "${ten}" đang TẮT — path của nó không chứng minh Pancake đang bắn vào`);
      continue;
    }
    const p = dd.rutDuongDanWebhookTuNodes(wf.nodes);
    if (!dd.laDuongDanWebhookHopLe(p)) {
      lyDoBo.set(vai, `workflow "${ten}" không có path webhook hợp lệ (placeholder/rỗng?)`);
      continue;
    }
    trangThai[vai] = "dang-chay";
    nguon[vai] = p;
  }
  return { nguon, lyDoBo, trangThai };
}

// import ĐỘNG: `src/lib/prisma.ts` đọc `DATABASE_URL` ngay lúc nạp module, import static bị hoist TRƯỚC
// `loadEnvFile` ở trên → client nối sai DB.
async function main(): Promise<void> {
  const thamSo = docThamSo();
  const db = docDbDich();
  console.log("DB đích:", db.moTa);

  const { prisma } = await import("@/lib/prisma");
  const { DANH_SACH_WORKFLOW } = await import("@/lib/n8n/provision/doc-goi-workflow-tu-repo");
  const n8n = await import("@/lib/n8n/provision/n8n-api-client");

  try {
    const hienCo = await dd.docDuongDanWebhookPancake(prisma);
    const theoKhoa = new Map(
      (await prisma.setting.findMany({ where: { key: { in: VAI.map((v) => dd.KHOA_SETTING_DUONG_DAN_WEBHOOK[v]) } } })).map((r) => [
        r.key,
        r.value.trim(),
      ])
    );
    const moTaHienCo = (vai: VaiWebhookPancake): string => {
      const v = theoKhoa.get(dd.KHOA_SETTING_DUONG_DAN_WEBHOOK[vai]);
      if (v === undefined) return "(trống)";
      return dd.laDuongDanWebhookHopLe(v) ? dd.cheDuongDan(v) : "(giá trị HỎNG — không dùng được)";
    };

    // ── Xoay: ghi ĐÈ path mới ngẫu nhiên ─────────────────────────────────────────
    if (thamSo.xoay.length > 0) {
      console.table(thamSo.xoay.map((vai) => ({ vai, hienCo: moTaHienCo(vai), sau: "path ngẫu nhiên MỚI (32 hex)" })));
      if (!thamSo.apply) {
        console.log("\nLƯỢT THỬ — KHÔNG ghi gì. Thêm --apply để xoay. Sau khi xoay: làm TIẾP checklist xoay path (hướng dẫn n8n).");
        return;
      }
      if (!(await xacNhanTenDb(db.tenDb, thamSo.xacNhanDb))) {
        process.exitCode = 1;
        console.error("Tên DB không khớp — KHÔNG ghi gì.");
        return;
      }
      const moi = await prisma.$transaction((tx) => dd.xoayDuongDanWebhookPancake(tx, thamSo.xoay));
      for (const vai of thamSo.xoay) console.log(`  ${vai}: đã xoay → ${dd.cheDuongDan(moi[vai] ?? "")}`);
      const ngay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
      console.log("\nDán các dòng dưới vào VAN_TAY_PATH_WEBHOOK trong scripts/publish-public-snapshot.sh (vân tay sha256, KHÔNG phải path):");
      for (const vai of thamSo.xoay) {
        const p = moi[vai];
        if (p) console.log(`    "${dd.vanTayDuongDan(p)}",  # ${vai} — xoay ${ngay}`);
      }
      console.log(
        "\nPath mới CHƯA có hiệu lực trên n8n. Tiếp theo: giữ path cũ chạy song song → bấm \"Cài / cập nhật workflows\" → " +
          "dán URL mới (trang Cài đặt) vào Pancake → chờ sự kiện THẬT về path mới → tắt path cũ → kiểm path cũ trả 404 → " +
          "commit vân tay ở trên."
      );
      return;
    }

    // ── Nạp: chỉ điền khoá trống ─────────────────────────────────────────────────
    const nguon: Partial<DuongDanWebhookPancake> = {};
    const lyDoBo = new Map<VaiWebhookPancake, string>();
    const canNap = hienCo.ok ? [] : hienCo.thieu;

    if (thamSo.nguon === "ngau-nhien") {
      // Cổng bản clone mới: đọc n8n + Setting TRƯỚC khi sinh — bản đang chạy lỡ chạy lệnh này (vd sau một lượt nạp
      // bỏ vai vì API key hết hạn) thì dừng ở đây thay vì đổi path dưới chân Pancake.
      let bangChung: dd.BangChungN8nChoSinhPath;
      try {
        bangChung = { docDuoc: true, trangThai: (await docPathTuN8n(prisma, DANH_SACH_WORKFLOW, n8n)).trangThai };
      } catch (e) {
        bangChung = { docDuoc: false, loi: e instanceof Error ? e.message : String(e) };
      }
      const settingDaCo = VAI.filter((v) => theoKhoa.has(dd.KHOA_SETTING_DUONG_DAN_WEBHOOK[v]));
      const tuChoi = dd.lyDoTuChoiSinhPathNgauNhien({ settingDaCo, n8n: bangChung });
      if (tuChoi.length > 0 && !thamSo.xacNhanBanCloneMoi) {
        for (const l of tuChoi) console.error(`  ✗ ${l}`);
        console.error(
          "\nTỪ CHỐI sinh path ngẫu nhiên: lối này CHỈ cho bản clone MỚI. Bản đang chạy: nạp path n8n đang dùng (bỏ --nguon) " +
            "hoặc xoay có chủ đích (--xoay). Chắc chắn là bản clone mới ⇒ thêm --xac-nhan-ban-clone-moi."
        );
        process.exitCode = 1;
        return;
      }
      if (tuChoi.length > 0) console.warn(`⚠ Bỏ qua ${tuChoi.length} lý do từ chối theo --xac-nhan-ban-clone-moi.`);
      for (const vai of canNap) nguon[vai] = dd.sinhDuongDanWebhookMoi();
    } else {
      const kq = await docPathTuN8n(prisma, DANH_SACH_WORKFLOW, n8n);
      Object.assign(nguon, kq.nguon);
      for (const [vai, l] of kq.lyDoBo) lyDoBo.set(vai, l);
    }

    console.table(
      VAI.map((vai) => {
        const daCo = theoKhoa.get(dd.KHOA_SETTING_DUONG_DAN_WEBHOOK[vai]);
        const tuNguon = nguon[vai];
        let duKien: string;
        if (!tuNguon) duKien = lyDoBo.get(vai) ? `BỎ — ${lyDoBo.get(vai)}` : "giữ nguyên";
        else if (daCo === undefined) duKien = "GHI";
        else if (daCo === tuNguon) duKien = "khớp — không ghi";
        else duKien = "LỆCH — KHÔNG ghi đè (đối chiếu tay)";
        return { vai, setting: moTaHienCo(vai), nguon: tuNguon ? dd.cheDuongDan(tuNguon) : "—", duKien };
      })
    );

    // Nạp chỉ đụng khoá TRỐNG — khoá đã có (kể cả giá trị hỏng) cần người quyết, không tự sửa.
    const seGhi = VAI.filter((v) => nguon[v] !== undefined && !theoKhoa.has(dd.KHOA_SETTING_DUONG_DAN_WEBHOOK[v]));
    if (seGhi.length === 0) {
      console.log("\nKhông có khoá nào cần ghi.");
      if (lyDoBo.size > 0) process.exitCode = 1;
      return;
    }
    if (!thamSo.apply) {
      console.log(`\nLƯỢT THỬ — KHÔNG ghi gì. Sẽ ghi: ${seGhi.join(", ")}. Đối chiếu bảng trên rồi chạy lại kèm --apply.`);
      return;
    }
    if (!(await xacNhanTenDb(db.tenDb, thamSo.xacNhanDb))) {
      process.exitCode = 1;
      console.error("Tên DB không khớp — KHÔNG ghi gì.");
      return;
    }
    const chiGhi: Partial<DuongDanWebhookPancake> = {};
    for (const v of seGhi) chiGhi[v] = nguon[v];
    const kq = await prisma.$transaction((tx) => dd.napDuongDanNeuThieu(tx, chiGhi));
    for (const r of kq) console.log(`  ${r.vai}: ${r.ketQua}`);
    if (kq.some((r) => r.ketQua === "lech")) {
      process.exitCode = 1;
      console.error("Có khoá bị ghi chồng bởi lượt khác trong lúc chạy (LỆCH) — chạy lại lượt thử để đối chiếu.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
