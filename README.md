# 01交易所 BTC 网格自动交易脚本

适用于 [01.xyz](https://01.xyz) 交易所的 BTC/USD 网格交易自动化脚本。

## ✨ 功能特点

- 🎯 **自动网格下单**：根据当前价格自动在上下方挂买卖限价单
- 📊 **动态窗口调整**：订单始终围绕当前市场价格，自动撤销远离窗口的订单
- 🛡️ **风控机制**：支持 RSI/ADX 指标触发的冷却保护
- 💰 **Post-Only 模式**：自动启用 Post-Only，节省手续费
- ⚡ **剥头皮策略**：可配置为紧密间距的高频交易模式

## 📋 使用方法

### 1. 准备工作

1. 登录 [01.xyz](https://01.xyz) 交易所
2. 打开 BTC/USD 交易页面
3. 在右侧面板手动设置好 **Size**（每单开仓数量）

### 2. 运行脚本

1. 按 **F12** 打开浏览器开发者工具
2. 切换到 **Console** 标签
3. 复制 `01_grid.js` 全部代码，粘贴到 Console 并回车
4. 输入以下命令启动：

```javascript
autoTrader.startAutoTrading()
```

### 3. 常用命令

| 命令 | 功能 |
|------|------|
| `autoTrader.startAutoTrading()` | 启动自动交易 |
| `autoTrader.stopAutoTrading()` | 停止自动交易 |
| `autoTrader.getStatus()` | 查看当前状态 |
| `autoTrader.cancelAllOrders()` | 取消所有挂单 |
| `autoTrader.resetRiskCooldown()` | 重置风控冷却 |

## ⚙️ 参数配置

在代码开头的 `GRID_STRATEGY_CONFIG` 中调整：

```javascript
static GRID_STRATEGY_CONFIG = {
    TOTAL_ORDERS: 10,           // 总订单数
    WINDOW_PERCENT: 0.005,      // 窗口范围 (0.5% ≈ ±$475)
    BASE_PRICE_INTERVAL: 10,    // 网格间距 $10
    SAFE_GAP: 3,                // 首单距盘口距离 $3
    // ...
}
```

### 策略模式建议

| 模式 | WINDOW_PERCENT | SAFE_GAP | TOTAL_ORDERS | 适用场景 |
|------|----------------|----------|--------------|----------|
| 保守 | 0.12 (12%) | 20 | 18 | 震荡行情，宽幅网格 |
| 激进 | 0.03 (3%) | 5 | 18 | 窄幅震荡 |
| 剥头皮 | 0.005 (0.5%) | 3 | 10 | 高频小幅获利 |

## ⚠️ 风险提示

- 本脚本仅供学习研究使用
- 加密货币交易存在较高风险，可能导致本金损失
- 请在充分了解风险后谨慎使用
- 建议先用小资金测试

## 📝 更新日志

### 2026-01-19
- 优化订单方向识别（支持 01 交易所的颜色标识）
- 添加循环撤单逻辑（解决表格虚拟滚动限制）
- 支持剥头皮策略参数配置

## 📄 License

MIT License
