# 更新日志 / Changelog

## v2.1 优化版 (2026-01-20) - 01_grid_v2.1_optimized.js

基于 298 分钟实盘运行数据分析后的优化版本。

### 问题诊断

通过分析 `exportFullReport()` 导出的日志发现：
- 运行 298 分钟，检测到 **0 次插针**
- 17,729 次大单新增，17,578 次大单移除
- 市场在 $93,000-$93,400 窄幅震荡
- 原因：`spikeThreshold: 60` 对于窄幅市场过高

### 核心优化

#### 1. 插针检测阈值优化 (WhaleMonitor.CONFIG)

| 参数 | v2.0 | v2.1 | 说明 |
|------|------|------|------|
| `spikeThreshold` | $60 | $40 | 降低绝对阈值 |
| `spikeThresholdPercent` | - | 0.04% | 新增百分比阈值 |
| `usePercentThreshold` | - | true | 启用百分比模式 |
| `spikeWindowLong` | - | [15, 30] | 新增长期检测窗口 |
| `minDownSpikeSize` | $150 | $100 | 降低最小插针幅度 |

#### 2. 狙击策略优化 (SNIPER_CONFIG)

**LONG_AFTER_DOWN (下插做多)**
| 参数 | v2.0 | v2.1 | 说明 |
|------|------|------|------|
| `minSpikeSize` | $100 | $50 | 更容易触发 |
| `stopLoss` | $60 | $40 | 更紧的止损 |
| `takeProfit` | [80, 120] | [50, 80] | 更低的止盈目标 |
| `confirmVacuum` | true | false | 不强制真空确认 |

**V_SHAPE_REVERSAL (V型反转)**
| 参数 | v2.0 | v2.1 | 说明 |
|------|------|------|------|
| `maxInterval` | 30秒 | 45秒 | 更长的检测窗口 |
| `minDownSize` | $150 | $80 | 更小的触发幅度 |

#### 3. 网格策略优化 (GRID_STRATEGY_CONFIG)

| 参数 | v2.0 | v2.1 | 说明 |
|------|------|------|------|
| `WINDOW_PERCENT` | 0.3% | 0.5% | 更宽的窗口减少频繁撤单 |
| `SAFE_GAP` | $3 | $5 | 更大的首单安全距离 |
| `RSI_MAX` | 65 | 70 | 放宽 RSI 上限 |

#### 4. detectSpike() 方法重构

- 支持动态阈值计算（百分比或绝对值）
- 三时间窗口检测：短期(2-6秒)、中期(5-15秒)、长期(15-30秒)
- 返回值增加 `changePercent` 和 `window` 字段

### 使用方法

与 v2.0 完全相同：

```javascript
// 启动自动交易
autoTrader.startAutoTrading()

// 启动止盈止损监控
tpslManager.start()

// 导出报告供分析
autoTrader.exportFullReport()
```

### 预期效果

- 在窄幅震荡市场中能检测到更多插针信号
- V型反转检测更灵敏
- 网格更稳定，减少频繁撤单重挂
- 止损更紧，风险控制更好

---

## v2.0 (2026-01-20) - 01_grid.js

- 新增：大单监控模块（WhaleMonitor）
- 新增：插针检测与狙击功能
- 新增：V型反转检测
- 新增：持仓止盈止损自动挂单（PositionStopLossManager）
- 新增：完整日志导出（供AI分析优化）
- 优化：风险警报级别系统

## v1.0 (2026-01-19)

- 优化订单方向识别（支持 01 交易所的颜色标识）
- 添加循环撤单逻辑（解决表格虚拟滚动限制）
- 支持剥头皮策略参数配置
