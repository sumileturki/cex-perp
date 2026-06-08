import type { Request, Response } from "express";
import { prisma } from "db";
import { CreateOrderSchema } from "../schema/order.schema";
import { redis } from "../utils/redis";

export const createOrder = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const parsedData = CreateOrderSchema.safeParse(req.body);
    if (!parsedData.success) {
      return res.status(400).json({
        success: false,
        errors: parsedData.error.issues,
      });
    }

    const { marketId, side, type: orderType, price, quantity } = parsedData.data;

    // Verify market exists
    const market = await prisma.market.findUnique({
      where: { id: marketId },
    });

    if (!market || !market.isActive) {
      return res.status(404).json({
        success: false,
        message: "Market not found or inactive",
      });
    }

    const response = await redis.xAdd(
      "engine-stream",
      "*",
      {
        type: "CREATE_ORDER",
        userId,
        marketId,
        side,
        orderType,
        price: price?.toString() || "",
        quantity: quantity.toString(),
      }
    );

    return res.status(200).json({
      success: true,
      message: "Order request submitted",
      response,
    });
  } catch (error) {
    console.error("Failed to create order request:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create order request",
    });
  }
};

export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Missing orderId",
      });
    }

    // Fetch order from DB to check ownership and status
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (order.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to cancel this order",
      });
    }

    if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") {
      return res.status(400).json({
        success: false,
        message: `Order cannot be cancelled. Current status is ${order.status}`,
      });
    }

    // Publish CANCEL_ORDER command to engine-stream
    const response = await redis.xAdd(
      "engine-stream",
      "*",
      {
        type: "CANCEL_ORDER",
        orderId,
        marketId: order.marketId,
        side: order.side,
        userId,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Cancel order request submitted",
      response,
    });
  } catch (error) {
    console.error("Failed to cancel order request:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to cancel order request",
    });
  }
};
