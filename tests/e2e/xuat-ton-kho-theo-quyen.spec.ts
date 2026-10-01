import { expect, test } from "./fixture-cho-trang-stream-xong";

import { dangNhapVoi } from "./dang-nhap-voi-tai-khoan";
import { CHUOI_DO_GIA_VON, seedDoGiaVon } from "./fixture-gia-von-do";
import { testPrisma } from "./ingest-raw";
import { dangNhap } from "./mobile-helpers";
import { taoTaiKhoanStaff } from "./tao-tai-khoan-staff";
import { VAI_TRO_MAU } from "../../src/lib/quyen/vai-tro-mau";

/**
 * `/api/export/ton-kho` theo quyền (spec §4.3): cần `ton-kho:xem` ∧ `xuat-du-lieu`; thiếu giá vốn ⇒ file
 * KHÔNG có cột giá vốn và không số nào suy từ nó. Mẫu Kho chưa có `xuat-du-lieu` ⇒ 403; chủ shop bật quyền
 * ở /quan-tri (qua giao diện thật, không gọi action) ⇒ 200 nhưng vẫn không giá vốn.
 */

const EMAIL_KHO = "kho-xuat@hogikids.test";
const MAT_KHAU = "Kho-Password-123!";
const DONG_DAU_KHONG_GIA_VON = "sku,ten_san_pham,bien_the,ton,nguong";
const CHUOI_DINH_DANG = "7.331.117";

test.beforeAll(async () => {
  const prisma = testPrisma();
  try {
    await seedDoGiaVon(prisma);
    await taoTaiKhoanStaff(prisma, { email: EMAIL_KHO, matKhau: MAT_KHAU, quyen: [...VAI_TRO_MAU.kho.quyen] });
  } finally {
    await prisma.$disconnect();
  }
});

test.afterAll(async () => {
  const prisma = testPrisma();
  try {
    await prisma.user.deleteMany({ where: { email: EMAIL_KHO } });
  } finally {
    await prisma.$disconnect();
  }
});

test("Kho: 403 khi chưa có xuất dữ liệu; chủ shop bật quyền ⇒ 200, CSV không cột giá vốn; chủ shop có giá vốn", async ({
  page,
  browser,
  baseURL,
}) => {
  // Hai phiên độc lập: chủ shop ở `page`, nhân sự kho ở context riêng (cookie không lẫn).
  const ctxKho = await browser.newContext({ baseURL });
  try {
    const trangKho = await ctxKho.newPage();
    await dangNhapVoi(trangKho, EMAIL_KHO, MAT_KHAU);

    const tuChoi = await trangKho.request.get("/api/export/ton-kho");
    expect(tuChoi.status(), "mẫu Kho chưa có xuất dữ liệu").toBe(403);
    expect(await tuChoi.text()).not.toContain(CHUOI_DO_GIA_VON);

    // Chủ shop thêm quyền "Xuất dữ liệu ra file" bằng giao diện /quan-tri.
    await dangNhap(page);
    await page.goto("/quan-tri");
    await page.getByRole("button", { name: `Thao tác với ${EMAIL_KHO}` }).click();
    await page.getByRole("menuitem", { name: "Sửa quyền" }).click();
    const hopThoai = page.getByRole("dialog");
    const oXuat = hopThoai.getByRole("checkbox", { name: "Xuất dữ liệu ra file" });
    await expect(oXuat).not.toBeChecked();
    await oXuat.click();
    await hopThoai.getByRole("button", { name: "Lưu quyền" }).click();
    await expect(page.getByText("Đã lưu quyền.")).toBeVisible();

    // Nhân sự kho (cùng phiên, không đăng nhập lại): đọc quyền mới ⇒ 200, không cột/số giá vốn.
    const duoc = await trangKho.request.get("/api/export/ton-kho");
    expect(duoc.status(), "có xuất dữ liệu nhưng không giá vốn").toBe(200);
    const csvKho = (await duoc.text()).replace(/^﻿/, "");
    expect(csvKho.split("\n")[0]).toBe(DONG_DAU_KHONG_GIA_VON);
    expect(csvKho).toContain("SKU-DO-GIA-VON"); // có dòng dữ liệu thật, không phải file rỗng
    expect(csvKho).not.toContain(CHUOI_DO_GIA_VON);
    expect(csvKho).not.toContain(CHUOI_DINH_DANG);
  } finally {
    await ctxKho.close();
  }

  // Đối chứng: chủ shop có giá vốn ⇒ header thêm 2 cột và thân chứa số dò.
  const chu = await page.request.get("/api/export/ton-kho");
  expect(chu.status()).toBe(200);
  const csvChu = (await chu.text()).replace(/^﻿/, "");
  expect(csvChu.split("\n")[0]).toBe(`${DONG_DAU_KHONG_GIA_VON},gia_von,gia_tri_von`);
  expect(csvChu).toContain(CHUOI_DO_GIA_VON);
});
