import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hợp đồng của helper vòng đời thao tác nền (`tests/helpers/thao-tac-nen-cho-xong-truoc-khi-don.ts`) trên DB test thật:
 * hook dọn phải thấy KHÔNG còn transaction nào của test đang mở, khoá bước bật đã nhả, M không commit — kể cả khi thân
 * test ném giữa chừng; lỗi của thao tác nền không bị nuốt; `choTatCa` chờ đủ mọi lượt rồi mới báo đỏ; thao tác đã đăng
 * ký còn sống quá trần thì KHÔNG dọn và chặn mọi ca / file kế tiếp (huỷ cả lượt — đo bằng một lượt Vitest con).
 * Ca HẾT GIỜ thật (Vitest cắt test, hook chạy khi thân test còn chạy nền) không giữ ở đây vì bản thân nó là một test đỏ.
 */
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";

import {
  chayNen,
  choTatCa,
  choThaoTacNenXong,
  doiCauHinhChoTestHopDong,
  dangKyTheHeCa,
  donSauKhiThaoTacNenXong,
  giaLapBuocBatGiuKhoa,
  kiemThieuHookDon,
  moTheoDoiThaoTacNen,
  TIMEOUT_HOOK_DON_MS,
} from "./helpers/thao-tac-nen-cho-xong-truoc-khi-don";

const docM = async () => (await prisma.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } }))?.value ?? null;

/** Transaction đang mở của phiên KHÁC + khoá advisory của bước bật (cả lượt giữ lẫn lượt đứng chờ). */
async function doPhienConMo(): Promise<{ tx: number; khoa: number }> {
  const [d] = await prisma.$queryRaw<{ tx: number; khoa: number }[]>`
    SELECT
      (SELECT count(*)::int FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
          AND xact_start IS NOT NULL) AS tx,
      (SELECT count(*)::int FROM pg_locks
        WHERE locktype = 'advisory' AND objsubid = 1
          AND objid = (hashtext(${KHOA_BAT_NO_PHAI_TRA}::text)::bigint & 4294967295)::oid) AS khoa`;
  return d!;
}

/** Lượt "đường ghi" giả: giành khoá SHARED của bước bật (chờ nếu bước bật đang giữ) rồi đọc M thấy được. */
const docMSauKhoaChung = () =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`;
    const [r] = await tx.$queryRaw<{ value: string | null }[]>`
      SELECT (SELECT value FROM "Setting" WHERE key = ${KEY_NO_PHAI_TRA_TU_NGAY}) AS value`;
    return r!.value;
  });

dangKyTheHeCa();

beforeEach(async () => {
  moTheoDoiThaoTacNen();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterEach(
  () =>
    donSauKhiThaoTacNenXong(async () => {
      await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
    }),
  TIMEOUT_HOOK_DON_MS
);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("hook dọn chờ / huỷ thao tác nền", () => {
  it("thân test ném trước tha() ⇒ hook dọn ROLLBACK bước bật ngay, chờ lượt đang chờ khoá xong, báo việc dở; lúc dọn 0 transaction, khoá nhả, M không commit", async () => {
    let daChayXong = false;
    let mThayDuoc: string | null | undefined;
    await expect(
      giaLapBuocBatGiuKhoa(
        "2026-10-01",
        async () => {
          mThayDuoc = await docMSauKhoaChung();
          daChayXong = true;
          return mThayDuoc;
        },
        async () => {
          throw new Error("lỗi sớm cố ý");
        }
      )
    ).rejects.toThrow("lỗi sớm cố ý");
    // Ngay sau lỗi: bước bật vẫn giữ khoá EXCLUSIVE + M chưa commit, lượt ghi đứng chờ.
    expect((await doPhienConMo()).khoa).toBeGreaterThanOrEqual(1);
    expect(daChayXong).toBe(false);

    const t0 = performance.now();
    await expect(choThaoTacNenXong()).rejects.toThrow(/"giả lập bước bật" còn giữ transaction lúc test kết thúc/);
    // Huỷ ngay chứ không đợi hết timeout transaction 20s.
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(await doPhienConMo()).toEqual({ tx: 0, khoa: 0 });
    expect(daChayXong).toBe(true);
    expect(mThayDuoc).toBeNull();
    expect(await docM()).toBeNull();
  });

  it("sau hook dọn, thân test (đã hết giờ) không khởi chạy thêm thao tác được tới beforeEach kế tiếp", async () => {
    await choThaoTacNenXong();
    expect(() => chayNen("lượt muộn", () => docM())).toThrow(/sổ thao tác nền đang đóng/);
    moTheoDoiThaoTacNen();
    await expect(chayNen("lượt sau khi mở lại", () => docM())).resolves.toBeNull();
  });

  it("thao tác nền ném mà thân test không kịp await ⇒ hook dọn chờ nó rồi báo lại lý do gốc (không nuốt)", async () => {
    void chayNen("ghi nền hỏng", async () => {
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("lý do gốc của thao tác nền");
    });
    await expect(choThaoTacNenXong()).rejects.toThrow(/"ghi nền hỏng" ném: Error: lý do gốc của thao tác nền/);
  });
});

/** Một lượt nền ném sau 30 ms — thân test không await nó (như thân test đã chết trước khi kịp await). */
const nenHong = () =>
  void chayNen("ghi nền hỏng", async () => {
    await new Promise((r) => setTimeout(r, 30));
    throw new Error("lý do gốc của thao tác nền");
  });

describe("donSauKhiThaoTacNenXong — thân afterEach", () => {
  it("bước chờ báo lỗi ⇒ VẪN chạy lượt dọn của file, rồi ném lại lý do gốc", async () => {
    nenHong();
    const don = vi.fn(async () => {});
    await expect(donSauKhiThaoTacNenXong(don)).rejects.toThrow(/"ghi nền hỏng" ném: Error: lý do gốc của thao tác nền/);
    expect(don).toHaveBeenCalledTimes(1);
  });

  it("cả bước chờ lẫn lượt dọn đều lỗi ⇒ thông điệp gộp đủ cả hai lý do", async () => {
    nenHong();
    const don = vi.fn(async () => {
      throw new Error("lượt dọn hỏng");
    });
    await expect(donSauKhiThaoTacNenXong(don)).rejects.toThrow(
      /chờ: [\s\S]*lý do gốc của thao tác nền[\s\S]*dọn: Error: lượt dọn hỏng/
    );
    expect(don).toHaveBeenCalledTimes(1);
  });
});

describe("file quên hook dọn", () => {
  it("test kết thúc mà chưa qua hook dọn ⇒ kiểm cuối test chờ lượt nền rồi NÉM kèm lý do gốc (không im lặng)", async () => {
    nenHong();
    await expect(kiemThieuHookDon()).rejects.toThrow(
      /KHÔNG qua hook dọn[\s\S]*"ghi nền hỏng" ném: Error: lý do gốc của thao tác nền/
    );
  });
});

describe("choTatCa thay Promise.all", () => {
  it("một lượt ném ngoài dự kiến ⇒ ĐỎ kèm lý do gốc, và chỉ báo sau khi lượt còn lại đã chạy xong", async () => {
    let luotChamXong = false;
    const cham = () =>
      new Promise<number>((res) =>
        setTimeout(() => {
          luotChamXong = true;
          res(1);
        }, 200)
      );
    const nem = () => Promise.reject(new Error("lượt hai ném lạ"));

    // Đối chứng: Promise.all trả lỗi SỚM, lượt kia vẫn chạy sau lưng.
    let luotChamXongKhiAllBao: boolean | undefined;
    await Promise.all([cham(), nem()]).catch((loi: Error) => {
      luotChamXongKhiAllBao = luotChamXong;
      expect(loi.message).toBe("lượt hai ném lạ");
    });
    expect(luotChamXongKhiAllBao).toBe(false);
    await new Promise((r) => setTimeout(r, 250));

    luotChamXong = false;
    let luotChamXongKhiBao: boolean | undefined;
    const loi = await choTatCa([cham(), nem()]).then(
      () => null,
      (e: unknown) => {
        luotChamXongKhiBao = luotChamXong;
        return e;
      }
    );
    expect(loi).toBeInstanceOf(Error);
    expect((loi as Error).message).toBe("Lượt đồng thời ném ngoài dự kiến: #1: Error: lượt hai ném lạ");
    expect((loi as Error).cause).toEqual(new Error("lượt hai ném lạ"));
    expect(luotChamXongKhiBao).toBe(true);
  });

  it("mọi lượt thành công ⇒ trả đúng thứ tự kết quả", async () => {
    await expect(choTatCa([Promise.resolve(1), Promise.resolve("hai")])).resolves.toEqual([1, "hai"]);
  });
});

const nghi = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const GOC_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAU_HINH_LUOT_CON = path.join(GOC_REPO, "tests/fixtures/thao-tac-nen-qua-tran/vitest.config.ts");
const VITEST_CLI = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

/**
 * Chạy lượt Vitest CON trên file fixture (`tests/fixtures/thao-tac-nen-qua-tran/`, lọc theo tên trong `thamSo`) — hành
 * động huỷ lượt THẬT chỉ đo được ở lượt khác lượt đang chạy. `close` chỉ phát khi MỌI tiến trình giữ pipe đầu ra (cả
 * worker) đã đóng; lượt con treo thì giết nó và báo đỏ kèm đầu ra.
 */
function chayLuotVitestCon(
  thuMucDau: string,
  thamSo: string[]
): Promise<{ ma: number | null; tinHieu: NodeJS.Signals | null; dauRa: string }> {
  // Bỏ biến VITEST_* của worker lượt chính: lượt con là một lượt Vitest độc lập.
  const env: NodeJS.ProcessEnv = { ...process.env, THU_MUC_DAU_QUA_TRAN: thuMucDau };
  for (const k of Object.keys(env)) if (k.startsWith("VITEST")) delete env[k];
  return new Promise((resolve, reject) => {
    const con = spawn(process.execPath, [VITEST_CLI, "run", "--config", CAU_HINH_LUOT_CON, ...thamSo], {
      cwd: GOC_REPO,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let dauRa = "";
    con.stdout.on("data", (b: Buffer) => (dauRa += b.toString()));
    con.stderr.on("data", (b: Buffer) => (dauRa += b.toString()));
    const hen = setTimeout(() => {
      con.kill("SIGKILL");
      reject(new Error(`Lượt Vitest con quá 25s chưa kết thúc — đầu ra:\n${dauRa}`));
    }, 25_000);
    con.on("error", (loi) => {
      clearTimeout(hen);
      reject(loi);
    });
    con.on("close", (ma, tinHieu) => {
      clearTimeout(hen);
      resolve({ ma, tinHieu, dauRa });
    });
  });
}

describe("thao tác đã đăng ký còn sống quá trần", () => {
  it("chưa xác nhận kết thúc ⇒ KHÔNG dọn, gọi huỷ lượt, rồi ca kế / lượt khởi chạy / lượt dọn kế tiếp đều bị chặn, báo đỏ rõ lý do", async () => {
    const huyLuotChay = vi.fn<(baoCao: string) => void>();
    const khoiPhuc = doiCauHinhChoTestHopDong({ tranChoXongMs: 300, huyLuotChay });
    let thaoTac: Promise<void> | undefined;
    try {
      // Thao tác DB thật sống ~1,2s (quá trần 300ms) rồi mới GHI M — đúng hình lượt ghi chạy nốt SAU thời điểm dọn.
      let thaoTacXong = false;
      thaoTac = chayNen("ghi M sau 1,2s", () =>
        prisma
          .$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_sleep(1.2)`;
            await tx.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-10-01" } });
          })
          .then(() => {
            thaoTacXong = true;
          })
      );
      let thaoTacXongLucDon: boolean | null = null;
      const don = vi.fn(async () => {
        thaoTacXongLucDon = thaoTacXong;
        await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
      });

      const t0 = performance.now();
      const loi = await donSauKhiThaoTacNenXong(don).then(
        () => null,
        (e: unknown) => e
      );
      const msBao = performance.now() - t0;
      const thaoTacXongLucBao = thaoTacXong;
      await thaoTac;
      const mSauKhiThaoTacXong = await docM();

      // Một diff đủ bằng chứng khi đỏ: lượt dọn có chạy không, lúc đó thao tác xong chưa, có gọi huỷ lượt không, và
      // dòng thao tác ghi SAU thời điểm lẽ ra dọn (vì thế dọn rồi chạy tiếp là để ca sau nhận dòng lạ).
      expect({
        lanDon: don.mock.calls.length,
        thaoTacXongLucDon,
        thaoTacXongLucBao,
        lanHuyLuot: huyLuotChay.mock.calls.length,
        mSauKhiThaoTacXong,
      }).toEqual({ lanDon: 0, thaoTacXongLucDon: null, thaoTacXongLucBao: false, lanHuyLuot: 1, mSauKhiThaoTacXong: "2026-10-01" });
      // Báo ở trần, không đợi thao tác.
      expect(msBao).toBeLessThan(1_000);
      expect(loi).toBeInstanceOf(Error);
      expect((loi as Error).name).toBe("ThaoTacNenConSong");
      expect((loi as Error).message).toMatch(/Quá 300ms vẫn còn chạy: "ghi M sau 1,2s" — CHƯA xác nhận kết thúc ⇒ KHÔNG dọn/);
      expect(huyLuotChay).toHaveBeenCalledWith((loi as Error).message);

      expect(() => moTheoDoiThaoTacNen()).toThrow(/Chặn ca kế tiếp: .*vẫn còn chạy quá trần chờ/);
      expect(() => chayNen("lượt kế", () => docM())).toThrow(/Chặn khởi chạy "lượt kế"/);
      const donKe = vi.fn(async () => {});
      await expect(donSauKhiThaoTacNenXong(donKe)).rejects.toThrow(/Chặn lượt chờ \/ dọn/);
      expect(donKe).not.toHaveBeenCalled();
    } finally {
      // Chờ thao tác còn sống kết thúc THẬT rồi mới gỡ dấu chặn và để afterEach dọn M.
      try {
        if (thaoTac) await thaoTac;
      } finally {
        khoiPhuc();
      }
    }
  });

  it("đối chiếu: thao tác đã KẾT THÚC bằng lỗi trong trần ⇒ vẫn dọn rồi báo lỗi, không huỷ lượt, ca kế không bị chặn", async () => {
    const huyLuotChay = vi.fn<(baoCao: string) => void>();
    const khoiPhuc = doiCauHinhChoTestHopDong({ tranChoXongMs: 300, huyLuotChay });
    try {
      nenHong();
      const don = vi.fn(async () => {});
      await expect(donSauKhiThaoTacNenXong(don)).rejects.toThrow(/"ghi nền hỏng" ném: Error: lý do gốc của thao tác nền/);
      expect({ lanDon: don.mock.calls.length, lanHuyLuot: huyLuotChay.mock.calls.length }).toEqual({ lanDon: 1, lanHuyLuot: 0 });
      moTheoDoiThaoTacNen();
      await expect(chayNen("lượt kế", () => docM())).resolves.toBeNull();
    } finally {
      khoiPhuc();
    }
  });

  it("lượt thật: huỷ CẢ lượt Vitest — lượt dọn, ca kế, afterAll, file kế đều không chạy; JS của thao tác còn sống bị giết", async () => {
    // Chờ thêm quá mốc thao tác nền lẽ ra xong (1s sau khi bắt đầu): vắng dấu "thao-tac-nen-xong" là nó đã bị giết.
    const kq = await chayLuotConVaDocDau(["a-thao-tac-con-song", "z-file-ke-tiep"], [], 1_200);
    expect({ dau: kq.dau, biGietBoiHelper: kq.biGietBoiHelper }, kq.dauRa).toEqual({
      dau: ["ca-1-bat-dau"],
      biGietBoiHelper: true,
    });
    expect(kq.dauRa).toMatch(/HUỶ CẢ LƯỢT VITEST/);
    expect(kq.dauRa).toMatch(/Quá 300ms vẫn còn chạy: "thao tác nền chậm" — CHƯA xác nhận kết thúc/);
  }, 40_000);

  it("lượt thật: ghi khung lý do ra stderr ném (EAGAIN mãi) ⇒ VẪN huỷ cả lượt — không afterAll, ca kế, file kế", async () => {
    const kq = await chayLuotConVaDocDau(["d-ghi-stderr-loi", "z-file-ke-tiep"], [], 1_200);
    expect({ dau: kq.dau, biGietBoiHelper: kq.biGietBoiHelper }, kq.dauRa).toEqual({
      dau: ["ca-1-bat-dau", "ghi-stderr-nem"],
      biGietBoiHelper: true,
    });
  }, 40_000);

  it("lượt thật: stderr đầy (EAGAIN) rồi chỉ nhận từng phần ⇒ khung lý do tới ĐỦ, rồi vẫn huỷ cả lượt", async () => {
    const kq = await chayLuotConVaDocDau(["e-ghi-stderr-eagain", "z-file-ke-tiep"], [], 1_200);
    expect({ dau: kq.dau, biGietBoiHelper: kq.biGietBoiHelper }, kq.dauRa).toEqual({
      dau: ["ca-1-bat-dau", "eagain-da-nem"],
      biGietBoiHelper: true,
    });
    // Dòng lý do + dòng khung đóng cuối cùng: thiếu là khung bị cắt (bỏ phần chưa ghi / bỏ cuộc ở EAGAIN đầu).
    expect(kq.dauRa).toMatch(/HUỶ CẢ LƯỢT VITEST/);
    expect(kq.dauRa).toMatch(/Quá 300ms vẫn còn chạy: "thao tác nền chậm" — CHƯA xác nhận kết thúc ⇒ KHÔNG dọn, chặn mọi ca \/ file kế tiếp trên cùng DB\n█{100}\n/);
  }, 40_000);

  it("lượt thật: file quên hook dọn, thao tác sống quá hookTimeout ⇒ kiểm cuối test không bị cắt, vẫn huỷ cả lượt", async () => {
    // `--hookTimeout=1000` đứng thay 10s mặc định: kiểm cuối test dựa vào mặc định thì bị cắt ở 1s (trước trần 1,5s).
    const kq = await chayLuotConVaDocDau(["c-quen-hook-don", "z-file-ke-tiep"], ["--hookTimeout=1000"], 2_000);
    expect({ dau: kq.dau, biGietBoiHelper: kq.biGietBoiHelper }, kq.dauRa).toEqual({
      dau: ["ca-1-bat-dau"],
      biGietBoiHelper: true,
    });
    expect(kq.dauRa).toMatch(/Quá 1500ms vẫn còn chạy: "thao tác nền chậm"/);
  }, 40_000);
});

describe("lời gọi không thuộc ca nào", () => {
  let kichHoat!: () => void;
  let goiNgoaiCa!: Promise<string | null>;
  let batDauDaGoi = false;
  beforeAll(() => {
    // `.then` gắn ở beforeAll ⇒ callback chạy trong ngữ cảnh của beforeAll (không thuộc ca nào), dù được kích lúc ca
    // đang chạy và sổ đang mở — đúng hình một chuỗi promise khởi từ beforeAll rồi chạm DB giữa chừng một ca.
    goiNgoaiCa = new Promise<void>((res) => (kichHoat = res)).then(() =>
      chayNen("ghi ngoài ca", () => {
        batDauDaGoi = true;
        return docM();
      })
    );
  });

  it("chayNen từ ngữ cảnh không thuộc ca nào lúc sổ đang mở ⇒ TỪ CHỐI trước batDau, hook dọn của ca đang chạy báo đỏ", async () => {
    kichHoat();
    await expect(goiNgoaiCa).rejects.toThrow(
      /KHÔNG thuộc ca nào .*chayNen\("ghi ngoài ca"\) lúc ca "chayNen từ ngữ cảnh không thuộc ca nào.*" đang chạy — ĐÃ TỪ CHỐI/
    );
    expect(batDauDaGoi).toBe(false);
    await expect(choThaoTacNenXong()).rejects.toThrow(/KHÔNG thuộc ca nào .*chayNen\("ghi ngoài ca"\)/);
  });
});

describe("thân ca đã hết giờ còn chạy tiếp", () => {
  it("lượt thật: thân ca cũ gọi chayNen lúc ca mới đã mở sổ ⇒ TỪ CHỐI trước batDau, ca mới ĐỎ ở hook dọn, thao tác của ca mới vẫn chạy trọn", async () => {
    const thuMuc = mkdtempSync(path.join(tmpdir(), "than-ca-cu-"));
    const thuMucKq = mkdtempSync(path.join(tmpdir(), "than-ca-cu-kq-"));
    try {
      const fileKq = path.join(thuMucKq, "kq.json");
      const kq = await chayLuotVitestCon(thuMuc, ["--reporter=json", `--outputFile=${fileKq}`, "f-than-ca-cu"]);
      const json = JSON.parse(readFileSync(fileKq, "utf8")) as {
        testResults: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
      };
      const ca = json.testResults.flatMap((f) => f.assertionResults);
      const dauRa = `kết thúc: ${String(kq.tinHieu ?? kq.ma)}\n${JSON.stringify(ca, null, 2)}\n${kq.dauRa}`;
      expect(
        {
          dau: readdirSync(thuMuc).sort(),
          trangThai: ca.map((c) => `${c.title}: ${c.status}`),
          ma: kq.ma,
        },
        dauRa
      ).toEqual({
        // Không có "ca-cu-batdau-chay": thao tác của thân ca cũ không bao giờ được khởi chạy.
        dau: ["ca-1-than-chay-tiep", "ca-moi-batdau-chay", "ca-moi-xong", "don-chay"],
        trangThai: ["ca 1: hết giờ, thân còn chạy tiếp: failed", "ca 2: ca mới, thao tác của chính nó chạy bình thường: failed"],
        ma: 1,
      });
      expect(ca[0]!.failureMessages.join("\n"), dauRa).toMatch(/Test timed out in 300ms/);
      expect(ca[1]!.failureMessages.join("\n"), dauRa).toMatch(
        /Thân ca "ca 1: hết giờ, thân còn chạy tiếp" đã KẾT THÚC \(hết giờ \/ bị bỏ\) nhưng vẫn chạy tiếp và gọi chayNen\("ghi của ca cũ"\) lúc ca "ca 2: ca mới, thao tác của chính nó chạy bình thường" đang chạy — ĐÃ TỪ CHỐI, không khởi chạy/
      );
    } finally {
      rmSync(thuMuc, { recursive: true, force: true });
      rmSync(thuMucKq, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * Chạy lượt con trên các file fixture lọc theo `locFile`, chờ thêm `choThemMs` (để thao tác nền lẽ ra đã xong nếu còn
 * sống), rồi đọc danh sách dấu. Lượt con chết vì tín hiệu helper gửi: Vitest 5 bắt SIGTERM rồi thoát mã 143 (đo
 * 06/11); không bắt thì chết bằng chính tín hiệu; không chịu chết sau 5s thì helper SIGKILL (137).
 */
async function chayLuotConVaDocDau(
  locFile: string[],
  thamSoThem: string[],
  choThemMs: number
): Promise<{ dau: string[]; biGietBoiHelper: boolean; dauRa: string }> {
  const thuMuc = mkdtempSync(path.join(tmpdir(), "thao-tac-nen-qua-tran-"));
  try {
    const kq = await chayLuotVitestCon(thuMuc, [...thamSoThem, ...locFile]);
    await nghi(choThemMs);
    const ketThuc = kq.tinHieu ?? kq.ma;
    return {
      dau: readdirSync(thuMuc).sort(),
      biGietBoiHelper: [143, "SIGTERM", 137, "SIGKILL"].includes(ketThuc ?? -1),
      dauRa: `kết thúc: ${String(ketThuc)}\n${kq.dauRa}`,
    };
  } finally {
    rmSync(thuMuc, { recursive: true, force: true });
  }
}
