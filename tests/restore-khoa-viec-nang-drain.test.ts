import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  getSession: async () => ({ userId: "test-user" }),
  getAuthenticatedUserId: async () => "test-user",
  thuHoiMoiPhien: vi.fn(async () => undefined),
}));

// Chặn `pg_dump` THẬT (xem restore-khoa-doc-quyen.test.ts). Mặc định ném lỗi = sentinel "đã đi
// qua các cổng chặn, tới bước bản lùi"; từng case override khi cần một bản lùi "thành công".
vi.mock("@/lib/backup/run-pg-dump", () => ({
  runPgDump: vi.fn(async () => {
    throw new Error("pg_dump bị chặn trong test");
  }),
}));

// Bước (4) của route mkdir + writeFile vào `/backups` (đường TUYỆT ĐỐI trong container) TRƯỚC chốt
// gia hạn (4b) — trên máy dev sẽ nổ EACCES và che mất đúng cái cổng cần test. Mock no-op: thứ cần
// chốt ở file này là các CỔNG, không phải việc ghi file bản lùi.
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  unlink: vi.fn(async () => undefined),
}));

// `runRestore` mặc định NÉM = sentinel "route đã bước vào vùng phá huỷ" — mọi case trừ case chốt
// `truocKhiPhaHuy` đều KHÔNG được tới đây. Giữ nguyên các hàm thuần (detect/gunzip/assert).
vi.mock("@/lib/backup/run-restore", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/backup/run-restore");
  return {
    ...real,
    runRestore: vi.fn(async () => {
      throw new Error("runRestore không được gọi trong case này");
    }),
  };
});

// Đường THÀNH CÔNG trọn lượt đi tới bước thu hồi phiên — mock no-op để test không ghi mốc phiên
// thật vào DB (thứ cần chốt ở file này là vòng đời KHOÁ, không phải thu hồi phiên).
vi.mock("@/lib/backup/thu-hoi-phien-co-han", () => ({
  thuHoiMoiPhienCoHan: vi.fn(async () => undefined),
}));

// Bọc `traKhoaViecNang` bằng vi.fn passthrough để một case ép nó ném (mô phỏng bảng Setting đã bị
// drop khi restore chết giữa chừng), và `giuKhoaViecNang` để chứng minh route THẬT SỰ giành khoá
// (không có spy này, assertion "dòng khoá = null" xanh cả khi route chưa từng ghi gì vào Setting —
// phantom guard). Các case khác vẫn chạy bản thật xuống DB test.
vi.mock("@/lib/backup/khoa-viec-nang", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/backup/khoa-viec-nang");
  return {
    ...real,
    giuKhoaViecNang: vi.fn(real.giuKhoaViecNang),
    traKhoaViecNang: vi.fn(real.traKhoaViecNang),
  };
});

// Bọc `coLuotDangChay` passthrough: một case chen "việc nặng cướp lease" vào ĐÚNG khe giữa bước
// drain và chốt gia hạn (3d) — cách duy nhất nhắm trúng chốt đó một cách tất định.
vi.mock("@/lib/ingest/sync-log", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/ingest/sync-log");
  return { ...real, coLuotDangChay: vi.fn(real.coLuotDangChay) };
});

import { POST } from "@/app/api/restore/route";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { giuKhoaViecNang, traKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { runRestore } from "@/lib/backup/run-restore";
import { coLuotDangChay } from "@/lib/ingest/sync-log";
import { prisma } from "@/lib/prisma";
import { VIEC_GHI_GIA_VON } from "@/lib/gia-von/ghi-gia-von-theo-pancake";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";

const KHOA_KEY = "khoaViecNang";

function formCoFile(bytes: Buffer): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], "backup.dump"));
  return fd;
}

function req(fd: FormData): Request {
  return new Request("http://localhost/api/restore", { method: "POST", body: fd });
}

function postDumpGia(): Promise<Response> {
  return POST(req(formCoFile(Buffer.from("PGDMP dữ liệu giả"))));
}

/** Dòng khoá việc nặng đang nằm trong DB test (null = không có). */
async function docKhoaTrongDb(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: KHOA_KEY } });
  return row?.value ?? null;
}

/** Ghi đè dòng khoá bằng token của "việc khác" — mô phỏng lease hết hạn bị việc nặng mới giành. */
async function cuopKhoaViecNang(viec: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: KHOA_KEY },
    create: { key: KHOA_KEY, value: `tok-viec-khac|${Date.now() + 5 * 60_000}|${viec}` },
    update: { value: `tok-viec-khac|${Date.now() + 5 * 60_000}|${viec}` },
  });
}

/**
 * Cổng DRAIN cũ đoán sống/chết writer bằng TUỔI SyncLog (RUNNING > 15' = coi như chết), nên
 * lượt "Dựng lại từ kho thô" chạy quá 15 phút trở nên VÔ HÌNH và restore DROP schema đè lên nó.
 * Lớp vá: restore tự giành `khoaViecNang` — khoá mà cả 3 việc nặng giữ TƯƠI bằng checkpoint tiến
 * độ thật, nên "còn giữ khoá" = tín hiệu sống thật thay vì đoán tuổi.
 *
 * Khoá nằm trong chính `app."Setting"` mà restore sẽ thay sạch ⇒ nó CHỈ là cổng chặn TRƯỚC vùng
 * phá huỷ, không phải hàng rào xuyên suốt — các case dưới chỉ chốt hành vi trước-phá-huỷ.
 */
describe("POST /api/restore — giành khoá việc nặng làm cổng drain", () => {
  afterEach(async () => {
    vi.mocked(giuKhoaViecNang).mockClear();
    vi.mocked(traKhoaViecNang).mockClear();
    vi.mocked(coLuotDangChay).mockClear();
    vi.mocked(runPgDump).mockClear();
    vi.mocked(runRestore).mockClear();
    await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
    await prisma.syncLog.deleteMany();
    donKhoaPhucHoi();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("việc nặng đang SỐNG (lease tươi) → 409 kèm TÊN việc, không đụng pg, không giật khoá của nó", async () => {
    const khoa = await giuKhoaViecNang("dựng lại từ kho thô");
    if (!khoa.the) throw new Error("không giành được khoá để dựng cảnh");

    const res = await postDumpGia();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/dựng lại từ kho thô/);
    expect(vi.mocked(runPgDump)).not.toHaveBeenCalled();
    // Restore thua thì TUYỆT ĐỐI không được đụng vào khoá của việc đang chạy.
    expect(await docKhoaTrongDb()).toContain(khoa.the.token);
    // Khoá bảo trì phải được trả trong finally — không kẹt app chỉ-đọc.
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    await traKhoaViecNang(khoa.the);
  });

  it("lượt ghi giá vốn đang giữ lease → 409 nêu đúng tên việc đó, không đụng pg", async () => {
    // Hai đường ghi giá vốn (CLI ngoài tiến trình app + nút "Áp giá vốn Pancake" trong app) dùng
    // CHUNG lease này. CLI không thấy cờ khoá bảo trì trong tiến trình app nên lease là kênh DUY
    // NHẤT nó và route phục hồi cùng thấy. Chốt tên việc để câu 409 chỉ thẳng thủ phạm cho chủ shop.
    const khoa = await giuKhoaViecNang(VIEC_GHI_GIA_VON);
    if (!khoa.the) throw new Error("không giành được khoá để dựng cảnh");

    const res = await postDumpGia();

    expect(res.status).toBe(409);
    // Ràng theo GIÁ TRỊ, không chỉ theo hằng: tên rỗng/vô nghĩa làm câu 409 rơi về "một việc nặng
    // khác" mà `toContain("")` vẫn xanh — chủ shop phải đọc ra được "giá vốn".
    // KHÔNG ràng chữ "script" nữa (bỏ 2026-09-07): nút trong app dùng cùng lease, nhãn nói "script"
    // trong khi chủ shop vừa bấm nút thì câu từ chối đọc như báo lỗi của hệ khác.
    expect(VIEC_GHI_GIA_VON).toMatch(/giá vốn/);
    expect(VIEC_GHI_GIA_VON.trim().length).toBeGreaterThan(8);
    expect((await res.json()).error).toContain(VIEC_GHI_GIA_VON);
    expect(vi.mocked(runPgDump)).not.toHaveBeenCalled();
    expect(await docKhoaTrongDb()).toContain(khoa.the.token);

    await traKhoaViecNang(khoa.the);
  });

  it("lease tồn tại nhưng HẾT HẠN (việc đã chết) → restore giành được và đi tiếp — DR không chờ 15'", async () => {
    await prisma.setting.create({
      data: { key: KHOA_KEY, value: `tok-da-chet|${Date.now() - 60_000}|việc đã chết` },
    });

    const res = await postDumpGia();

    // Qua cổng lease + cổng SyncLog ⇒ tới bước bản lùi, nơi runPgDump mock ném ⇒ 500. 500 chính là
    // bằng chứng ĐÃ ĐI QUA (cùng kiểu assert với restore-khoa-doc-quyen.test.ts).
    expect(res.status).toBe(500);
    // finally trả khoá restore vừa giành — không kẹt khoá chặn việc nặng kế tiếp.
    expect(await docKhoaTrongDb()).toBeNull();
  });

  it("SyncLog RUNNING tươi (writer ngắn, lớp drain cũ) → vẫn 409, và lease restore vừa giành được TRẢ", async () => {
    await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "RUNNING" } });

    const res = await postDumpGia();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/lượt đồng bộ/i);
    // "Dòng khoá = null" một mình là phantom guard (xanh cả khi route không giành gì): phải chứng
    // minh route ĐÃ giành thắng lease rồi finally mới TRẢ nó.
    expect(vi.mocked(giuKhoaViecNang)).toHaveBeenCalledTimes(1);
    const ketQuaGianh = await vi.mocked(giuKhoaViecNang).mock.results[0]!.value;
    expect(ketQuaGianh.the).not.toBeNull();
    expect(await docKhoaTrongDb()).toBeNull();
  });

  it("lease bị cướp NGAY SAU bước drain (chốt 3d) → 409 việc nặng TRƯỚC KHI chụp bản lùi", async () => {
    // Chen vào đúng khe drain → (3d): coLuotDangChay chạy giữa hai bước đó, cho nó "cướp" lease
    // (mô phỏng lease hết hạn vì drain quét lâu và một việc nặng giành được) rồi trả false như thật.
    vi.mocked(coLuotDangChay).mockImplementationOnce(async () => {
      await cuopKhoaViecNang("dựng lại từ kho thô");
      return false;
    });

    const res = await postDumpGia();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/việc nặng/i);
    // Chốt (3d) phải chặn TRƯỚC bước bản lùi — thiếu nó thì vụ cướp chỉ bị phát hiện ở (4b), tức
    // SAU khi đã đốt một lượt pg_dump (và một suất trong 3 bản pre-restore).
    expect(vi.mocked(runPgDump)).not.toHaveBeenCalled();
    expect(await docKhoaTrongDb()).toContain("tok-viec-khac");
  });

  it("lease bị việc khác giành GIỮA pg_dump (restore treo quá hạn khoá) → 409 trước phá huỷ, runRestore không chạy", async () => {
    vi.mocked(runPgDump).mockImplementationOnce(async () => {
      // pg_dump "chạy lâu": lease của restore hết hạn và một việc nặng giành được, bắt đầu ghi.
      await cuopKhoaViecNang("dựng lại từ kho thô (script)");
      return Buffer.from("ban lui gia");
    });

    const res = await postDumpGia();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/việc nặng|dựng lại/i);
    expect(vi.mocked(runRestore)).not.toHaveBeenCalled();
    // Khoá đang thuộc việc kia — restore thua không được xoá.
    expect(await docKhoaTrongDb()).toContain("tok-viec-khac");
  });

  it("lease bị giành ngay TRƯỚC lệnh phá huỷ (chốt trong runRestore) → hook ném, route trả 409 chứ không 500", async () => {
    vi.mocked(runPgDump).mockImplementationOnce(async () => Buffer.from("ban lui gia"));
    vi.mocked(runRestore).mockImplementationOnce(async (_buf, opts) => {
      await cuopKhoaViecNang("xoá dữ liệu giao dịch");
      // Bản thật await hook ngay trước lệnh phá huỷ đầu tiên — hook PHẢI ném để cắt mạch tại đây.
      await opts?.truocKhiPhaHuy?.();
      throw new Error("đã lọt qua chốt truocKhiPhaHuy — lẽ ra phải ném ở hook");
    });

    const res = await postDumpGia();

    // Mọi đường ném ở chốt này đều TRƯỚC lệnh phá huỷ đầu tiên ⇒ dữ liệu còn nguyên ⇒ 409 (đúng
    // triết lý LoiMatKhoaPhucHoi), tuyệt đối không 500 xui người dùng đi lùi bản pre-restore.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/việc nặng|giành/i);
  });

  it("phục hồi THÀNH CÔNG trọn lượt → lease được giành rồi TRẢ, việc nặng kế tiếp không bị kẹt", async () => {
    vi.mocked(runPgDump).mockImplementationOnce(async () => Buffer.from("ban lui gia"));
    vi.mocked(runRestore).mockImplementationOnce(async (_buf, opts) => {
      // Diễn đúng hợp đồng thật: await hook trước khi (giả vờ) nạp thành công.
      await opts?.truocKhiPhaHuy?.();
      return { format: "custom" as const };
    });

    const res = await postDumpGia();

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // Vòng đời khoá trọn vẹn: giành thắng → trả đúng một lần → DB sạch dòng khoá.
    expect(vi.mocked(giuKhoaViecNang)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(traKhoaViecNang)).toHaveBeenCalledTimes(1);
    expect(await docKhoaTrongDb()).toBeNull();
    // Và bằng chứng vận hành: một việc nặng mới giành được NGAY — không kẹt khoá sau phục hồi.
    const sau = await giuKhoaViecNang("dựng lại từ kho thô");
    expect(sau.the).not.toBeNull();
    if (sau.the) await traKhoaViecNang(sau.the);
  });

  it("traKhoaViecNang NÉM trong finally (bảng Setting đã bị drop) → không che response gốc", async () => {
    await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "RUNNING" } });
    vi.mocked(traKhoaViecNang).mockImplementationOnce(async () => {
      throw new Error('relation "Setting" does not exist');
    });

    const res = await postDumpGia();

    // Response gốc của đường drain phải sống sót qua finally lỗi.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/lượt đồng bộ/i);
    // Và khoá bảo trì vẫn được trả dù bước trả lease nổ.
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
  });
});
