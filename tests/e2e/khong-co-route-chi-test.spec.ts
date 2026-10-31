/**
 * Bản build THƯỜNG (`npm run test:e2e:prod` — `next build` không đặt `E2E_CONG_GHI_BUILD`) KHÔNG có route/
 * trang chỉ-test của e2e cổng ghi (`*.e2e.ts(x)`, xem `next.config.ts` → `pageExtensions`). Lưới tĩnh
 * `tests/luoi/file-chi-build-e2e.test.ts` chỉ MÔ PHỎNG luật khớp file của Next; spec này đo trên bản build
 * thật. Cũng chạy dưới `npm run test:e2e` (`next dev`, cùng cấu hình) — ở đó cũng phải 404.
 *
 * Đăng nhập CHỦ SHOP trước: route/trang chỉ-test (nếu lọt vào bản build) gác bằng cổng chủ shop — 404 đo
 * dưới phiên chủ shop mới chứng minh được "không tồn tại" chứ không phải "bị cổng chặn".
 */
import { dangNhapVoi } from "./dang-nhap-voi-tai-khoan";
import { expect, test } from "./fixture-cho-trang-stream-xong";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

test("bản build thường không có route/trang chỉ-test của e2e cổng ghi (404 dưới phiên chủ shop)", async ({ page }) => {
  await dangNhapVoi(page, TEST_USER_EMAIL, TEST_USER_PASSWORD);

  // Đối chứng: phiên chủ shop qua được cổng chủ shop thật.
  const quanTri = await page.goto("/quan-tri");
  expect(quanTri?.status()).toBe(200);

  expect((await page.request.get("/api/e2e-cong-ghi")).status()).toBe(404);
  // POST không có handler nào nhận ⇒ không 2xx (Next trả trang không tồn tại); kiểm cả nhánh restore khô.
  for (const duong of ["/api/e2e-cong-ghi?lam=tha", "/api/e2e-cong-ghi?lam=restore-kho&hanDrainMs=1000"]) {
    const r = await page.request.post(duong);
    expect([404, 405], duong).toContain(r.status());
  }

  const trang = await page.goto("/e2e-cong-ghi");
  expect(trang?.status()).toBe(404);
  await expect(page.getByTestId("ghi-giu")).toHaveCount(0);
});
