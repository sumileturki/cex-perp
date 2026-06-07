import { prisma } from "./index";

async function main() {
  console.log("Seeding markets...");
  const markets = [
    { symbol: "BTC_USDT", baseAsset: "BTC", quoteAsset: "USDT" },
    { symbol: "SOL_USDT", baseAsset: "SOL", quoteAsset: "USDT" },
    { symbol: "ETH_USDT", baseAsset: "ETH", quoteAsset: "USDT" },
  ];

  for (const m of markets) {
    const market = await prisma.market.upsert({
      where: { symbol: m.symbol },
      update: {
        baseAsset: m.baseAsset,
        quoteAsset: m.quoteAsset,
        isActive: true,
      },
      create: {
        symbol: m.symbol,
        baseAsset: m.baseAsset,
        quoteAsset: m.quoteAsset,
        isActive: true,
      },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("Seeding failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
