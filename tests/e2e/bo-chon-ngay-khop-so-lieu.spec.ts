import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";

import { dangNhap, KHUNG_IPHONE } from "./mobile-helpers";

/**
 * #254 — NHÃN bộ chọn ngày và SỐ LIỆU server phải luôn cùng một khoảng.
 *
 * Server dựng khoảng theo URL → lựa chọn đã lưu → "Tháng này"; khung nội dung 6 trang mang
 * `data-khoang-server` = khoảng server ĐÃ dùng. "Đáp án" của mỗi ca lấy từ CHÍNH server: mở cùng
 * trang với URL tường minh (`?range=7d`…) rồi đọc thuộc tính — không tự tính ngày trong test (trang
 * Kênh/Marketing còn kẹp ngày cuối về hôm nay).
 *
 * Menu (sidebar, thanh tab dưới) luôn là URL SẠCH ⇒ đây là đường lộ lệch: nhãn giữ lựa chọn đã
 * chọn, server từng rơi về "Tháng này".
 */

async function khoangServer(page: Page): Promise<string> {
  const khung = page.locator("[data-khoang-server]");
  await expect(khung).toHaveCount(1);
  return (await khung.getAttribute("data-khoang-server")) ?? "";
}

/** Khoảng server dựng cho `duongDan` khi URL NÓI RÕ khoảng — làm đáp án. */
async function dapAn(page: Page, duongDan: string): Promise<string> {
  await page.goto(duongDan);
  return khoangServer(page);
}

/**
 * Kiểm CÓ CHỜ cả hai phía: nút đang chọn của bộ chọn ngày mang đúng `nhan` VÀ khoảng server là
 * `khoang`. Chờ (không đọc một lần) vì nhãn có thể được áp sau lượt vẽ đầu — đọc một lần là đo
 * nhầm thời điểm chứ không phải bằng chứng lệch.
 */
async function kiemNhanVaSo(page: Page, nhan: string, khoang: string): Promise<void> {
  const nhom = page.getByRole("group", { name: "Chọn khoảng thời gian" }).filter({ visible: true });
  await expect(nhom.locator("button[class*='bg-surface-card']")).toHaveText(nhan);
  await expect(page.locator("[data-khoang-server]")).toHaveAttribute("data-khoang-server", khoang);
}

/** Bấm preset rồi CHỜ server trả (nút đổi trạng thái chọn — nhãn chỉ đổi cùng lúc với số liệu). */
async function chonPreset(page: Page, nhan: string): Promise<void> {
  const nhom = page.getByRole("group", { name: "Chọn khoảng thời gian" }).filter({ visible: true });
  await nhom.getByRole("button", { name: nhan, exact: true }).click();
  await expect(nhom.locator("button[class*='bg-surface-card']")).toHaveText(nhan);
}

test.describe("Bộ chọn ngày — nhãn và số liệu cùng một khoảng (máy tính)", () => {
  test("chọn '7 ngày' ở Kênh rồi bấm menu Dashboard ⇒ số liệu Dashboard là 7 ngày", async ({ page }) => {
    await dangNhap(page);
    const dung = await dapAn(page, "/?range=7d");

    await page.goto("/kenh");
    await chonPreset(page, "7 ngày");
    await expect(page).toHaveURL(/\/kenh$/); // chọn xong URL GIỮ SẠCH — cookie là nơi lưu duy nhất
    await page.locator("aside").getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL(/\/$/);

    await kiemNhanVaSo(page, "7 ngày", dung);
  });

  test("chọn 'Tháng trước' rồi mở lại app bằng URL sạch ⇒ số liệu là tháng trước", async ({ page }) => {
    await dangNhap(page);
    const dung = await dapAn(page, "/?range=last_month");

    await page.goto("/kenh");
    await chonPreset(page, "Tháng trước");

    // Cookie lựa chọn đã lưu: đúng thuộc tính cookie phiên + hạn 1 năm (Secure khi chạy bản production).
    const cookie = (await page.context().cookies()).find((c) => c.name === "hogikids_khoang_ngay");
    expect(cookie?.value).toBe("last_month");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.secure).toBe(!!process.env.E2E_BAN_PRODUCTION);
    const conLaiNgay = ((cookie?.expires ?? 0) * 1000 - Date.now()) / 86_400_000;
    expect(conLaiNgay).toBeGreaterThan(364);
    expect(conLaiNgay).toBeLessThanOrEqual(365);

    await page.goto("/"); // mở lại app: URL sạch, giữ lưu trữ của trình duyệt

    await kiemNhanVaSo(page, "Tháng trước", dung);
  });

  test("drill mang tu/den chỉ là ngữ cảnh tạm: bấm menu sau đó ⇒ về lựa chọn đã lưu (số + nhãn)", async ({
    page,
  }) => {
    await dangNhap(page);
    const dungKenh7d = await dapAn(page, "/kenh?range=7d");
    const drill = await dapAn(page, "/bao-cao?tab=san-pham&tu=2026-06-01&den=2026-06-30");
    expect(drill).toBe("2026-06-01..2026-06-30"); // URL thắng mọi lựa chọn đã lưu

    await page.goto("/kenh");
    await chonPreset(page, "7 ngày");
    await page.goto("/bao-cao?tab=san-pham&tu=2026-06-01&den=2026-06-30"); // vào bằng link drill
    expect(await khoangServer(page)).toBe("2026-06-01..2026-06-30");
    await page.locator("aside").getByRole("link", { name: "Kênh" }).click();
    await expect(page).toHaveURL(/\/kenh$/);

    await kiemNhanVaSo(page, "7 ngày", dungKenh7d);
  });
});

test.describe("Bộ chọn tháng Lãi/Lỗ, nhiều tab, nút Back", () => {
  test("bộ chọn tháng: tháng cũ lưu cứng khoảng tháng; về đúng tháng hiện tại ⇒ lưu 'this_month'", async ({
    page,
  }) => {
    await dangNhap(page);
    const dungThangNay = await dapAn(page, "/tai-chinh?tab=loi-lo&range=this_month");
    const dungThangTruoc = await dapAn(page, "/tai-chinh?tab=loi-lo&range=last_month");
    await page.goto("/tai-chinh?tab=loi-lo");

    await page.getByLabel("Tháng trước", { exact: true }).click(); // nút ‹ của bộ chọn tháng
    await expect(page.locator("[data-khoang-server]")).toHaveAttribute("data-khoang-server", dungThangTruoc);
    const giaTri = async () =>
      (await page.context().cookies()).find((c) => c.name === "hogikids_khoang_ngay")?.value;
    expect(await giaTri()).toBe(dungThangTruoc);

    await page.getByLabel("Tháng sau", { exact: true }).click(); // về đúng tháng hiện tại
    await expect(page.locator("[data-khoang-server]")).toHaveAttribute("data-khoang-server", dungThangNay);
    expect(await giaTri()).toBe("this_month");
  });

  test("hai tab: tab B đổi lựa chọn ⇒ tab A tự khớp nhãn với số (không phải F5)", async ({ page, context }) => {
    await dangNhap(page);
    const dung = await dapAn(page, "/kenh?range=7d");
    await page.goto("/kenh"); // tab A: "Tháng này"
    const tabB = await context.newPage();
    await tabB.goto("/kenh");
    await chonPreset(tabB, "7 ngày");

    await kiemNhanVaSo(page, "7 ngày", dung); // tab A tự dựng lại
    await page.locator("aside").getByRole("link", { name: "Dashboard" }).click();
    await page.locator("aside").getByRole("link", { name: "Kênh" }).click();
    await kiemNhanVaSo(page, "7 ngày", dung);
  });

  test("nút Back sau khi đổi lựa chọn ⇒ nhãn và số vẫn cùng một khoảng", async ({ page }) => {
    await dangNhap(page);
    const dung = await dapAn(page, "/kenh?range=last_month");
    await page.goto("/kenh");
    await page.locator("aside").getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL(/\/$/);
    await chonPreset(page, "Tháng trước");
    await page.goBack();
    await expect(page).toHaveURL(/\/kenh$/);
    await kiemNhanVaSo(page, "Tháng trước", dung);
  });
});

test.describe("Server đọc lựa chọn đã lưu (cookie) khi URL sạch — cả 6 trang", () => {
  const TRANG = ["/", "/tai-chinh", "/kenh", "/kenh/shopee", "/marketing", "/bao-cao"];

  async function datCookie(page: Page, giaTri: string): Promise<void> {
    await page.context().addCookies([{ name: "hogikids_khoang_ngay", value: giaTri, url: "http://localhost:3000" }]);
  }

  test("cookie '7d' ⇒ mọi trang URL sạch dựng số liệu 7 ngày; URL tường minh vẫn thắng cookie", async ({
    page,
  }) => {
    await dangNhap(page);
    await datCookie(page, "7d");
    for (const duongDan of TRANG) {
      const dung = await dapAn(page, `${duongDan}?range=7d`);
      await page.goto(duongDan);
      await expect(page.locator("[data-khoang-server]"), duongDan).toHaveAttribute("data-khoang-server", dung);
    }
    const drill = await dapAn(page, "/bao-cao?tab=san-pham&tu=2026-06-01&den=2026-06-30");
    expect(drill).toBe("2026-06-01..2026-06-30");
  });

  test("cookie hỏng (đảo ngược / ngày không tồn tại / rác) ⇒ bỏ qua, về 'Tháng này'", async ({ page }) => {
    await dangNhap(page);
    const thangNay = await dapAn(page, "/?range=this_month");
    for (const hong of ["2026-06-30..2026-06-01", "2026-02-30..2026-03-05", "khong-hop-le"]) {
      await datCookie(page, hong);
      await page.goto("/");
      await expect(page.locator("[data-khoang-server]"), hong).toHaveAttribute("data-khoang-server", thangNay);
    }
  });
});

test.describe("Bộ chọn ngày — nhãn và số liệu cùng một khoảng (điện thoại, tab tải sẵn)", () => {
  test.use({ viewport: KHUNG_IPHONE });

  // Thanh tab dưới là nơi DUY NHẤT `prefetch={true}` (chỉ bật ở bản build): tab có thể đã tải sẵn
  // theo lựa chọn CŨ — không được hiện số cũ sau khi đổi lựa chọn. Ở dev không có tải sẵn.
  test("đổi sang '7 ngày' rồi chạm tab Tài chính (có thể đã tải sẵn) ⇒ số liệu là 7 ngày", async ({ page }) => {
    await dangNhap(page);
    const dung = await dapAn(page, "/tai-chinh?range=7d");
    // KHÔNG chờ "tab đã tải sẵn": đo trên bản production Next 16.3.6 (29/09, ×5) — request tải sẵn
    // số liệu `/tai-chinh` (`rsc: 1`, không header prefetch, query chỉ `_rsc`) chạy chồng lúc trang
    // còn tải và bị trình duyệt HUỶ (`net::ERR_ABORTED`) ~2/5 lượt, KHÔNG gửi lại ⇒ tiền điều kiện
    // không bảo đảm được bằng chờ (hai cách chờ trước — đọc thân qua DevTools, `finished()` — đều
    // chập chờn vì vậy). Ca này kiểm nhãn = số liệu khi chạm tab bằng URL sạch (có hoặc không có bản
    // tải sẵn); bằng chứng xoá Client Cache khi lưu cookie: đột biến bỏ làm mới (#254 Pha 3) + tài
    // liệu Next 16 (`cookies.set` trong Server Action xoá Client Cache).
    await page.goto("/");
    const thanh = page.getByRole("navigation", { name: "Điều hướng chính" });
    await expect(thanh).toBeVisible();

    await chonPreset(page, "7 ngày");
    await thanh.getByRole("link", { name: "Tài chính" }).click();
    await expect(page).toHaveURL(/\/tai-chinh$/);
    await kiemNhanVaSo(page, "7 ngày", dung);
  });
});
