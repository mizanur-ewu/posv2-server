const express = require("express");
const {
  getAllProduct,
  createProduct,
  updateProduct,
  getMasters,
  createMaster,
  updateMaster,
  deleteMaster,
} = require("../controllers/product.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// categories / brands / units  (:kind = categories | brands | units)
router.get("/master/:kind", authenticateJWT, getMasters);
router.post("/master/:kind", authenticateJWT, authorizePermission("products:create"), createMaster);
router.patch("/master/:kind/:id", authenticateJWT, authorizePermission("products:edit"), updateMaster);
router.delete("/master/:kind/:id", authenticateJWT, authorizePermission("products:edit"), deleteMaster);

// products (the list is used by POS, stock entry and products pages)
router.get("/", authenticateJWT, getAllProduct);
router.post("/", authenticateJWT, authorizePermission("products:create"), createProduct);
router.patch("/:id", authenticateJWT, authorizePermission("products:edit"), updateProduct);

module.exports = router;
