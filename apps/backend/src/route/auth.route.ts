import express from "express"
import { loginUser, registerUser } from "../controller/auth.controller";
import { onramp } from "../controller/balance.controller";
import { authMiddleware } from "../middleware/auth.middleware";

const router = express.Router();

router.post("/registeruser", registerUser);
router.post("/login", loginUser)
router.post("/onramp",authMiddleware, onramp )

export default router;