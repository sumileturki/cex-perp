import express from "express"
import { createOrder } from "../controller/order.controller";
import { authMiddleware } from "../middleware/auth.middleware";


const router = express.Router();

router.post("/order", authMiddleware, createOrder);

export default router;