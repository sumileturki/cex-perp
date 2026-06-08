import { redis } from "./redis";
import { prisma } from "db";
import { updateUserPositionAndBalance } from "../settlement";
import { OrderSide, OrderType, OrderStatus } from "db";

const LEVERAGE = 10;

export async function startDBWriter() {
  try {
    await redis.xGroupCreate("db-write-stream", "db-write-group", "0", {
      MKSTREAM: true,
    });
  } catch (err: any) {
    if (!err.message?.includes("BUSYGROUP")) {
      console.error("Error creating Redis stream / consumer group for db-write-stream:", err);
    }
  }

  const blockingRedis = redis.duplicate();
  await blockingRedis.connect();

  while (true) {
    try {
      const messages = await blockingRedis.xReadGroup(
        "db-write-group",
        "db-writer-1",
        [
          {
            key: "db-write-stream",
            id: ">",
          },
        ],
        {
          BLOCK: 0,
        }
      );

      if (!messages) continue;

      for (const stream of messages) {
        for (const msg of stream.messages) {
          try {
            const data = msg.message;
            const type = data.type;

            console.log(`[DB_WRITER] Processing Event: ${type}`);

            switch (type) {
              case "BALANCE_ONRAMP": {
                const { userId, asset, amount } = data;
                await prisma.balance.upsert({
                  where: {
                    userId_asset: { userId, asset },
                  },
                  update: {
                    available: { increment: Number(amount) },
                  },
                  create: {
                    userId,
                    asset,
                    available: Number(amount),
                    locked: 0,
                  },
                });
                break;
              }

              case "ORDER_CREATE": {
                const { orderId, userId, marketId, side, orderType, price, quantity, marginRequired } = data;
                const margin = Number(marginRequired);
                const orderPrice = price ? Number(price) : null;
                const qty = Number(quantity);

                await prisma.$transaction(async (tx) => {
                  const market = await tx.market.findUnique({ where: { id: marketId } });
                  if (!market) throw new Error(`Market ${marketId} not found`);
                  const asset = market.quoteAsset;

                  if (margin > 0) {
                    await tx.balance.update({
                      where: { userId_asset: { userId, asset } },
                      data: {
                        available: { decrement: margin },
                        locked: { increment: margin },
                      },
                    });
                  }

                  await tx.order.create({
                    data: {
                      id: orderId,
                      userId,
                      marketId,
                      side: side as OrderSide,
                      type: orderType as OrderType,
                      status: OrderStatus.OPEN,
                      price: orderPrice,
                      quantity: qty,
                      filledQty: 0,
                      margin: margin,
                    },
                  });
                }, { maxWait: 15000, timeout: 20000 });
                break;
              }

              case "TRADE_SETTLE": {
                const {
                  marketId,
                  tradePrice,
                  tradeQty,
                  buyerId,
                  sellerId,
                  buyOrderId,
                  sellOrderId,
                  makerOrderId,
                  makerUserId,
                  makerSide,
                  makerFilledQty,
                  makerStatus,
                  makerRemainingMargin,
                  makerReleasedMargin,
                  takerOrderId,
                  takerUserId,
                  takerSide,
                  takerFilledQty,
                  takerStatus,
                  takerRemainingMargin,
                  takerReleasedMargin,
                } = data;

                await prisma.$transaction(async (tx) => {
                  const market = await tx.market.findUnique({ where: { id: marketId } });
                  if (!market) throw new Error(`Market ${marketId} not found`);
                  const asset = market.quoteAsset;

                  await tx.order.update({
                    where: { id: makerOrderId },
                    data: {
                      filledQty: Number(makerFilledQty),
                      status: makerStatus as OrderStatus,
                      margin: Number(makerRemainingMargin),
                    },
                  });

                  await updateUserPositionAndBalance(
                    tx,
                    makerUserId,
                    marketId,
                    makerSide as "BUY" | "SELL",
                    Number(tradePrice),
                    Number(tradeQty),
                    LEVERAGE,
                    Number(makerReleasedMargin)
                  );

                  await updateUserPositionAndBalance(
                    tx,
                    takerUserId,
                    marketId,
                    takerSide as "BUY" | "SELL",
                    Number(tradePrice),
                    Number(tradeQty),
                    LEVERAGE,
                    Number(takerReleasedMargin)
                  );

                  await tx.trade.create({
                    data: {
                      marketId,
                      price: Number(tradePrice),
                      quantity: Number(tradeQty),
                      buyerId,
                      sellerId,
                      buyOrderId,
                      sellOrderId,
                    },
                  });

                  await tx.order.update({
                    where: { id: takerOrderId },
                    data: {
                      filledQty: Number(takerFilledQty),
                      status: takerStatus as OrderStatus,
                      margin: Number(takerRemainingMargin),
                    },
                  });
                }, { maxWait: 15000, timeout: 35000 });
                break;
              }

              case "ORDER_CANCEL": {
                const { orderId, userId, marketId, refundMargin } = data;
                const refund = Number(refundMargin);

                await prisma.$transaction(async (tx) => {
                  const market = await tx.market.findUnique({ where: { id: marketId } });
                  if (!market) throw new Error(`Market ${marketId} not found`);
                  const asset = market.quoteAsset;

                  await tx.order.update({
                    where: { id: orderId },
                    data: { status: OrderStatus.CANCELLED },
                  });

                  if (refund > 0) {
                    await tx.balance.update({
                      where: { userId_asset: { userId, asset } },
                      data: {
                        available: { increment: refund },
                        locked: { decrement: refund },
                      },
                    });
                  }
                }, { maxWait: 15000, timeout: 20000 });
                break;
              }

              case "LIQUIDATE_FORCE_CLOSE": {
                const { orderId, userId, marketId, size, lastPrice, forceMargin, forcePnL } = data;

                await prisma.$transaction(async (tx) => {
                  const market = await tx.market.findUnique({ where: { id: marketId } });
                  if (!market) throw new Error(`Market ${marketId} not found`);
                  const asset = market.quoteAsset;

                  await tx.balance.update({
                    where: { userId_asset: { userId, asset } },
                    data: {
                      available: { increment: Number(forceMargin) + Number(forcePnL) },
                      locked: { decrement: Number(forceMargin) },
                    },
                  });

                  await tx.position.delete({
                    where: { userId_marketId: { userId, marketId } },
                  });

                  await tx.order.update({
                    where: { id: orderId },
                    data: {
                      filledQty: Number(size),
                      status: OrderStatus.FILLED,
                    },
                  });
                }, { maxWait: 15000, timeout: 25000 });
                break;
              }

              case "LIQUIDATE_CAP_BALANCE": {
                const { userId, asset } = data;
                await prisma.balance.update({
                  where: { userId_asset: { userId, asset } },
                  data: { available: 0 },
                });
                break;
              }
            }

            await redis.xAck("db-write-stream", "db-write-group", msg.id);
          } catch (msgErr) {
          }
        }
      }
    } catch (err) {
      console.error("[DB_WRITER] Error reading from db-write-stream group:", err);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
