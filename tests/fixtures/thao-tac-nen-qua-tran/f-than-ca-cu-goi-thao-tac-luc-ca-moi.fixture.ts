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
 * Thân ca ĐÃ HẾT GIỜ còn chạy tiếp và gọi thao tác lúc ca SAU đã mở sổ. Dòng thời gian (tính từ đầu ca 1):
 *  - 300ms: ca 1 hết giờ (thân đứng ở một await KHÔNG đăng ký); hook dọn của ca 1 chạy, sổ trống;
 *  - ~310ms: ca 2 mở sổ, khởi chạy thao tác của chính nó (sống 700ms);
 *  - 600ms: thân ca 1 tỉnh dậy, gọi `chayNen("ghi của ca cũ")` — phải bị TỪ CHỐI trước `batDau` (dấu
 *    `ca-cu-batdau-chay` không được có) và làm ca 2 ĐỎ ở hook dọn; thao tác của ca 2 vẫn chạy trọn.
 */
dangKyTheHeCa();

beforeEach(() => {
  moTheoDoiThaoTacNen();
});

afterEach(() => donSauKhiThaoTacNenXong(() => ghiDau("don-chay")), TIMEOUT_HOOK_DON_MS);

it("ca 1: hết giờ, thân còn chạy tiếp", async () => {
  await new Promise((r) => setTimeout(r, 600));
  ghiDau("ca-1-than-chay-tiep");
  await chayNen("ghi của ca cũ", async () => {
    ghiDau("ca-cu-batdau-chay");
  });
}, 300);

it("ca 2: ca mới, thao tác của chính nó chạy bình thường", async () => {
  await chayNen("ghi của ca mới", async () => {
    ghiDau("ca-moi-batdau-chay");
    await new Promise((r) => setTimeout(r, 700));
    ghiDau("ca-moi-xong");
  });
});
