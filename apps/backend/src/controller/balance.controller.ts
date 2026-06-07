import type { Request, Response } from "express";
import { redis } from "../utils/redis";

export const onramp = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const { asset, amount } = req.body;

    const response = await redis.xAdd(
      "engine-stream",
      "*",
      {
        type: "RAMP_USER",
        userId,
        asset,
        amount: amount.toString(),
      }
    );

    return res.status(200).json({
      success: true,
      response,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create onramp request",
    });
  }
};