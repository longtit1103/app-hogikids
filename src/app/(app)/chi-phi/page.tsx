import { redirect } from "next/navigation";

/**
 * `/chi-phi` cũ đã gộp vào hub Tài chính (`/tai-chinh`). Giữ file làm lưới an
 * toàn cho bookmark cũ → redirect thẳng sang tab "Sổ chi phí". Query filter cũ
 * (danh_muc/kenh/nguon/q/sap_xep/trang) KHÔNG mang theo — chấp nhận (link nội
 * bộ đã trỏ thẳng `/tai-chinh?tab=so-chi-phi&...`). Auth do `(app)/layout.tsx`.
 */
export default function ChiPhiRedirect() {
  redirect("/tai-chinh?tab=so-chi-phi");
}
