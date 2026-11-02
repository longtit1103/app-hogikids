import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * Harness chạy TRỌN `deploy/restore.sh` với `docker` GIẢ (`docker-gia.sh`) đứng đầu PATH.
 *
 * Không chạm Postgres/Docker thật nào: stub chỉ ghi lại lời gọi + trả lời từ máy trạng thái trong thư
 * mục tạm. Thêm hai lớp an toàn phòng stub lỡ không được dùng (PATH sai): `DOCKER_HOST` trỏ socket
 * không tồn tại (docker thật nếu có cũng không nối được đâu) và `HOME` là thư mục tạm (tệp đánh dấu
 * mặc định không bao giờ rơi vào `~/docker/backups` của máy chạy test).
 *
 * Chạy bằng `spawn` (bất đồng bộ), KHÔNG `spawnSync`: ca "gửi SIGTERM giữa lượt" cần pipe stdout/stderr
 * còn mở sau tín hiệu — `spawnSync` hết `timeout` thì đóng pipe, bash chết vì SIGPIPE ở dòng echo kế
 * tiếp TRƯỚC khi kịp chạy trap (đo 28/10 trên bash 3.2: status null, signal SIGPIPE) ⇒ test đỏ oan.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
export const RESTORE_SH = path.join(repoRoot, "deploy/restore.sh");
export const DOCKER_GIA = path.join(here, "docker-gia.sh");

export type KichBanDockerGia = {
  /** `datacl` của DB đích trước lượt: "NULL" (mặc định) hoặc chuỗi `{…}` nguyên văn. */
  aclBanDau?: string;
  /** rolcanlogin của role app trước lượt (mặc định "t"). */
  loginBanDau?: "t" | "f";
  /** Tên container thêm vào kết quả `docker ps` (vd `hogikids-app`). */
  containerDangChay?: string[];
  /** Số lần đếm phiên đầu tiên còn trả > 0 (mặc định 0 = sạch ngay). */
  phienConLai?: number;
  /** Nhãn sự kiện (xem docker-gia.sh) bị tiêm lỗi. */
  loiKhi?: string[];
  /** Mã thoát của lời gọi bị tiêm lỗi (mặc định 1; > 128 = lệnh chết vì tín hiệu, vd 130 Ctrl-C). */
  maLoi?: number;
  /** Nhãn sự kiện mà stub NGỦ 2s trước khi trả lời (để gửi tín hiệu giữa chừng). */
  nguO?: string;
  /** Kết quả kiểm cột User.sessionEpoch: "1" (mặc định) hay "0" (dump đời trước phân quyền ⇒ mã 3). */
  cotSessionEpoch?: "0" | "1";
  /** Sau REVOKE quyền hiệu lực vẫn còn (grant từ grantor khác / role cha). */
  conQuyenSauRevoke?: boolean;
};

export type TuyChonChay = {
  dinhDang: "custom" | "gzip";
  db: string;
  schema?: string;
  kichBan?: KichBanDockerGia;
  /** Nội dung có sẵn của tệp đánh dấu (giả lập lượt trước dừng dở). */
  tepDangDoCoSan?: string;
  /** Số lần chờ hết phiên (mặc định 3, nghỉ 0s giữa hai lần). */
  hanChoLan?: number;
  /**
   * Gửi SIGTERM cho tiến trình restore.sh ĐÚNG lúc stub đang "chạy lâu" ở nhãn `kichBan.nguO`
   * (giả lập Ctrl-C / kill giữa lượt). Chờ tệp tín hiệu của stub chứ không hẹn giờ — máy CI chậm
   * thì hẹn giờ có thể bắn trước khi khoá, test đỏ/xanh theo tốc độ máy.
   */
  guiTermKhiStubNgu?: boolean;
  /** Nội dung SQL của dump `.sql.gz` (mặc định một bảng hợp lệ trong schema app). */
  sqlGzip?: string;
  /** Ghi đè `CONTAINER_DB_DICH` (stack diễn tập song song). */
  containerDb?: string;
};

export type KetQuaChay = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Nhãn sự kiện theo đúng thứ tự stub nhận. */
  suKien: string[];
  /** Toàn văn tham số từng lời gọi docker. */
  loiGoi: string[];
  aclCuoi: string;
  loginCuoi: string;
  tepDangDo: string;
  tepDangDoConKhong: boolean;
  /** File tạm `hogikids-*` restore.sh để lại trong TMPDIR (phải rỗng ở mọi lối thoát). */
  tepTamSot: string[];
};

const thuMucDaTao: string[] = [];

/** Gọi trong `afterEach` của file test. */
export function donThuMucHarness(): void {
  for (const d of thuMucDaTao.splice(0)) rmSync(d, { recursive: true, force: true });
}

const SQL_GZIP_MAC_DINH = 'CREATE SCHEMA app;\nCREATE TABLE app."X" (id integer);\n';

function taoDump(thuMuc: string, dinhDang: "custom" | "gzip", sqlGzip: string): string {
  if (dinhDang === "custom") {
    // Chỉ cần đúng magic byte PGDMP — nội dung archive do stub "đọc" (pg_restore giả).
    const f = path.join(thuMuc, "x.dump");
    writeFileSync(f, "PGDMP-gia-cho-harness");
    return f;
  }
  const f = path.join(thuMuc, "x.sql.gz");
  writeFileSync(f, gzipSync(sqlGzip));
  return f;
}

export async function chayRestoreVoiDockerGia(o: TuyChonChay): Promise<KetQuaChay> {
  const kb = o.kichBan ?? {};
  const d = mkdtempSync(path.join(tmpdir(), "restore-sh-loai-tru-"));
  thuMucDaTao.push(d);

  const bin = path.join(d, "bin");
  const trangThai = path.join(d, "trang-thai");
  const home = path.join(d, "home");
  const tmp = path.join(d, "tmp");
  for (const p of [bin, trangThai, home, tmp]) mkdirSync(p);
  copyFileSync(DOCKER_GIA, path.join(bin, "docker"));
  chmodSync(path.join(bin, "docker"), 0o755);
  writeFileSync(path.join(trangThai, "acl"), kb.aclBanDau ?? "NULL");
  writeFileSync(path.join(trangThai, "login"), kb.loginBanDau ?? "t");
  writeFileSync(path.join(trangThai, "phien"), String(kb.phienConLai ?? 0));
  writeFileSync(path.join(trangThai, "su-kien"), "");
  writeFileSync(path.join(trangThai, "loi-goi"), "");

  const tepDangDo = path.join(d, "backups", ".restore-dang-do");
  if (o.tepDangDoCoSan !== undefined) {
    mkdirSync(path.dirname(tepDangDo), { recursive: true });
    writeFileSync(tepDangDo, o.tepDangDoCoSan);
  }

  const dump = taoDump(d, o.dinhDang, o.sqlGzip ?? SQL_GZIP_MAC_DINH);
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    TMPDIR: tmp,
    LANG: process.env.LANG ?? "C.UTF-8",
    DOCKER_HOST: `unix://${path.join(d, "khong-co-docker-that.sock")}`,
    GIA_TRANG_THAI: trangThai,
    GIA_CONTAINER_DANG_CHAY: (kb.containerDangChay ?? []).join(" "),
    GIA_LOI_KHI: (kb.loiKhi ?? []).join(" "),
    GIA_MA_LOI: String(kb.maLoi ?? 1),
    GIA_COT_SESSION_EPOCH: kb.cotSessionEpoch ?? "1",
    GIA_CON_QUYEN_SAU_REVOKE: kb.conQuyenSauRevoke ? "1" : "0",
    GIA_NGU_O: kb.nguO ?? "",
    GIA_NGU_GIAY: "2",
    RESTORE_TEP_DANG_DO: tepDangDo,
    RESTORE_HAN_CHO_HET_PHIEN_LAN: String(o.hanChoLan ?? 3),
    RESTORE_NGU_GIUA_LAN_KIEM: "0",
  };
  if (o.containerDb !== undefined) env.CONTAINER_DB_DICH = o.containerDb;

  const { status, signal, stdout, stderr } = await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const c = spawn("bash", [RESTORE_SH, dump, o.db, o.schema ?? "app"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.setEncoding("utf8").on("data", (s: string) => (out += s));
    c.stderr.setEncoding("utf8").on("data", (s: string) => (err += s));
    c.on("error", reject);
    const tinHieu = path.join(trangThai, "dang-ngu");
    let hen: ReturnType<typeof setInterval> | undefined;
    if (o.guiTermKhiStubNgu) {
      hen = setInterval(() => {
        if (existsSync(tinHieu)) {
          clearInterval(hen);
          c.kill("SIGTERM");
        }
      }, 20);
    }
    // Lưới chống treo: restore.sh treo thì giết hẳn, test đỏ rõ ràng thay vì chờ hết hạn Vitest.
    const tran = setTimeout(() => c.kill("SIGKILL"), 12_000);
    c.on("close", (code, sig) => {
      if (hen) clearInterval(hen);
      clearTimeout(tran);
      resolve({ status: code, signal: sig, stdout: out, stderr: err });
    });
    c.stdin.end("y\n");
  });

  const doc = (f: string) => readFileSync(path.join(trangThai, f), "utf8");
  return {
    status,
    signal,
    stdout,
    stderr,
    suKien: doc("su-kien").split("\n").filter((s) => s.length > 0),
    loiGoi: doc("loi-goi").split("\0").filter((s) => s.length > 0),
    aclCuoi: doc("acl"),
    loginCuoi: doc("login"),
    tepDangDo,
    tepDangDoConKhong: existsSync(tepDangDo),
    tepTamSot: readdirSync(tmp).filter((f) => f.startsWith("hogikids-")),
  };
}
