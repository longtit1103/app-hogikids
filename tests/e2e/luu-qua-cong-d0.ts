import { expect, type Locator } from "@playwright/test";

/**
 * Bấm "Lưu" trên form Khoản vay / Sổ tiết kiệm / Nhập quỹ và tự bấm tiếp "Xác nhận ghi trước ngày mở
 * sổ" nếu cổng D0 hỏi lại. Dùng cho spec KHÔNG nhằm kiểm cổng đó (tạo khoản vay lùi 3 tháng, gửi sổ
 * lùi 6 tháng…): DB e2e đã có dòng tiền từ spec khác thì D0 tồn tại và cổng sẽ nổ, spec cũ không được
 * đỏ vì thế. Cổng D0 tự nó được kiểm ở `cong-d0-form-khoan-vay-va-so-tiet-kiem.spec.ts`.
 */
export async function luuQuaCongD0(form: Locator): Promise<void> {
  await form.getByRole("button", { name: "Lưu", exact: true }).click();
  const xacNhan = form.getByRole("button", { name: "Xác nhận ghi trước ngày mở sổ", exact: true });
  // Không có cổng ⇒ nút không bao giờ hiện; chờ ngắn rồi đi tiếp thay vì fail.
  const hienCong = await xacNhan.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false);
  if (hienCong) {
    await expect(xacNhan).toBeEnabled();
    await xacNhan.click();
  }
}
