import { afterAll, beforeEach, it } from "vitest";

import {
  chayNen,
  dangKyTheHeCa,
  doiCauHinhChoTestHopDong,
  moTheoDoiThaoTacNen,
} from "../../helpers/thao-tac-nen-cho-xong-truoc-khi-don";

import { ghiDau } from "./dau-thu-muc";

/**
 * File QUÊN `afterEach(donSauKhiThaoTacNenXong…)`: chỉ còn kiểm cuối test (`onTestFinished` do `moTheoDoiThaoTacNen`
 * hẹn) đứng chờ thao tác nền. Test hợp đồng chạy file này với `--hookTimeout=1000` (thay 10s mặc định cho nhanh) và trần
 * chờ 1,5s: nếu kiểm cuối test KHÔNG mang timeout riêng thì Vitest cắt nó ở 1s, rồi ca 2 và `afterAll` chạy khi thao tác
 * (sống 3s) vẫn còn.
 */
doiCauHinhChoTestHopDong({ tranChoXongMs: 1_500 });

dangKyTheHeCa();

beforeEach(() => {
  moTheoDoiThaoTacNen();
});

afterAll(() => {
  ghiDau("after-all-chay");
});

it("ca 1: thao tác nền còn sống, file quên hook dọn", () => {
  ghiDau("ca-1-bat-dau");
  void chayNen("thao tác nền chậm", async () => {
    await new Promise((r) => setTimeout(r, 3_000));
    ghiDau("thao-tac-nen-xong");
  });
});

it("ca 2: ca kế trong cùng file", () => {
  ghiDau("ca-2-chay");
});
