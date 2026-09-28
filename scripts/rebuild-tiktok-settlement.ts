/**
 * Dựng Silver "Tiền đã về" TikTok từ Bronze — CHỈ 3 stream settlement
 * (statements/statement_transactions/payments), KHÔNG chạy full rebuild (không
 * đụng Order/Product Silver). Idempotent. Chạy 1 lần sau khi migrate deploy;
 * nightly sau đó tự dựng incremental. In tổng để đối chiếu scout.
 *
 *   DATABASE_URL đọc từ .env (= PROD) → chạy: `npx tsx scripts/rebuild-tiktok-settlement.ts`
 */
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

async function main(): Promise<void> {
  const warnings: string[] = [];
  const st = await transformFromRaw("tiktok/statements", warnings);
  const ad = await transformFromRaw("tiktok/statement_transactions", warnings);
  const pay = await transformFromRaw("tiktok/payments", warnings);

  console.log(
    `Upserted → settlements: ${st.settlementsUpserted} · ads: ${ad.adsUpserted} · payments: ${pay.paymentsUpserted}` +
      ` · skipped: ${st.skipped + ad.skipped + pay.skipped}`
  );
  if (warnings.length) console.log(`warnings (${warnings.length}):`, warnings.slice(0, 5));

  const [net] = await prisma.$queryRaw<{ sum: bigint }[]>`SELECT COALESCE(SUM("settlementAmount"),0)::bigint AS sum FROM "TiktokSettlement"`;
  const [ads] = await prisma.$queryRaw<{ sum: bigint }[]>`SELECT COALESCE(SUM("settlementAmount"),0)::bigint AS sum FROM "TiktokAdsSettlement"`;
  const [bank] = await prisma.$queryRaw<{ sum: bigint }[]>`SELECT COALESCE(SUM("settlementValue"),0)::bigint AS sum FROM "TiktokPayment" WHERE status = 'PAID'`;

  console.log("\n=== Đối chiếu scout (toàn kỳ) ===");
  console.log(`Σ net thực về : ${net.sum}  (scout 1883204162)`);
  console.log(`Σ ads sàn trừ : ${ads.sum}  (scout -198968797)`);
  console.log(`Σ bank PAID   : ${bank.sum}  (scout 2002660000)`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
