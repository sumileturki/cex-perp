export async function handleCreateOrder(
  data: Record<string, string>
) {
  console.log("CREATE_ORDER");

  console.log({
    userId: data.userId,
    marketId: data.marketId,
    side: data.side,
    orderType: data.orderType,
    price: data.price,
    quantity: data.quantity,
  });
}