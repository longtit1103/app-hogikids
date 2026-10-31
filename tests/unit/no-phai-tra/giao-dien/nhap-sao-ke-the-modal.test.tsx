// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { XemTruocSaoKe } from "@/lib/actions/sao-ke-the";

const { xemTruocSaoKeThe, chotSaoKeTuPdf, toast } = vi.hoisted(() => ({
  xemTruocSaoKeThe: vi.fn(),
  chotSaoKeTuPdf: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/actions/sao-ke-the", () => ({ xemTruocSaoKeThe, chotSaoKeTuPdf }));

import { NhapSaoKeTheModal } from "@/components/no-phai-tra/nhap-sao-ke-the-modal";

const dong = (ngay: string, ghiNo: number, ghiCo: number, dienGiai: string) => ({
  ngayGiaoDich: ngay,
  ngayGhiSo: ngay,
  ghiNo,
  ghiCo,
  dienGiai,
  laTiktok: false,
  laThanhToan: ghiCo > 0 && dienGiai.includes("Thanh toan"),
});

/** Bản xem trước theo số đo thật sao kê 20/10 (rút gọn danh sách). */
function xemTruoc(o: Partial<XemTruocSaoKe> = {}): XemTruocSaoKe {
  return {
    saoKe: {
      nganHang: "TECHCOMBANK",
      ngaySaoKe: "2026-10-20",
      soCuoiThe: "9999",
      hanMuc: 50_000_000,
      duNoKyTruoc: 9_459_000,
      tongGhiNo: 67_546_000,
      tongGhiCo: 44_530_000,
      duNoCuoiKy: 32_475_000,
      traToiThieu: 1_623_750,
      hanTra: "2026-11-05",
      soDong: 357,
    },
    ketQua: {
      soKhop: 333,
      saoKeKhongCoTrongApp: [],
      billGhiSoTre: [
        { id: "b1", ngay: "2026-10-17", soTien: 196_000 },
        { id: "b2", ngay: "2026-10-20", soTien: 2_168_000 },
      ],
      billKhongThayTrenSaoKe: [],
      dongKhac: { ghiNo: [dong("2026-09-26", 978_000, 0, "DICH VU B")], ghiCo: [dong("2026-10-19", 0, 821_000, "Hoan phi")] },
      thanhToan: [dong("2026-10-01", 0, 9_459_000, "Thanh toan no the")],
      tongBillGhiSoTre: 2_364_000,
      chiTayChuaLenSaoKe: [],
      chiTayKhongThayTrenSaoKe: [],
      chiSaiNgay: [],
      dongChiDaCoTrongApp: [],
      traChuaLenSaoKe: [],
      traKhongThayTrenSaoKe: [],
      traSaiNgay: [],
      thanhToanChuaGhi: [],
      traMoHo: [],
      tongChiTayChuaLenSaoKe: 0,
      tongTraChuaLenSaoKe: 0,
      soKhopHoan: 0,
      saoKeHoanKhongCoTrongApp: [],
      hoanGhiSoTre: [],
      hoanKhongThayTrenSaoKe: [],
      tongHoanGhiSoTre: 0,
      soDeXuat: 34_839_000,
      giaiThich: ["Sao kê 32.475.000 + 15 bill ghi sổ trễ 2.364.000 = 34.839.000"],
    },
    uocTinhApp: 35_757_000,
    hash: "a".repeat(64),
    ngayChotTruoc: "2026-10-14",
    thanhToanChuaGhi: [],
    lyDoKhongChot: null,
    canhBao: [],
    ...o,
  };
}

function mo() {
  render(
    <NhapSaoKeTheModal
      open
      onOpenChange={() => {}}
      the={[
        { id: "t1", ten: "Techcombank 9999" },
        { id: "t2", ten: "VPBank" },
      ]}
      cardIdMacDinh="t1"
    />,
  );
}

const pdf = (ten = "sao-ke.pdf") => new File(["%PDF-1.7 ..."], ten, { type: "application/pdf" });
const chonFile = (f: File) => fireEvent.change(screen.getByLabelText("Chọn file sao kê PDF"), { target: { files: [f] } });

beforeEach(() => {
  xemTruocSaoKeThe.mockReset();
  chotSaoKeTuPdf.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(() => cleanup());

describe("NhapSaoKeTheModal", () => {
  it("chọn file ⇒ gửi thẻ + file, hiện số đề xuất, bill ghi sổ trễ, dòng khác; ô số chốt + hạn trả điền sẵn", async () => {
    xemTruocSaoKeThe.mockResolvedValue({ ok: true, data: xemTruoc() });
    mo();
    chonFile(pdf());
    await screen.findByTestId("sao-ke-pdf-so-de-xuat");

    const fd = xemTruocSaoKeThe.mock.calls[0][0] as FormData;
    expect(fd.get("cardId")).toBe("t1");
    expect((fd.get("file") as File).name).toBe("sao-ke.pdf");
    expect(screen.getByTestId("sao-ke-pdf-so-de-xuat").textContent).toContain("34.839.000");
    expect(screen.getByTestId("sao-ke-pdf-ghi-so-tre").textContent).toContain("2.364.000");
    expect(screen.getByTestId("sao-ke-pdf-dong-khac").textContent).toContain("DICH VU B");
    expect((screen.getByLabelText("Số chốt") as HTMLInputElement).value).toBe("34.839.000");
    expect((screen.getByLabelText("Hạn trả") as HTMLInputElement).value).toBe("2026-11-05");
  });

  it("ô Hạn trả CHỈ ĐỌC, hiện hạn in trên sao kê; chốt gửi đúng hạn đó", async () => {
    xemTruocSaoKeThe.mockResolvedValue({ ok: true, data: xemTruoc() });
    chotSaoKeTuPdf.mockResolvedValue({ ok: true, data: { id: "k1" } });
    mo();
    chonFile(pdf());
    await screen.findByTestId("sao-ke-pdf-so-de-xuat");
    const o = screen.getByLabelText("Hạn trả") as HTMLInputElement;
    expect(o.readOnly).toBe(true);
    fireEvent.change(o, { target: { value: "2026-11-10" } });
    expect(o.value).toBe("2026-11-05");
    expect(screen.getByText("Theo hạn in trên sao kê")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chốt sao kê với số này" }));
    await waitFor(() => expect(chotSaoKeTuPdf).toHaveBeenCalled());
    expect((chotSaoKeTuPdf.mock.calls[0][0] as FormData).get("hanTra")).toBe("2026-11-05");
  });

  it("file không phải .pdf ⇒ báo lỗi (role=alert), không gọi server", async () => {
    mo();
    chonFile(new File(["x"], "sao-ke.xlsx"));
    expect((await screen.findByTestId("sao-ke-pdf-loi")).textContent).toContain("PDF");
    expect(screen.getByRole("alert").textContent).toContain("PDF");
    expect(xemTruocSaoKeThe).not.toHaveBeenCalled();
  });

  it("file > 2,5 MB ⇒ từ chối ngay ở trình duyệt với câu rõ, không gọi server", async () => {
    mo();
    chonFile(new File([new Uint8Array(2.5 * 1024 * 1024 + 1)], "sao-ke.pdf", { type: "application/pdf" }));
    expect((await screen.findByTestId("sao-ke-pdf-loi")).textContent).toContain("tối đa 2,5 MB");
    expect(xemTruocSaoKeThe).not.toHaveBeenCalled();
  });

  it("ô chọn file Tab tới được (không display:none)", () => {
    mo();
    expect(screen.getByLabelText("Chọn file sao kê PDF").className).not.toContain("hidden");
  });

  it("hiện 3 khối: trả chưa lên sao kê, chi thẻ chưa lên sao kê, ghi sai ngày", async () => {
    const dongTra = dong("2026-10-19", 0, 5_000_000, "Thanh toan no the");
    xemTruocSaoKeThe.mockResolvedValue({
      ok: true,
      data: xemTruoc({
        lyDoKhongChot: "Trả thẻ 5.000.000 ₫ ghi ngày 21/10 — ngân hàng ghi ngày 19/10. Sửa ngày Trả thẻ về đúng ngày ngân hàng",
        ketQua: {
          ...xemTruoc().ketQua,
          traChuaLenSaoKe: [{ id: "p20", ngay: "2026-10-20", soTien: 3_000_000 }],
          tongTraChuaLenSaoKe: 3_000_000,
          chiTayChuaLenSaoKe: [{ id: "c19", ngay: "2026-10-19", soTien: 250_000, loai: "CHI_TAY" }],
          tongChiTayChuaLenSaoKe: 250_000,
          traSaiNgay: [{ giaoDich: { id: "p21", ngay: "2026-10-21", soTien: 5_000_000 }, dong: dongTra }],
        },
      }),
    });
    mo();
    chonFile(pdf());
    expect((await screen.findByTestId("sao-ke-pdf-tra-chua-len")).textContent).toContain("3.000.000");
    expect(screen.getByTestId("sao-ke-pdf-chi-tay-tre").textContent).toContain("250.000");
    expect(screen.getByTestId("sao-ke-pdf-sai-ngay").textContent).toContain("app ghi 21/10, ngân hàng 19/10");
    expect(screen.queryByRole("button", { name: "Chốt sao kê với số này" })).toBeNull();
  });

  it("trả chưa lên sao kê ⇒ nói rõ ngân hàng còn đòi sao kê − P; không có thì không hiện dòng này", async () => {
    xemTruocSaoKeThe.mockResolvedValue({
      ok: true,
      data: xemTruoc({
        ketQua: {
          ...xemTruoc().ketQua,
          traChuaLenSaoKe: [{ id: "p20", ngay: "2026-10-20", soTien: 3_000_000 }],
          tongTraChuaLenSaoKe: 3_000_000,
          soDeXuat: 31_839_000,
        },
      }),
    });
    mo();
    chonFile(pdf());
    const dong = await screen.findByTestId("sao-ke-pdf-phai-tra-ky");
    expect(dong.textContent).toContain("Trả chưa lên sao kê: 3.000.000");
    expect(dong.textContent).toContain("29.475.000");
    cleanup();

    xemTruocSaoKeThe.mockResolvedValue({ ok: true, data: xemTruoc() });
    mo();
    chonFile(pdf());
    await screen.findByTestId("sao-ke-pdf-so-de-xuat");
    expect(screen.queryByTestId("sao-ke-pdf-phai-tra-ky")).toBeNull();
  });

  it("hoàn TikTok chưa lên sao kê ⇒ khối riêng 'đã trừ'", async () => {
    xemTruocSaoKeThe.mockResolvedValue({
      ok: true,
      data: xemTruoc({
        ketQua: {
          ...xemTruoc().ketQua,
          hoanGhiSoTre: [{ id: "h1", ngay: "2026-10-20", soTien: 200_000 }],
          tongHoanGhiSoTre: 200_000,
          soDeXuat: 34_639_000,
        },
      }),
    });
    mo();
    chonFile(pdf());
    const khoi = await screen.findByTestId("sao-ke-pdf-hoan-chua-len");
    expect(khoi.textContent).toContain("Hoàn TikTok chưa lên sao kê: 1");
    expect(khoi.textContent).toContain("200.000");
    expect(khoi.textContent).toContain("đã trừ");
  });

  it("server từ chối file ⇒ hiện câu lỗi, vẫn ở bước chọn file", async () => {
    xemTruocSaoKeThe.mockResolvedValue({ ok: false, error: "Không đọc được PDF: PDF không có lớp chữ (ảnh scan)" });
    mo();
    chonFile(pdf());
    expect((await screen.findByTestId("sao-ke-pdf-loi")).textContent).toContain("ảnh scan");
  });

  it("chỉ xem (đã nhập rồi) ⇒ nói lý do, không có nút chốt", async () => {
    xemTruocSaoKeThe.mockResolvedValue({ ok: true, data: xemTruoc({ lyDoKhongChot: "Sao kê này đã nhập ngày 21/10/2026 — chỉ xem" }) });
    mo();
    chonFile(pdf());
    expect((await screen.findByTestId("sao-ke-pdf-chi-xem")).textContent).toContain("đã nhập");
    expect(screen.queryByRole("button", { name: "Chốt sao kê với số này" })).toBeNull();
  });

  it("chốt ⇒ gửi lại file + số chốt (đã sửa) + số đề xuất đã thấy + vân tay; thành công ⇒ toast", async () => {
    xemTruocSaoKeThe.mockResolvedValue({ ok: true, data: xemTruoc() });
    chotSaoKeTuPdf.mockResolvedValue({ ok: true, data: { id: "k1" } });
    mo();
    const f = pdf();
    chonFile(f);
    await screen.findByTestId("sao-ke-pdf-so-de-xuat");
    fireEvent.change(screen.getByLabelText("Số chốt"), { target: { value: "34.935.000" } });
    // Sửa số khác đề xuất mà chưa ghi chú ⇒ báo lỗi ô ghi chú, KHÔNG gửi.
    fireEvent.click(screen.getByRole("button", { name: "Chốt sao kê với số này" }));
    expect(await screen.findByText("Số chốt khác số đề xuất — ghi chú lý do sửa")).toBeTruthy();
    expect(chotSaoKeTuPdf).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Ghi chú (bắt buộc — vì sao sửa số)"), { target: { value: "phí ngân hàng" } });
    fireEvent.click(screen.getByRole("button", { name: "Chốt sao kê với số này" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    const fd = chotSaoKeTuPdf.mock.calls[0][0] as FormData;
    expect(fd.get("cardId")).toBe("t1");
    expect(fd.get("soDu")).toBe("34935000");
    expect(fd.get("soDeXuat")).toBe("34839000");
    expect(fd.get("hash")).toBe("a".repeat(64));
    expect(fd.get("hanTra")).toBe("2026-11-05");
    expect((fd.get("file") as File).name).toBe("sao-ke.pdf");
    expect(fd.get("yeuCauId")).toMatch(/^[0-9a-f-]{36}$/);
    expect(fd.get("note")).toBe("phí ngân hàng");
  });

  it("số đề xuất đã đổi ⇒ báo lỗi, modal giữ nguyên để xem lại", async () => {
    xemTruocSaoKeThe.mockResolvedValue({ ok: true, data: xemTruoc() });
    chotSaoKeTuPdf.mockResolvedValue({ ok: false, error: "Số đề xuất đã đổi thành 35.035.000 ₫ — xem trước lại", code: "SO_DA_DOI" });
    mo();
    chonFile(pdf());
    await screen.findByTestId("sao-ke-pdf-so-de-xuat");
    fireEvent.click(screen.getByRole("button", { name: "Chốt sao kê với số này" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("xem trước lại")));
    expect(screen.getByRole("button", { name: "Xem lại" })).toBeTruthy();
  });

  it("chốt xong mà server báo hạn trả lệch hạn in trên sao kê ⇒ modal ở lại, hiện câu cảnh báo, bấm Đóng mới đóng", async () => {
    const canhBao = "Hạn trả nhập 10/11/2026 khác hạn in trên sao kê 05/11/2026 — đã dùng hạn trên sao kê";
    const onOpenChange = vi.fn();
    xemTruocSaoKeThe.mockResolvedValue({ ok: true, data: xemTruoc() });
    chotSaoKeTuPdf.mockResolvedValue({ ok: true, data: { id: "k1", canhBaoHanTra: canhBao } });
    render(
      <NhapSaoKeTheModal open onOpenChange={onOpenChange} the={[{ id: "t1", ten: "Techcombank 9999" }]} cardIdMacDinh="t1" />,
    );
    chonFile(pdf());
    await screen.findByTestId("sao-ke-pdf-so-de-xuat");
    fireEvent.click(screen.getByRole("button", { name: "Chốt sao kê với số này" }));

    const chu = await screen.findByTestId("sao-ke-pdf-canh-bao-han-tra");
    expect(chu.textContent).toBe(canhBao);
    expect(chu.className).toContain("text-warning");
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("chốt xong không có cảnh báo hạn trả ⇒ đóng ngay như cũ", async () => {
    const onOpenChange = vi.fn();
    xemTruocSaoKeThe.mockResolvedValue({ ok: true, data: xemTruoc() });
    chotSaoKeTuPdf.mockResolvedValue({ ok: true, data: { id: "k1" } });
    render(
      <NhapSaoKeTheModal open onOpenChange={onOpenChange} the={[{ id: "t1", ten: "Techcombank 9999" }]} cardIdMacDinh="t1" />,
    );
    chonFile(pdf());
    await screen.findByTestId("sao-ke-pdf-so-de-xuat");
    fireEvent.click(screen.getByRole("button", { name: "Chốt sao kê với số này" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByTestId("sao-ke-pdf-canh-bao-han-tra")).toBeNull();
  });
});
