import { inMemoryMarkets } from "../engine/src/memoryState";
import { lastPrices } from "../engine/src/globals";
import { checkMarketLiquidations } from "../engine/src/liquidation";

let ws: WebSocket | null = null;


export function startBinanceFeed() {
  const markets = Object.values(inMemoryMarkets);
  if (markets.length === 0) {
    console.warn("[BINANCE_WS] No active markets in memoryState to subscribe.");
    return;
  }

  const streams = markets.map(
    (m) => `${m.symbol.toLowerCase().replace("_", "")}@ticker`
  );

  const wsUrl = `wss://stream.binance.com:9443/ws/${streams.join("/")}`;
  console.log(`[BINANCE_WS] Connecting to stream URL: ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("[BINANCE_WS] Connection successfully established.");
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!data || !data.s) return;

      const binanceSymbol = data.s; // e.g. "BTCUSDT"
      const price = parseFloat(data.c); // Current close price (mark price)

      if (isNaN(price) || price <= 0) return;

      // Find matching market in our memoryState
      const marketId = Object.keys(inMemoryMarkets).find(
        (id) => inMemoryMarkets[id]?.symbol.replace("_", "") === binanceSymbol
      );

      if (marketId) {
        lastPrices[marketId] = price;
        
        // Trigger liquidation evaluations for users holding open positions on this market
        await checkMarketLiquidations(marketId);
      }
    } catch (err) {
      console.error("[BINANCE_WS] Error parsing ticker message:", err);
    }
  };

  ws.onerror = (err) => {
    console.error("[BINANCE_WS] WebSocket Error:", err);
  };

  ws.onclose = () => {
    console.warn("[BINANCE_WS] Connection closed. Reconnecting in 5 seconds...");
    ws = null;
    setTimeout(startBinanceFeed, 5000);
  };
}

/**
 * Closes the active WebSocket feed.
 */
export function stopBinanceFeed() {
  if (ws) {
    ws.close();
    ws = null;
  }
}
