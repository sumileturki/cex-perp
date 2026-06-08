import { OrderSide } from "db";
import { orderbooks } from "../globals";
import { inMemoryMarkets, getOrCreateMemoryBalance } from "../memoryState";
import { publishDepth } from "../redis/publishDepth";
import { redis } from "../redis/redis";

export async function handleCancelOrder(data: Record<string, string>) {
  try {
    const { orderId, marketId, side, userId } = data;

    if (!orderId || !marketId || !side || !userId) {
      return;
    }

    const book = orderbooks[marketId];
    if (!book) {
      return;
    }

    const cancelledOrder = book.cancelOrder(orderId, side as OrderSide);
    if (!cancelledOrder) {
      return;
    }

    const market = inMemoryMarkets[marketId];
    if (!market) {
      return;
    }
    const asset = market.quoteAsset;

    const refundMargin = cancelledOrder.margin;
    if (refundMargin > 0) {
      const balance = getOrCreateMemoryBalance(userId, asset);
      balance.available += refundMargin;
      balance.locked -= refundMargin;
    }

    await redis.xAdd("db-write-stream", "*", {
      type: "ORDER_CANCEL",
      orderId,
      userId,
      marketId,
      refundMargin: refundMargin.toString(),
    });

    await publishDepth(marketId);

  } catch (err: any) {
  }
}
