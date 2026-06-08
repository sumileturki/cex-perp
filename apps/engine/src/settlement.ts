import { prisma, PositionSide } from "db";

export function calculateReleasedMargin(
  quantity: number,
  margin: number,
  price: number,
  previouslyFilled: number,
  fillQty: number,
  leverage: number = 10
): number {
  if (margin <= 0 || price <= 0) {
    return 0;
  }
  const openQty = (margin * leverage) / price;
  const reduceQty = quantity - openQty;
  const fillReduceQty = Math.max(0, Math.min(fillQty, reduceQty - previouslyFilled));
  const fillOpenQty = Math.max(0, fillQty - fillReduceQty);
  
  if (openQty <= 0) {
    return 0;
  }
  return (fillOpenQty / openQty) * margin;
}

export async function updateUserPositionAndBalance(
  tx: any,
  userId: string,
  marketId: string,
  side: "BUY" | "SELL",
  fillPrice: number,
  fillQty: number,
  leverage: number = 10,
  releasedOrderMargin: number = 0
): Promise<{ realizedPnL: number }> {
  const market = await tx.market.findUnique({
    where: { id: marketId },
  });
  if (!market) {
    throw new Error(`Market ${marketId} not found during settlement`);
  }
  const asset = market.quoteAsset;

  const position = await tx.position.findUnique({
    where: { userId_marketId: { userId, marketId } },
  });

  const balance = await tx.balance.findUnique({
    where: { userId_asset: { userId, asset } },
  });

  if (!balance) {
    throw new Error(`User ${userId} does not have a balance record for ${asset}`);
  }

  const posSide: PositionSide | null = position ? position.side : null;
  const posSize = position ? Number(position.size) : 0;
  const entryPrice = position ? Number(position.entryPrice) : 0;
  const posMargin = position ? Number(position.margin) : 0;

  let availableChange = releasedOrderMargin;
  let lockedChange = -releasedOrderMargin;
  let realizedPnL = 0;

  if (side === "BUY") {
    if (posSize === 0) {
      const initialMargin = (fillQty * fillPrice) / leverage;
      availableChange -= initialMargin;
      lockedChange += initialMargin;

      await tx.position.create({
        data: {
          userId,
          marketId,
          side: PositionSide.LONG,
          size: fillQty,
          entryPrice: fillPrice,
          margin: initialMargin,
          leverage,
        },
      });
    } else if (posSide === PositionSide.LONG) {
      const newSize = posSize + fillQty;
      const newEntryPrice = (posSize * entryPrice + fillQty * fillPrice) / newSize;
      const additionalMargin = (fillQty * fillPrice) / leverage;
      availableChange -= additionalMargin;
      lockedChange += additionalMargin;

      await tx.position.update({
        where: { id: position.id },
        data: {
          size: newSize,
          entryPrice: newEntryPrice,
          margin: posMargin + additionalMargin,
        },
      });
    } else if (posSide === PositionSide.SHORT) {
      if (fillQty < posSize) {
        const newSize = posSize - fillQty;
        realizedPnL = (entryPrice - fillPrice) * fillQty;
        const marginToRelease = (fillQty * entryPrice) / leverage;

        availableChange += marginToRelease + realizedPnL;
        lockedChange -= marginToRelease;

        await tx.position.update({
          where: { id: position.id },
          data: {
            size: newSize,
            margin: posMargin - marginToRelease,
          },
        });
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

          await tx.position.update({
            where: { id: position.id },
            data: {
              side: PositionSide.LONG,
              size: remainingQty,
              entryPrice: fillPrice,
              margin: newMargin,
            },
          });
        } else {
          await tx.position.delete({
            where: { id: position.id },
          });
        }
      }
    }
  } else {
    if (posSize === 0) {
      const initialMargin = (fillQty * fillPrice) / leverage;
      availableChange -= initialMargin;
      lockedChange += initialMargin;

      await tx.position.create({
        data: {
          userId,
          marketId,
          side: PositionSide.SHORT,
          size: fillQty,
          entryPrice: fillPrice,
          margin: initialMargin,
          leverage,
        },
      });
    } else if (posSide === PositionSide.SHORT) {
      const newSize = posSize + fillQty;
      const newEntryPrice = (posSize * entryPrice + fillQty * fillPrice) / newSize;
      const additionalMargin = (fillQty * fillPrice) / leverage;
      availableChange -= additionalMargin;
      lockedChange += additionalMargin;

      await tx.position.update({
        where: { id: position.id },
        data: {
          size: newSize,
          entryPrice: newEntryPrice,
          margin: posMargin + additionalMargin,
        },
      });
    } else if (posSide === PositionSide.LONG) {
      if (fillQty < posSize) {
        const newSize = posSize - fillQty;
        realizedPnL = (fillPrice - entryPrice) * fillQty;
        const marginToRelease = (fillQty * entryPrice) / leverage;

        availableChange += marginToRelease + realizedPnL;
        lockedChange -= marginToRelease;

        await tx.position.update({
          where: { id: position.id },
          data: {
            size: newSize,
            margin: posMargin - marginToRelease,
          },
        });
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

          await tx.position.update({
            where: { id: position.id },
            data: {
              side: PositionSide.SHORT,
              size: remainingQty,
              entryPrice: fillPrice,
              margin: newMargin,
            },
          });
        } else {
          await tx.position.delete({
            where: { id: position.id },
          });
        }
      }
    }
  }

  await tx.balance.update({
    where: { id: balance.id },
    data: {
      available: { increment: availableChange },
      locked: { increment: lockedChange },
    },
  });

  return { realizedPnL };
}
