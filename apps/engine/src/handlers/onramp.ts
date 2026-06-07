import { prisma } from "db";

export async function handleOnRamp(
  data: Record<string, string>
) {
  const userId = data.userId;
  const asset = data.asset;
  const amountStr = data.amount;

  if (!userId || !asset || !amountStr) {
    console.error("Invalid onramp data: missing parameters", data);
    return;
  }

  const amount = Number(amountStr);
  if (isNaN(amount)) {
    console.error("Invalid amount:", amountStr);
    return;
  }

  await prisma.balance.upsert({
    where: {
      userId_asset: {
        userId,
        asset,
      },
    },
    update: {
      available: {
        increment: amount,
      },
    },
    create: {
      userId,
      asset,
      available: amount,
      locked: 0,
    },
  });

  console.log(
    `Balance credited: ${amount} ${asset}`
  );
}