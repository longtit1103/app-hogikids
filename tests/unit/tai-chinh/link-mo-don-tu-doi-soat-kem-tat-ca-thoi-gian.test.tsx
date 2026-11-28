import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DoiSoatSanChuaGhiDoanhThu } from "@/components/finance/doi-soat-san-chua-ghi-doanh-thu";

/**
 * Link "#mã đơn" ở khối đối soát của tab Dòng tiền mở drawer trên `/don-hang`. Đơn chờ đối soát thường thuộc
 * tháng trước, nên link phải kèm `ky=tat_ca` (như tab Kênh): không có thì danh sách phía sau drawer là "Tháng
 * này", cụm ‹ › báo "ngoài lọc" và đóng drawer xong người dùng không thấy đơn vừa xem.
 */
describe("link mở đơn từ khối đối soát", () => {
  it("Sàn chưa ghi doanh thu: href kèm ky=tat_ca", () => {
    const html = renderToStaticMarkup(
      <DoiSoatSanChuaGhiDoanhThu
        tongDoanhThuApp={100_000}
        danhSach={[
          {
            id: "don-1",
            code: "1234",
            pancakeId: "579172014854280645",
            status: "COMPLETED",
            doanhThuApp: 100_000,
            sanTra: 0,
            soGiaoDich: 1,
            tuoiNgay: 40,
            conTrongCuaSoCho: false,
          },
        ]}
      />,
    );
    expect(html).toContain('href="/don-hang?ky=tat_ca&amp;don=don-1"');
  });
});
