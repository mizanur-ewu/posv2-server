const express = require("express");
const {
  getSalesReport,
  getStockReport,
  getProfitReport,
  getEmployeeReport,
  getSettlementReport,
  getExpiryReport,
  getDueReport,
} = require("../controllers/report/report.controller");
const {
  getCustomerStatement,
  getSupplierLedger,
  getStockMovement,
  getSalesBy,
  getDeadStock,
  getPurchaseReport,
  getVatReport,
} = require("../controllers/report/extra.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// ?from=YYYY-MM-DD&to=YYYY-MM-DD on the range reports
router.get("/sales", authenticateJWT, authorizePermission("reports"), getSalesReport);
router.get("/stock", authenticateJWT, authorizePermission("reports"), getStockReport);
router.get("/profit", authenticateJWT, authorizePermission("reports"), getProfitReport);
router.get("/employee", authenticateJWT, authorizePermission("reports"), getEmployeeReport);
router.get("/settlement", authenticateJWT, authorizePermission("reports"), getSettlementReport);
router.get("/expiry", authenticateJWT, authorizePermission("reports"), getExpiryReport);
router.get("/due", authenticateJWT, authorizePermission("reports"), getDueReport);
router.get("/customerStatement", authenticateJWT, authorizePermission("reports"), getCustomerStatement); // ?customerId=&from=&to=
router.get("/supplierLedger", authenticateJWT, authorizePermission("reports"), getSupplierLedger); // ?supplierId=&from=&to=
router.get("/stockMovement", authenticateJWT, authorizePermission("reports"), getStockMovement);
router.get("/salesBy", authenticateJWT, authorizePermission("reports"), getSalesBy); // ?group=product|category|brand|cashier&channel=
router.get("/deadStock", authenticateJWT, authorizePermission("reports"), getDeadStock); // ?days=60
router.get("/purchases", authenticateJWT, authorizePermission("reports"), getPurchaseReport);
router.get("/vat", authenticateJWT, authorizePermission("reports"), getVatReport);

module.exports = router;
