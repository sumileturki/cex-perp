import { prisma } from "db";

export interface MemoryBalance {
  available: number;
  locked: number;
}

export interface MemoryPosition {
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  margin: number;
  leverage: number;
}

export const inMemoryBalances: Record<string, Record<string, MemoryBalance>> = {};

export const inMemoryPositions: Record<string, Record<string, MemoryPosition>> = {};

export interface MemoryMarket {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}
export const inMemoryMarkets: Record<string, MemoryMarket> = {};

export async function loadDatabaseStateToMemory() {
  const dbMarkets = await prisma.market.findMany({ where: { isActive: true } });
  for (const m of dbMarkets) {
    inMemoryMarkets[m.id] = {
      symbol: m.symbol,
      baseAsset: m.baseAsset,
      quoteAsset: m.quoteAsset,
    };
  }

  const dbBalances = await prisma.balance.findMany();
  for (const bal of dbBalances) {
    if (!inMemoryBalances[bal.userId]) {
      inMemoryBalances[bal.userId] = {};
    }
    const userBals = inMemoryBalances[bal.userId]!;
    userBals[bal.asset] = {
      available: Number(bal.available),
      locked: Number(bal.locked),
    };
  }

  const dbPositions = await prisma.position.findMany();
  for (const pos of dbPositions) {
    if (!inMemoryPositions[pos.userId]) {
      inMemoryPositions[pos.userId] = {};
    }
    const userPos = inMemoryPositions[pos.userId]!;
    userPos[pos.marketId] = {
      side: pos.side === "LONG" ? "LONG" : "SHORT",
      size: Number(pos.size),
      entryPrice: Number(pos.entryPrice),
      margin: Number(pos.margin),
      leverage: Number(pos.leverage),
    };
  }
}

export function getOrCreateMemoryBalance(userId: string, asset: string): MemoryBalance {
  if (!inMemoryBalances[userId]) {
    inMemoryBalances[userId] = {};
  }
  const userBals = inMemoryBalances[userId]!;
  if (!userBals[asset]) {
    userBals[asset] = { available: 0, locked: 0 };
  }
  return userBals[asset]!;
}

export function getMemoryPosition(userId: string, marketId: string): MemoryPosition | null {
  const userPos = inMemoryPositions[userId];
  if (!userPos) {
    return null;
  }
  return userPos[marketId] || null;
}

export function updateUserPositionAndBalanceInMemory(
  userId: string,
  marketId: string,
  side: "BUY" | "SELL",
  fillPrice: number,
  fillQty: number,
  leverage: number = 10,
  releasedOrderMargin: number = 0,
  asset: string
) {
  if (!inMemoryPositions[userId]) {
    inMemoryPositions[userId] = {};
  }
  const userPositions = inMemoryPositions[userId]!;

  const balance = getOrCreateMemoryBalance(userId, asset);
  const position = userPositions[marketId] || null;

  const posSide = position ? position.side : null;
  const posSize = position ? position.size : 0;
  const entryPrice = position ? position.entryPrice : 0;
  const posMargin = position ? position.margin : 0;

  let availableChange = releasedOrderMargin;
  let lockedChange = -releasedOrderMargin;
  let realizedPnL = 0;

  let positionAction: "CREATE" | "UPDATE" | "DELETE" = "CREATE";
  let finalPosSide: "LONG" | "SHORT" = "LONG";
  let finalPosSize = 0;
  let finalPosEntryPrice = 0;
  let finalPosMargin = 0;

  if (side === "BUY") {
    if (posSize === 0) {
      const initialMargin = (fillQty * fillPrice) / leverage;
      availableChange -= initialMargin;
      lockedChange += initialMargin;

      positionAction = "CREATE";
      finalPosSide = "LONG";
      finalPosSize = fillQty;
      finalPosEntryPrice = fillPrice;
      finalPosMargin = initialMargin;

      userPositions[marketId] = {
        side: "LONG",
        size: fillQty,
        entryPrice: fillPrice,
        margin: initialMargin,
        leverage,
      };
    } else if (posSide === "LONG") {
      const newSize = posSize + fillQty;
      const newEntryPrice = (posSize * entryPrice + fillQty * fillPrice) / newSize;
      const additionalMargin = (fillQty * fillPrice) / leverage;
      availableChange -= additionalMargin;
      lockedChange += additionalMargin;

      positionAction = "UPDATE";
      finalPosSide = "LONG";
      finalPosSize = newSize;
      finalPosEntryPrice = newEntryPrice;
      finalPosMargin = posMargin + additionalMargin;

      userPositions[marketId]!.size = newSize;
      userPositions[marketId]!.entryPrice = newEntryPrice;
      userPositions[marketId]!.margin = posMargin + additionalMargin;
    } else if (posSide === "SHORT") {
      if (fillQty < posSize) {
        const newSize = posSize - fillQty;
        realizedPnL = (entryPrice - fillPrice) * fillQty;
        const marginToRelease = (fillQty * entryPrice) / leverage;

        availableChange += marginToRelease + realizedPnL;
        lockedChange -= marginToRelease;

        positionAction = "UPDATE";
        finalPosSide = "SHORT";
        finalPosSize = newSize;
        finalPosEntryPrice = entryPrice;
        finalPosMargin = posMargin - marginToRelease;

        userPositions[marketId]!.size = newSize;
        userPositions[marketId]!.margin = posMargin - marginToRelease;
      } else {
        const closedQty = posSize;
        realizedPnL = (entryPrice - fillPrice) * closedQty;
        const marginToRelease = posMargin;

        availableChange += marginToRelease + realizedPnL;
        lockedChange -= marginToRelease;

        const remainingQty = fillQty - posSize;

        if (remainingQty > 0) {
          const newMargin = (remainingQty * fillPrice) / leverage;
          availableChange -= newMargin;
          lockedChange += newMargin;

          positionAction = "UPDATE";
          finalPosSide = "LONG";
          finalPosSize = remainingQty;
          finalPosEntryPrice = fillPrice;
          finalPosMargin = newMargin;

          userPositions[marketId] = {
            side: "LONG",
            size: remainingQty,
            entryPrice: fillPrice,
            margin: newMargin,
            leverage,
          };
        } else {
          positionAction = "DELETE";
          delete userPositions[marketId];
        }
      }
    }
  } else {
    if (posSize === 0) {
      const initialMargin = (fillQty * fillPrice) / leverage;
      availableChange -= initialMargin;
      lockedChange += initialMargin;

      positionAction = "CREATE";
      finalPosSide = "SHORT";
      finalPosSize = fillQty;
      finalPosEntryPrice = fillPrice;
      finalPosMargin = initialMargin;

      userPositions[marketId] = {
        side: "SHORT",
        size: fillQty,
        entryPrice: fillPrice,
        margin: initialMargin,
        leverage,
      };
    } else if (posSide === "SHORT") {
      const newSize = posSize + fillQty;
      const newEntryPrice = (posSize * entryPrice + fillQty * fillPrice) / newSize;
      const additionalMargin = (fillQty * fillPrice) / leverage;
      availableChange -= additionalMargin;
      lockedChange += additionalMargin;

      positionAction = "UPDATE";
      finalPosSide = "SHORT";
      finalPosSize = newSize;
      finalPosEntryPrice = newEntryPrice;
      finalPosMargin = posMargin + additionalMargin;

      userPositions[marketId]!.size = newSize;
      userPositions[marketId]!.entryPrice = newEntryPrice;
      userPositions[marketId]!.margin = posMargin + additionalMargin;
    } else if (posSide === "LONG") {
      if (fillQty < posSize) {
        const newSize = posSize - fillQty;
        realizedPnL = (fillPrice - entryPrice) * fillQty;
        const marginToRelease = (fillQty * entryPrice) / leverage;

        availableChange += marginToRelease + realizedPnL;
        lockedChange -= marginToRelease;

        positionAction = "UPDATE";
        finalPosSide = "LONG";
        finalPosSize = newSize;
        finalPosEntryPrice = entryPrice;
        finalPosMargin = posMargin - marginToRelease;

        userPositions[marketId]!.size = newSize;
        userPositions[marketId]!.margin = posMargin - marginToRelease;
      } else {
        const closedQty = posSize;
        realizedPnL = (fillPrice - entryPrice) * closedQty;
        const marginToRelease = posMargin;

        availableChange += marginToRelease + realizedPnL;
        lockedChange -= marginToRelease;

        const remainingQty = fillQty - posSize;

        if (remainingQty > 0) {
          const newMargin = (remainingQty * fillPrice) / leverage;
          availableChange -= newMargin;
          lockedChange += newMargin;

          positionAction = "UPDATE";
          finalPosSide = "SHORT";
          finalPosSize = remainingQty;
          finalPosEntryPrice = fillPrice;
          finalPosMargin = newMargin;

          userPositions[marketId] = {
            side: "SHORT",
            size: remainingQty,
            entryPrice: fillPrice,
            margin: newMargin,
            leverage,
          };
        } else {
          positionAction = "DELETE";
          delete userPositions[marketId];
        }
      }
    }
  }

  balance.available += availableChange;
  balance.locked += lockedChange;

  return {
    realizedPnL,
    positionUpdate: {
      action: positionAction,
      side: finalPosSide,
      size: finalPosSize,
      entryPrice: finalPosEntryPrice,
      margin: finalPosMargin,
      leverage,
    },
    balanceUpdate: {
      asset,
      availableChange,
      lockedChange,
    },
  };
}
