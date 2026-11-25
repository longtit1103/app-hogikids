import { afterEach, beforeEach, describe, it } from "vitest";

import {
  chayNen,
  dangKyTheHeCa,
  donSauKhiThaoTacNenXong,
  moTheoDoiThaoTacNen,
  TIMEOUT_HOOK_DON_MS,
} from "../../helpers/thao-tac-nen-cho-xong-truoc-khi-don";

/**
 * Hai ca khai báo `it.concurrent` trong một `describe` lồng. Helper chỉ có một sổ chung nên không phủ được ca đồng thời:
 * CẢ HAI ca phải đỏ ở `aroundEach` với cùng một lời báo đúng lý do (ca đồng thời), kèm đường `describe` của ca — không
 * ca nào được chạy thân test, không ca nào bị báo nhầm "thân ca đã kết thúc".
 */
dangKyTheHeCa();

beforeEach(() => {
  moTheoDoiThaoTacNen();
});

afterEach(() => donSauKhiThaoTacNenXong(() => {}), TIMEOUT_HOOK_DON_MS);

describe("nhóm ngoài", () => {
  describe("nhóm trong", () => {
    it.concurrent("ca A", async () => {
      await chayNen("lượt của ca A", () => new Promise<void>((r) => setTimeout(r, 100)));
    });
    it.concurrent("ca B", async () => {
      await chayNen("lượt của ca B", () => new Promise<void>((r) => setTimeout(r, 100)));
    });
  });
});
