import { afterEach, beforeEach, it } from "vitest";

import {
  chayNen,
  dangKyTheHeCa,
  donSauKhiThaoTacNenXong,
  moTheoDoiThaoTacNen,
  TIMEOUT_HOOK_DON_MS,
} from "../../helpers/thao-tac-nen-cho-xong-truoc-khi-don";

import { ghiDau } from "./dau-thu-muc";

/**
 * Thân ca ĐÃ HẾT GIỜ còn chạy tiếp và gọi thao tác lúc ca SAU đã mở sổ. Thứ tự do hai MỐC BÁO HIỆU quyết định, KHÔNG
 * do đồng hồ — máy chậm tới đâu thì trình tự vẫn y nguyên:
 *  1. Ca 1 đứng ở một await KHÔNG đăng ký (`caMoiDaKhoiChay.cho`). Chỉ ca 2 báo mốc này, mà ca 2 chỉ chạy sau khi ca 1
 *     kết thúc ⇒ ca 1 LUÔN hết giờ (300ms); hook dọn của ca 1 chạy, sổ trống.
 *  2. Ca 2 mở sổ, khởi chạy thao tác của chính nó; thao tác đó báo `caMoiDaKhoiChay` rồi đứng chờ `thanCaCuDaGoi`.
 *  3. Thân ca 1 tỉnh dậy ĐÚNG lúc thao tác của ca 2 còn dở, gọi `chayNen("ghi của ca cũ")` — phải bị TỪ CHỐI trước
 *     `batDau` (dấu `ca-cu-batdau-chay` không được có) và làm ca 2 ĐỎ ở hook dọn; xong thì báo `thanCaCuDaGoi`.
 *  4. Thao tác của ca 2 chạy nốt (dấu `ca-moi-xong`).
 *
 * Phải báo hiệu bằng PROMISE mà thân ca 1 tự `await`, không bằng callback do ca 2 gọi: phần chạy tiếp sau `await` giữ
 * ngữ cảnh của ca 1 (đúng thứ cần đo), còn callback thì chạy theo ngữ cảnh của nơi gọi — tức của ca 2.
 */
dangKyTheHeCa();

/** Một mốc báo hiệu một lần: `cho` xong khi có người gọi `bao()`. */
function taoMoc(): { cho: Promise<void>; bao: () => void } {
  let bao!: () => void;
  const cho = new Promise<void>((xong) => {
    bao = xong;
  });
  return { cho, bao };
}

/** Thao tác của ca 2 đã khởi chạy (sổ đang mở cho ca 2). */
const caMoiDaKhoiChay = taoMoc();
/** Lời gọi `chayNen` của thân ca 1 đã có kết cục (bị từ chối, hoặc — nếu helper hỏng — đã chạy). */
const thanCaCuDaGoi = taoMoc();

/**
 * Chặn TRÊN cho nhánh hỏng, không tham gia quyết định thứ tự: ở nhánh đúng, từ lúc ca 2 báo mốc tới lúc thân ca 1 báo
 * lại chỉ là một chuỗi microtask (không I/O bất đồng bộ) nên hẹn giờ này không bao giờ kịp nổ. Thân ca 1 không tỉnh dậy
 * ⇒ thao tác của ca 2 ném lời báo rõ, thay vì treo tới trần chờ của hook dọn rồi huỷ cả lượt con.
 */
const TRAN_CHO_THAN_CA_CU_MS = 3_000;

async function choThanCaCuGoi(): Promise<void> {
  let henGio: ReturnType<typeof setTimeout> | undefined;
  const quaTran = new Promise<never>((_, tuChoi) => {
    henGio = setTimeout(
      () => tuChoi(new Error(`Thân ca 1 không gọi chayNen trong ${TRAN_CHO_THAN_CA_CU_MS}ms sau khi ca 2 báo mốc.`)),
      TRAN_CHO_THAN_CA_CU_MS
    );
  });
  try {
    await Promise.race([thanCaCuDaGoi.cho, quaTran]);
  } finally {
    clearTimeout(henGio);
  }
}

beforeEach(() => {
  moTheoDoiThaoTacNen();
});

afterEach(() => donSauKhiThaoTacNenXong(() => ghiDau("don-chay")), TIMEOUT_HOOK_DON_MS);

it("ca 1: hết giờ, thân còn chạy tiếp", async () => {
  await caMoiDaKhoiChay.cho;
  ghiDau("ca-1-than-chay-tiep");
  try {
    await chayNen("ghi của ca cũ", async () => {
      ghiDau("ca-cu-batdau-chay");
    });
  } finally {
    thanCaCuDaGoi.bao();
  }
}, 300);

it("ca 2: ca mới, thao tác của chính nó chạy bình thường", async () => {
  await chayNen("ghi của ca mới", async () => {
    ghiDau("ca-moi-batdau-chay");
    caMoiDaKhoiChay.bao();
    await choThanCaCuGoi();
    ghiDau("ca-moi-xong");
  });
});
