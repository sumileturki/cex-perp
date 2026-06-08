import express from "express"
import { createOrder, cancelOrder } from "../controller/order.controller";
import { authMiddleware } from "../middleware/auth.middleware";


const router = express.Router();

router.post("/order", authMiddleware, createOrder);
router.delete("/order", authMiddleware, cancelOrder);

export default router;