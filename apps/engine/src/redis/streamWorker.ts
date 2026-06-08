import { redis } from "./redis";
import { handleOnRamp } from "../handlers/onramp";
import { handleCreateOrder } from "../handlers/createOrder";
import { handleCancelOrder } from "../handlers/cancelOrder";
import { prisma, OrderStatus } from "db";
import { orderbooks, lastPrices } from "../globals";
import { Orderbook } from "../Orderbook";
import { loadDatabaseStateToMemory, inMemoryMarkets } from "../memoryState";
import { startBinanceFeed } from "../../../ws/binance";

async function initEngine() {
  let success = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await loadDatabaseStateToMemory();
      success = true;
      break;
    } catch (err: any) {
      if (attempt === 6) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  for (const marketId in inMemoryMarkets) {
    orderbooks[marketId] = new Orderbook(marketId);
  }

  const openOrders = await prisma.order.findMany({
    where: {
      status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const o of openOrders) {
    const book = orderbooks[o.marketId];
    if (!book) continue;

    if (o.type !== "LIMIT") {
      continue;
    }

    const orderPrice = Number(o.price);
    if (isNaN(orderPrice) || orderPrice <= 0) {
      continue;
    }

    book.loadOrder({
      id: o.id,
      userId: o.userId,
      marketId: o.marketId,
      side: o.side,
      type: o.type,
      status: o.status,
      price: orderPrice,
      quantity: Number(o.quantity),
      filledQty: Number(o.filledQty),
      createdAt: o.createdAt,
      margin: Number(o.margin),
    });
  }

  for (const marketId in inMemoryMarkets) {
    const lastFilledOrder = await prisma.order.findFirst({
      where: {
        marketId,
        status: { in: [OrderStatus.FILLED, OrderStatus.PARTIALLY_FILLED] },
      },
      orderBy: { updatedAt: "desc" },
    });
    if (lastFilledOrder && lastFilledOrder.price) {
      lastPrices[marketId] = Number(lastFilledOrder.price);
    }
  }

  startBinanceFeed();
}

export async function startWorker() {
  await initEngine();

  try {
    await redis.xGroupCreate("engine-stream", "engine-group", "0", {
      MKSTREAM: true,
    });
  } catch (err: any) {
    if (!err.message?.includes("BUSYGROUP")) {
      console.error("Error creating Redis stream / consumer group:", err);
    }
  }

  const blockingRedis = redis.duplicate();
  await blockingRedis.connect();

  while (true) {
    const messages = await blockingRedis.xReadGroup(
      "engine-group",
      "engine-1",
      [
        {
          key: "engine-stream",
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
          const type = msg.message.type;

          switch (type) {
            case "RAMP_USER":
              await handleOnRamp(msg.message);
              break;

            case "CREATE_ORDER":
              await handleCreateOrder(msg.message);
              break;

            case "CANCEL_ORDER":
              await handleCancelOrder(msg.message);
              break;
          }

          await redis.xAck(
            "engine-stream",
            "engine-group",
            msg.id
          );
        } catch (err) {
        }
      }
    }
  }
}