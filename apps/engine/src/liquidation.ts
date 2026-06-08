import { redis } from "./redis/redis";
import { orderbooks, lastPrices } from "./globals";
import { calculateReleasedMargin } from "./settlement";
import { OrderSide, OrderType, OrderStatus } from "db";
import { Orderbook } from "./Orderbook";
import { publishDepth } from "./redis/publishDepth";
import {
  inMemoryBalances,
  inMemoryPositions,
  inMemoryMarkets,
  getOrCreateMemoryBalance,
  getMemoryPosition,
  updateUserPositionAndBalanceInMemory,
} from "./memoryState";

export const MAINTENANCE_MARGIN_RATE = 0.05; // 5% maintenance margin
export const LEVERAGE = 10;

export async function checkAndLiquidateUser(userId: string): Promise<boolean> {
  try {
    const userPositions = inMemoryPositions[userId];
    if (!userPositions || Object.keys(userPositions).length === 0) {
      return false;
    }

    const balance = getOrCreateMemoryBalance(userId, "USDT");
    const available = balance.available;
    const locked = balance.locked;

    let totalUnrealizedPnL = 0;
    let totalMM = 0;

    for (const marketId in userPositions) {
      const pos = userPositions[marketId];
      if (!pos || pos.size === 0) continue;

      const size = pos.size;
      const entryPrice = pos.entryPrice;
      const lastPrice = lastPrices[marketId] || entryPrice;
      const isLong = pos.side === "LONG";

      const unrealizedPnL = isLong
        ? (lastPrice - entryPrice) * size
        : (entryPrice - lastPrice) * size;

      totalUnrealizedPnL += unrealizedPnL;
      totalMM += size * lastPrice * MAINTENANCE_MARGIN_RATE;
    }

    const equity = available + locked + totalUnrealizedPnL;

    if (equity >= totalMM) {
      return false;
    }

    for (const marketId in orderbooks) {
      const book = orderbooks[marketId];
      if (!book) continue;
      const market = inMemoryMarkets[marketId];
      if (!market) continue;
      const asset = market.quoteAsset;

      const userBids = book.bids.filter((o) => o.userId === userId);
      const userAsks = book.asks.filter((o) => o.userId === userId);

      for (const order of [...userBids, ...userAsks]) {
        book.cancelOrder(order.id, order.side);

        const refundMargin = order.margin;

        const bal = getOrCreateMemoryBalance(userId, asset);
        bal.available += refundMargin;
        bal.locked -= refundMargin;

        await redis.xAdd("db-write-stream", "*", {
          type: "ORDER_CANCEL",
          orderId: order.id,
          userId,
          marketId,
          refundMargin: refundMargin.toString(),
        });
      }
      await publishDepth(marketId);
    }
    const activeMarketIds = Object.keys(userPositions);

    for (const marketId of activeMarketIds) {
      const pos = userPositions[marketId];
      if (!pos || pos.size === 0) continue;

      const size = pos.size;
      const entryPrice = pos.entryPrice;
      const lastPrice = lastPrices[marketId] || entryPrice;
      const isLong = pos.side === "LONG";

      const market = inMemoryMarkets[marketId];
      if (!market) continue;
      const asset = market.quoteAsset;

      const liqSide = isLong ? OrderSide.SELL : OrderSide.BUY;
      const orderId = crypto.randomUUID();

      await redis.xAdd("db-write-stream", "*", {
        type: "ORDER_CREATE",
        orderId,
        userId,
        marketId,
        side: liqSide,
        orderType: OrderType.MARKET,
        price: "",
        quantity: size.toString(),
        marginRequired: "0",
      });

      let book = orderbooks[marketId];
      if (!book) {
        book = new Orderbook(marketId);
        orderbooks[marketId] = book;
      }

      const bookOrder = {
        id: orderId,
        userId,
        marketId,
        side: liqSide,
        type: OrderType.MARKET,
        status: OrderStatus.OPEN,
        price: 0,
        quantity: size,
        filledQty: 0,
        createdAt: new Date(),
        margin: 0,
      };

      const { trades, remainingQty } = book!.addOrder(bookOrder);

      let takerPreviouslyFilled = 0;
      for (const t of trades) {
        const makerReleasedMargin = calculateReleasedMargin(
          t.makerOrder.quantity,
          t.makerOrder.margin,
          t.makerOrder.price,
          t.makerOrder.filledQty - t.quantity,
          t.quantity,
          LEVERAGE
        );

        updateUserPositionAndBalanceInMemory(
          t.makerOrder.userId,
          marketId,
          t.makerOrder.side === OrderSide.BUY ? "BUY" : "SELL",
          t.price,
          t.quantity,
          LEVERAGE,
          makerReleasedMargin,
          asset
        );

        const makerFilledRatio = t.makerOrder.filledQty / t.makerOrder.quantity;
        const makerRemainingMargin = t.makerOrder.margin * (1 - makerFilledRatio);
        t.makerOrder.margin = makerRemainingMargin;

        updateUserPositionAndBalanceInMemory(
          userId,
          marketId,
          liqSide === OrderSide.BUY ? "BUY" : "SELL",
          t.price,
          t.quantity,
          LEVERAGE,
          0,
          asset
        );

        lastPrices[marketId] = t.price;

        const isTakerBuyer = liqSide === OrderSide.BUY;
        const buyerId = isTakerBuyer ? userId : t.makerOrder.userId;
        const sellerId = isTakerBuyer ? t.makerOrder.userId : userId;
        const buyOrderId = isTakerBuyer ? orderId : t.makerOrder.id;
        const sellOrderId = isTakerBuyer ? t.makerOrder.id : orderId;

        await redis.xAdd("db-write-stream", "*", {
          type: "TRADE_SETTLE",
          marketId,
          tradePrice: t.price.toString(),
          tradeQty: t.quantity.toString(),
          buyerId,
          sellerId,
          buyOrderId,
          sellOrderId,

          makerOrderId: t.makerOrder.id,
          makerUserId: t.makerOrder.userId,
          makerSide: t.makerOrder.side,
          makerFilledQty: t.makerOrder.filledQty.toString(),
          makerStatus: t.makerOrder.status,
          makerRemainingMargin: makerRemainingMargin.toString(),
          makerReleasedMargin: makerReleasedMargin.toString(),

          takerOrderId: orderId,
          takerUserId: userId,
          takerSide: liqSide,
          takerFilledQty: bookOrder.filledQty.toString(),
          takerStatus: bookOrder.status,
          takerRemainingMargin: "0",
          takerReleasedMargin: "0",
        });

        takerPreviouslyFilled += t.quantity;
      }

      if (remainingQty > 0) {
        const forcePnL = isLong
          ? (lastPrice - entryPrice) * remainingQty
          : (entryPrice - lastPrice) * remainingQty;

        const forceMargin = (remainingQty * entryPrice) / LEVERAGE;

        const bal = getOrCreateMemoryBalance(userId, asset);
        bal.available += forceMargin + forcePnL;
        bal.locked -= forceMargin;

        if (inMemoryPositions[userId]) {
          delete inMemoryPositions[userId][marketId];
        }

        await redis.xAdd("db-write-stream", "*", {
          type: "LIQUIDATE_FORCE_CLOSE",
          orderId,
          userId,
          marketId,
          size: size.toString(),
          lastPrice: lastPrice.toString(),
          forceMargin: forceMargin.toString(),
          forcePnL: forcePnL.toString(),
        });
      }
      await publishDepth(marketId);
    }

    const finalBal = getOrCreateMemoryBalance(userId, "USDT");
    if (finalBal.available < 0) {
      finalBal.available = 0;
      await redis.xAdd("db-write-stream", "*", {
        type: "LIQUIDATE_CAP_BALANCE",
        userId,
        asset: "USDT",
      });
    }

    return true;

  } catch (err: any) {
    return false;
  }
}

export async function checkMarketLiquidations(marketId: string) {
  const userIds: string[] = [];
  for (const userId in inMemoryPositions) {
    if (inMemoryPositions[userId]?.[marketId]) {
      userIds.push(userId);
    }
  }

  for (const userId of userIds) {
    try {
      await checkAndLiquidateUser(userId);
    } catch (err) {
    }
  }
}
