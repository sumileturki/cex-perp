import { OrderSide, OrderType, OrderStatus } from "db";
import { orderbooks, lastPrices } from "../globals";
import { Orderbook } from "../Orderbook";
import { calculateReleasedMargin } from "../settlement";
import {
  inMemoryBalances,
  inMemoryPositions,
  inMemoryMarkets,
  getOrCreateMemoryBalance,
  getMemoryPosition,
  updateUserPositionAndBalanceInMemory,
} from "../memoryState";
import { checkMarketLiquidations } from "../liquidation";
import { redis } from "../redis/redis";
import { publishDepth } from "../redis/publishDepth";

const LEVERAGE = 10;

export async function handleCreateOrder(data: Record<string, string>) {
  try {
    const userId = data.userId;
    const marketId = data.marketId;
    const side = data.side as OrderSide;
    const orderType = data.orderType as OrderType;
    const price = Number(data.price || 0);
    const quantity = Number(data.quantity);

    if (!userId || !marketId || !side || !orderType || isNaN(quantity) || quantity <= 0) {
      return;
    }

    if (orderType === OrderType.LIMIT && (isNaN(price) || price <= 0)) {
      return;
    }

    const market = inMemoryMarkets[marketId];
    if (!market) {
      return;
    }
    const asset = market.quoteAsset;

    const balance = getOrCreateMemoryBalance(userId, asset);
    const position = getMemoryPosition(userId, marketId);
    const posSize = position ? position.size : 0;
    const posSide = position ? position.side : null;

    const isReducing =
      posSize > 0 &&
      ((posSide === "LONG" && side === OrderSide.SELL) ||
        (posSide === "SHORT" && side === OrderSide.BUY));

    let marginRequired = 0;

    if (orderType === OrderType.LIMIT) {
      if (isReducing) {
        const remainingQty = quantity - posSize;
        if (remainingQty > 0) {
          marginRequired = (remainingQty * price) / LEVERAGE;
        } else {
          marginRequired = 0;
        }
      } else {
        marginRequired = (quantity * price) / LEVERAGE;
      }

      if (balance.available < marginRequired) {
        return;
      }

      balance.available -= marginRequired;
      balance.locked += marginRequired;
    } else {
      const estPrice = lastPrices[marketId] || 0;
      let finalEstPrice = estPrice;
      if (finalEstPrice === 0) {
        const book = orderbooks[marketId];
        const oppositeBook = side === OrderSide.BUY ? book?.asks : book?.bids;
        finalEstPrice = oppositeBook && oppositeBook.length > 0 && oppositeBook[0] ? oppositeBook[0].price : 0;
      }

      if (finalEstPrice === 0) {
        return;
      }

      const checkQty = isReducing ? Math.max(0, quantity - posSize) : quantity;
      const requiredEstMargin = (checkQty * finalEstPrice) / LEVERAGE;

      if (balance.available < requiredEstMargin) {
        return;
      }
      marginRequired = 0;
    }

    const orderId = crypto.randomUUID();

    await redis.xAdd("db-write-stream", "*", {
      type: "ORDER_CREATE",
      orderId,
      userId,
      marketId,
      side,
      orderType,
      price: orderType === OrderType.LIMIT ? price.toString() : "",
      quantity: quantity.toString(),
      marginRequired: marginRequired.toString(),
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
      side,
      type: orderType,
      status: OrderStatus.OPEN as OrderStatus,
      price: orderType === OrderType.LIMIT ? price : 0,
      quantity,
      filledQty: 0,
      createdAt: new Date(),
      margin: marginRequired,
    };

    const { trades, remainingQty } = book.addOrder(bookOrder);

    if (trades.length > 0) {
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

        let takerReleasedMargin = 0;
        if (orderType === OrderType.LIMIT) {
          takerReleasedMargin = calculateReleasedMargin(
            quantity,
            marginRequired,
            price,
            takerPreviouslyFilled,
            t.quantity,
            LEVERAGE
          );
        }

        updateUserPositionAndBalanceInMemory(
          userId,
          marketId,
          side === OrderSide.BUY ? "BUY" : "SELL",
          t.price,
          t.quantity,
          LEVERAGE,
          takerReleasedMargin,
          asset
        );

        lastPrices[marketId] = t.price;

        const isTakerBuyer = side === OrderSide.BUY;
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
          takerSide: side,
          takerFilledQty: bookOrder.filledQty.toString(),
          takerStatus: bookOrder.status,
          takerRemainingMargin: (orderType === OrderType.LIMIT ? (marginRequired * (1 - (bookOrder.filledQty / quantity))).toString() : "0"),
          takerReleasedMargin: takerReleasedMargin.toString(),
        });

        takerPreviouslyFilled += t.quantity;
      }

      await checkMarketLiquidations(marketId);
    } else {
      if (orderType === OrderType.MARKET) {
        bookOrder.status = OrderStatus.CANCELLED;
        await redis.xAdd("db-write-stream", "*", {
          type: "ORDER_CANCEL",
          orderId,
          userId,
          marketId,
          refundMargin: "0",
        });
      }
    }

    await publishDepth(marketId);

  } catch (err: any) {
  }
}