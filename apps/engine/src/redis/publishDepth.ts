import { redis } from "./redis";
import { orderbooks } from "../globals";
import { inMemoryMarkets } from "../memoryState";

export async function publishDepth(marketId: string) {
  try {
    const book = orderbooks[marketId];
    if (!book) return;

    const market = inMemoryMarkets[marketId];
    if (!market) return;

    const symbol = market.symbol.toLowerCase();
    const depth = book.getDepth(20);

    const payload = JSON.stringify({
      e: "depthUpdate",
      E: Date.now(),
      s: market.symbol,
      b: depth.bids,
      a: depth.asks
    });

    console.log(`Publishing depth update for ${market.symbol} to channel depth:${symbol}`);
    await redis.publish(`depth:${symbol}`, payload);
  } catch (err) {
    console.error(`Failed to publish depth for market ${marketId}:`, err);
  }
}
