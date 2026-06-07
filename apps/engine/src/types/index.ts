export type EngineMessage =
  | {
      type: "RAMP_USER";
      userId: string;
      asset: string;
      amount: string;
    }
  | {
      type: "CREATE_ORDER";
      userId: string;
      marketId: string;
      side: "BUY" | "SELL";
      orderType: "MARKET" | "LIMIT";
      price: string;
      quantity: string;
    };