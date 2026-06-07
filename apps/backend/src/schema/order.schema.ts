import { z } from "zod";

export const CreateOrderSchema = z
  .object({
    marketId: z.string().uuid(),

    side: z.enum(["BUY", "SELL"]),

    type: z.enum(["MARKET", "LIMIT"]),

    price: z.coerce.number().positive().optional(),

    quantity: z.coerce.number().positive(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "LIMIT" && data.price === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price"],
        message: "Price is required for LIMIT orders",
      });
    }

    if (data.type === "MARKET" && data.price !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price"],
        message: "Price should not be sent for MARKET orders",
      });
    }
  });