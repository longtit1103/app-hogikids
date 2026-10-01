import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * deploy/don-anh-lui.sh — dọn ảnh rollback-* có bảo vệ cứng.
 *  (a) Hợp đồng TĨNH: đọc mã nguồn, cấm lệnh phá hàng loạt, bắt buộc đọc .deploy-vars + dry-run mặc định.
 *  (b) HÀNH VI: chạy script thật với `docker` GIẢ đặt đầu PATH (stub ghi log mọi lệnh nhận) —
 *      kiểm danh sách `rmi` ra đúng, không một lệnh phá nào lọt.
 * Không chạm docker thật. Script được nhận qua env DON_ANH_LUI_SCRIPT chỉ để chạy đột biến tay.
 */

const goc = (...phan: string[]) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..", ...phan);

const SCRIPT = process.env.DON_ANH_LUI_SCRIPT ?? goc("deploy", "don-anh-lui.sh");
const nguon = readFileSync(SCRIPT, "utf8");
const boDongComment = (s: string) =>
  s
    .split("\n")
    .filter((d) => !/^\s*#/.test(d))
    .join("\n");

describe("don-anh-lui.sh: hợp đồng tĩnh", () => {
  const lenh = boDongComment(nguon);

  it("không chứa lệnh phá hàng loạt / ép buộc", () => {
    expect(lenh).not.toMatch(/prune\s+-a\b/);
    expect(lenh).not.toMatch(/prune\s+--all/);
    expect(lenh).not.toMatch(/system\s+prune/);
    expect(lenh).not.toMatch(/image\s+prune/);
    expect(lenh).not.toMatch(/rmi\s+(-\S*f|--force)/);
    expect(lenh).not.toMatch(/--force/);
    expect(lenh).not.toMatch(/xargs/);
    expect(lenh).not.toMatch(/\brm\s+-rf/);
  });

  it("mọi lệnh `docker rmi` thật chỉ gỡ theo TÊN repo:tag", () => {
    const rmi = lenh
      .split("\n")
      .filter((d) => /docker rmi/.test(d) && !/^\s*echo /.test(d));
    expect(rmi.length).toBe(1);
    expect(rmi[0]).toMatch(/docker rmi "\$REPO:\$tag" \|\| die/);
  });

  it("dọn build cache luôn ghim --builder default và filter until=72h", () => {
    const cache = lenh.match(/docker builder prune[^\n]*/g) ?? [];
    expect(cache.length).toBeGreaterThan(0);
    for (const d of cache) {
      expect(d).toContain("--builder default");
      expect(d).toContain("--filter until=72h");
    }
  });

  it("đọc container bằng `docker container inspect`, không dùng `docker inspect` trần", () => {
    expect(lenh).toMatch(/docker container inspect/);
    expect(lenh).not.toMatch(/docker inspect\b/);
  });

  it("liệt kê ảnh luôn kèm --no-trunc (ID đầy đủ 64 hex)", () => {
    expect(lenh).toMatch(/docker images --no-trunc /);
  });

  it("không `source` file mốc; xoá thật bắt buộc vân tay", () => {
    expect(lenh).not.toMatch(/^\s*(source|\.)\s+/m);
    expect(lenh).toMatch(/--xac-nhan/);
    expect(lenh).toMatch(/\[ "\$XAC_NHAN" = "\$FP" \] \|\| die/);
  });

  it("đọc .deploy-vars (2 khoá) và thiếu file/khoá thì thoát lỗi", () => {
    expect(lenh).toMatch(/\.deploy-vars/);
    expect(lenh).toMatch(/OLD_IMAGE_ID/);
    expect(lenh).toMatch(/ROLLBACK_TAG/);
    expect(lenh).toMatch(/\[ -r "\$VARS_FILE" \] \|\| die/);
  });

  it("dry-run là mặc định: XOA_THAT=0 và rmi nằm sau cổng thoát dry-run", () => {
    expect(lenh).toMatch(/^XOA_THAT=0$/m);
    const cong = lenh.indexOf('if [ "$XOA_THAT" -ne 1 ]');
    const vanTay = lenh.indexOf('[ "$XAC_NHAN" = "$FP" ]');
    const rmi = lenh.indexOf("docker rmi");
    expect(cong).toBeGreaterThan(-1);
    expect(vanTay).toBeGreaterThan(cong);
    expect(rmi).toBeGreaterThan(vanTay);
  });

  it("set -euo pipefail và không dùng cú pháp bash4/GNU-only", () => {
    expect(lenh).toMatch(/^set -euo pipefail$/m);
    expect(lenh).not.toMatch(/\bmapfile\b|\breadarray\b|declare -A|date -d|\$\{[^}]*,,[^}]*\}|\$\{[^}]*\^\^[^}]*\}/);
  });
});

// ── Hành vi với docker giả ────────────────────────────────────────────────────

const STUB = `#!/usr/bin/env bash
# docker GIẢ: ghi log mọi lệnh, trả dữ liệu từ $FIX
echo "docker $*" >> "$FIX/docker.log"
case "$1" in
  container)
    # container inspect -f '{{.Image}}' <tên|id container>
    [ "$2" = "inspect" ] || exit 99
    while read -r cid name img; do
      if [ "$5" = "$cid" ] || [ "$5" = "$name" ]; then echo "$img"; exit 0; fi
    done < "$FIX/containers.txt"
    exit 1 ;;
  inspect) echo "docker giả: inspect trần bị cấm" >&2; exit 98 ;;
  image)
    # image inspect -f '{{.Id}}' repo:tag (CAT_ID_INSPECT=1: mô phỏng ID bị cắt 12 ký tự)
    while read -r repo tag id; do
      if [ "$5" = "$repo:$tag" ]; then
        if [ -n "\${CAT_ID_INSPECT:-}" ]; then x="\${id#sha256:}"; echo "\${x:0:12}"; else echo "$id"; fi
        exit 0
      fi
    done < "$FIX/images.txt"
    exit 1 ;;
  ps) cut -d' ' -f1 "$FIX/containers.txt" ;;
  images)
    # images [--no-trunc] --format F [repo]: tôn trọng đối số repo; thiếu --no-trunc ⇒ ID cắt 12 ký tự không tiền tố như docker thật
    NT=0; [ "$2" = "--no-trunc" ] && NT=1
    RP="$5"; [ "$NT" = 1 ] || RP="$4"
    while read -r repo tag id; do
      if [ -n "$RP" ] && [ "$repo" != "$RP" ]; then continue; fi
      if [ "$NT" = 1 ]; then echo "$repo $tag $id"; else x="\${id#sha256:}"; echo "$repo $tag \${x:0:12}"; fi
    done < "$FIX/images.txt" ;;
  rmi)
    if [ "\${RMI_FAIL:-}" = "$2" ]; then echo "Error: image is being used" >&2; exit 1; fi
    exit 0 ;;
  builder) cat > /dev/null; exit 0 ;;
  *) echo "docker giả: lệnh lạ $*" >&2; exit 99 ;;
esac
`;

const hex = (n: number) => n.toString(16).padStart(7, "0");
const idDe = (ten: string) => `sha256:${Buffer.from(ten).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const tagRb = (i: number) => `rollback-${hex(i)}-202609${String(10 + i).padStart(2, "0")}-1200`;
/** Ảnh lùi M1: cũ hơn mọi rollback i=1..19 ⇒ ngoài top-N, chỉ file mốc phụ mới giữ được. */
const TAG_M1 = "rollback-0b1c2d3-20260801-0900";
const ID_M1 = idDe("anh-lui-m1");
const M1_FILE = ".deploy-vars-truoc-m1";

interface Fixture {
  dir: string;
  vars: string;
  log: () => string[];
}
let fx: Fixture;

const khoaVars = (idHienThi: string, tag: string) => `OLD_HEAD=abc\nOLD_IMAGE_ID=${idHienThi}\nROLLBACK_TAG=${tag}\n`;
const varsMacDinh = () => khoaVars(idDe(tagRb(3)), `hogikids-app:${tagRb(3)}`);
const ghiAnh = (dong: string[]) => writeFileSync(path.join(fx.dir, "images.txt"), dong.join("\n") + "\n");
const ghiContainer = (dong: string[]) => writeFileSync(path.join(fx.dir, "containers.txt"), dong.join("\n") + "\n");

/** 19 rollback (i=1..19, i càng lớn càng mới) + ảnh lùi M1 cũ + latest + deploy-xxx + tag lạ + repo khác.
 *  Container chạy = id của latest = cũng là id của rollback i=11 (tag cũ cùng ảnh). Container dừng giữ rollback i=10.
 *  Vars mặc định: ROLLBACK_TAG = OLD_IMAGE_ID = rollback i=3. */
function dungFixture(opts: { vars?: string | null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "don-anh-lui-"));
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin", "docker"), STUB);
  chmodSync(path.join(dir, "bin", "docker"), 0o755);

  const idLatest = idDe("latest");
  const dong: string[] = [];
  for (let i = 1; i <= 19; i++) dong.push(`hogikids-app ${tagRb(i)} ${i === 11 ? idLatest : idDe(tagRb(i))}`);
  dong.push(`hogikids-app ${TAG_M1} ${ID_M1}`);
  dong.push(`hogikids-app latest ${idLatest}`);
  dong.push(`hogikids-app deploy-ad7a38d-20260917-1545 ${idDe("deploy")}`);
  dong.push(`hogikids-app deploy-trung-container-dung ${idDe(tagRb(10))}`);
  dong.push(`hogikids-app deploy-trung-old-image-id ${idDe(tagRb(3))}`);
  dong.push(`hogikids-app deploy-trung-m1 ${ID_M1}`);
  dong.push(`hogikids-app rollback-la-khong-co-moc ${idDe("la")}`);
  dong.push(`hogikids-app rollback-0000abc-2026093-1200 ${idDe("sai-ngay")}`);
  // repo KHÁC: nếu lọt qua lọc repo thì sẽ thành ứng viên XOÁ (đúng định dạng rollback, cũ)
  dong.push(`khac/hogikids-app rollback-1111111-20260901-1200 ${idDe("repo-khac")}`);
  dong.push(`supabase/postgres 15 ${idDe("supabase")}`);
  dong.push(`n8nio/n8n latest ${idDe("n8n")}`);

  mkdirSync(dir, { recursive: true });
  const vars = path.join(dir, ".deploy-vars");
  fx = {
    dir,
    vars,
    log: () => {
      try {
        return readFileSync(path.join(dir, "docker.log"), "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
  ghiAnh(dong);
  ghiContainer([`c1 hogikids-app ${idLatest}`, `c2 thu-nghiem-cu ${idDe(tagRb(10))}`]);
  if (opts.vars !== null) writeFileSync(vars, opts.vars ?? varsMacDinh());
}

function chay(args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync("/bin/bash", [SCRIPT, "--vars", fx.vars, ...args], {
    env: {
      ...process.env,
      GIU_ROLLBACK: "", // trống ⇒ script dùng mặc định 5, không nhiễm biến của máy chạy test
      PATH: `${path.join(fx.dir, "bin")}:/usr/bin:/bin`,
      HOME: fx.dir,
      FIX: fx.dir,
      ...env,
    },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const lamVanTay = (out: string) => /VÂN TAY: (\S+)/.exec(out)?.[1] ?? "";

/** Quy trình thật: dry-run lấy vân tay (chủ shop duyệt) rồi chạy --xoa-that --xac-nhan với CÙNG các cờ. */
function xoaThat(args: string[] = [], env: Record<string, string> = {}) {
  const kho = chay(args, env);
  return chay([...args, "--xoa-that", "--xac-nhan", lamVanTay(kho.out)], env);
}

const rmiLog = () => fx.log().filter((l) => l.startsWith("docker rmi"));
const rmiTag = (t: string) => `docker rmi hogikids-app:${t}`;
const dongBang = (out: string, tag: string) => out.split("\n").find((d) => d.startsWith(`hogikids-app:${tag} `)) ?? "";

beforeEach(() => dungFixture());
afterEach(() => rmSync(fx.dir, { recursive: true, force: true }));

describe("don-anh-lui.sh: hành vi với docker giả", () => {
  it("dry-run mặc định: in bảng + vân tay, exit 0, KHÔNG gọi rmi/builder", () => {
    const r = chay();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DRY-RUN/);
    expect(lamVanTay(r.out)).toMatch(/^[0-9a-f]{16}$/);
    expect(r.out).toContain(`hogikids-app:${tagRb(1)}`);
    expect(r.out).toMatch(/XOA/);
    expect(rmiLog()).toEqual([]);
    expect(fx.log().some((l) => l.startsWith("docker builder"))).toBe(false);
  });

  it("--xoa-that: xoá ĐÚNG danh sách (ngoài 5 ảnh mới nhất, trừ bảo vệ theo ID) từng tag theo tên", () => {
    const r = xoaThat();
    expect(r.code).toBe(0);
    // i=15..19 giữ (N=5); i=3 vars; i=10 container dừng; i=11 trùng ID ảnh đang chạy; ảnh lùi M1 cũ KHÔNG có file phụ ⇒ xoá.
    const mong = [...[1, 2, 4, 5, 6, 7, 8, 9, 12, 13, 14].map(tagRb), TAG_M1].map(rmiTag);
    expect(rmiLog().sort()).toEqual(mong.sort());
  });

  it("không bao giờ gọi rmi với latest, deploy-xxx, tag lạ, repo khác hay cờ ép", () => {
    xoaThat();
    for (const l of rmiLog()) {
      expect(l).toMatch(/^docker rmi hogikids-app:rollback-[0-9a-f]{7}-\d{8}-\d{4}$/);
      expect(l).not.toMatch(/deploy-ad7a38d|la-khong-co-moc|2026093-1200|supabase|n8n|latest|1111111/);
    }
    expect(fx.log().filter((l) => /prune|--force|\srmi -f/.test(l))).toEqual([]);
  });

  it("repo khác (khac/hogikids-app, supabase, n8n) không bao giờ vào bảng", () => {
    const r = chay();
    expect(r.out).not.toMatch(/1111111|supabase|n8nio/);
    // lệnh liệt kê luôn truyền đối số repo
    expect(fx.log().find((l) => l.startsWith("docker images"))).toMatch(/ hogikids-app$/);
  });

  it("tag rollback-* sai định dạng ⇒ GIỮ + cảnh báo", () => {
    const r = xoaThat();
    expect(r.err).toMatch(/sai định dạng/);
    expect(r.out).toMatch(/rollback-la-khong-co-moc\s+\S+\s+GIU/);
    expect(r.out).toMatch(/rollback-0000abc-2026093-1200\s+\S+\s+GIU/);
  });

  it("deploy-xxx mặc định GIỮ; chỉ xoá khi --xoa-tag đích danh", () => {
    expect(xoaThat().out).toMatch(/deploy-ad7a38d-20260917-1545\s+\S+\s+GIU/);
    expect(rmiLog().join("\n")).not.toContain("deploy-ad7a38d");
    xoaThat(["--xoa-tag", "deploy-ad7a38d-20260917-1545"]);
    expect(rmiLog()).toContain(rmiTag("deploy-ad7a38d-20260917-1545"));
  });

  it("--xoa-tag latest vẫn bị chặn", () => {
    xoaThat(["--xoa-tag", "latest"]);
    expect(rmiLog().join("\n")).not.toContain("hogikids-app:latest");
  });

  it("--xoa-tag vượt bảo vệ ID bị TỪ CHỐI: tag trùng ID container dừng / OLD_IMAGE_ID / ảnh lùi M1", () => {
    // đối chứng: tag không trùng ID bảo vệ nào thì --xoa-tag xoá được
    xoaThat(["--xoa-tag", "deploy-ad7a38d-20260917-1545"]);
    expect(rmiLog()).toContain(rmiTag("deploy-ad7a38d-20260917-1545"));
    rmSync(path.join(fx.dir, "docker.log"));

    writeFileSync(path.join(fx.dir, M1_FILE), khoaVars(ID_M1, `hogikids-app:${TAG_M1}`));
    const r = xoaThat([
      "--xoa-tag", "deploy-trung-container-dung",
      "--xoa-tag", "deploy-trung-old-image-id",
      "--xoa-tag", "deploy-trung-m1",
      "--xoa-tag", tagRb(10),
      "--xoa-tag", TAG_M1,
    ]);
    expect(r.code).toBe(0);
    const rm = rmiLog().join("\n");
    expect(rm).not.toMatch(/deploy-trung-/);
    expect(rm).not.toContain(tagRb(10));
    expect(rm).not.toContain(TAG_M1);
    expect(r.out).toMatch(/deploy-trung-m1\s+\S+\s+GIU\s+bảo vệ theo ID/);
  });

  it("--xoa-tag tag không tồn tại ⇒ cảnh báo, so chuỗi chính xác (không regex)", () => {
    const r = chay(["--xoa-tag", "deploy.*", "--xoa-tag", "khong-co-tag-nay"]);
    expect(r.err).toMatch(/--xoa-tag deploy\.\*: không có ảnh/);
    expect(r.err).toMatch(/--xoa-tag khong-co-tag-nay: không có ảnh/);
    expect(r.err).not.toMatch(/--xoa-tag deploy-ad7a38d/);
  });

  it("--giu N đổi số giữ; N không hợp lệ ⇒ exit 2 và 0 rmi", () => {
    xoaThat(["--giu", "10"]);
    // giữ i=10..19 (10 ảnh phân biệt); còn lại trừ 3 (vars) → 1,2,4..9 + ảnh M1 cũ
    expect(rmiLog().sort()).toEqual([...[1, 2, 4, 5, 6, 7, 8, 9].map(tagRb), TAG_M1].map(rmiTag).sort());
    for (const sai of ["0", "abc", "-1", ""]) {
      const r = chay(["--xoa-that", "--xac-nhan", "x", "--giu", sai]);
      expect(r.code).toBe(2);
    }
  });

  it("biến GIU_ROLLBACK được tôn trọng", () => {
    xoaThat([], { GIU_ROLLBACK: "17" });
    expect(rmiLog().sort()).toEqual([tagRb(1), tagRb(2), TAG_M1].map(rmiTag).sort());
  });

  it("thiếu .deploy-vars ⇒ exit ≠ 0 và 0 lệnh rmi", () => {
    rmSync(fx.vars);
    const r = chay(["--xoa-that", "--xac-nhan", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/deploy-vars/);
    expect(rmiLog()).toEqual([]);
  });

  it("thiếu khoá OLD_IMAGE_ID hoặc ROLLBACK_TAG ⇒ exit ≠ 0 và 0 rmi", () => {
    for (const noiDung of [`ROLLBACK_TAG=hogikids-app:${tagRb(3)}\n`, `OLD_IMAGE_ID=${idDe(tagRb(3))}\n`, "OLD_HEAD=x\n"]) {
      writeFileSync(fx.vars, noiDung);
      const r = chay(["--xoa-that", "--xac-nhan", "x"]);
      expect(r.code).not.toBe(0);
      expect(rmiLog()).toEqual([]);
    }
  });

  it("không đọc được container hogikids-app ⇒ dừng, 0 rmi", () => {
    ghiContainer([`c2 thu-nghiem-cu ${idDe(tagRb(10))}`]);
    const r = chay(["--xoa-that", "--xac-nhan", "x"]);
    expect(r.code).not.toBe(0);
    expect(rmiLog()).toEqual([]);
  });

  it("rmi lỗi ⇒ dừng cả lượt, không thử ép", () => {
    const r = xoaThat([], { RMI_FAIL: `hogikids-app:${tagRb(2)}` });
    expect(r.code).not.toBe(0);
    expect(fx.log().filter((l) => /rmi -f|--force/.test(l))).toEqual([]);
    expect(rmiLog()).not.toContain(rmiTag(tagRb(4)));
  });

  it("--don-cache: dry-run không gọi builder; --xoa-that gọi đúng --builder default + until=72h", () => {
    chay(["--don-cache"]);
    expect(fx.log().some((l) => l.startsWith("docker builder"))).toBe(false);
    xoaThat(["--don-cache"]);
    expect(fx.log()).toContain("docker builder prune --builder default --filter until=72h");
  });

  it("chỉ gọi docker với lệnh đọc + rmi theo tên; không đụng ảnh repo khác", () => {
    xoaThat();
    for (const l of fx.log()) {
      expect(l).toMatch(/^docker (container inspect|image inspect|ps|images|rmi) /);
    }
  });
});

describe("don-anh-lui.sh: parse .deploy-vars đóng-an-toàn", () => {
  // ROLLBACK_TAG/OLD_IMAGE_ID trỏ rollback i=5 (ngoài top-5, không bảo vệ nào khác) ⇒ chỉ parse đúng mới giữ được.
  const id5 = idDe(tagRb(5));
  const tag5 = `hogikids-app:${tagRb(5)}`;
  const giuDuoc = (noiDung: string) => {
    writeFileSync(fx.vars, noiDung);
    const r = xoaThat();
    expect(r.code).toBe(0);
    expect(rmiLog()).not.toContain(rmiTag(tagRb(5)));
    expect(rmiLog().length).toBeGreaterThan(0); // vẫn dọn các tag khác
    expect(dongBang(r.out, tagRb(5))).toMatch(/GIU/);
  };

  it("đối chứng: không có file mốc trỏ i=5 thì i=5 bị xoá", () => {
    xoaThat();
    expect(rmiLog()).toContain(rmiTag(tagRb(5)));
  });

  it("LF chuẩn", () => giuDuoc(khoaVars(id5, tag5)));
  it("CRLF", () => giuDuoc(khoaVars(id5, tag5).replace(/\n/g, "\r\n")));
  it("khoảng trắng đầu/cuối dòng và quanh dấu =", () =>
    giuDuoc(`  OLD_IMAGE_ID = ${id5}   \n\tROLLBACK_TAG=${tag5}\t \n`));
  it("nháy đơn/kép bao quanh", () => giuDuoc(`OLD_IMAGE_ID="${id5}"\nROLLBACK_TAG='${tag5}'\n`));
  it("tiền tố export", () => giuDuoc(`export OLD_IMAGE_ID=${id5}\nexport ROLLBACK_TAG=${tag5}\n`));
  it("thiếu tiền tố sha256: vẫn chuẩn hoá đúng", () => giuDuoc(khoaVars(id5.replace("sha256:", ""), tag5)));
  it("khoá lặp ⇒ lấy dòng cuối", () => giuDuoc(`OLD_IMAGE_ID=${idDe("cu")}\nROLLBACK_TAG=x\n${khoaVars(id5, tag5)}`));

  it("OLD_IMAGE_ID 12 ký tự (ID rút gọn) ⇒ dừng, 0 rmi", () => {
    writeFileSync(fx.vars, khoaVars(id5.slice(7, 19), tag5));
    const r = chay(["--xoa-that", "--xac-nhan", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/64 hex/);
    expect(rmiLog()).toEqual([]);
  });

  it("ROLLBACK_TAG không phân giải được ảnh (RB_ID rỗng) ⇒ dừng, 0 rmi", () => {
    writeFileSync(fx.vars, khoaVars(id5, "hogikids-app:rollback-9999999-20260101-0000"));
    const r = chay(["--xoa-that", "--xac-nhan", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/không phân giải được ảnh/);
    expect(rmiLog()).toEqual([]);
  });

  it("ROLLBACK_TAG và OLD_IMAGE_ID lệch nhau ⇒ dừng, 0 rmi", () => {
    writeFileSync(fx.vars, khoaVars(idDe(tagRb(6)), tag5));
    const r = chay(["--xoa-that", "--xac-nhan", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/không nhất quán/);
    expect(rmiLog()).toEqual([]);
  });
});

describe("don-anh-lui.sh: bảo vệ mọi file .deploy-vars* (đường lùi M1)", () => {
  const m1 = () => path.join(fx.dir, M1_FILE);

  it("đối chứng: không có file M1 ⇒ ảnh lùi M1 bị xoá (ngoài top-N)", () => {
    xoaThat();
    expect(rmiLog()).toContain(rmiTag(TAG_M1));
  });

  it(".deploy-vars-truoc-m1 ⇒ ảnh lùi M1 được GIỮ dù ngoài top-N; phần còn lại vẫn dọn", () => {
    writeFileSync(m1(), khoaVars(ID_M1, `hogikids-app:${TAG_M1}`));
    const r = xoaThat();
    expect(r.code).toBe(0);
    expect(rmiLog()).not.toContain(rmiTag(TAG_M1));
    expect(dongBang(r.out, TAG_M1)).toMatch(/GIU/);
    expect(rmiLog().sort()).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 12, 13, 14].map(tagRb).map(rmiTag).sort());
  });

  it("file phụ thiếu khoá ⇒ cảnh báo, vẫn bảo vệ phần có (chỉ OLD_IMAGE_ID)", () => {
    writeFileSync(m1(), `OLD_IMAGE_ID=${ID_M1}\n`);
    const r = xoaThat();
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/thiếu ROLLBACK_TAG/);
    expect(rmiLog()).not.toContain(rmiTag(TAG_M1));
  });

  it("file phụ chỉ có ROLLBACK_TAG ⇒ cảnh báo, vẫn bảo vệ ảnh của tag", () => {
    writeFileSync(m1(), `ROLLBACK_TAG=hogikids-app:${TAG_M1}\n`);
    const r = xoaThat();
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/thiếu OLD_IMAGE_ID/);
    expect(rmiLog()).not.toContain(rmiTag(TAG_M1));
  });

  it("file phụ hỏng định dạng / lệch ID ⇒ dừng, 0 rmi (không đoán)", () => {
    writeFileSync(m1(), khoaVars("abc123", `hogikids-app:${TAG_M1}`));
    expect(chay(["--xoa-that", "--xac-nhan", "x"]).code).not.toBe(0);
    writeFileSync(m1(), khoaVars(idDe(tagRb(6)), `hogikids-app:${TAG_M1}`));
    expect(chay(["--xoa-that", "--xac-nhan", "x"]).code).not.toBe(0);
    expect(rmiLog()).toEqual([]);
  });

  it("mọi tên .deploy-vars* đều được đọc (vd .deploy-vars.bak)", () => {
    writeFileSync(path.join(fx.dir, ".deploy-vars.bak"), khoaVars(ID_M1, `hogikids-app:${TAG_M1}`));
    xoaThat();
    expect(rmiLog()).not.toContain(rmiTag(TAG_M1));
  });
});

describe("don-anh-lui.sh: vân tay dry-run chặn xoá lệch bảng đã duyệt", () => {
  it("--xoa-that thiếu --xac-nhan ⇒ exit 2, không gọi docker nào, 0 rmi", () => {
    const r = chay(["--xoa-that"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--xac-nhan/);
    expect(fx.log()).toEqual([]);
  });

  it("vân tay sai ⇒ dừng, 0 rmi", () => {
    const r = chay(["--xoa-that", "--xac-nhan", "0000000000000000"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/vân tay không khớp/);
    expect(rmiLog()).toEqual([]);
  });

  it("vân tay đúng ⇒ xoá; ổn định giữa các lần chạy cùng trạng thái", () => {
    const a = lamVanTay(chay().out);
    expect(lamVanTay(chay().out)).toBe(a);
    const r = chay(["--xoa-that", "--xac-nhan", a]);
    expect(r.code).toBe(0);
    expect(rmiLog().length).toBe(12);
  });

  it("có deploy mới sau lúc duyệt (thêm rollback mới) ⇒ vân tay cũ bị từ chối, 0 rmi", () => {
    const fp = lamVanTay(chay().out);
    const cu = readFileSync(path.join(fx.dir, "images.txt"), "utf8");
    writeFileSync(path.join(fx.dir, "images.txt"), cu + `hogikids-app rollback-ffffff1-20261020-1300 ${idDe("moi")}\n`);
    const r = chay(["--xoa-that", "--xac-nhan", fp]);
    expect(r.code).not.toBe(0);
    expect(rmiLog()).toEqual([]);
  });

  it(".deploy-vars* đổi nội dung (khoá cũ ⇒ khoá mới) ⇒ vân tay cũ bị từ chối", () => {
    const fp = lamVanTay(chay().out);
    writeFileSync(fx.vars, khoaVars(idDe(tagRb(5)), `hogikids-app:${tagRb(5)}`));
    const r = chay(["--xoa-that", "--xac-nhan", fp]);
    expect(r.code).not.toBe(0);
    expect(rmiLog()).toEqual([]);
  });

  it("đổi khoá mốc mà danh sách XOÁ không đổi (tag khác, cùng ID) ⇒ vân tay vẫn đổi", () => {
    const fp = lamVanTay(chay().out);
    writeFileSync(fx.vars, khoaVars(idDe(tagRb(3)), "hogikids-app:deploy-trung-old-image-id"));
    const r = chay();
    expect(r.out).toMatch(/→ 12 tag sẽ xoá/);
    expect(lamVanTay(r.out)).not.toBe(fp);
  });

  it("thêm file mốc phụ sau lúc duyệt ⇒ vân tay đổi", () => {
    const fp = lamVanTay(chay().out);
    writeFileSync(path.join(fx.dir, M1_FILE), khoaVars(ID_M1, `hogikids-app:${TAG_M1}`));
    expect(lamVanTay(chay().out)).not.toBe(fp);
  });

  it("vân tay không phụ thuộc định dạng thừa (CRLF/khoảng trắng) của cùng nội dung", () => {
    const a = lamVanTay(chay().out);
    writeFileSync(fx.vars, varsMacDinh().replace(/\n/g, " \r\n"));
    expect(lamVanTay(chay().out)).toBe(a);
  });
});

describe("don-anh-lui.sh: N đếm theo ẢNH phân biệt", () => {
  const A = idDe("anh-a");
  const B = idDe("anh-b");
  const C = idDe("anh-c");
  it("hai tag cùng ID chung một suất; mọi tag của ảnh được giữ đều giữ", () => {
    ghiAnh([
      `hogikids-app rollback-aaaaaaa-20260930-1005 ${A}`,
      `hogikids-app rollback-aaaaaaa-20260930-1000 ${A}`,
      `hogikids-app rollback-bbbbbbb-20260929-0900 ${B}`,
      `hogikids-app rollback-ccccccc-20260928-0900 ${C}`,
      `hogikids-app latest ${idDe("latest")}`,
    ]);
    writeFileSync(fx.vars, khoaVars(A, "hogikids-app:rollback-aaaaaaa-20260930-1005"));
    const r = xoaThat(["--giu", "2"]);
    expect(r.code).toBe(0);
    expect(rmiLog()).toEqual([rmiTag("rollback-ccccccc-20260928-0900")]);
    expect(dongBang(r.out, "rollback-aaaaaaa-20260930-1000")).toMatch(/GIU/);
    expect(dongBang(r.out, "rollback-bbbbbbb-20260929-0900")).toMatch(/GIU/);
  });
});

describe("don-anh-lui.sh: vân tay không lộ khi xoá thật + bao phủ cờ", () => {
  it("lượt --xoa-that KHÔNG in vân tay; vân tay lệch ⇒ thông báo không in vân tay hiện tại", () => {
    const fp = lamVanTay(chay().out);
    const ok = chay(["--xoa-that", "--xac-nhan", fp]);
    expect(ok.code).toBe(0);
    expect(ok.out).not.toMatch(/VÂN TAY/);
    expect(ok.out + ok.err).not.toContain(fp);
    rmSync(path.join(fx.dir, "docker.log"));
    const sai = chay(["--xoa-that", "--xac-nhan", "0000000000000000"]);
    expect(sai.code).not.toBe(0);
    expect(sai.err).toMatch(/vân tay không khớp bảng đã duyệt — chạy lại dry-run/);
    expect(sai.out + sai.err).not.toContain(fp);
    expect(rmiLog()).toEqual([]);
  });

  it("--don-cache nằm trong vân tay: duyệt không cache, xoá thật có cache ⇒ từ chối, 0 rmi + 0 builder", () => {
    const fp = lamVanTay(chay().out);
    expect(lamVanTay(chay(["--don-cache"]).out)).not.toBe(fp);
    const r = chay(["--xoa-that", "--xac-nhan", fp, "--don-cache"]);
    expect(r.code).not.toBe(0);
    expect(fx.log().filter((l) => /^docker (rmi|builder)/.test(l))).toEqual([]);
  });

  it("N (--giu) nằm trong vân tay dù danh sách xoá y hệt (N=25 vs 30 đều xoá 0 tag)", () => {
    const a = chay(["--giu", "25"]);
    expect(a.out).toMatch(/→ 0 tag sẽ xoá/);
    const b = chay(["--giu", "30"]);
    expect(b.out).toMatch(/→ 0 tag sẽ xoá/);
    expect(lamVanTay(a.out)).not.toBe(lamVanTay(b.out));
    const r = chay(["--giu", "30", "--xoa-that", "--xac-nhan", lamVanTay(a.out)]);
    expect(r.code).not.toBe(0);
    expect(rmiLog()).toEqual([]);
  });

  it("--xoa-tag nằm trong vân tay dù tag không tồn tại (danh sách xoá y hệt)", () => {
    const fp = lamVanTay(chay().out);
    expect(lamVanTay(chay(["--xoa-tag", "khong-co-tag-nay"]).out)).not.toBe(fp);
    const r = chay(["--xoa-that", "--xac-nhan", fp, "--xoa-tag", "khong-co-tag-nay"]);
    expect(r.code).not.toBe(0);
    expect(rmiLog()).toEqual([]);
  });

  it("tag bị trỏ sang ảnh khác giữa dry-run và xoá thật (tên tag y nguyên) ⇒ dừng, 0 rmi", () => {
    const fp = lamVanTay(chay().out);
    const cu = readFileSync(path.join(fx.dir, "images.txt"), "utf8");
    const moi = cu.replace(`${tagRb(1)} ${idDe(tagRb(1))}`, `${tagRb(1)} ${idDe("anh-khac-hoan-toan")}`);
    expect(moi).not.toBe(cu);
    writeFileSync(path.join(fx.dir, "images.txt"), moi);
    const r = chay(["--xoa-that", "--xac-nhan", fp]);
    expect(r.code).not.toBe(0);
    expect(rmiLog()).toEqual([]);
  });
});

describe("don-anh-lui.sh: mọi Image ID đọc từ docker phải đủ 64 hex", () => {
  const chayXoa = () => chay(["--xoa-that", "--xac-nhan", "x"]);

  it("container hogikids-app đang chạy trả ID cắt 12 ký tự ⇒ dừng, 0 rmi", () => {
    ghiContainer([`c1 hogikids-app ${idDe("latest").slice(7, 19)}`, `c2 thu-nghiem-cu ${idDe(tagRb(10))}`]);
    const r = chayXoa();
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/64 hex/);
    expect(rmiLog()).toEqual([]);
  });

  it("container dừng (ps -a) trả ID cắt 12 ký tự ⇒ dừng, 0 rmi", () => {
    ghiContainer([`c1 hogikids-app ${idDe("latest")}`, `c2 thu-nghiem-cu ${idDe(tagRb(10)).slice(7, 19)}`]);
    const r = chayXoa();
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/64 hex/);
    expect(rmiLog()).toEqual([]);
  });

  it("docker images trả ID cắt (thiếu --no-trunc) ⇒ dừng, 0 rmi", () => {
    // stub tự cắt ID khi lệnh không có --no-trunc; ép bằng cách ghi ID cắt thẳng vào dữ liệu ảnh
    const cu = readFileSync(path.join(fx.dir, "images.txt"), "utf8");
    writeFileSync(path.join(fx.dir, "images.txt"), cu.replace(idDe(tagRb(1)), idDe(tagRb(1)).slice(7, 19)));
    const r = chayXoa();
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/64 hex/);
    expect(rmiLog()).toEqual([]);
  });

  it("docker image inspect trả ID cắt ⇒ dừng, 0 rmi", () => {
    const r = chay(["--xoa-that", "--xac-nhan", "x"], { CAT_ID_INSPECT: "1" });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/không hợp lệ/);
    expect(rmiLog()).toEqual([]);
  });

  it("ID container hogikids-app đang chạy không có trong danh sách ảnh repo ⇒ dừng, 0 rmi", () => {
    ghiContainer([`c1 hogikids-app ${idDe("khong-co-trong-repo")}`]);
    const r = chayXoa();
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/không thuộc danh sách ảnh repo/);
    expect(rmiLog()).toEqual([]);
  });

  it("ID container chạy có tiền tố sha256: hoặc không đều chuẩn hoá được", () => {
    ghiContainer([`c1 hogikids-app ${idDe("latest").replace("sha256:", "")}`, `c2 thu-nghiem-cu ${idDe(tagRb(10))}`]);
    expect(chay().code).toBe(0);
  });
});

describe("don-anh-lui.sh: file mốc phụ — ảnh còn sống dưới tag khác vẫn GIỮ + gợi ý xử lý", () => {
  it("ROLLBACK_TAG mất ảnh nhưng OLD_IMAGE_ID vẫn sống dưới tag khác ⇒ mọi tag của ảnh đó GIỮ", () => {
    writeFileSync(
      path.join(fx.dir, M1_FILE),
      khoaVars(ID_M1, "hogikids-app:rollback-9999999-20260101-0000"),
    );
    const r = xoaThat();
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/không còn ảnh/);
    expect(rmiLog()).not.toContain(rmiTag(TAG_M1));
    expect(dongBang(r.out, TAG_M1)).toMatch(/GIU/);
    expect(dongBang(r.out, "deploy-trung-m1")).toMatch(/GIU/);
  });

  it("file phụ hỏng ⇒ thông điệp nêu cách xử lý (chuyển file rác ra khỏi mẫu .deploy-vars*); file chính thì không", () => {
    writeFileSync(path.join(fx.dir, M1_FILE), khoaVars("abc123", `hogikids-app:${TAG_M1}`));
    const r = chay(["--xoa-that", "--xac-nhan", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/nếu là file rác, chuyển ra khỏi mẫu tên \.deploy-vars\*/);
    rmSync(path.join(fx.dir, M1_FILE));
    writeFileSync(fx.vars, khoaVars("abc123", tagRb(3)));
    expect(chay(["--xoa-that", "--xac-nhan", "x"]).err).not.toMatch(/file rác/);
  });
});

describe("don-anh-lui.sh: bảng thẳng hàng dưới LC_ALL=C", () => {
  it("cột GIU/XOA bắt đầu cùng một vị trí ở mọi dòng", () => {
    const r = chay();
    const dong = r.out.split("\n").filter((d) => d.startsWith("hogikids-app:"));
    expect(dong.length).toBeGreaterThan(10);
    for (const d of dong) expect(d.slice(60, 66)).toMatch(/^(GIU|XOA)   $/);
    expect(dong.some((d) => d.slice(60, 63) === "XOA")).toBe(true);
    expect(dong.some((d) => d.slice(60, 63) === "GIU")).toBe(true);
  });
});

describe("don-anh-lui.sh: mô phỏng trạng thái THẬT host sau deploy 01/10 14:46", () => {
  // tag ⇒ 12 ký tự đầu Image ID (đo từ host); phần còn lại độn 0 cho đủ 64 hex, trừ 3 ID đo đủ.
  const RB: Record<string, string> = {
    "940ac90-20261001-1444": "cc135e618baa", "76441cc-20261001-1045": "2fc4736c2211",
    "14661e7-20260929-1736": "19be228e4dca", "63670eb-20260929-1005": "87ba980e503e",
    "8727673-20260928-1721": "f681858121ab", "8627fe5-20260928-1700": "8b7e2857b12f",
    "2805b72-20260928-1443": "1301aa487969", "ff1eb72-20260928-1412": "187fbeb593e1",
    "00b9300-20260928-0123": "f654561f06b7", "1d96faf-20260927-2342": "bb7ee26c8c08",
    "c3888ae-20260927-2210": "f628f4117676", "2dcb2fa-20260926-1939": "6f500a4264bf",
    "bc135dd-20260926-1428": "d43fc0c224ad", "ceb8d52-20260925-2111": "7031e08dda08",
    "ad9238b-20260925-1845": "d07c26ad31dc", "5378815-20260925-1747": "86dc10531002",
    "992deb6-20260925-1641": "3d4f501c2fbf", "9608bc6-20260925-1100": "5c7f5c8a6d45",
    "031476b-20260924-1954": "0a24a3083455",
  };
  const DEPLOY = "deploy-ad7a38d-20260917-1545";
  const ID_LATEST = "sha256:f0a9194aec0c19f15d269408c8402da38607feb5849e539d98d09a1a8db51ea0";
  const ID_OLD = "sha256:cc135e618baa4d7b2c1e7717ac773a07abcf2f6acbe2b3b461a4b8d55313cc39";
  const ID_M1_THAT = "sha256:2fc4736c2211ade6b29e23d08e5a0daacad19ca7a033b26c6bc3540fc6e88744";
  const ID_THAT: Record<string, string> = {
    "940ac90-20261001-1444": ID_OLD,
    "76441cc-20261001-1045": ID_M1_THAT,
  };
  const idTag = (k: string) => ID_THAT[k] ?? `sha256:${RB[k].padEnd(64, "0")}`;
  const bi = ["8627fe5-20260928-1700", "2805b72-20260928-1443", "ff1eb72-20260928-1412", "00b9300-20260928-0123",
    "1d96faf-20260927-2342", "c3888ae-20260927-2210", "2dcb2fa-20260926-1939", "bc135dd-20260926-1428",
    "ceb8d52-20260925-2111", "ad9238b-20260925-1845", "5378815-20260925-1747", "992deb6-20260925-1641",
    "9608bc6-20260925-1100", "031476b-20260924-1954"].map((k) => `rollback-${k}`);
  const giu = ["940ac90-20261001-1444", "76441cc-20261001-1045", "14661e7-20260929-1736",
    "63670eb-20260929-1005", "8727673-20260928-1721"].map((k) => `rollback-${k}`);

  it("N=5 + --xoa-tag deploy-ad7a38d ⇒ xoá đúng 15 tag, giữ 6 ảnh/tag cần giữ; vân tay không lộ", () => {
    ghiAnh([
      ...Object.keys(RB).map((k) => `hogikids-app rollback-${k} ${idTag(k)}`),
      `hogikids-app latest ${ID_LATEST}`,
      `hogikids-app ${DEPLOY} sha256:${"2e56d111f1be".padEnd(64, "0")}`,
    ]);
    ghiContainer([`c1 hogikids-app ${ID_LATEST}`]);
    writeFileSync(fx.vars, khoaVars(ID_OLD, "hogikids-app:rollback-940ac90-20261001-1444"));
    writeFileSync(path.join(fx.dir, M1_FILE), khoaVars(ID_M1_THAT, "hogikids-app:rollback-76441cc-20261001-1045"));
    const r = xoaThat(["--xoa-tag", DEPLOY]);
    expect(r.code).toBe(0);
    expect(rmiLog().sort()).toEqual([...bi, DEPLOY].map(rmiTag).sort());
    expect(rmiLog().length).toBe(15);
    for (const t of [...giu, "latest"]) expect(rmiLog()).not.toContain(rmiTag(t));
    expect(r.out).not.toMatch(/VÂN TAY/);
  });
});
