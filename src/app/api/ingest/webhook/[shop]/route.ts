import { prisma } from "@/lib/prisma";
import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { catNote, xuLySuKienWebhook, type KetQuaXuLy } from "@/lib/ingest/webhook-processor";
import { LOI_CHUA_CAU_HINH_SHOP } from "@/lib/ket-noi/cau-hinh-shop";
import {
  laShopSlug,
  luuSuKienWebhook,
  MAX_WEBHOOK_PAYLOAD,
  SHOP_SLUGS,
  shopIdTheoSlug,
} from "@/lib/ingest/webhook-inbox";

/**
 * POST /api/ingest/webhook/:shop — hộp thư THÔ + bộ xử lý pha 2 cho webhook Pancake POS.
 * `:shop` = `kho` | `shopee` | `tiktok` (whitelist trong webhook-inbox.ts).
 *
 * Body là **bytes nguyên xi Pancake gửi**, KHÔNG bọc JSON: đọc bằng `req.text()` nên không
 * có bước parse nào chạm vào payload ⇒ id int64 (`585140898791786238`) giữ đúng từng chữ số.
 * Đây là lý do tồn tại của endpoint riêng thay vì dùng `/api/ingest/raw` (endpoint đó bọc
 * payload trong một JSON envelope 3 field).
 *
 * Thứ tự BẤT DI BẤT DỊCH: ① hộp thư ghi TRƯỚC (mất raw là mất vĩnh viễn) → ② xử lý pha 2
 * (đơn hàng land Bronze + Silver, tồn KHO cập nhật Variant.stock, còn lại bỏ qua CÓ KẾT CỤC)
 * → ③ ghi kết cục (`processedAs`/`processedNote`) lên đúng dòng vừa tạo. Xử lý lỗi KHÔNG làm
 * mất sự kiện và KHÔNG đổi mã trả về — luôn 200 sau khi hộp thư đã ghi (nightly API vét bù;
 * panel /cai-dat là nơi báo sự kiện lạ/lỗi). KHÔNG ghi SyncLog per-event (panel đọc thẳng hộp thư).
 * n8n vẫn giữ nhánh ghi file mẫu song song — app chết thì file vẫn hứng, nạp bù sau được.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ shop: string }> }
): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  // Đang phục hồi DB ⇒ hộp thư cũng KHÔNG ghi được (schema đang bị thay). Trả 503 để Pancake/n8n
  // biết là tạm bận. Không mất dữ liệu vĩnh viễn: lượt API nightly vét lại đơn trong cửa sổ.
  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  const { shop } = await params;
  // Whitelist slug TĨNH — slug lạ là request hỏng/bịa, chặn 400 không đụng DB.
  if (!laShopSlug(shop)) {
    return Response.json(
      { ok: false, error: `shop không hợp lệ: ${shop} (hợp lệ: ${SHOP_SLUGS.join(", ")})` },
      { status: 400 }
    );
  }
  // Slug đúng nhưng CHƯA CẤU HÌNH shop id (bản clone chưa setup / Setting bị lùi sau phục hồi):
  // trả 503 tạm-bận như nhánh đang-phục-hồi ở trên — Pancake/n8n gửi lại được, nhánh ghi file của
  // n8n vẫn giữ payload, nightly vét bù. KHÔNG được 500 sau khi đã đọc body rồi đánh rơi sự kiện.
  let shopId: string;
  try {
    shopId = await shopIdTheoSlug(shop);
  } catch (err) {
    // Nhánh này bắt CẢ lỗi Prisma (DB chập) — chỉ thông điệp "Chưa cấu hình" (mở đầu bằng đúng
    // hằng LOI_CHUA_CAU_HINH_SHOP) là dành cho người dùng; còn lại trả chuỗi cố định (không lộ
    // chi tiết hạ tầng ra response) + log phía server.
    const msg = err instanceof Error ? err.message : "";
    const laChuaCauHinh = msg.startsWith(LOI_CHUA_CAU_HINH_SHOP);
    if (!laChuaCauHinh) console.error("webhook: không resolve được shop id:", err);
    return Response.json(
      { ok: false, error: laChuaCauHinh ? msg : "Tạm chưa nhận được — thử lại sau" },
      { status: 503 }
    );
  }

  const payload = await req.text();
  if (!payload) {
    return Response.json({ ok: false, error: "body rỗng" }, { status: 400 });
  }
  if (payload.length > MAX_WEBHOOK_PAYLOAD) {
    return Response.json(
      { ok: false, error: `payload ${payload.length} ký tự vượt trần ${MAX_WEBHOOK_PAYLOAD}` },
      { status: 413 }
    );
  }

  const luu = await luuSuKienWebhook({ shopId, payload });

  // Trùng khoá hộp thư (cùng shop + cùng mili-giây + cùng hash) — thực tế chỉ xảy ra khi nạp bù
  // chạy lại. Không có dòng mới để ghi kết cục ⇒ không xử lý (bản y hệt đã được xử lý lần đầu).
  if (!luu.daGhi || !luu.id) {
    return Response.json({ ok: true, shopId, bytes: payload.length, luu: false });
  }

  // `xuLySuKienWebhook` tự nuốt mọi lỗi thành kết cục `loi` nên không ném ra đây.
  const ketCuc: KetQuaXuLy = await xuLySuKienWebhook({ shopId, payload });

  // Ghi kết cục là bước RIÊNG và best-effort: nếu chỉ mỗi lệnh update này hỏng (DB chập chờn) thì
  // việc xử lý bên trên VẪN đúng — đơn đã vào Silver. Đánh dấu dòng đó `loi` sẽ tạo báo động giả,
  // bắt người đọc đi tìm lỗi không tồn tại. Update hỏng ⇒ dòng ở lại `processedAs = NULL`, và panel
  // đếm NULL vào nhóm "cần xem" nên vẫn lộ ra, không im lặng.
  await prisma.rawPancakeWebhookEvent
    .update({
      where: { id: luu.id },
      data: { processedAs: ketCuc.processedAs, processedNote: catNote(ketCuc.note) ?? null },
    })
    .catch(() => {});

  return Response.json({
    ok: true,
    shopId,
    bytes: payload.length,
    luu: true,
    processedAs: ketCuc.processedAs,
    ...(ketCuc.note ? { note: catNote(ketCuc.note) } : {}),
  });
}
