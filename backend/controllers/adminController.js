const Product = require("../models/Product");
const Order = require("../models/Order");
const User = require("../models/User");
const Voucher = require("../models/Voucher");
const moment = require("moment");
const { createStatisticsReportPDF } = require("../utils/pdfGenerator");
const Delivery = require("../models/Delivery");

exports.getAllProducts = async (req, res) => {
  try {
    const products = await Product.find();
    res.json(products);
  } catch (error) {
    res
      .status(500)
      .json({
        message: "Lỗi khi lấy danh sách sản phẩm",
        error: error.message,
      });
  }
};

exports.createProduct = async (req, res) => {
  try {
    const { name, price, description, category } = req.body;
    const image = req.file ? req.file.filename : "";
    const newProduct = new Product({
      name,
      price,
      description,
      category,
      image,
    });
    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (error) {
    res.status(500).json({ message: "Lỗi khi tạo sản phẩm mới" });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, description, category } = req.body;
    const image = req.file ? req.file.path : undefined;

    const updateData = { name, price, description, category };
    if (image) {
      updateData.image = image;
    }

    const updatedProduct = await Product.findByIdAndUpdate(id, updateData, {
      new: true,
    });

    if (!updatedProduct) {
      return res.status(404).json({ message: "Không tìm thấy sản phẩm" });
    }

    res.json(updatedProduct);
  } catch (error) {
    console.error("Error updating product:", error);
    res.status(500).json({ message: "Lỗi khi cập nhật sản phẩm" });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: "Sản phẩm đã được xóa" });
  } catch (error) {
    res.status(500).json({ message: "Lỗi khi xóa sản phẩm" });
  }
};

exports.getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user", "username email")
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ message: "Lỗi khi lấy danh sách đơn hàng" });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    console.log(`[DEBUG] Nhận yêu cầu cập nhật đơn hàng ${id} sang trạng thái ${status}`);
    
    const order = await Order.findById(id);
    
    if (!order) {
      console.log(`[DEBUG] Không tìm thấy đơn hàng với ID ${id}`);
      return res.status(404).json({ 
        success: false, 
        message: "Không tìm thấy đơn hàng" 
      });
    }
    
    console.log(`[DEBUG] Đơn hàng hiện tại: ${order._id}, trạng thái: ${order.status}`);
    
    // Sử dụng state pattern
    console.log(`[DEBUG] Gọi order.changeState(${status})`);
    const stateResult = await order.changeState(status);
    console.log(`[DEBUG] Kết quả changeState:`, stateResult);
    
    // Xử lý kết quả từ state pattern
    if (!stateResult.success) {
      console.log(`[DEBUG] Cập nhật thất bại:`, stateResult.message);
      return res.status(400).json(stateResult);
    }
    
    console.log(`[DEBUG] Cập nhật thành công, trả về response`);
    return res.json({
      success: true,
      message: stateResult.message,
      order: order
    });
  } catch (error) {
    console.error("[DEBUG] Lỗi ngoại lệ:", error);
    res.status(500).json({ 
      success: false,
      message: error.message || "Lỗi khi cập nhật trạng thái"
    });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select("username email role isActive");
    res.json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: "Lỗi khi lấy danh sách người dùng" });
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { isActive },
      { new: true }
    ).select("-password");
    if (!updatedUser) {
      return res.status(404).json({ message: "Không tìm thấy người dùng" });
    }
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user status:", error);
    res.status(500).json({ message: "Lỗi khi cập nhật trạng thái người dùng" });
  }
};

exports.getStatistics = async (req, res) => {
  try {
    const { startDate, endDate, period } = req.query;
    const start = startDate
      ? moment(startDate).startOf("day")
      : moment().subtract(30, "days").startOf("day");
    const end = endDate ? moment(endDate).endOf("day") : moment().endOf("day");

    const totalRevenue = await calculateTotalRevenue(start, end);
    const totalOrders = await countDeliveredOrders(start, end);
    const totalUsers = await User.countDocuments();
    const topProducts = await getTopProducts(start, end);
    const salesData = await getSalesData(start, end, period);

    res.json({
      totalRevenue,
      totalOrders,
      totalUsers,
      topProducts,
      salesData,
    });
  } catch (error) {
    console.error("Error in getStatistics:", error);
    res
      .status(500)
      .json({ message: "Error fetching statistics", error: error.message });
  }
};
//Tính tổng doanh thu
async function calculateTotalRevenue(start, end) {
  const result = await Order.aggregate([
    {
      $match: {
        status: "delivered",
        updatedAt: { $gte: start.toDate(), $lte: end.toDate() },
      },
    },
    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
  ]);
  return result[0]?.total || 0;
}
//đếm số đơn hàng đã giao
async function countDeliveredOrders(start, end) {
  return await Order.countDocuments({
    status: "delivered",
    updatedAt: { $gte: start.toDate(), $lte: end.toDate() },
  });
}

async function getTopProducts(start, end) {
  try {
    const topProducts = await Order.aggregate([
      {
        $match: {
          status: "delivered",
          createdAt: { $gte: start.toDate(), $lte: end.toDate() },
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product",
          soldQuantity: { $sum: "$items.quantity" },
          revenue: { $sum: { $multiply: ["$items.quantity", "$items.price"] } },
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "productInfo",
        },
      },
      { $unwind: "$productInfo" },
      {
        $project: {
          name: "$productInfo.name",
          soldQuantity: 1,
          revenue: 1,
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]);

    return topProducts;
  } catch (error) {
    console.error("Error getting top products:", error);
    return [];
  }
}

async function getSalesData(start, end, period) {
  try {
    let groupBy;
    let dateFormat;
    let interval;

    switch (period) {
      case "day":
        groupBy = {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          day: { $dayOfMonth: "$updatedAt" },
        };
        dateFormat = "DD/MM/YYYY";
        interval = { days: 1 };
        break;
      case "week":
        groupBy = {
          year: { $year: "$updatedAt" },
          week: { $week: "$updatedAt" },
        };
        dateFormat = "[Tuần] w/YYYY";
        interval = { weeks: 1 };
        break;
      case "month":
        groupBy = {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
        };
        dateFormat = "MM/YYYY";
        interval = { months: 1 };
        break;
      default:
        throw new Error("Khoảng thời gian không hợp lệ");
    }

    const result = await Order.aggregate([
      {
        $match: {
          status: "delivered",
          updatedAt: { $gte: start.toDate(), $lte: end.toDate() },
        },
      },
      {
        $group: {
          _id: groupBy,
          revenue: { $sum: "$totalAmount" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Tạo mảng các ngày trong khoảng
    let currentDate = moment(start);
    const dates = [];
    while (currentDate <= end) {
      dates.push(moment(currentDate));
      currentDate = moment(currentDate).add(1, `${period}s`);
    }

    // Map kết quả với các ngày
    return dates.map((date) => {
      const matchingData = result.find((item) => {
        if (period === "day") {
          return (
            item._id.year === date.year() &&
            item._id.month === date.month() + 1 &&
            item._id.day === date.date()
          );
        } else if (period === "week") {
          return item._id.year === date.year() && item._id.week === date.week();
        } else {
          return (
            item._id.year === date.year() && item._id.month === date.month() + 1
          );
        }
      });

      return {
        date: date.format(dateFormat),
        revenue: matchingData ? matchingData.revenue : 0,
        orders: matchingData ? matchingData.orders : 0,
      };
    });
  } catch (error) {
    console.error("Error in getSalesData:", error);
    throw error;
  }
}

exports.getDashboardData = async (req, res) => {
  try {
    const lowStockProducts = await Product.find({
      $expr: { $lte: ["$stock", "$lowStockThreshold"] },
    }).select("name stock lowStockThreshold");

    res.json({
      lowStockProducts,
    });
  } catch (error) {
    res.status(500).json({ message: "Lỗi server", error: error.message });
  }
};

exports.createVoucher = async (req, res) => {
  console.log("Đang xử lý yêu cầu tạo voucher:", req.body);
  try {
    const newVoucher = new Voucher(req.body);
    console.log("Voucher mới trước khi lưu:", newVoucher);
    await newVoucher.save();
    console.log("Voucher đã được lưu vào database:", newVoucher);
    res.status(201).json(newVoucher);
  } catch (error) {
    console.error("Lỗi khi tạo voucher:", error);
    res
      .status(400)
      .json({ message: "Lỗi khi tạo voucher", error: error.message });
  }
};

exports.getAllVouchers = async (req, res) => {
  console.log("Đang xử lý yêu cầu lấy tất cả voucher");
  try {
    const vouchers = await Voucher.find();
    console.log("Vouchers từ database:", vouchers);
    res.json(vouchers);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách voucher:", error);
    res
      .status(500)
      .json({ message: "Lỗi khi lấy danh sách voucher", error: error.message });
  }
};

exports.updateVoucher = async (req, res) => {
  try {
    const updatedVoucher = await Voucher.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!updatedVoucher) {
      return res.status(404).json({ message: "Không tìm thấy voucher" });
    }
    res.json(updatedVoucher);
  } catch (error) {
    res
      .status(400)
      .json({ message: "Lỗi khi cập nhật voucher", error: error.message });
  }
};

exports.deleteVoucher = async (req, res) => {
  try {
    const deletedVoucher = await Voucher.findByIdAndDelete(req.params.id);
    if (!deletedVoucher) {
      return res.status(404).json({ message: "Không tìm thấy voucher" });
    }
    res.json({ message: "Đã xóa voucher thành công" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Lỗi khi xóa voucher", error: error.message });
  }
};

exports.changeUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ message: "Vai trò không hợp lệ" });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { role },
      { new: true }
    ).select("-password");

    if (!user) {
      return res.status(404).json({ message: "Không tìm thấy người dùng" });
    }

    res.json(user);
  } catch (error) {
    console.error("Error changing user role:", error);
    res.status(500).json({ message: "Lỗi khi thay đổi vai trò người dùng" });
  }
};

exports.toggleUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    console.log(
      `Toggle status request for user ID: ${id} by admin: ${req.user._id}`
    );

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: "ID người dùng không hợp lệ" });
    }

    // Kiểm tra nếu admin đang cố khóa tài khoản của chính mình
    if (id === req.user._id.toString()) {
      return res.status(400).json({
        message: "Không thể khóa tài khoản của chính mình",
      });
    }

    // Lấy trạng thái hiện tại của user
    const currentUser = await User.findById(id).select("isActive");

    if (!currentUser) {
      return res.status(404).json({ message: "Không tìm thấy người dùng" });
    }

    // Đảo ngược trạng thái isActive
    const newStatus = !currentUser.isActive;

    // Sử dụng findByIdAndUpdate thay vì save() để tránh validation toàn bộ
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { isActive: newStatus },
      { new: true, runValidators: false }
    ).select("_id username email role isActive");

    console.log(
      `User ${id} status changed to: ${newStatus ? "active" : "inactive"}`
    );

    res.json({
      message: `Tài khoản đã được ${newStatus ? "mở khóa" : "khóa"} thành công`,
      user: updatedUser,
    });
  } catch (error) {
    console.error("Error toggling user status:", error);
    res.status(500).json({
      message: "Lỗi khi thay đổi trạng thái người dùng: " + error.message,
    });
  }
};
exports.downloadStatisticsReport = async (req, res) => {
  try {
    const { startDate, endDate, period } = req.query;

    // Chuyển đổi và kiểm tra ngày hợp lệ
    const start = moment(startDate);
    const end = moment(endDate);

    if (!start.isValid() || !end.isValid()) {
      throw new Error("Ngày không hợp lệ");
    }

    // Đảm bảo start date bắt đầu từ đầu ngày và end date kết thúc cuối ngày
    const startDateTime = start.startOf(period);
    const endDateTime = end.endOf(period);

    // Kiểm tra khoảng thời gian hợp lệ
    if (!["day", "week", "month"].includes(period)) {
      throw new Error("Khoảng thời gian không hợp lệ");
    }

    if (endDateTime.isBefore(startDateTime)) {
      throw new Error("Ngày kết thúc phải sau ngày bắt đầu");
    }

    const stats = {
      totalRevenue: await calculateTotalRevenue(startDateTime, endDateTime),
      totalOrders: await countDeliveredOrders(startDateTime, endDateTime),
      totalUsers: await User.countDocuments(),
      topProducts: (await getTopProducts(startDateTime, endDateTime)).map(
        (product) => ({
          name: product.name || "Không xác định",
          soldQuantity: product.soldQuantity || 0,
          revenue: product.revenue || 0,
        })
      ),
      salesData: await getSalesData(startDateTime, endDateTime, period),
    };

    // Định dạng tên file theo period
    const periodText = {
      day: "ngay",
      week: "tuan",
      month: "thang",
    };

    const filename = `bao-cao-thong-ke-${periodText[period]}-${start.format(
      "DDMMYYYY"
    )}-${end.format("DDMMYYYY")}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    // Thêm thông tin period vào tiêu đề báo cáo
    const periodTitle = {
      day: "Theo ngày",
      week: "Theo tuần",
      month: "Theo tháng",
    };

    await createStatisticsReportPDF(
      stats,
      `${periodTitle[period]}: ${start.format("DD/MM/YYYY")} - ${end.format(
        "DD/MM/YYYY"
      )}`,
      res
    );
  } catch (error) {
    console.error("Error generating statistics report:", error);
    if (!res.headersSent) {
      res.status(500).json({
        message: "Lỗi khi tạo báo cáo thống kê",
        error: error.message,
      });
    }
  }
};
