import { redis } from "../redis/redis";
import { getOrCreateMemoryBalance } from "../memoryState";

export async function handleOnRamp(data: Record<string, string>) {
  const userId = data.userId;
  const asset = data.asset;
  const amountStr = data.amount;

  if (!userId || !asset || !amountStr) {
    return;
  }

  const amount = Number(amountStr);
  if (isNaN(amount)) {
    return;
  }

  const balance = getOrCreateMemoryBalance(userId, asset);
  balance.available += amount;

  await redis.xAdd("db-write-stream", "*", {
    type: "BALANCE_ONRAMP",
    userId,
    asset,
    amount: amount.toString(),
  });
}