const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderController")
// const authMiddleware = require("../middleware/authMiddleware");
const { authChainMiddleware } = require("../middleware/chainMiddleware");
const Invoice = require("../models/Invoice"); 
const { createInvoicePDF } = require("../utils/pdfGenerator");

router.use(authChainMiddleware);

router.post(
  "/create-vnpay-payment",
  authChainMiddleware,
  orderController.createPayment
);
router.get("/vnpay-return", orderController.handlePaymentResponse);

router.post("/create-paypal-order", orderController.createPaypalOrder);
router.post(
  "/complete-paypal-order",
  authChainMiddleware,
  (req, res, next) => {
    console.log("Received request body:", req.body);
    next();
  },
  orderController.completePaypalOrder
);

router.post("/", async (req, res) => {
  try {
    const { items, shippingAddress, paymentMethod } = req.body;

    if (
      !shippingAddress ||
      !shippingAddress.streetAddress ||
      !shippingAddress.ward ||
      !shippingAddress.district ||
      !shippingAddress.province
    ) {
      return res
        .status(400)
        .json({ message: "Thông tin địa chỉ giao hàng không đầy đủ" });
    }

    const formattedAddress = `${shippingAddress.streetAddress}, ${shippingAddress.wardName}, ${shippingAddress.districtName}, ${shippingAddress.provinceName}`;

    const newOrder = new Order({
      user: req.user._id,
      items,
      shippingAddress: formattedAddress,
      paymentMethod,
      status: "pending",
    });
    await newOrder.save();

    const newDelivery = new Delivery({
      order: newOrder._id,
      shippingAddress: formattedAddress,
      status: "pending",
    });
    await newDelivery.save();

    // Clear the user's cart
    await Cart.findOneAndUpdate(
      { user: req.user._id },
      { $set: { items: [] } }
    );

    res.status(201).json(newOrder);
  } catch (error) {
    res.status(500).json({ message: "Lỗi server", error: error.message });
  }
});

router.get("/invoice/:id", authChainMiddleware, async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ order: req.params.id }).populate(
      "items.product"
    );
    if (!invoice) {
      return res.status(404).json({ message: "Không tìm thấy hóa đơn" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoice-${invoice.invoiceNumber}.pdf`
    );

    createInvoicePDF(invoice, res);
  } catch (error) {
    console.error("Lỗi khi tạo PDF hóa đơn:", error);
    res
      .status(500)
      .json({ message: "Lỗi khi tạo PDF hóa đơn", error: error.message });
  }
});

router.get("/:id", authChainMiddleware, orderController.getOrderById);

// Thêm route để lấy danh sách phương thức thanh toán
router.get("/payment-methods", orderController.getPaymentMethods);

router.put("/:id/cancel", authChainMiddleware, orderController.cancelOrder);

router.post(
  "/create-cod-order",
  authChainMiddleware,
  orderController.createCodOrder
);

module.exports = router;
