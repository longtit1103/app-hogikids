import { test as testGoc, expect, request, type Page } from "@playwright/test";

// Fixture là file DUY NHẤT trong tests/e2e được lấy GIÁ TRỊ từ @playwright/test (hàng rào
// tests/unit/e2e-dung-fixture-cho-stream.test.ts). Helper cần `expect`/`request` lấy lại từ đây.
export { expect, request };
export type { APIResponse, Locator, Page } from "@playwright/test";

/** Vùng React stream nội dung tới trước khi dời vào trang. `\3A` = dấu hai chấm (id "S:0", "S:1"…). */
const VUNG_STREAM_AN = 'div[hidden][id^="S\\3A"]';

/**
 * `test` dùng chung cho mọi spec e2e: `page.goto` / `page.reload` CHỈ trả về khi nội dung trang đã
 * THỰC SỰ nằm trong `<main>` — không chỉ khi sự kiện `load` bắn.
 *
 * Vì sao cần: `src/app/(app)/loading.tsx` bọc mọi trang trong một Suspense boundary. Lượt tải cả
 * trang (không phải chuyển trang phía client) khi đó được STREAM: HTML đầu mang khung chờ, nội dung
 * thật tới sau trong một `<div hidden id="S:n">` ở cuối `<body>` (ngoài `<main>`), rồi script
 * `$RC` của React mới dời nó vào chỗ khung chờ. Hai khe hở mà test đọc DOM ngay sau `goto` rơi vào:
 *  1. React (từ 19.2) KHÔNG dời ngay: `$RC` xếp hàng rồi `$RV` chạy ở khung hình kế / sau tới
 *     ~300ms (sát mốc 2s thì chờ tới 2,3s). Sự kiện `load` có thể bắn TRƯỚC đó ⇒ bản duy nhất của
 *     nội dung đang nằm trong vùng ẩn. `innerText` của phần tử không được vẽ trả về NGUYÊN
 *     `textContent` (gồm cả dòng `md:hidden`) ⇒ số đọc ra dính thêm chữ số.
 *  2. Khi một context phía trên (bộ chọn kỳ đọc localStorage lúc mount) đổi giá trị trong lúc
 *     boundary còn chờ server, React bỏ hydrate và tự render lại trang ở client. Nếu bản client vào
 *     `<main>` trước khi `$RC` tới xoá vùng ẩn thì DOM có HAI bản cùng lúc (một hiện, một ẩn) ⇒
 *     locator chế độ strict vỡ ngay lập tức.
 * Người dùng không thấy gì trong cả hai khe (vùng `hidden` không được vẽ) — đây là chuyện đọc DOM
 * sớm của test, không phải lỗi hiển thị.
 *
 * Điều kiện "xong": không còn khung chờ trang VÀ không còn vùng stream ẩn nào.
 */
export async function choTrangStreamXong(page: Page): Promise<void> {
  await expect(page.getByTestId("khung-cho-trang"), "khung chờ trang phải nhường chỗ cho nội dung").toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.locator(VUNG_STREAM_AN), "nội dung stream phải được React dời vào trang").toHaveCount(
    0,
    { timeout: 15_000 }
  );
}

/**
 * Hai núm tái hiện máy chậm (CI) — để trống = không đổi gì:
 *  - `E2E_CPU_THROTTLE=6` làm chậm CPU trình duyệt N lần qua CDP (chỉ Chromium);
 *  - `E2E_TRE_REVEAL_MS=800` hoãn hàm `$RV` (bước React dời nội dung stream vào trang) thêm N ms —
 *    mô phỏng khe "đã `load` mà nội dung còn trong vùng ẩn" mà React tự tạo (tới ~300ms) và máy CI
 *    chậm kéo dài thêm. Dùng để chứng minh test không đọc DOM trước khi stream xong.
 */
const HE_SO_CHAM_CPU = Number(process.env.E2E_CPU_THROTTLE ?? "0");
const TRE_REVEAL_MS = Number(process.env.E2E_TRE_REVEAL_MS ?? "0");

export const test = testGoc.extend({
  page: async ({ page }, use) => {
    if (HE_SO_CHAM_CPU > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: HE_SO_CHAM_CPU });
    }
    if (TRE_REVEAL_MS > 0) {
      await page.addInitScript((tre: number) => {
        let rv: ((q: unknown[]) => void) | undefined;
        Object.defineProperty(window, "$RV", {
          configurable: true,
          get: () => rv,
          set: (goc: (q: unknown[]) => void) => {
            rv = (q) => {
              setTimeout(() => goc(q), tre);
            };
          },
        });
      }, TRE_REVEAL_MS);
    }
    const gotoGoc = page.goto.bind(page);
    const reloadGoc = page.reload.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      const res = await gotoGoc(...args);
      await choTrangStreamXong(page);
      return res;
    };
    page.reload = async (...args: Parameters<Page["reload"]>) => {
      const res = await reloadGoc(...args);
      await choTrangStreamXong(page);
      return res;
    };
    await use(page);
  },
});
