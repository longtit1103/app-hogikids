/**
 * CỔNG GHI TOÀN CỤC trên BẢN BUILD (`next build && next start`, Turbopack) — chạy bằng
 * `npm run test:e2e:prod:cong-ghi` (`playwright.cong-ghi-prod.config.ts`).
 *
 * Vitest chỉ MÔ PHỎNG "Next nạp module thành nhiều bản sao" (`vi.resetModules()`); ở đây đo trên bundler
 * thật: server action (bundle ACTION) và route handler (bundle ROUTE) phải thấy CÙNG bộ đếm + CÙNG cờ
 * phục hồi (neo `globalThis`), và lượt phục hồi phải chờ/nhả đúng như hợp đồng của `/api/restore`.
 *
 * Bộ phận chỉ-test (chỉ có trong bản build `E2E_CONG_GHI_BUILD=1`):
 *  - trang `/e2e-cong-ghi` + action `ghiGiuBarrierE2e` / `ghiNgayE2e` (cửa `vaoCuaGhi` THẬT);
 *  - route `/api/e2e-cong-ghi`: GET bộ đếm, POST `?lam=tha` thả barrier, POST `?lam=restore-kho` gọi
 *    `POST` THẬT của `/api/restore` ở chế độ restore khô (lease → X → cờ → drain → fencing rồi dừng trước
 *    bản lùi — không `pg_dump`/`pg_restore`, không đụng dữ liệu).
 * Route ghi "khác" dùng route THẬT `/api/ingest/raw` (bearer test). Lưới cấp op đo bằng action ghi NGOÀI
 * cửa (`ghiNgoaiCuaE2e`) và bằng lượt render THẬT của trang Tổng quan trong lúc cờ bật.
 *
 * Server action bị router React xếp hàng theo TRANG (action sau chờ action trước) ⇒ action thứ hai luôn
 * bấm ở trang THỨ HAI.
 */
import { LOI_DANG_PHUC_HOI } from "../../src/lib/backup/khoa-bao-tri";
import { dangNhapVoi } from "./dang-nhap-voi-tai-khoan";
import { choTrangStreamXong, expect, test, type Page } from "./fixture-cho-trang-stream-xong";
import { INGEST_SECRET_TEST, TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

type BoDem = {
  soRequest: number;
  soOpLe: number;
  dangPhucHoi: boolean;
  dangDrain: boolean;
  soDangChoBarrier: number;
  nextRuntime: string | null;
};
type KetQuaAction = { ok: true; xongLuc: number; giaTri: string } | { ok: false; error: string; loai?: "cong-ghi-chan" };
type KetQuaRestoreKho = { status: number; body: { ok?: boolean; khoE2e?: string; luc?: number; boDem?: Partial<BoDem>; error?: string } };

// `playwright.config.ts` (mọi `*.spec.ts`, server `next dev` không có route chỉ-test) cũng quét thấy file
// này — chỉ chạy dưới config cổng ghi.
test.skip(process.env.E2E_CONG_GHI_SPEC !== "1", "Chỉ chạy qua `npm run test:e2e:prod:cong-ghi` (bản build có route chỉ-test).");
// Trạng thái server (bộ đếm, barrier, cờ) sống suốt lượt ⇒ chạy tuần tự.
test.describe.configure({ mode: "serial", timeout: 120_000 });

const DUONG_ROUTE = "/api/e2e-cong-ghi";

async function docDem(page: Page): Promise<BoDem> {
  const r = await page.request.get(DUONG_ROUTE);
  expect(r.status(), "route chỉ-test phải có trong bản build e2e").toBe(200);
  return (await r.json()) as BoDem;
}

async function thaBarrier(page: Page): Promise<void> {
  const r = await page.request.post(`${DUONG_ROUTE}?lam=tha`);
  expect(r.status()).toBe(200);
}

/** Bấm "ghi giữ barrier" rồi chờ tới khi action đã ghi lần đầu VÀ đang đứng chờ (soi, không đoán giờ). */
async function batDauActionGiuCua(page: Page): Promise<void> {
  await page.getByTestId("ghi-giu").click();
  await expect.poll(async () => (await docDem(page)).soDangChoBarrier, { timeout: 15_000 }).toBe(1);
}

async function ketQuaAction(page: Page, testId: "kq-giu" | "kq-ngay" | "kq-ngoai-cua"): Promise<KetQuaAction> {
  return JSON.parse((await page.getByTestId(testId).textContent()) ?? "{}") as KetQuaAction;
}

/** Gọi restore khô; trả promise + cờ "đã trả lời" để kiểm restore CHƯA xong trong lúc drain chờ. */
function goiRestoreKho(page: Page, hanDrainMs: number): { xong: () => boolean; ketQua: Promise<KetQuaRestoreKho> } {
  let daXong = false;
  const ketQua = page.request
    .post(`${DUONG_ROUTE}?lam=restore-kho&hanDrainMs=${hanDrainMs}`, { timeout: 90_000 })
    .then(async (r) => {
      daXong = true;
      return { status: r.status(), body: (await r.json()) as KetQuaRestoreKho["body"] };
    });
  return { xong: () => daXong, ketQua };
}

test.beforeEach(async ({ page }) => {
  // Restore khô đi qua cổng chủ shop THẬT của `/api/restore` ⇒ cần phiên chủ shop (seed ở global setup).
  await dangNhapVoi(page, TEST_USER_EMAIL, TEST_USER_PASSWORD);
  await page.goto("/e2e-cong-ghi");
  // Soi tới khi yên (không đoán giờ): lượt render trang chủ sau đăng nhập có thể còn câu ghi lẻ đang bay.
  await expect
    .poll(async () => docDem(page), { timeout: 15_000 })
    .toMatchObject({ soRequest: 0, soOpLe: 0, dangPhucHoi: false, dangDrain: false, soDangChoBarrier: 0 });
});

test.afterEach(async ({ page }) => {
  // Test đỏ giữa chừng vẫn không để action treo sang test sau (trạng thái server sống suốt lượt).
  await page.request.post(`${DUONG_ROUTE}?lam=tha`).catch(() => {});
});

test("(1) action giữ cửa ở bundle ACTION ⇒ route ở bundle ROUTE đọc CÙNG bộ đếm: 1, thả ⇒ 0", async ({ page }) => {
  expect((await docDem(page)).nextRuntime, "route chạy trong Next (KHÔNG phải chế độ khoá CLI)").toBe("nodejs");

  await batDauActionGiuCua(page);
  // Bộ đếm do cửa ở bundle ACTION tăng — route chỉ thấy 1 nếu hai bundle dùng chung ô `globalThis`.
  expect(await docDem(page)).toMatchObject({ soRequest: 1, dangPhucHoi: false });

  await thaBarrier(page);
  await expect(page.getByTestId("kq-giu")).toContainText('"ok":true');
  expect(await ketQuaAction(page, "kq-giu")).toMatchObject({ ok: true, giaTri: "sau" });
  await expect.poll(async () => (await docDem(page)).soRequest).toBe(0);
  expect(await docDem(page)).toMatchObject({ soDangChoBarrier: 0, dangPhucHoi: false });
});

test("(2)+(4) action giữ cửa ⇒ restore khô bật cờ rồi CHỜ drain; trong lúc chờ route ghi thật 503 + Retry-After, action khác bị từ chối; thả ⇒ restore khô xong", async ({
  page,
  context,
}) => {
  await batDauActionGiuCua(page);

  const restore = goiRestoreKho(page, 60_000);
  // Cờ bật (bundle ROUTE) + drain đang chờ đúng lượt action đã vào trước cờ.
  await expect.poll(async () => (await docDem(page)).dangDrain, { timeout: 15_000 }).toBe(true);
  expect(await docDem(page)).toMatchObject({ soRequest: 1, dangPhucHoi: true });
  expect(restore.xong(), "restore khô phải CHỜ action đang giữ cửa").toBe(false);

  // (4a) Route ghi THẬT khác tới sau cờ ⇒ 503 + Retry-After ngay ở cửa (chưa đọc body).
  const ingest = await page.request.post("/api/ingest/raw", {
    headers: { Authorization: `Bearer ${INGEST_SECRET_TEST}` },
    data: { stream: "pancake/orders", shopId: "0", payload: "{}" },
  });
  expect(ingest.status()).toBe(503);
  expect(ingest.headers()["retry-after"]).toBe("60");
  expect(await ingest.json()).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });

  // (4b) Server action khác (bundle ACTION) tới sau cờ do bundle ROUTE bật ⇒ cửa từ chối.
  const trang2 = await context.newPage();
  await trang2.goto("/e2e-cong-ghi");
  await trang2.getByTestId("ghi-ngay").click();
  await expect(trang2.getByTestId("kq-ngay")).toContainText(LOI_DANG_PHUC_HOI);
  expect(await ketQuaAction(trang2, "kq-ngay")).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });

  // (4c) Câu ghi NGOÀI cửa (như lúc render) ⇒ lưới cấp op của singleton Prisma ném, và action ở bundle
  // khác vẫn nhận diện được lỗi (nhãn `Symbol.for`, không `instanceof`) ⇒ `loai: "cong-ghi-chan"`.
  await trang2.getByTestId("ghi-ngoai-cua").click();
  await expect(trang2.getByTestId("kq-ngoai-cua")).toContainText(LOI_DANG_PHUC_HOI);
  expect(await ketQuaAction(trang2, "kq-ngoai-cua")).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI, loai: "cong-ghi-chan" });

  // (4d) Trang Tổng quan render trong lúc cờ bật (render có câu ghi lẻ ngoài cửa — bộ sinh chi phí định kỳ)
  // ⇒ 200, stream xong, không rơi vào ranh giới lỗi, không lỗi JS phía trình duyệt.
  const trang3 = await context.newPage();
  const loiTrinhDuyet: string[] = [];
  trang3.on("pageerror", (e) => loiTrinhDuyet.push(e.message));
  const tongQuan = await trang3.goto("/");
  expect(tongQuan?.status()).toBe(200);
  await choTrangStreamXong(trang3);
  await expect(trang3.getByText("Đã có lỗi xảy ra")).toHaveCount(0);
  expect(loiTrinhDuyet).toEqual([]);
  await trang3.close();

  // Không request nào vừa bị từ chối được đếm; restore vẫn chờ đúng một lượt.
  expect(await docDem(page)).toMatchObject({ soRequest: 1, dangPhucHoi: true, dangDrain: true });
  expect(restore.xong()).toBe(false);

  await thaBarrier(page);
  await expect(page.getByTestId("kq-giu")).toContainText('"ok":true');
  const kqAction = await ketQuaAction(page, "kq-giu");
  expect(kqAction).toMatchObject({ ok: true, giaTri: "sau" });

  const kq = await restore.ketQua;
  expect(kq.status, JSON.stringify(kq.body)).toBe(200);
  expect(kq.body).toMatchObject({ ok: true, khoE2e: "da-drain", boDem: { soRequest: 0, dangPhucHoi: true } });
  // Restore khô chỉ đi tiếp SAU khi action đã ghi xong lần thứ hai.
  expect(kq.body.luc).toBeGreaterThanOrEqual(kqAction.ok ? kqAction.xongLuc : Number.POSITIVE_INFINITY);

  // `finally` của lượt phục hồi đã nhả cờ ⇒ ghi lại được.
  expect(await docDem(page)).toMatchObject({ soRequest: 0, dangPhucHoi: false, dangDrain: false });
  await trang2.getByTestId("ghi-ngay").click();
  await expect(trang2.getByTestId("kq-ngay")).toContainText('"ok":true');
  await trang2.close();
});

test("(3) restore khô với hạn drain ngắn khi action còn giữ cửa ⇒ 409 'chưa đổi gì', cờ nhả, action vẫn hoàn tất", async ({
  page,
  context,
}) => {
  await batDauActionGiuCua(page);

  const kq = await goiRestoreKho(page, 1_500).ketQua;
  expect(kq.status, JSON.stringify(kq.body)).toBe(409);
  expect(kq.body.error).toMatch(/Còn 1 lượt ghi trong app/);
  expect(kq.body.error).toMatch(/còn nguyên/);

  // Cờ đã nhả dù action vẫn đang giữ cửa (không phải chờ action xong mới mở lại app).
  expect(await docDem(page)).toMatchObject({ soRequest: 1, dangPhucHoi: false, dangDrain: false, soDangChoBarrier: 1 });
  const trang2 = await context.newPage();
  await trang2.goto("/e2e-cong-ghi");
  await trang2.getByTestId("ghi-ngay").click();
  await expect(trang2.getByTestId("kq-ngay")).toContainText('"ok":true');
  // Cờ tắt ⇒ câu ghi ngoài cửa chạy bình thường (đối chứng cho ca bị chặn ở test (2)+(4)).
  await trang2.getByTestId("ghi-ngoai-cua").click();
  await expect(trang2.getByTestId("kq-ngoai-cua")).toContainText('"ok":true');
  await trang2.close();

  // Lượt vào trước cờ không bị cắt: thả là ghi nốt lần hai.
  await thaBarrier(page);
  await expect(page.getByTestId("kq-giu")).toContainText('"ok":true');
  expect(await ketQuaAction(page, "kq-giu")).toMatchObject({ ok: true, giaTri: "sau" });
  await expect.poll(async () => (await docDem(page)).soRequest).toBe(0);
});
