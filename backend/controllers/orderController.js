const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const Delivery = require("../models/Delivery");
const paypal = require("@paypal/checkout-server-sdk");
const User = require("../models/User");
const Voucher = require("../models/Voucher");
const ShippingInfo = require("../models/ShippingInfo");
const { createInvoiceFromOrder } = require("./invoiceController");
const { sendOrderConfirmationEmail } = require("../utils/emailService");
const mongoose = require("mongoose");
const crypto = require("crypto");
const moment = require("moment");
const { vnpayConfig } = require("../config/vnpay");
const querystring = require("querystring");

let environment = new paypal.core.SandboxEnvironment(
  process.env.PAYPAL_CLIENT_ID,
  process.env.PAYPAL_CLIENT_SECRET
);
let client = new paypal.core.PayPalHttpClient(environment);

// Thêm hàm helper sortObject
const sortObject = (obj) => {
  const sorted = {};
  const str = [];
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      str.push(encodeURIComponent(key));
    }
  }
  str.sort();
  for (let i = 0; i < str.length; i++) {
    sorted[str[i]] = encodeURIComponent(obj[str[i]]).replace(/%20/g, "+");
  }
  return sorted;
};

// Thêm hàm createVNPayUrl
const createVNPayUrl = async (order, ipAddr) => {
  // Kiểm tra biến môi trường từ config
  if (!vnpayConfig.tmCode || !vnpayConfig.hashSecret || !vnpayConfig.url) {
    console.error("VNPAY Config:", vnpayConfig);
    throw new Error("Thiếu cấu hình VNPAY trong biến môi trường");
  }

  const date = new Date();
  const createDate = moment(date).format("YYYYMMDDHHmmss");

  const vnpParams = {
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: vnpayConfig.tmCode,
    vnp_Amount: Math.round(order.finalAmount * 100),
    vnp_CreateDate: createDate,
    vnp_CurrCode: "VND",
    vnp_IpAddr: ipAddr,
    vnp_Locale: "vn",
    vnp_OrderInfo: `Thanh toan don hang ${order._id}`,
    vnp_OrderType: "other",
    vnp_ReturnUrl: vnpayConfig.returnUrl,
    vnp_TxnRef: order._id.toString(),
  };

  const sortedParams = sortObject(vnpParams);
  const signData = querystring.stringify(sortedParams, { encode: false });

  const hmac = crypto.createHmac("sha512", vnpayConfig.hashSecret);
  const signed = hmac.update(Buffer.from(signData, "utf-8")).digest("hex");
  vnpParams.vnp_SecureHash = signed;

  return `${vnpayConfig.url}?${querystring.stringify(vnpParams, {
    encode: false,
  })}`;
};

exports.createPaypalOrder = async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id }).populate(
      "items.product"
    );
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: "Giỏ hàng trống" });
    }

    // Tính tổng tiền với xử lý thập phân đúng cách
    const total = cart.items.reduce(
      (sum, item) => sum + item.product.price * item.quantity,
      0
    );
    VNPAY_HASHSECRET;

    const exchangeRate = process.env.USD_VND_RATE || 23000;
    const usdAmount = (total / exchangeRate).toFixed(2);

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: usdAmount,
          },
          description: `Đơn hàng cho người dùng ${req.user._id}`,
        },
      ],
      application_context: {
        shipping_preference: "NO_SHIPPING",
      },
    });

    const order = await client.execute(request);
    res.json({
      id: order.result.id,
      totalVND: total,
      totalUSD: usdAmount,
    });
  } catch (error) {
    console.error("Lỗi khi tạo đơn hàng PayPal:", error);
    res.status(500).json({
      message: "Lỗi khi tạo đơn hàng PayPal",
      error: error.message,
    });
  }
};

exports.completePaypalOrder = async (req, res) => {
  try {
    const { orderId, paypalDetails, shippingInfo } = req.body;
    const userId = req.user._id;

    const cart = await Cart.findOne({ user: userId })
      .populate("items.product")
      .populate("voucher")
      .lean();

    if (!cart) {
      return res.status(404).json({ message: "Không tìm thấy giỏ hàng" });
    }

    // Kiểm tra và cập nhật số lượng tồn kho
    for (const item of cart.items) {
      const product = await Product.findById(item.product._id);
      if (!product) {
        return res.status(404).json({
          message: `Không tìm thấy sản phẩm với ID: ${item.product._id}`,
        });
      }

      // Kiểm tra số lượng tồn kho
      if (product.stock < item.quantity) {
        return res.status(400).json({
          message: `Sản phẩm ${product.name} chỉ còn ${product.stock} trong kho`,
        });
      }

      // Cập nhật số lượng tồn kho
      await product.updateStock(-item.quantity);
    }

    const newOrder = new Order({
      user: userId,
      items: cart.items.map((item) => ({
        product: item.product._id,
        quantity: item.quantity,
        price: item.product.price,
        size: item.size,
        color: item.color,
      })),
      totalAmount: cart.items.reduce(
        (total, item) => total + item.quantity * item.product.price,
        0
      ),
      shippingFee: 30000,
      voucher: cart.voucher ? cart.voucher._id : null,
      discountAmount: cart.discountAmount || 0,
      finalAmount:
        cart.items.reduce(
          (total, item) => total + item.quantity * item.product.price,
          0
        ) +
        30000 -
        (cart.discountAmount || 0),
      paypalOrderId: orderId,
      paypalDetails: paypalDetails,
      shippingInfo: shippingInfo,
      paymentMethod: "paypal",
      status: "pending",
    });

    await newOrder.save();

    // Cập nhật voucher
    await updateVoucherAfterOrder(cart, userId);

    // Reset giỏ hàng hoàn toàn
    await Cart.findOneAndUpdate(
      { user: userId },
      {
        $set: {
          items: [],
          voucher: null,
          discountAmount: 0,
          finalAmount: 0,
          totalAmount: 0,
        },
      },
      { new: true }
    );

    // Populate order with full details
    const populatedOrder = await Order.findById(newOrder._id)
      .populate({
        path: "items.product",
        select: "name price",
      })
      .populate("user", "email")
      .lean();

    // Đảm bảo các thông tin quan trọng được giữ nguyên
    populatedOrder.shippingFee = newOrder.shippingFee;
    populatedOrder.totalAmount = newOrder.totalAmount;
    populatedOrder.discountAmount = newOrder.discountAmount;
    populatedOrder.finalAmount = newOrder.finalAmount;
    populatedOrder.shippingInfo = newOrder.shippingInfo;

    // Create invoice
    const invoice = await createInvoiceFromOrder(newOrder);

    // Create delivery record
    const newDelivery = new Delivery({
      order: newOrder._id,
      shippingInfo: { ...newOrder.shippingInfo },
      status: "pending",
    });
    await newDelivery.save();

    // Send email with populated order data
    const user = await User.findById(userId);
    await sendOrderConfirmationEmail(user.email, populatedOrder, invoice);

    res.status(200).json({
      message: "Đơn hàng đã được tạo và thanh toán thành công",
      order: populatedOrder,
      invoiceId: invoice._id,
    });
  } catch (error) {
    console.error("Error completing PayPal order:", error);
    res.status(500).json({ message: "Lỗi khi xử lý đơn hàng PayPal" });
  }
};

exports.createPayment = async (req, res) => {
  try {
    // Log request body để debug
    console.log("Request body:", req.body);

    // Kiểm tra cấu hình VNPAY
    if (!vnpayConfig.tmCode || !vnpayConfig.hashSecret || !vnpayConfig.url) {
      console.error("VNPAY Config:", vnpayConfig);
      throw new Error("Thiếu cấu hình VNPAY");
    }

    const { shippingInfo } = req.body;
    const userId = req.user._id;

    const cart = await Cart.findOne({ user: userId })
      .populate("items.product")
      .populate("voucher");

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: "Giỏ hàng trống" });
    }

    // Log để kiểm tra dữ liệu
    console.log("Cart data:", {
      items: cart.items,
      totalAmount: cart.totalAmount,
      finalAmount: cart.finalAmount,
    });

    // Tạo order với dữ liệu từ cart
    const order = new Order({
      user: userId,
      items: cart.items.map((item) => ({
        product: item.product._id,
        quantity: item.quantity,
        price: item.product.price,
        size: item.size,
        color: item.color,
      })),
      shippingInfo,
      totalAmount: cart.totalAmount,
      shippingFee: 30000,
      voucher: cart.voucher?._id,
      discountAmount: cart.discountAmount || 0,
      finalAmount: cart.finalAmount,
      paymentMethod: "vnpay",
      status: "awaiting_payment",
    });

    await order.save();

    // Tạo URL thanh toán VNPAY
    const vnpUrl = await createVNPayUrl(order, req.ip);

    res.json({ url: vnpUrl });
  } catch (error) {
    console.error("Lỗi khi tạo thanh toán:", error);
    res.status(500).json({
      message: "Lỗi khi tạo thanh toán",
      error: error.message,
    });
  }
};

exports.handlePaymentResponse = async (req, res) => {
  const vnpResponse = req.query;
  const secureHash = vnpResponse.vnp_SecureHash;
  delete vnpResponse.vnp_SecureHash;

  const sortedKeys = Object.keys(vnpResponse).sort();
  const queryString = sortedKeys
    .map((key) => `${key}=${encodeURIComponent(vnpResponse[key])}`)
    .join("&");
  const hashData = queryString + `&vnp_SecureHashType=SHA256`;
  const calculatedHash = crypto
    .createHmac("sha256", vnpayConfig.hashSecret)
    .update(hashData)
    .digest("hex");

  if (secureHash === calculatedHash) {
    const orderId = vnpResponse.vnp_TxnRef;
    const userId = vnpResponse.vnp_UserId; // Giả sử bạn có thông tin userId trong vnpResponse

    const cart = await Cart.findOne({ user: userId })
      .populate("items.product")
      .populate("voucher")
      .lean();

    if (!cart) {
      return res.status(404).json({ message: "Không tìm thấy giỏ hàng" });
    }

    // Kiểm tra và cập nhật số lượng tồn kho
    for (const item of cart.items) {
      const product = await Product.findById(item.product._id);
      if (!product) {
        return res.status(404).json({
          message: `Không tìm thấy sản phẩm với ID: ${item.product._id}`,
        });
      }

      // Kiểm tra số lượng tồn kho
      if (product.stock < item.quantity) {
        return res.status(400).json({
          message: `Sản phẩm ${product.name} chỉ còn ${product.stock} trong kho`,
        });
      }

      // Cập nhật số lượng tồn kho
      await product.updateStock(-item.quantity);
    }

    const newOrder = new Order({
      user: userId,
      items: cart.items.map((item) => ({
        product: item.product._id,
        quantity: item.quantity,
        price: item.product.price,
        size: item.size,
        color: item.color,
      })),
      totalAmount: cart.items.reduce(
        (total, item) => total + item.quantity * item.product.price,
        0
      ),
      shippingFee: 30000,
      voucher: cart.voucher ? cart.voucher._id : null,
      discountAmount: cart.discountAmount || 0,
      finalAmount:
        cart.items.reduce(
          (total, item) => total + item.quantity * item.product.price,
          0
        ) +
        30000 -
        (cart.discountAmount || 0),
      vnpayOrderId: orderId,
      paymentMethod: "vnpay",
      status: "pending",
    });

    await newOrder.save();

    // Cập nhật voucher
    await updateVoucherAfterOrder(cart, userId);

    // Reset giỏ hàng hoàn toàn
    await Cart.findOneAndUpdate(
      { user: userId },
      {
        $set: {
          items: [],
          voucher: null,
          discountAmount: 0,
          finalAmount: 0,
          totalAmount: 0,
        },
      },
      { new: true }
    );

    // Populate order with full details
    const populatedOrder = await Order.findById(newOrder._id)
      .populate({
        path: "items.product",
        select: "name price",
      })
      .populate("user", "email")
      .lean();

    // Create invoice
    const invoice = await createInvoiceFromOrder(newOrder);

    // Create delivery record
    const newDelivery = new Delivery({
      order: newOrder._id,
      shippingInfo: { ...newOrder.shippingInfo },
      status: "pending",
    });
    await newDelivery.save();

    // Send email with populated order data
    const user = await User.findById(userId);
    await sendOrderConfirmationEmail(user.email, populatedOrder, invoice);

    res.status(200).json({
      message: "Đơn hàng đã được tạo và thanh toán thành công",
      order: populatedOrder,
      invoiceId: invoice._id,
    });
  } else {
    res.status(400).json({ message: "Thanh toán không hợp lệ" });
  }
};

exports.createOrder = async (req, res) => {
  try {
    const { cartItems, shippingInfo, paymentMethod, voucherId } = req.body;

    // Validate payment method
    const validPaymentMethods = ["cod", "paypal", "banking"];
    if (!validPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({
        message: "Phương thức thanh toán không hợp lệ",
      });
    }

    const totalAmount = cartItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const shippingFee = 30000;
    let discountAmount = 0;
    let finalAmount = totalAmount + shippingFee;

    // Tính lại giá trị giảm giá nếu có voucher
    if (voucherId) {
      const voucher = await Voucher.findById(voucherId);
      if (voucher && voucher.isActive) {
        if (voucher.discountType === "percentage") {
          discountAmount = totalAmount * (voucher.discountValue / 100);
          if (voucher.maxDiscount) {
            discountAmount = Math.min(discountAmount, voucher.maxDiscount);
          }
        } else {
          discountAmount = voucher.discountValue;
        }
        finalAmount = totalAmount + shippingFee - discountAmount;
      }
    }

    const order = new Order({
      user: req.user._id,
      items: cartItems,
      shippingInfo,
      paymentMethod,
      totalAmount,
      shippingFee,
      voucher: voucherId || null,
      discountAmount,
      finalAmount,
      status: paymentMethod === "cod" ? "pending" : "awaiting_payment",
    });

    await order.save();

    // Cập nhật voucher
    await updateVoucherAfterOrder(cart, req.user._id);

    // Reset giỏ hàng
    await Cart.findOneAndUpdate(
      { user: req.user._id },
      {
        items: [],
        voucher: null,
        discountAmount: 0,
        finalAmount: 0,
      }
    );

    res.status(201).json({
      message: "Đơn hàng đã được tạo thành công",
      order: order,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Lỗi khi tạo đơn hàng", error: error.message });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }

    // Kiểm tra quyền truy cập
    if (
      req.user.role !== "admin" &&
      order.user.toString() !== req.user._id.toString()
    ) {
      return res
        .status(403)
        .json({ message: "Không có quyền truy cập đơn hàng này" });
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ message: "Lỗi server", error: error.message });
  }
};

// Thêm API để lấy danh sách phương thức thanh toán
exports.getPaymentMethods = async (req, res) => {
  try {
    const paymentMethods = [
      {
        id: "cod",
        name: "Thanh toán khi nhận hàng",
        description: "Thanh toán bằng tiền mặt khi nhn hàng",
        icon: "cash-icon",
        additionalInfo: "Phí thu hộ: Miễn phí",
      },
      {
        id: "paypal",
        name: "PayPal",
        description: "Thanh toán an toàn qua PayPal",
        icon: "paypal-icon",
        additionalInfo: "Chấp nhận thẻ Visa, MasterCard",
      },
      {
        id: "banking",
        name: "Chuyển khoản ngân hàng",
        description: "Chuyển khoản qua ngân hàng nội địa",
        icon: "bank-icon",
        additionalInfo: "Thời gian xử lý: 1-24h",
        bankAccounts: [
          {
            bankName: "VietcomBank",
            accountNumber: "1234567890",
            accountName: "SHOP NAME",
            branch: "Chi nhánh HCM",
          },
        ],
      },
      {
        id: "vnpay",
        name: "VNPAY",
        description: "Thanh toán qua VNPAY",
        icon: "vnpay-icon",
        additionalInfo: "Hỗ trợ thẻ ATM nội địa, Visa, Master",
      },
    ];

    res.json(paymentMethods);
  } catch (error) {
    res.status(500).json({ message: "Lỗi server" });
  }
};

exports.createCodOrder = async (req, res) => {
  try {
    const {
      shippingInfo,
      cartItems,
      voucher,
      totalAmount,
      shippingFee,
      discountAmount,
      finalAmount,
    } = req.body;

    if (!shippingInfo || !cartItems || !finalAmount) {
      return res.status(400).json({ message: "Thiếu thông tin đơn hàng" });
    }

    // Kiểm tra và cập nhật số lượng tồn kho
    for (const item of cartItems) {
      const product = await Product.findById(item.product._id);
      if (!product) {
        return res.status(404).json({
          message: `Không tìm thấy sản phẩm với ID: ${item.product._id}`,
        });
      }

      if (product.stock < item.quantity) {
        return res.status(400).json({
          message: `Sản phẩm ${product.name} chỉ còn ${product.stock} trong kho`,
        });
      }

      await product.updateStock(-item.quantity);
    }

    const order = new Order({
      user: req.user._id,
      items: cartItems.map((item) => ({
        product: item.product._id,
        quantity: item.quantity,
        price: item.product.price,
        size: item.size,
        color: item.color,
      })),
      shippingInfo,
      paymentMethod: "cod",
      totalAmount,
      shippingFee: 30000,
      voucher: voucher ? voucher._id : null,
      discountAmount,
      finalAmount,
      codAmount: finalAmount,
      status: "pending",
      codStatus: "pending",
    });

    await order.save();

    // Tạo delivery record
    const newDelivery = new Delivery({
      order: order._id,
      shippingInfo: { ...shippingInfo },
      status: "pending",
      trackingNumber: `TN${Date.now()}${Math.floor(Math.random() * 1000)}`,
      estimatedDeliveryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 ngày sau
    });
    await newDelivery.save();

    // Update order với deliveryId
    order.delivery = newDelivery._id;
    await order.save();

    // Populate và tạo hóa đơn song song
    const [populatedOrder, invoice] = await Promise.all([
      Order.findById(order._id)
        .populate({
          path: "items.product",
          select: "name price",
        })
        .populate("user", "email")
        .populate("delivery")
        .lean(),
      createInvoiceFromOrder(order),
    ]);

    // Clear cart và gửi email
    Cart.findOneAndUpdate(
      { user: req.user._id },
      {
        $set: {
          items: [],
          voucher: null,
          discountAmount: 0,
        },
      }
    ).exec();

    const user = await User.findById(req.user._id);
    sendOrderConfirmationEmail(user.email, populatedOrder, invoice).catch(
      (err) => console.error("Error sending email:", err)
    );

    res.status(201).json({
      message: "Đặt hàng thành công",
      order: populatedOrder,
      delivery: newDelivery,
      invoiceId: invoice._id,
    });
  } catch (error) {
    console.error("Lỗi khi tạo đơn hàng COD:", error);
    res.status(500).json({ message: "Lỗi khi tạo đơn hàng" });
  }
};

const updateVoucherAfterOrder = async (cart, userId) => {
  if (cart.voucher) {
    const voucher = await Voucher.findById(cart.voucher);
    if (voucher && voucher.isActive) {
      if (!voucher.hasUserUsed(userId)) {
        const updatedVoucher = await Voucher.findByIdAndUpdate(
          cart.voucher,
          {
            $inc: { usedCount: 1 },
            $push: {
              usedBy: {
                user: userId,
                usedAt: new Date(),
              },
            },
          },
          { new: true }
        );

        // Kiểm tra và vô hiệu hóa nếu đã hết lượt
        if (updatedVoucher.usedCount >= updatedVoucher.usageLimit) {
          await Voucher.findByIdAndUpdate(cart.voucher, { isActive: false });
        }
      }
    }
  }
};

exports.cancelOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }

    // Kiểm tra quyền
    if (order.user.toString() !== userId.toString()) {
      return res
        .status(403)
        .json({ message: "Không có quyền hủy đơn hàng này" });
    }

    // Sử dụng State Pattern để hủy đơn hàng
    const result = await order.cancelOrder();

    // Cập nhật delivery nếu có
    if (order.delivery) {
      const delivery = await Delivery.findById(order.delivery);
      if (delivery) {
        // Sử dụng State Pattern cho Delivery
        await delivery.cancelDelivery();
      }
    }

    res.json({
      message: result,
      order: order,
    });
  } catch (error) {
    console.error("Error cancelling order:", error);
    res.status(500).json({ message: "Lỗi khi hủy đơn hàng" });
  }
};
