import { endOfDay } from "date-fns";
import { z } from "zod";

/**
 * Ngày của một dòng GHI TAY (Sổ chi phí, khoản tiền khác) — một schema dùng CHUNG để hai form không
 * lệch nhau (từng lệch: khoản tiền khác vá 03/09 mà Sổ chi phí vẫn hở).
 *
 * Vì sao cần refine "hợp lệ": ô Ngày bị xoá trống ⇒ form gửi Invalid Date ⇒
 * React serialize thành `null` ⇒ `z.coerce.date()` ra 01/01/1970 — dòng ghi vào năm 1970 không hiện ở
 * tháng nào mà toast vẫn xanh, và lúc SỬA thì dời luôn dòng thật về 1970. `getFullYear()` của Invalid
 * Date là NaN nên cũng bị chặn. Mốc 2000 chỉ là chốt sanity (shop không có sổ trước đó).
 *
 * Thứ tự refine: `mapZodError` lấy issue ĐẦU và zod chạy hết mọi refine, nên với schema nhiều refine
 * câu người dùng thấy là refine đầu tiên đỏ theo thứ tự khai. Hiện hai vị từ loại trừ nhau (không có
 * ngày vừa < 2000 vừa ở tương lai) nên đảo thứ tự chưa đổi message nào — đặt "hợp lệ" trước để nếu sau
 * này thêm ràng buộc thì câu báo vẫn là câu cụ thể nhất.
 */
export const ngayGhiTaySchema = z.coerce
  .date()
  .refine((d) => d.getFullYear() >= 2000, "Ngày không hợp lệ")
  .refine((d) => d <= endOfDay(new Date()), "Không cho ngày tương lai");
