import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

import { aroundEach, expect, onTestFinished } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";

/**
 * Vòng đời thao tác DB chạy NỀN trong các test đồng thời: mọi transaction / lượt gọi mà test khởi chạy phải KẾT
 * THÚC trước khi hook dọn dữ liệu chạy, kể cả khi test lỗi sớm hay hết giờ.
 *
 * Vì sao không đủ `try/finally` trong thân test: Vitest hết giờ một test thì KHÔNG chờ hàm test — `afterEach` chạy
 * ngay trong lúc thân test còn chạy nền. Một transaction "giả lập bước bật" đang giữ khoá + ghi mốc M chưa commit
 * sẽ commit SAU lượt dọn (M sống sang test/file sau), còn lượt ghi đang chờ khoá thì chèn dòng lạ vào test kế tiếp.
 *
 * PHẠM VI: chỉ các file test ĐÃ áp helper này (đăng ký đủ 3 hook dưới) được phủ. Test đồng thời ở file khác (còn
 * transaction giữ tới `tha()` / `Promise.all` tự viết) vẫn có lỗ cũ — helper không tự lan sang chúng.
 *
 * Cách dùng (mỗi file, cùng cấp suite, theo đúng thứ tự):
 *  - `dangKyTheHeCa()`: đăng ký `aroundEach` gắn mỗi ca một THẾ HỆ qua `AsyncLocalStorage` — thân ca đã kết thúc (hết
 *    giờ) mà còn chạy tiếp thì thao tác nó khởi chạy bị nhận ra là của ca cũ và TỪ CHỐI (xem `chayNen`).
 *  - `beforeEach`: gọi `moTheoDoiThaoTacNen()` — BẮT BUỘC: chưa mở sổ thì `chayNen` từ chối; thiếu `dangKyTheHeCa()`
 *    thì chính lệnh này ném; test kết thúc mà chưa qua hook dọn (quên `afterEach` bên dưới) thì test ĐỎ kèm lỗi của
 *    thao tác nền, không im lặng.
 *  - `afterEach`: bọc cả thân bằng `donSauKhiThaoTacNenXong(async () => { …dọn như cũ… })`, hook đặt timeout
 *    `TIMEOUT_HOOK_DON_MS` — chờ thao tác nền xong TRƯỚC khi dọn, lượt dọn vẫn chạy cả khi bước chờ báo lỗi.
 *  - Thao tác chạy nền đi qua `chayNen` / `giuTransactionDenKhiTha` / `giaLapBuocBatGiuKhoa`; nhiều lượt cùng lúc
 *    chờ bằng `choTatCa` thay cho `Promise.all`.
 *
 * `choThaoTacNenXong` huỷ (ROLLBACK) mọi transaction còn đang giữ, CHỜ mọi thao tác đã đăng ký xong (có trần), rồi
 * phân hai kết cục:
 *  - Mọi thao tác đã KẾT THÚC (kể cả kết thúc bằng lỗi) ⇒ NÉM nếu còn transaction phải huỷ (test chưa thả — lỗi sớm /
 *    hết giờ / quên `tha()`) hoặc có thao tác ném ngoài dự kiến; `donSauKhiThaoTacNenXong` vẫn dọn rồi mới báo lỗi.
 *  - Quá trần mà thao tác VẪN CHẠY (chưa xác nhận kết thúc) ⇒ KHÔNG dọn và HUỶ CẢ LƯỢT VITEST (`huyCaLuotVitest`):
 *    dọn lúc này là xoá dữ liệu dưới chân thao tác còn sống (nó ghi tiếp sau lượt dọn — dòng lạ / M sống sang ca sau),
 *    còn chạy tiếp ca hay file kế trên cùng DB là để ca đó nhận dòng lạ.
 * Không nuốt lỗi nào: chỉ đúng lý do huỷ do chính hook gây ra được coi là dự kiến.
 * Chỉ đăng ký thao tác mà rejection là NGOÀI dự kiến; ca chủ động chờ một lỗi thì assert nó trực tiếp, đừng đăng ký.
 *
 * Vì sao phải huỷ cả lượt chứ không chỉ đánh dấu chặn: Vitest (pool `forks` mặc định, `isolate` mặc định bật) chạy MỖI
 * file trong một tiến trình con riêng (đo 06/11: pid khác nhau, `globalThis` / `process.env` không sống qua file), nên
 * dấu chặn trong module / `globalThis` chỉ chặn được ca kế TRONG file; còn `afterAll` của file (thường cũng xoá bảng)
 * và file kế tiếp vẫn chạy. Worker tự thoát cũng không đủ: Vitest báo "Worker exited unexpectedly" rồi chạy tiếp file
 * kế (đo cùng ngày). Vì vậy ở nhánh quá trần helper đặt dấu chặn trong file (ca kế, hook dọn, `chayNen` đều từ chối),
 * cố in lý do ra stderr (lỗi ghi không chặn bước sau), giết tiến trình chính của lượt (không còn ai lên lịch file kế),
 * rồi giết chính worker (JS của thao tác còn sống chết theo, kết nối DB đóng ⇒ Postgres ROLLBACK transaction đang mở).
 * Giới hạn còn lại: một câu lệnh SQL server ĐANG THỰC THI lúc worker chết (vd câu autocommit đang chờ khoá) vẫn có thể
 * chạy nốt phía Postgres — nhưng lượt đã huỷ nên không ca nào của lượt này chạy sau nó.
 */

/** Timeout transaction giữ khoá ở các ca đồng thời (số các file đã dùng từ trước). */
export const TIMEOUT_TX_GIU_KHOA_MS = 20_000;

/**
 * Trần chờ ở hook dọn: transaction đã đăng ký dài nhất Prisma cho sống là `TIMEOUT_TX_GIU_KHOA_MS`, cộng biên cho
 * lượt đang chờ khoá chạy nốt sau khi khoá nhả. Thực tế (huỷ ngay transaction đang giữ) hook xong trong vài trăm ms.
 */
const TRAN_CHO_XONG_MS = TIMEOUT_TX_GIU_KHOA_MS + 5_000;

/** Timeout cho `afterEach` gọi `choThaoTacNenXong` — phải trên trần chờ, nếu không Vitest cắt hook giữa lúc chờ. */
export const TIMEOUT_HOOK_DON_MS = TRAN_CHO_XONG_MS + 5_000;

/** Lý do huỷ do chính hook dọn gây ra — kết cục DUY NHẤT được coi là dự kiến khi dọn. */
class HuyBoiHookDon extends Error {
  override name = "HuyBoiHookDon";
}

/** Quá trần mà thao tác đã đăng ký vẫn chạy — chưa xác nhận kết thúc ⇒ không dọn, không chạy gì thêm trên DB. */
class ThaoTacNenConSong extends Error {
  override name = "ThaoTacNenConSong";
}

/** Trần chờ đang áp — chỉ `doiCauHinhChoTestHopDong` đổi được, mặc định `TRAN_CHO_XONG_MS`. */
let tranChoXongMs = TRAN_CHO_XONG_MS;
/** Hành động khi quá trần mà thao tác còn sống — mặc định huỷ cả lượt; chỉ test hợp đồng thay (không giết chính lượt). */
let huyLuotChay: (baoCao: string) => void = huyCaLuotVitest;
/** Có ⇒ worker này đã gặp thao tác còn sống quá trần: mọi ca kế / hook dọn / `chayNen` trong file đều từ chối. */
let chanDoConSong: ThaoTacNenConSong | null = null;

/**
 * CHỈ test hợp đồng của helper dùng: rút trần chờ (ca quá trần không phải chờ 25s thật) và/hoặc thay hành động huỷ
 * lượt chạy (ca chạy TRONG lượt đang chạy không được giết chính lượt đó). Trả hàm khôi phục mặc định — hàm đó gỡ cả dấu
 * chặn, nên chỉ gọi SAU khi chính ca đã chờ thao tác còn sống kết thúc thật.
 */
export function doiCauHinhChoTestHopDong(cauHinh: {
  tranChoXongMs?: number;
  huyLuotChay?: (baoCao: string) => void;
}): () => void {
  if (cauHinh.tranChoXongMs !== undefined && !(Number.isInteger(cauHinh.tranChoXongMs) && cauHinh.tranChoXongMs > 0)) {
    throw new Error(`tranChoXongMs phải là số nguyên dương, nhận ${String(cauHinh.tranChoXongMs)}`);
  }
  tranChoXongMs = cauHinh.tranChoXongMs ?? TRAN_CHO_XONG_MS;
  huyLuotChay = cauHinh.huyLuotChay ?? huyCaLuotVitest;
  return () => {
    tranChoXongMs = TRAN_CHO_XONG_MS;
    huyLuotChay = huyCaLuotVitest;
    chanDoConSong = null;
  };
}

/** Ném nếu worker đã gặp thao tác còn sống quá trần — dùng ở mọi cửa vào của một ca / một lượt dọn. */
function nemNeuDaChan(viec: string): void {
  if (chanDoConSong) {
    throw new Error(
      `Chặn ${viec}: một thao tác nền đã đăng ký vẫn còn chạy quá trần chờ — chưa xác nhận kết thúc nên không dọn và ` +
        `không chạy gì thêm trên DB test. Lý do gốc: ${chanDoConSong.message}`,
      { cause: chanDoConSong }
    );
  }
}

/** Ngủ đồng bộ (chặn cả luồng) — trong lúc huỷ lượt, không để JS nào khác của worker kịp chạy. */
function nguDongBo(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Tiến trình `pid` còn là cha của worker và còn sống không (cha chết ⇒ worker bị nhận nuôi, `ppid` đổi). */
function chaConSong(pid: number): boolean {
  if (process.ppid !== pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (loi) {
    // Tín hiệu 0 chỉ dò: ESRCH = không còn tiến trình đó. Mọi mã khác là lỗi thật — để nơi gọi in ra.
    if ((loi as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw loi;
  }
}

/**
 * `ppid` chốt lúc nạp module = tiến trình chính Vitest đã fork worker này (pool forks). Lúc huỷ chỉ gửi tín hiệu tới
 * đúng pid này khi worker vẫn còn là con của nó (`ppid` chưa đổi) và kênh IPC còn nối — cha đã chết thì worker bị nhận
 * nuôi (Linux có thể là một subreaper cùng người dùng như `systemd --user`), gửi tín hiệu tới `ppid` mới là giết nhầm.
 */
const PID_CHA_LUC_NAP = process.ppid;

/** Trần ghi khung lý do: pipe stderr đầy mãi (tiến trình chính không đọc) thì thôi ghi, vẫn huỷ lượt. */
const TRAN_GHI_STDERR_MS = 500;

/**
 * Ghi HẾT `noiDung` vào fd 2. Ở pool forks, fd 2 của worker là pipe NON-BLOCKING: `writeSync` có thể chỉ ghi một phần
 * (trả số byte nhỏ hơn độ dài) hoặc ném EAGAIN khi pipe đầy — ghi tiếp phần còn lại, gặp EAGAIN thì ngủ 10ms, trong
 * trần `TRAN_GHI_STDERR_MS`. Lỗi khác (EBADF, EPIPE…) hoặc hết trần ⇒ ném; nơi gọi vẫn huỷ lượt trong `finally`.
 */
function ghiHetVaoStderr(noiDung: string): void {
  const buf = Buffer.from(noiDung);
  const hetHan = performance.now() + TRAN_GHI_STDERR_MS;
  let daGhi = 0;
  while (daGhi < buf.length) {
    try {
      daGhi += writeSync(2, buf, daGhi);
    } catch (loi) {
      if ((loi as NodeJS.ErrnoException).code !== "EAGAIN") throw loi;
      if (performance.now() >= hetHan) {
        throw new Error(`stderr đầy quá ${TRAN_GHI_STDERR_MS}ms, mới ghi ${daGhi}/${buf.length} byte`, { cause: loi });
      }
      nguDongBo(10);
    }
  }
}

/**
 * Huỷ CẢ lượt Vitest: in lý do ra stderr (reporter sẽ không kịp in), giết tiến trình chính của lượt rồi giết chính
 * worker. Phần giết nằm trong `finally`: ghi stderr lỗi (EBADF, pipe đầy quá trần…) vẫn KHÔNG được bỏ qua việc huỷ.
 * Pool `forks`/`vmForks`: worker là tiến trình con có kênh IPC ⇒ tiến trình chính là `ppid` (chốt lúc nạp module).
 * Pool `threads`/`vmThreads`: worker là một luồng TRONG tiến trình chính ⇒ giết `process.pid` là giết cả lượt.
 */
function huyCaLuotVitest(baoCao: string): void {
  try {
    const { currentTestName, testPath } = expect.getState();
    ghiHetVaoStderr(
      `\n${"█".repeat(100)}\n` +
        `█ HUỶ CẢ LƯỢT VITEST — thao tác DB nền của test VẪN CÒN CHẠY quá trần chờ ${tranChoXongMs}ms.\n` +
        `█ Không dọn dữ liệu, không chạy ca / afterAll / file kế tiếp trên cùng DB test (sẽ nhận dòng lạ do thao tác ghi sau dọn).\n` +
        `█ File: ${testPath ?? "?"} · ca: ${currentTestName ?? "?"}\n` +
        `█ ${baoCao.replaceAll("\n", "\n█ ")}\n` +
        `${"█".repeat(100)}\n`
    );
    // Khung đi qua pipe worker → tiến trình chính; nhận SIGTERM thì nó chỉ đợi rất ngắn rồi thoát — cho nó kịp đọc.
    nguDongBo(100);
  } finally {
    gietTienTrinhChinhRoiChinhMinh();
  }
}

function gietTienTrinhChinhRoiChinhMinh(): void {
  const laTienTrinhCon = isMainThread && typeof process.send === "function";
  try {
    if (laTienTrinhCon && process.connected && process.ppid === PID_CHA_LUC_NAP) {
      process.kill(PID_CHA_LUC_NAP, "SIGTERM");
      for (let i = 0; i < 100 && chaConSong(PID_CHA_LUC_NAP); i++) nguDongBo(50);
      if (chaConSong(PID_CHA_LUC_NAP)) process.kill(PID_CHA_LUC_NAP, "SIGKILL");
    }
  } catch (loi) {
    // Ghi lỗi này mà lại ném thì `finally` dưới vẫn giết worker.
    ghiHetVaoStderr(`█ Không giết được tiến trình chính ${PID_CHA_LUC_NAP} của lượt: ${moTaLoi(loi)}\n`);
  } finally {
    process.kill(process.pid, "SIGKILL");
  }
}

type Muc = {
  ten: string;
  xong: boolean;
  coLoi: boolean;
  loi: unknown;
  /** Resolve khi thao tác kết thúc (mọi kết cục) — để hook chờ mà không tự sinh rejection treo. */
  ketThuc: Promise<void>;
  /** Có ⇒ thao tác huỷ được từ ngoài (transaction đang giữ chờ `tha()`); trả true nếu lúc gọi nó CHƯA được thả. */
  huy: (() => boolean) | null;
};

const dangChay = new Set<Muc>();
/**
 * Sổ đóng thì `chayNen` từ chối. Mở ở `beforeEach` (`moTheoDoiThaoTacNen`), đóng ở hook dọn. Ban đầu ĐÓNG: file chưa
 * gọi `moTheoDoiThaoTacNen` thì không dùng được sổ (tránh quên luôn cả hook dọn).
 *
 * Sổ đóng/mở chỉ chặn trong cửa sổ từ hook dọn tới `beforeEach` kế tiếp. Thân test đã hết giờ mà đang đứng ở một
 * `await` KHÔNG đăng ký (vd vòng chờ tự viết) có thể chạy tiếp SAU khi test sau mở lại sổ — phần đó do THẾ HỆ ca chặn
 * (`dangKyTheHeCa`, `chayNen`). Chỉ thao tác đã đăng ký trước hook dọn mới chắc chắn xong trước lượt dọn (hoặc, nếu quá
 * trần vẫn chưa xong, lượt dọn không chạy và cả lượt Vitest bị huỷ).
 */
let daDong = true;
/** Hook dọn của test hiện tại đã chạy chưa — kiểm ở cuối test (`onTestFinished`) để bắt file quên `afterEach`. */
let daQuaHookDon = true;

/** Một lượt chạy ca do `aroundEach` cấp: thế hệ tăng dần + tên ca (để báo lỗi). */
type TheHeCa = { theHe: number; tenCa: string };
/**
 * Thế hệ của ca mà đoạn mã đang chạy THUỘC VỀ — đi theo mọi `await` / timer / promise sinh ra từ thân ca, kể cả khi thân
 * ca đó đã bị Vitest bỏ (hết giờ) mà vẫn chạy tiếp. Vì vậy thân ca cũ còn sống thì vẫn mang thế hệ CŨ.
 */
const alsTheHeCa = new AsyncLocalStorage<TheHeCa>();
let demTheHe = 0;
/** Ca mà `aroundEach` đang chạy (`runTest` chưa trả); null giữa hai ca. */
let caDangChay: TheHeCa | null = null;
/** Thế hệ của ca đã mở sổ gần nhất (`moTheoDoiThaoTacNen`). */
let theHeMoSo: number | null = null;
/**
 * Lời từ chối dành cho thân ca CŨ: lỗi ném vào thân ca đã bị Vitest bỏ thì không ai thấy, nên lưu lại để hook dọn kế
 * tiếp (của ca đang chạy) NÉM ra — ca đó đỏ ở `afterEach`.
 */
const tuChoiThanCaCu: string[] = [];

/**
 * Đăng ký `aroundEach` cấp thế hệ cho mỗi ca — gọi ở cấp file (hoặc `describe`), TRƯỚC `beforeEach` mở sổ. Thiếu nó thì
 * `moTheoDoiThaoTacNen` ném. Phải là `aroundEach` (không phải `beforeEach`): chỉ `runTest` của nó bao được cả
 * `beforeEach`, thân ca, `afterEach` trong cùng một ngữ cảnh `AsyncLocalStorage`.
 */
export function dangKyTheHeCa(): void {
  aroundEach(async (runTest, context) => {
    const ca: TheHeCa = { theHe: ++demTheHe, tenCa: context.task.name };
    caDangChay = ca;
    try {
      await alsTheHeCa.run(ca, runTest);
    } finally {
      caDangChay = null;
    }
  });
}

/**
 * Gọi ở `beforeEach`: mở sổ đăng ký cho test sắp chạy, và hẹn kiểm ở cuối test (sau mọi `afterEach`) rằng hook dọn đã
 * chạy. Quên hook dọn ⇒ lúc đó mới chờ thao tác nền xong rồi NÉM (kèm lỗi của chúng) — muộn hơn lượt dọn của file,
 * nhưng không bao giờ im lặng nuốt lỗi; thao tác còn sống quá trần thì huỷ cả lượt như ở hook dọn. Hook này mang timeout
 * `TIMEOUT_HOOK_DON_MS` riêng: để mặc định thì Vitest cắt nó ở `hookTimeout` (10s) giữa lúc chờ, rồi ca kế / `afterAll`
 * chạy tiếp khi thao tác còn sống.
 */
export function moTheoDoiThaoTacNen(): void {
  nemNeuDaChan("ca kế tiếp");
  const ca = alsTheHeCa.getStore();
  if (!ca) {
    throw new Error(
      "moTheoDoiThaoTacNen() chạy ngoài ngữ cảnh thế hệ ca — thiếu dangKyTheHeCa() cùng cấp, đặt TRƯỚC beforeEach này."
    );
  }
  theHeMoSo = ca.theHe;
  daDong = false;
  daQuaHookDon = false;
  onTestFinished(async () => {
    if (daQuaHookDon) return;
    await kiemThieuHookDon();
  }, TIMEOUT_HOOK_DON_MS);
}

/** Phần kiểm của `onTestFinished` — tách riêng để test hợp đồng gọi thẳng. */
export async function kiemThieuHookDon(): Promise<void> {
  let chiTiet = "không còn thao tác nền nào";
  try {
    await choThaoTacNenXong();
  } catch (loi) {
    chiTiet = moTaLoi(loi);
  }
  throw new Error(
    `Test dùng sổ thao tác nền nhưng KHÔNG qua hook dọn — thiếu afterEach(() => donSauKhiThaoTacNenXong(…), ` +
      `TIMEOUT_HOOK_DON_MS) cùng cấp với beforeEach gọi moTheoDoiThaoTacNen(). Kết quả chờ muộn: ${chiTiet}`
  );
}

/**
 * Khởi chạy `batDau()` và đăng ký vào sổ để hook dọn chờ nó xong. Trả ĐÚNG promise của thao tác (thân test await như
 * thường, lỗi tới thân test như cũ); hook dọn báo lại lỗi đó lần nữa nếu thân test đã chết trước khi kịp await.
 *
 * Mọi phép từ chối xảy ra TRƯỚC `batDau()` — thao tác bị từ chối không chạy một câu SQL nào. Lời gọi từ thân một ca ĐÃ
 * KẾT THÚC (thế hệ khác ca đang chạy — hết giờ mà thân còn chạy tiếp) bị từ chối kể cả khi sổ đang mở cho ca mới, và
 * được lưu để hook dọn kế tiếp làm ca đang chạy ĐỎ. Lời gọi từ ngữ cảnh không thuộc ca nào (chuỗi promise khởi từ
 * `beforeAll`…) bị đối xử y như vậy. Giới hạn: thân của ca CUỐI file gọi sau hook dọn cuối thì vẫn bị từ chối (không
 * SQL) nhưng không còn hook dọn nào để báo đỏ — ca đó vốn đã đỏ vì hết giờ. Thao tác ca cũ gọi thẳng `prisma` / `await`
 * thẳng (không qua `chayNen`) thì helper không thấy — vẫn ngoài phạm vi.
 */
export function chayNen<T>(ten: string, batDau: () => Promise<T>, huy?: () => boolean): Promise<T> {
  nemNeuDaChan(`khởi chạy "${ten}"`);
  const ca = alsTheHeCa.getStore();
  if (!ca || ca.theHe !== caDangChay?.theHe) {
    const nguon = ca
      ? `Thân ca "${ca.tenCa}" đã KẾT THÚC (hết giờ / bị bỏ) nhưng vẫn chạy tiếp và gọi`
      : "Một đoạn mã KHÔNG thuộc ca nào (khởi từ beforeAll / afterAll / cấp module) gọi";
    const lyDo =
      `${nguon} chayNen("${ten}") ${caDangChay ? `lúc ca "${caDangChay.tenCa}" đang chạy` : "giữa hai ca"} — ĐÃ ` +
      `TỪ CHỐI, không khởi chạy (không câu SQL nào).` +
      (ca ? " Thân ca cũ còn sống là dấu hiệu nó đứng ở một await không đăng ký (vòng chờ tự viết…)." : "");
    tuChoiThanCaCu.push(lyDo);
    throw new Error(lyDo);
  }
  if (daDong) {
    throw new Error(
      `Không khởi chạy "${ten}": sổ thao tác nền đang đóng — hoặc test đã qua hook dọn (hết giờ / đã kết thúc, chạy lúc ` +
        `này là chồng lên lượt dọn), hoặc file chưa gọi moTheoDoiThaoTacNen() ở beforeEach.`
    );
  }
  const p = batDau();
  const muc: Muc = { ten, xong: false, coLoi: false, loi: undefined, ketThuc: Promise.resolve(), huy: huy ?? null };
  muc.ketThuc = p.then(
    () => {
      muc.xong = true;
    },
    (loi: unknown) => {
      muc.xong = true;
      muc.coLoi = true;
      muc.loi = loi;
    }
  );
  dangChay.add(muc);
  return p;
}

/**
 * Mở một transaction riêng, chạy `lam(tx)` (giành khoá / ghi chưa commit) rồi GIỮ transaction mở tới khi gọi `tha()`
 * (commit). Trả sau khi `lam` xong. Hook dọn huỷ (ROLLBACK) transaction nếu test chưa thả.
 */
export async function giuTransactionDenKhiTha(
  ten: string,
  lam: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<{ tha: () => void; xong: Promise<void> }> {
  // Resolve bằng cờ chứ không reject: huỷ lúc callback chưa tới `await cho` không để lại rejection treo.
  let ketCuc!: (cach: "commit" | "huy") => void;
  const cho = new Promise<"commit" | "huy">((res) => (ketCuc = res));
  let daQuyet = false;
  /** Chỉ lần quyết đầu tiên có hiệu lực; trả true nếu lần gọi này là lần quyết. */
  const quyetDinh = (cach: "commit" | "huy"): boolean => {
    if (daQuyet) return false;
    daQuyet = true;
    ketCuc(cach);
    return true;
  };
  let daGiu!: () => void;
  const giuXong = new Promise<void>((res) => (daGiu = res));
  const xong = chayNen(
    ten,
    () =>
      prisma.$transaction(
        async (tx) => {
          await lam(tx);
          daGiu();
          if ((await cho) === "huy") throw new HuyBoiHookDon(`"${ten}" bị hook dọn huỷ (ROLLBACK)`);
        },
        { timeout: TIMEOUT_TX_GIU_KHOA_MS }
      ),
    () => quyetDinh("huy")
  );
  // Transaction kết thúc trước khi báo đã giữ (vd `lam` ném) ⇒ báo ngay lý do gốc, đừng treo ở `giuXong`.
  await Promise.race([
    giuXong,
    xong.then(() => {
      throw new Error(`"${ten}" kết thúc trước khi báo đã giữ`);
    }),
  ]);
  return {
    tha: () => {
      quyetDinh("commit");
    },
    xong,
  };
}

/**
 * Giả lập bước bật: giữ EXCLUSIVE `KHOA_BAT_NO_PHAI_TRA` + ghi Setting M (chưa commit) 0,8s rồi commit. `hanhDong`
 * chạy giữa chừng; `giua` (nếu có) chạy sau khi nó đã bắt đầu, TRƯỚC khi bước bật commit. Trả kết quả + thời gian
 * `hanhDong` phải chờ. Lỗi giữa chừng / hết giờ ⇒ hook dọn huỷ bước bật (M không bao giờ commit) và chờ `hanhDong`.
 * `hanhDong` LUÔN được đăng ký ⇒ đừng dùng cho ca chờ chính `hanhDong` ném (hook dọn sẽ báo đỏ lỗi đó).
 */
export async function giaLapBuocBatGiuKhoa<T>(
  moc: string,
  hanhDong: () => Promise<T>,
  giua?: () => Promise<void>
): Promise<{ r: T; ms: number }> {
  const buocBat = await giuTransactionDenKhiTha("giả lập bước bật", async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`;
    await tx.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: moc } });
  });
  const t0 = performance.now();
  // Đăng ký CẢ phần đo giờ: promise trả về là promise được theo dõi, lỗi sớm ở `giua` không để lại rejection treo.
  const p = chayNen("hành động chạy giữa bước bật", async () => {
    const r = await hanhDong();
    return { r, ms: performance.now() - t0 };
  });
  if (giua) await giua();
  await new Promise((res) => setTimeout(res, 800));
  buocBat.tha();
  await buocBat.xong;
  return p;
}

/**
 * Thay `Promise.all` cho các lượt chạy đồng thời: LUÔN chờ đủ mọi lượt kết thúc (không trả sớm khi một lượt ném, để
 * lượt kia commit sau lưng), rồi nếu có lượt ném thì ném lại kèm lý do gốc từng lượt.
 */
export async function choTatCa<T extends readonly unknown[] | []>(
  dsLuot: { readonly [K in keyof T]: Promise<T[K]> }
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const kq = await Promise.allSettled(dsLuot as readonly Promise<unknown>[]);
  const loi = kq.flatMap((k, i) => (k.status === "rejected" ? [{ i, lyDo: k.reason as unknown }] : []));
  if (loi.length > 0) {
    throw new Error(`Lượt đồng thời ném ngoài dự kiến: ${loi.map((l) => `#${l.i}: ${moTaLoi(l.lyDo)}`).join(" · ")}`, {
      cause: loi.length === 1 ? loi[0]!.lyDo : loi.map((l) => l.lyDo),
    });
  }
  return kq.map((k) => (k as PromiseFulfilledResult<unknown>).value) as { -readonly [K in keyof T]: Awaited<T[K]> };
}

/**
 * Lỗi ném ra là `Error` thường kèm `cause`, KHÔNG dùng `AggregateError`: Vitest tách `AggregateError` thành các lỗi con
 * của nó — mảng con rỗng (vd chỉ báo "còn giữ transaction") thì test đỏ mà không in một dòng lý do nào (đo 06/11).
 */
function moTaLoi(loi: unknown): string {
  return loi instanceof Error ? `${loi.name}: ${loi.message}` : String(loi);
}

/**
 * Bước chờ của hook dọn (file test gọi qua `donSauKhiThaoTacNenXong`): huỷ transaction còn giữ, chờ mọi thao tác đã
 * đăng ký xong (trần `TRAN_CHO_XONG_MS`), khoá sổ tới `beforeEach` kế tiếp, rồi ném nếu test để lại việc dở hoặc có thao
 * tác ném ngoài dự kiến. Quá trần mà còn thao tác chạy ⇒ đặt dấu chặn, gọi huỷ cả lượt (mặc định không trở về), rồi
 * ném `ThaoTacNenConSong` — `donSauKhiThaoTacNenXong` thấy lỗi này thì KHÔNG dọn.
 */
export async function choThaoTacNenXong(): Promise<void> {
  daDong = true;
  daQuaHookDon = true;
  nemNeuDaChan("lượt chờ / dọn");
  const muc = [...dangChay];
  dangChay.clear();

  // Huỷ NGAY (không chờ hết timeout transaction): transaction giữ khoá ROLLBACK, lượt đang chờ khoá chạy nốt.
  const conGiu = muc.filter((m) => !m.xong && m.huy !== null && m.huy());

  let hen: ReturnType<typeof setTimeout> | undefined;
  const ketQua = await Promise.race([
    Promise.all(muc.map((m) => m.ketThuc)).then(() => "xong" as const),
    new Promise<"het-tran">((res) => {
      hen = setTimeout(() => res("het-tran"), tranChoXongMs);
    }),
  ]);
  clearTimeout(hen);

  const baoCao: string[] = [];
  const nguyenNhan: unknown[] = [];
  const conChay = ketQua === "het-tran" ? muc.filter((m) => !m.xong).map((m) => `"${m.ten}"`) : [];
  if (conChay.length > 0) {
    baoCao.push(
      `Quá ${tranChoXongMs}ms vẫn còn chạy: ${conChay.join(", ")} — CHƯA xác nhận kết thúc ⇒ KHÔNG dọn, chặn mọi ca / ` +
        `file kế tiếp trên cùng DB`
    );
  }
  for (const m of conGiu) {
    baoCao.push(`"${m.ten}" còn giữ transaction lúc test kết thúc (lỗi sớm / hết giờ / quên tha()) — đã ROLLBACK trước khi dọn`);
  }
  for (const m of muc) {
    if (m.coLoi && !(m.loi instanceof HuyBoiHookDon)) {
      nguyenNhan.push(m.loi);
      baoCao.push(`"${m.ten}" ném: ${moTaLoi(m.loi)}`);
    }
  }
  // Lời từ chối thân ca cũ (ném vào thân đã bị bỏ — không ai thấy): báo ra ĐÂY, ca đang chạy đỏ ở hook dọn.
  baoCao.push(...tuChoiThanCaCu.splice(0));
  if (baoCao.length === 0) return;
  const thongDiep = `Thao tác nền của test:\n- ${baoCao.join("\n- ")}`;
  const cause = nguyenNhan.length === 1 ? nguyenNhan[0] : nguyenNhan.length > 1 ? nguyenNhan : undefined;
  if (conChay.length > 0) {
    // Đặt dấu chặn TRƯỚC khi huỷ lượt: lối huỷ thay thế (test hợp đồng) trở về thì ca kế / hook dọn vẫn bị chặn.
    chanDoConSong = new ThaoTacNenConSong(thongDiep, { cause });
    huyLuotChay(thongDiep);
    throw chanDoConSong;
  }
  throw new Error(thongDiep, { cause });
}

/**
 * Thân `afterEach` của file có test đồng thời: chờ thao tác nền xong TRƯỚC, rồi chạy `don` — kể cả khi bước chờ báo lỗi
 * mà mọi thao tác đã KẾT THÚC (lượt dọn của file không bị bỏ), rồi ném lại lỗi của bước chờ. Ngoại lệ duy nhất: thao
 * tác còn chạy quá trần / worker đã bị chặn ⇒ KHÔNG chạy `don` (đang có thao tác ghi sống trên DB), chỉ ném.
 */
export async function donSauKhiThaoTacNenXong(don: () => Promise<void> | void): Promise<void> {
  let loiCho: unknown;
  let coLoiCho = false;
  try {
    await choThaoTacNenXong();
  } catch (loi) {
    coLoiCho = true;
    loiCho = loi;
  }
  if (chanDoConSong) throw loiCho;
  try {
    await don();
  } catch (loiDon) {
    if (coLoiCho) {
      throw new Error(`Cả bước chờ thao tác nền lẫn lượt dọn đều lỗi — chờ: ${moTaLoi(loiCho)} · dọn: ${moTaLoi(loiDon)}`, {
        cause: [loiCho, loiDon],
      });
    }
    throw loiDon;
  }
  if (coLoiCho) throw loiCho;
}
