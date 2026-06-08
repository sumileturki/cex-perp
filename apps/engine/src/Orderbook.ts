import { OrderSide, OrderType, OrderStatus } from "db";

export interface BookOrder {
  id: string;
  userId: string;
  marketId: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price: number;
  quantity: number;
  filledQty: number;
  createdAt: Date;
  margin: number;
}

export interface MatchEvent {
  makerOrder: BookOrder;
  takerOrder: BookOrder;
  price: number;
  quantity: number;
}

export class Orderbook {
  public marketId: string;
  public bids: BookOrder[] = [];
  public asks: BookOrder[] = [];

  constructor(marketId: string) {
    this.marketId = marketId;
  }

  public loadOrder(order: BookOrder) {
    if (order.side === "BUY") {
      this.bids.push(order);
      this.sortBids();
    } else {
      this.asks.push(order);
      this.sortAsks();
    }
  }

  private sortBids() {
    this.bids.sort((a, b) => {
      if (b.price !== a.price) {
        return b.price - a.price;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  private sortAsks() {
    this.asks.sort((a, b) => {
      if (a.price !== b.price) {
        return a.price - b.price;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  public addOrder(order: BookOrder): { trades: MatchEvent[]; remainingQty: number } {
    const trades: MatchEvent[] = [];
    let remainingQty = order.quantity - order.filledQty;

    if (order.side === "BUY") {
      while (this.asks.length > 0 && remainingQty > 0) {
        const bestAsk = this.asks[0]!;
        if (order.type === "LIMIT" && order.price < bestAsk.price) {
          break;
        }

        const matchPrice = bestAsk.price;
        if (!matchPrice || matchPrice <= 0) {
          throw new Error("Invalid trade price");
        }

        const bestAskRemaining = bestAsk.quantity - bestAsk.filledQty;
        const fillQty = Math.min(remainingQty, bestAskRemaining);

        remainingQty -= fillQty;
        order.filledQty += fillQty;
        bestAsk.filledQty += fillQty;

        trades.push({
          makerOrder: bestAsk,
          takerOrder: order,
          price: matchPrice,
          quantity: fillQty,
        });

        if (bestAsk.filledQty >= bestAsk.quantity) {
          bestAsk.status = "FILLED";
          this.asks.shift();
        } else {
          bestAsk.status = "PARTIALLY_FILLED";
        }
      }

      if (remainingQty > 0) {
        if (order.type === "LIMIT") {
          order.status = order.filledQty > 0 ? "PARTIALLY_FILLED" : "OPEN";
          this.bids.push(order);
          this.sortBids();
        } else {
          order.status = order.filledQty > 0 ? "PARTIALLY_FILLED" : "CANCELLED";
        }
      } else {
        order.status = "FILLED";
      }

    } else {
      while (this.bids.length > 0 && remainingQty > 0) {
        const bestBid = this.bids[0]!;
        if (order.type === "LIMIT" && order.price > bestBid.price) {
          break;
        }

        const matchPrice = bestBid.price;
        if (!matchPrice || matchPrice <= 0) {
          throw new Error("Invalid trade price");
        }

        const bestBidRemaining = bestBid.quantity - bestBid.filledQty;
        const fillQty = Math.min(remainingQty, bestBidRemaining);

        remainingQty -= fillQty;
        order.filledQty += fillQty;
        bestBid.filledQty += fillQty;

        trades.push({
          makerOrder: bestBid,
          takerOrder: order,
          price: matchPrice,
          quantity: fillQty,
        });

        if (bestBid.filledQty >= bestBid.quantity) {
          bestBid.status = "FILLED";
          this.bids.shift();
        } else {
          bestBid.status = "PARTIALLY_FILLED";
        }
      }

      if (remainingQty > 0) {
        if (order.type === "LIMIT") {
          order.status = order.filledQty > 0 ? "PARTIALLY_FILLED" : "OPEN";
          this.asks.push(order);
          this.sortAsks();
        } else {
          order.status = order.filledQty > 0 ? "PARTIALLY_FILLED" : "CANCELLED";
        }
      } else {
        order.status = "FILLED";
      }
    }

    return { trades, remainingQty };
  }

  public cancelOrder(orderId: string, side: OrderSide): BookOrder | null {
    if (side === "BUY") {
      const index = this.bids.findIndex((o) => o.id === orderId);
      if (index !== -1) {
        const [order] = this.bids.splice(index, 1);
        return order || null;
      }
    } else {
      const index = this.asks.findIndex((o) => o.id === orderId);
      if (index !== -1) {
        const [order] = this.asks.splice(index, 1);
        return order || null;
      }
    }
    return null;
  }

  public getDepth(limit: number = 20): { bids: [string, string][]; asks: [string, string][] } {
    const bidDepth: Record<number, number> = {};
    const askDepth: Record<number, number> = {};

    for (const b of this.bids) {
      const remaining = b.quantity - b.filledQty;
      if (remaining > 0) {
        bidDepth[b.price] = (bidDepth[b.price] || 0) + remaining;
      }
    }

    for (const a of this.asks) {
      const remaining = a.quantity - a.filledQty;
      if (remaining > 0) {
        askDepth[a.price] = (askDepth[a.price] || 0) + remaining;
      }
    }

    const sortedBids = Object.keys(bidDepth)
      .map(Number)
      .sort((x, y) => y - x)
      .slice(0, limit)
      .map((p) => [p.toString(), bidDepth[p]!.toString()] as [string, string]);

    const sortedAsks = Object.keys(askDepth)
      .map(Number)
      .sort((x, y) => x - y)
      .slice(0, limit)
      .map((p) => [p.toString(), askDepth[p]!.toString()] as [string, string]);

    return {
      bids: sortedBids,
      asks: sortedAsks,
    };
  }
}

