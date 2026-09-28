import type { OrderStatus } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { ORDER_STATUS_META } from "@/lib/orders/order-status-meta";

const TONE_CLASS: Record<string, string> = {
  neutral: "bg-surface-soft text-ink",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  error: "bg-error/15 text-error",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const meta = ORDER_STATUS_META[status];
  return <Badge className={TONE_CLASS[meta.tone]}>{meta.label}</Badge>;
}
