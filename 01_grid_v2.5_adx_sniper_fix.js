// 01交易所 BTC 网格自动下单系统 - 带风控冷却机制 + 插针狙击
// 基于原版 var_grid.js 改写，适配 01.xyz 交易所
// v2.5 - 新增 ADX 指标风控 + 修复狙击与风控冲突
//
// v2.5 新增：
//   - 📊 新增 ADX 指标读取（索引16）
//   - ADX > 25 确认趋势，ADX > 30 强趋势
//   - 风控逻辑：ATR 检测波动 + ADX 确认趋势 + RSI 超买超卖
//   - 🔧 修复：图表指标风控不再阻止插针狙击入场
//   - 风控来源区分：INDICATOR(图表指标) vs WHALE(大单监控)
//   - 只有大单监控风控才会阻止狙击，图表指标风控时狙击仍可执行
//
// v2.4 新增：
//   - 📦 日志持久化管理器 (LogPersistenceManager)
//   - 自动保存日志到 localStorage（每60秒 + 页面关闭前）
//   - 关闭页面后可恢复日志
//   - 定期自动导出日志文件
//
// v2.3 修复：
//   - 🔧 修复止盈止损单因 Post-Only 被拒绝的问题
//   - 止盈止损单现在会临时关闭 Post-Only，确保能成交
//   - 下单后自动恢复 Post-Only 设置
//
// v2.2 新增功能：
//   - 保证金保护管理器 (MarginProtectionManager)
//   - 当仓位占用超过50%时自动启动挂单平仓
//   - 通过 Close Position 对话框执行限价平仓
//   - 支持自定义阈值和平仓比例
//
// v2.1 优化内容：
//   - 降低插针检测阈值（$60→$40，支持百分比阈值 0.04%）
//   - 增加长期检测窗口（15-30秒）
//   - 降低狙击策略门槛（更容易触发）
//   - 扩大网格窗口范围（0.3%→0.5%）

// ==================== 大单监控模块 ====================
class WhaleMonitor {
    // 监控配置（基于298分钟数据分析优化 v2.1）
    static CONFIG = {
        checkInterval: 1000,          // 检查间隔 1秒
        whaleThreshold: 50000,        // 大单阈值 $50k USDC

        // 插针检测阈值（优化：降低阈值提高灵敏度）
        spikeThreshold: 40,           // 绝对阈值 $40（从$60降低）
        spikeThresholdPercent: 0.04,  // 相对阈值 0.04%（约$37在$93k时）
        usePercentThreshold: true,    // 优先使用百分比阈值

        // 检测时间窗口（优化：增加多个窗口）
        spikeWindowShort: [2, 6],     // 短期窗口 2-6秒
        spikeWindowMid: [5, 15],      // 中期窗口 5-15秒
        spikeWindowLong: [15, 30],    // 长期窗口 15-30秒（新增）

        // 真空检测参数
        vacuumRange: 150,             // 检测范围 ±$150
        vacuumMinWhales: 3,           // 少于3个大单视为真空

        // 撤单速度监控
        velocityWindow: 10000,        // 速度计算窗口 10秒
        highRemovalVelocity: 3,       // 高撤单速度阈值 3次/秒

        // 订单簿不平衡参数
        imbalanceWarning: 0.4,
        imbalanceCritical: 0.6,

        // V型反转检测
        vShapeWindow: 30000,          // V型反转检测窗口 30秒
        minDownSpikeSize: 100,        // DOWN至少 $100（从$150降低）

        // 标志性订单规模（做市商特征）
        signatureSize1: 53600,        // 做市商标准小单
        signatureSize2: 93000,        // 1 BTC 订单
        signatureTolerance: 500,
    };

    // 狙击策略配置（优化 v2.1：降低门槛提高触发率）
    static SNIPER_CONFIG = {
        // DOWN_SPIKE 做多策略
        LONG_AFTER_DOWN: {
            enabled: true,
            minSpikeSize: 50,         // 最小插针幅度 $50（从$100降低）
            stopLoss: 40,             // 止损 $40（从$60降低）
            takeProfit: [50, 80],     // 分批止盈（从[80,120]降低）
            trailingStop: 30,         // 移动止损 $30
            maxHoldTime: 300000,      // 最大持仓 5分钟
            confirmVacuum: false,     // 不强制要求真空确认
        },

        // V型反转策略
        V_SHAPE_REVERSAL: {
            enabled: true,
            maxInterval: 45000,       // 两次插针间隔 ≤45秒（从30秒增加）
            minDownSize: 80,          // DOWN至少 $80（从$150降低）
            stopLoss: 30,
            takeProfit: [60, 100],
        }
    };

    constructor() {
        this.isRunning = false;
        this.whaleOrders = new Map();
        this.priceHistory = [];
        this.logs = [];
        this.spikeEvents = [];

        // 监控指标
        this.metrics = {
            vacuumDetected: false,
            vacuumStartTime: null,
            removalVelocity: 0,
            imbalanceRatio: 0,
            priceVelocity: 0,
            lastSpike: null,
        };

        // 统计
        this.stats = {
            totalNewOrders: 0,
            totalRemovedOrders: 0,
            upSpikes: 0,
            downSpikes: 0,
            signalsGenerated: 0,
        };

        // 警报级别
        this.alertLevel = 'GREEN';

        // 信号队列（供主交易系统使用）
        this.pendingSignals = [];
    }

    // ========== 订单簿抓取（复用01.xyz的DOM结构）==========
    getOrderBookData() {
        const whales = { asks: [], bids: [] };

        try {
            // 卖单（红色/pink）
            const askRows = document.querySelectorAll('div[class*="text-01-pink"][class*="z-20"]');
            askRows.forEach(el => {
                const priceText = el.textContent?.trim();
                const price = parseFloat(priceText?.replace(/,/g, ''));
                if (!price || price < 80000 || price > 150000) return;

                const row = el.closest('[class*="grid"]');
                if (!row) return;

                const spans = row.querySelectorAll('div[class*="z-20"], span');
                let sizeUSDC = null;

                spans.forEach(span => {
                    const text = span.textContent?.trim()?.replace(/,/g, '');
                    const num = parseFloat(text);
                    if (num >= WhaleMonitor.CONFIG.whaleThreshold && num < 1000000) {
                        sizeUSDC = num;
                    }
                });

                if (sizeUSDC) {
                    whales.asks.push({ price, sizeUSDC, side: 'ask' });
                }
            });

            // 买单（绿色/green）
            const bidRows = document.querySelectorAll('div[class*="text-01-green"][class*="z-20"]');
            bidRows.forEach(el => {
                const priceText = el.textContent?.trim();
                const price = parseFloat(priceText?.replace(/,/g, ''));
                if (!price || price < 80000 || price > 150000) return;

                const row = el.closest('[class*="grid"]');
                if (!row) return;

                const spans = row.querySelectorAll('div[class*="z-20"], span');
                let sizeUSDC = null;

                spans.forEach(span => {
                    const text = span.textContent?.trim()?.replace(/,/g, '');
                    const num = parseFloat(text);
                    if (num >= WhaleMonitor.CONFIG.whaleThreshold && num < 1000000) {
                        sizeUSDC = num;
                    }
                });

                if (sizeUSDC) {
                    whales.bids.push({ price, sizeUSDC, side: 'bid' });
                }
            });
        } catch (e) {
            // 静默失败
        }

        return whales;
    }

    getCurrentMidPrice() {
        try {
            const priceSpans = document.querySelectorAll('span.text-base.number');
            let askPrice = null, bidPrice = null;

            priceSpans.forEach(span => {
                const text = span.textContent.trim();
                if (text.startsWith('$')) {
                    const price = parseFloat(text.replace(/[$,]/g, ''));
                    if (price > 80000 && price < 150000) {
                        if (!askPrice) askPrice = price;
                        else if (!bidPrice) bidPrice = price;
                    }
                }
            });

            if (askPrice && bidPrice) {
                if (askPrice < bidPrice) [askPrice, bidPrice] = [bidPrice, askPrice];
                return (askPrice + bidPrice) / 2;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    // ========== 核心监控逻辑 ==========
    tick() {
        const orderbook = this.getOrderBookData();
        const currentPrice = this.getCurrentMidPrice();
        if (!currentPrice) return null;

        // 1. 更新价格历史
        this.updatePriceHistory(currentPrice);

        // 2. 检测大单变化
        this.detectWhaleChanges(orderbook, currentPrice);

        // 3. 更新各项指标
        this.updateMetrics(orderbook, currentPrice);

        // 4. 评估风险等级
        this.evaluateRisk();

        // 5. 检测插针
        const spike = this.detectSpike(currentPrice);
        if (spike) {
            this.handleSpike(spike, orderbook);
        }

        // 6. 检测V型反转
        this.detectVShapeReversal();

        return {
            price: currentPrice,
            alertLevel: this.alertLevel,
            metrics: { ...this.metrics },
            hasPendingSignal: this.pendingSignals.length > 0
        };
    }

    updatePriceHistory(currentPrice) {
        this.priceHistory.push({
            time: Date.now(),
            price: currentPrice
        });

        // 保留最近60秒数据
        const cutoff = Date.now() - 60000;
        this.priceHistory = this.priceHistory.filter(p => p.time > cutoff);
    }

    detectWhaleChanges(orderbook, currentPrice) {
        const currentWhales = new Map();
        const allOrders = [...orderbook.asks, ...orderbook.bids];

        allOrders.forEach(order => {
            const key = `${order.side}_${order.price}`;
            currentWhales.set(key, order);
        });

        // 检测新增大单
        currentWhales.forEach((order, key) => {
            if (!this.whaleOrders.has(key)) {
                this.stats.totalNewOrders++;
                this.logs.push({
                    timestamp: new Date().toISOString(),
                    action: 'NEW_WHALE_ORDER',
                    side: order.side,
                    order: { ...order }
                });

                // 检测标志性订单
                const cfg = WhaleMonitor.CONFIG;
                const isSignature = Math.abs(order.sizeUSDC - cfg.signatureSize1) < cfg.signatureTolerance ||
                                   Math.abs(order.sizeUSDC - cfg.signatureSize2) < cfg.signatureTolerance;
                if (isSignature) {
                    console.log(`%c🐋 标志性大单: ${order.side.toUpperCase()} $${order.price.toFixed(1)} | $${order.sizeUSDC.toLocaleString()}`,
                        'color: #FF9800;');
                }
            }
        });

        // 检测撤销大单
        this.whaleOrders.forEach((order, key) => {
            if (!currentWhales.has(key)) {
                this.stats.totalRemovedOrders++;
                this.logs.push({
                    timestamp: new Date().toISOString(),
                    action: 'WHALE_ORDER_REMOVED',
                    side: order.side,
                    order: { ...order },
                    currentPrice
                });
            }
        });

        this.whaleOrders = currentWhales;

        // 限制日志数量
        if (this.logs.length > 2000) this.logs = this.logs.slice(-2000);
    }

    updateMetrics(orderbook, currentPrice) {
        // 1. 真空检测
        this.detectVacuum(orderbook, currentPrice);

        // 2. 撤单速度
        this.calculateRemovalVelocity();

        // 3. 订单簿不平衡度
        this.calculateImbalance(orderbook);

        // 4. 价格速度
        this.calculatePriceVelocity();
    }

    detectVacuum(orderbook, currentPrice) {
        const range = WhaleMonitor.CONFIG.vacuumRange;
        const minWhales = WhaleMonitor.CONFIG.vacuumMinWhales;

        const nearbyAsks = orderbook.asks.filter(o =>
            o.price <= currentPrice + range && o.price >= currentPrice
        );
        const nearbyBids = orderbook.bids.filter(o =>
            o.price >= currentPrice - range && o.price <= currentPrice
        );

        const totalNearby = nearbyAsks.length + nearbyBids.length;

        if (totalNearby < minWhales) {
            if (!this.metrics.vacuumDetected) {
                this.metrics.vacuumDetected = true;
                this.metrics.vacuumStartTime = Date.now();
                console.log('%c⚠️ 订单簿真空检测! 附近大单仅 ' + totalNearby + ' 个',
                    'color: #FF5722; font-weight: bold; font-size: 14px;');
            }
        } else {
            if (this.metrics.vacuumDetected) {
                const duration = (Date.now() - this.metrics.vacuumStartTime) / 1000;
                console.log(`%c✅ 真空结束，持续 ${duration.toFixed(1)} 秒`, 'color: #4CAF50;');
            }
            this.metrics.vacuumDetected = false;
            this.metrics.vacuumStartTime = null;
        }
    }

    calculateRemovalVelocity() {
        const window = WhaleMonitor.CONFIG.velocityWindow;
        const cutoff = Date.now() - window;

        const recentRemovals = this.logs.filter(l =>
            l.action === 'WHALE_ORDER_REMOVED' &&
            new Date(l.timestamp).getTime() > cutoff
        );

        this.metrics.removalVelocity = recentRemovals.length / (window / 1000);

        if (this.metrics.removalVelocity > WhaleMonitor.CONFIG.highRemovalVelocity) {
            console.log(`%c⚠️ 高撤单速度: ${this.metrics.removalVelocity.toFixed(1)}/秒`,
                'color: #FF9800;');
        }
    }

    calculateImbalance(orderbook) {
        const bidVolume = orderbook.bids.reduce((sum, o) => sum + o.sizeUSDC, 0);
        const askVolume = orderbook.asks.reduce((sum, o) => sum + o.sizeUSDC, 0);
        this.metrics.imbalanceRatio = (bidVolume - askVolume) / (bidVolume + askVolume + 1);
    }

    calculatePriceVelocity() {
        if (this.priceHistory.length < 2) {
            this.metrics.priceVelocity = 0;
            return;
        }

        const recent = this.priceHistory.slice(-10);
        const oldest = recent[0];
        const newest = recent[recent.length - 1];

        const timeDiff = (newest.time - oldest.time) / 1000;
        const priceDiff = newest.price - oldest.price;

        this.metrics.priceVelocity = timeDiff > 0 ? priceDiff / timeDiff : 0;
    }

    // ========== 风险评估 ==========
    evaluateRisk() {
        let riskScore = 0;

        if (this.metrics.vacuumDetected) riskScore += 3;
        if (this.metrics.removalVelocity > WhaleMonitor.CONFIG.highRemovalVelocity) riskScore += 2;
        if (Math.abs(this.metrics.imbalanceRatio) > WhaleMonitor.CONFIG.imbalanceCritical) riskScore += 2;
        else if (Math.abs(this.metrics.imbalanceRatio) > WhaleMonitor.CONFIG.imbalanceWarning) riskScore += 1;
        if (Math.abs(this.metrics.priceVelocity) > 20) riskScore += 2;

        let newLevel;
        if (riskScore >= 6) newLevel = 'RED';
        else if (riskScore >= 4) newLevel = 'ORANGE';
        else if (riskScore >= 2) newLevel = 'YELLOW';
        else newLevel = 'GREEN';

        if (newLevel !== this.alertLevel) {
            this.setAlertLevel(newLevel, riskScore);
        }
        this.alertLevel = newLevel;
    }

    setAlertLevel(level, score) {
        const colors = {
            GREEN: '#4CAF50',
            YELLOW: '#FFC107',
            ORANGE: '#FF9800',
            RED: '#F44336'
        };
        const messages = {
            GREEN: '市场正常',
            YELLOW: '注意观察',
            ORANGE: '高风险状态',
            RED: '⚠️ 即将插针！准备入场'
        };

        console.log(
            `%c[${level}] ${messages[level]} (风险分: ${score})`,
            `color: ${colors[level]}; font-weight: bold; font-size: 14px;`
        );

        if (level === 'RED' && 'Notification' in window && Notification.permission === 'granted') {
            new Notification('01.xyz 插针警报!', { body: messages[level] });
        }
    }

    // ========== 插针检测（优化 v2.1：支持百分比阈值 + 长期窗口）==========
    detectSpike(currentPrice) {
        if (this.priceHistory.length < 3) return null;

        const cfg = WhaleMonitor.CONFIG;

        // 计算动态阈值（支持百分比或绝对值）
        const getThreshold = (multiplier = 1) => {
            if (cfg.usePercentThreshold) {
                return currentPrice * cfg.spikeThresholdPercent / 100 * multiplier;
            }
            return cfg.spikeThreshold * multiplier;
        };

        // 短期窗口 2-6秒
        const shortWindow = cfg.spikeWindowShort || [2, 6];
        const shortHistory = this.priceHistory.filter(p =>
            Date.now() - p.time >= shortWindow[0] * 1000 &&
            Date.now() - p.time <= shortWindow[1] * 1000
        );

        // 中期窗口 5-15秒
        const midWindow = cfg.spikeWindowMid || [5, 15];
        const midHistory = this.priceHistory.filter(p =>
            Date.now() - p.time >= midWindow[0] * 1000 &&
            Date.now() - p.time <= midWindow[1] * 1000
        );

        // 长期窗口 15-30秒（新增）
        const longWindow = cfg.spikeWindowLong || [15, 30];
        const longHistory = this.priceHistory.filter(p =>
            Date.now() - p.time >= longWindow[0] * 1000 &&
            Date.now() - p.time <= longWindow[1] * 1000
        );

        let spike = null;

        // 优先检测短期剧烈波动（阈值 1x）
        if (shortHistory.length > 0) {
            const oldPrice = shortHistory[0].price;
            const change = currentPrice - oldPrice;
            const threshold = getThreshold(1);

            if (Math.abs(change) >= threshold) {
                spike = {
                    type: change > 0 ? 'UP_SPIKE' : 'DOWN_SPIKE',
                    fromPrice: oldPrice,
                    toPrice: currentPrice,
                    change,
                    changePercent: (change / oldPrice * 100).toFixed(3),
                    duration: Date.now() - shortHistory[0].time,
                    window: 'short',
                    time: new Date().toISOString()
                };
            }
        }

        // 中期窗口检测（阈值 1.2x）
        if (!spike && midHistory.length > 0) {
            const oldPrice = midHistory[0].price;
            const change = currentPrice - oldPrice;
            const threshold = getThreshold(1.2);

            if (Math.abs(change) >= threshold) {
                spike = {
                    type: change > 0 ? 'UP_SPIKE' : 'DOWN_SPIKE',
                    fromPrice: oldPrice,
                    toPrice: currentPrice,
                    change,
                    changePercent: (change / oldPrice * 100).toFixed(3),
                    duration: Date.now() - midHistory[0].time,
                    window: 'mid',
                    time: new Date().toISOString()
                };
            }
        }

        // 长期窗口检测（阈值 1.5x，新增）
        if (!spike && longHistory.length > 0) {
            const oldPrice = longHistory[0].price;
            const change = currentPrice - oldPrice;
            const threshold = getThreshold(1.5);

            if (Math.abs(change) >= threshold) {
                spike = {
                    type: change > 0 ? 'UP_SPIKE' : 'DOWN_SPIKE',
                    fromPrice: oldPrice,
                    toPrice: currentPrice,
                    change,
                    changePercent: (change / oldPrice * 100).toFixed(3),
                    duration: Date.now() - longHistory[0].time,
                    window: 'long',
                    time: new Date().toISOString()
                };
            }
        }

        return spike;
    }

    handleSpike(spike, orderbook) {
        const lastSpike = this.metrics.lastSpike;
        if (lastSpike && Date.now() - new Date(lastSpike.time).getTime() < 5000) return;

        this.metrics.lastSpike = spike;

        if (spike.type === 'UP_SPIKE') this.stats.upSpikes++;
        else this.stats.downSpikes++;

        spike.nearbyWhales = {
            asks: orderbook.asks.filter(o => Math.abs(o.price - spike.toPrice) < 300),
            bids: orderbook.bids.filter(o => Math.abs(o.price - spike.toPrice) < 300)
        };

        this.spikeEvents.push(spike);
        if (this.spikeEvents.length > 100) this.spikeEvents = this.spikeEvents.slice(-100);

        const color = spike.type === 'UP_SPIKE' ? '#4CAF50' : '#F44336';
        const arrow = spike.type === 'UP_SPIKE' ? '📈' : '📉';

        console.log(
            `%c${arrow} ${spike.type}: $${spike.fromPrice.toFixed(1)} → $${spike.toPrice.toFixed(1)} (${spike.change > 0 ? '+' : ''}${spike.change.toFixed(1)})`,
            `color: ${color}; font-weight: bold; font-size: 16px;`
        );

        // 检查入场信号
        this.checkEntrySignal(spike);
    }

    detectVShapeReversal() {
        const config = WhaleMonitor.SNIPER_CONFIG.V_SHAPE_REVERSAL;
        if (!config.enabled) return;

        const recentSpikes = this.spikeEvents.filter(s =>
            Date.now() - new Date(s.time).getTime() < config.maxInterval
        );

        if (recentSpikes.length < 2) return;

        const last = recentSpikes[recentSpikes.length - 1];
        const prev = recentSpikes[recentSpikes.length - 2];

        if (prev.type === 'DOWN_SPIKE' && last.type === 'UP_SPIKE') {
            const interval = new Date(last.time) - new Date(prev.time);

            if (interval <= config.maxInterval && Math.abs(prev.change) >= config.minDownSize) {
                console.log(
                    '%c🔄 V型反转确认! DOWN(-$' + Math.abs(prev.change).toFixed(0) +
                    ') → UP(+$' + last.change.toFixed(0) + ') 间隔' + (interval/1000).toFixed(1) + '秒',
                    'color: #9C27B0; font-weight: bold; font-size: 14px;'
                );

                this.generateSignal({
                    type: 'V_SHAPE_LONG',
                    confidence: 0.9,
                    entryPrice: last.toPrice,
                    stopLoss: config.stopLoss,
                    takeProfit: config.takeProfit,
                    reason: 'V型反转'
                });
            }
        }
    }

    checkEntrySignal(spike) {
        if (spike.type === 'DOWN_SPIKE') {
            const config = WhaleMonitor.SNIPER_CONFIG.LONG_AFTER_DOWN;
            if (!config.enabled) return;
            if (Math.abs(spike.change) < config.minSpikeSize) return;

            // 不再强制要求真空确认（优化 v2.1）
            if (config.confirmVacuum && !this.metrics.vacuumDetected) {
                if (Math.abs(spike.change) < 80) return;  // 从150降低到80
            }

            // 计算置信度（优化：根据多个因素综合判断）
            let confidence = 0.6;  // 基础置信度
            if (this.metrics.vacuumDetected) confidence += 0.2;
            if (Math.abs(spike.change) >= 80) confidence += 0.1;
            if (spike.window === 'short') confidence += 0.1;  // 短期窗口更可信

            // 生成做多信号
            this.generateSignal({
                type: 'LONG_AFTER_DOWN',
                confidence: Math.min(confidence, 0.95),
                entryPrice: spike.toPrice,
                stopLoss: config.stopLoss,
                takeProfit: config.takeProfit,
                trailingStop: config.trailingStop,
                maxHoldTime: config.maxHoldTime,
                reason: `DOWN_SPIKE做多 (跌幅: $${Math.abs(spike.change).toFixed(0)}, 窗口: ${spike.window})`
            });
        }
    }

    generateSignal(signal) {
        if (signal.confidence < 0.7) return;

        this.stats.signalsGenerated++;
        this.pendingSignals.push({
            ...signal,
            timestamp: Date.now()
        });

        // 限制信号队列长度
        if (this.pendingSignals.length > 10) {
            this.pendingSignals = this.pendingSignals.slice(-10);
        }

        console.log('%c═══════════════════════════════════════════', 'color: #9C27B0;');
        console.log('%c  🎯 入场信号生成', 'color: #9C27B0; font-weight: bold; font-size: 16px;');
        console.log('%c═══════════════════════════════════════════', 'color: #9C27B0;');
        console.log(`  类型: ${signal.type}`);
        console.log(`  入场价: $${signal.entryPrice.toFixed(1)}`);
        console.log(`  止损: $${signal.stopLoss}`);
        console.log(`  止盈: $${signal.takeProfit.join(' / $')}`);
        console.log(`  置信度: ${(signal.confidence * 100).toFixed(0)}%`);
        console.log(`  原因: ${signal.reason}`);
    }

    // ========== 获取待处理信号 ==========
    getPendingSignal() {
        // 返回最新的有效信号（30秒内）
        const validSignals = this.pendingSignals.filter(s =>
            Date.now() - s.timestamp < 30000
        );
        return validSignals.length > 0 ? validSignals[validSignals.length - 1] : null;
    }

    clearPendingSignals() {
        this.pendingSignals = [];
    }

    // ========== 导出数据 ==========
    exportData() {
        return {
            exportTime: new Date().toISOString(),
            stats: this.stats,
            spikeEvents: this.spikeEvents,
            currentWhales: {
                asks: Array.from(this.whaleOrders.values()).filter(o => o.side === 'ask'),
                bids: Array.from(this.whaleOrders.values()).filter(o => o.side === 'bid')
            },
            logs: this.logs.slice(-1000)
        };
    }

    getStatus() {
        return {
            alertLevel: this.alertLevel,
            metrics: { ...this.metrics },
            stats: { ...this.stats },
            pendingSignals: this.pendingSignals.length
        };
    }
}

// ==================== 主交易系统 ====================
class BTCAutoTrading {
    // ========== 基础交易配置 ==========
    static TRADING_CONFIG = {
        START_PRICE: 80000,
        END_PRICE: 120000,
        MIN_ORDER_INTERVAL: 2000,      // 下单最小间隔
        ORDER_COOLDOWN: 1500,          // 单个订单成功后冷却
        MONITOR_INTERVAL: 5000,        // 主循环检查间隔
        MAX_PROCESSED_ORDERS: 100,
        POSITION_CHECK_DELAY: 2000,
        MAX_POSITION_CHECKS: 60,
        UI_OPERATION_DELAY: 500,
        PRICE_UPDATE_DELAY: 1000,
        ORDER_SUBMIT_DELAY: 1500,
        CLOSE_POSITION_CYCLE: 30,
        RISK_COOLDOWN_MINUTES: 15,     // 风控冷却时间（15分钟）
        CHECK_INTERVAL_RISK: 10000     // 风控状态下检查间隔
    };

    // ========== 网格策略核心配置 ==========
    // 网格策略核心配置（优化 v2.1：扩大窗口适应平稳行情）
    static GRID_STRATEGY_CONFIG = {
        TOTAL_ORDERS: 10,              // 总订单数

        // 窗口宽度（优化：扩大窗口范围）
        WINDOW_PERCENT: 0.005,         // 0.5% 窗口范围（约 ±$465，从0.3%扩大）

        // 买卖单比例（总和必须为1）
        SELL_RATIO: 0.5,
        BUY_RATIO: 0.5,

        // 网格间距
        BASE_PRICE_INTERVAL: 10,       // 基础间距 $10
        SAFE_GAP: 5,                   // 安全间距 $5（从$3扩大，降低成交频率）

        // 安全保护
        MAX_DRIFT_BUFFER: 600,         // 漂移缓冲（从500扩大）
        MIN_VALID_PRICE: 10000,
        MAX_MULTIPLIER: 15,

        // 策略配置（RSI/ATR/ADX 风控）
        RSI_MIN: 30,
        RSI_MAX: 70,                  // 从65提高到70，减少风控触发
        ATR_TREND_THRESHOLD: 100,     // ATR 趋势阈值
        ATR_STRONG_TREND: 150,        // ATR 强趋势阈值
        ADX_TREND_THRESHOLD: 25,      // ADX 趋势确认阈值（>25 表示趋势明确）
        ADX_STRONG_TREND: 30          // ADX 强趋势阈值（>30 表示强趋势）
    };

    // ========== 01交易所页面元素选择器 ==========
    static SELECTORS = {
        // 价格输入框
        PRICE_INPUT: 'input#limitPrice',
        // 数量输入框
        SIZE_INPUT: 'input#_inputSize',
        // 盘口价格（Ask/Bid）
        PRICE_DISPLAY: 'span.text-base.number',
        // Open Orders 表格（第一个table）
        ORDERS_TABLE: 'table',
        // Post Only 按钮
        POST_ONLY_BTN: 'button#post-only',
        // Reduce Only 按钮
        REDUCE_ONLY_BTN: 'button#reduce-only'
    };

    // ========== 文本匹配 ==========
    static TEXT_MATCH = {
        OPEN_ORDERS: ['Open Orders'],
        POSITIONS: ['Positions'],
        LIMIT_BUTTON: ['Limit'],
        MARKET_BUTTON: ['Market'],
        BUY_BUTTON: ['Buy | Long', 'Buy Long'],
        SELL_BUTTON: ['Sell | Short', 'Sell Short'],
        CANCEL_BUTTON: ['Cancel']
    };

    constructor() {
        this.orderManager = new OrderManager01();
        this.isMonitoring = false;
        this.monitorInterval = null;
        this.tradingEnabled = false;
        this.processedOrders = new Set();
        this.lastOrderTime = 0;
        this.cycleCount = 0;
        this.isPrepared = false;
        this.riskCoolingDown = false;
        this.riskCoolDownEndTime = 0;
        this.riskTriggeredReason = '';
        this.riskCooldownSource = null;    // 风控来源: 'INDICATOR' | 'WHALE'

        this.minOrderInterval = BTCAutoTrading.TRADING_CONFIG.MIN_ORDER_INTERVAL;

        // ====== 交易日志系统 ======
        this.tradingLogs = [];
        this.sessionStartTime = null;
        this.totalOrders = 0;
        this.successfulOrders = 0;
        this.cancelledOrders = 0;

        // ====== 当前指标 ======
        this.currentRsi = null;
        this.currentAtr = null;
        this.currentAdx = null;

        // ====== 大单监控模块 ======
        this.whaleMonitor = new WhaleMonitor();
        this.whaleMonitorInterval = null;
        this.sniperModeEnabled = true;     // 是否启用插针狙击模式
        this.lastSniperSignal = null;       // 最近的狙击信号
        this.sniperPosition = null;         // 狙击仓位状态
        this.isSniperExecuting = false;     // 狙击执行锁，防止并发
    }

    // ==================== 准备交易环境 ====================
    async prepareTradingEnvironment() {
        try {
            // 1. 点击 Open Orders 标签
            const openOrdersTab = this.findButtonByText(BTCAutoTrading.TEXT_MATCH.OPEN_ORDERS);
            if (openOrdersTab) {
                openOrdersTab.click();
                await this.delay(BTCAutoTrading.TRADING_CONFIG.UI_OPERATION_DELAY);
            }

            // 2. 点击 Limit 按钮
            await this.clickLimitButton();
            await this.delay(BTCAutoTrading.TRADING_CONFIG.UI_OPERATION_DELAY);

            // 3. 确保 Post Only 已勾选
            await this.ensurePostOnlyEnabled();
            await this.delay(BTCAutoTrading.TRADING_CONFIG.UI_OPERATION_DELAY);

            // 4. 等待仓位设置
            await this.checkAndWaitForPositionSize();

            this.isPrepared = true;
            return true;
        } catch (err) {
            console.error('交易环境准备失败:', err);
            return false;
        }
    }

    findButtonByText(textArray) {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn =>
            textArray.some(t => btn.textContent.includes(t))
        );
    }

    async clickLimitButton() {
        const limitBtn = this.findButtonByText(BTCAutoTrading.TEXT_MATCH.LIMIT_BUTTON);
        if (limitBtn) {
            limitBtn.click();
            await this.delay(BTCAutoTrading.TRADING_CONFIG.UI_OPERATION_DELAY);
            return true;
        }
        console.log('未找到Limit按钮，继续...');
        return false;
    }

    async ensurePostOnlyEnabled() {
        // 查找所有 post-only 按钮（页面上可能有多个下单面板）
        const postOnlyBtns = document.querySelectorAll(BTCAutoTrading.SELECTORS.POST_ONLY_BTN);

        for (const btn of postOnlyBtns) {
            // 检查按钮状态 - 通过 data-state 或 aria-checked 属性
            const isChecked = btn.getAttribute('data-state') === 'checked' ||
                btn.getAttribute('aria-checked') === 'true' ||
                btn.classList.contains('bg-01-green') ||
                btn.classList.contains('checked');

            if (!isChecked) {
                btn.click();
                console.log('已启用 Post Only');
                await this.delay(200);
            }
        }
        return true;
    }

    async checkAndWaitForPositionSize() {
        let checks = 0;
        while (checks < BTCAutoTrading.TRADING_CONFIG.MAX_POSITION_CHECKS) {
            const input = document.querySelector(BTCAutoTrading.SELECTORS.SIZE_INPUT);
            if (input && parseFloat(input.value) > 0) {
                console.log(`仓位已设置: ${input.value}`);
                return true;
            }
            checks++;
            console.warn('请先手动设置仓位数量！');
            await this.delay(BTCAutoTrading.TRADING_CONFIG.POSITION_CHECK_DELAY);
        }
        console.error('超时：请先手动设置仓位数量！');
        this.showWarningMessage('请先在Size框输入开仓大小！');
        return false;
    }

    async getCurrentPrice() {
        const prices = this.getBidAskPrices();
        if (!prices.ask || !prices.bid) return null;
        return (prices.ask + prices.bid) / 2;
    }

    getBidAskPrices() {
        // 01交易所的盘口价格在 span.text-base.number 中
        // 第一个是 Ask（卖一），第二个是 Bid（买一）
        const priceSpans = document.querySelectorAll('span.text-base.number');
        let askPrice = null;
        let bidPrice = null;

        priceSpans.forEach(span => {
            const text = span.textContent.trim();
            if (text.startsWith('$')) {
                const price = parseFloat(text.replace(/[$,]/g, ''));
                if (price > 0) {
                    // 根据父元素位置判断是 Ask 还是 Bid
                    const parent = span.closest('div');
                    if (parent) {
                        // Ask 价格通常在上方/左侧
                        if (!askPrice) {
                            askPrice = price;
                        } else if (!bidPrice) {
                            bidPrice = price;
                        }
                    }
                }
            }
        });

        // 确保 Ask > Bid（卖一价应该高于买一价）
        if (askPrice && bidPrice && askPrice < bidPrice) {
            [askPrice, bidPrice] = [bidPrice, askPrice];
        }

        return { ask: askPrice, bid: bidPrice };
    }

    async getTradeInfo() {
        // 获取当前仓位
        let positionBTC = 0;

        // 尝试从 Positions 标签页获取仓位信息
        const positionsTab = this.findButtonByText(BTCAutoTrading.TEXT_MATCH.POSITIONS);
        if (positionsTab) {
            // 可以从页面上读取仓位，这里简化处理
            // 实际使用时可能需要更精确的选择器
        }

        // 获取开仓大小
        const sizeInput = document.querySelector(BTCAutoTrading.SELECTORS.SIZE_INPUT);
        const orderSize = sizeInput ? parseFloat(sizeInput.value) || 0 : 0;

        console.log(`当前仓位: ${positionBTC.toFixed(4)} BTC`);
        console.log(`开仓大小: ${orderSize}`);
        return { positionBTC, orderSize };
    }

    // ==================== 风控冷却相关方法 ====================
    // source: 'INDICATOR' = 图表指标风控（不阻止狙击）
    //         'WHALE' = 大单监控风控（阻止狙击）
    async triggerRiskCooldown(reason, source = 'INDICATOR') {
        this.riskCoolingDown = true;
        this.riskTriggeredReason = reason;
        this.riskCooldownSource = source;  // 记录风控来源

        const cooldownMs = BTCAutoTrading.TRADING_CONFIG.RISK_COOLDOWN_MINUTES * 60 * 1000;
        this.riskCoolDownEndTime = Date.now() + cooldownMs;

        const endTime = new Date(this.riskCoolDownEndTime).toLocaleTimeString();
        const sourceLabel = source === 'INDICATOR' ? '📊 图表指标' : '🐋 大单监控';
        console.log(`%c⚠️ 触发风控冷却 [${sourceLabel}]：${reason}`, "color: red; font-weight: bold; font-size: 14px;");
        console.log(`%c冷却时间：15分钟，恢复时间：${endTime}`, "color: orange;");

        if (source === 'INDICATOR') {
            console.log('%c💡 狙击模式不受图表指标风控影响，仍可执行插针入场', 'color: #9C27B0;');
        }

        try {
            console.log('开始取消所有订单...');
            await this.cancelAllOrders();
            console.log('✅ 所有订单取消完成');

            await this.delay(500);

            console.log('开始平仓...');
            await this.closeAllPositions();
            console.log('✅ 平仓操作完成');

            console.log(`%c✅ 风控处理完成，进入冷却期`, "color: #4CAF50; font-weight: bold;");
        } catch (error) {
            console.error(`%c❌ 风控处理失败: ${error.message}`, "color: red; font-weight: bold;");
        }
    }

    checkRiskCooldown() {
        if (!this.riskCoolingDown) return false;

        const now = Date.now();
        if (now >= this.riskCoolDownEndTime) {
            this.riskCoolingDown = false;
            this.riskTriggeredReason = '';
            this.riskCooldownSource = null;
            console.log(`%c✅ 风控冷却已结束，恢复交易`, "color: green; font-weight: bold;");
            return false;
        }

        const remainingMs = this.riskCoolDownEndTime - now;
        const remainingMinutes = Math.floor(remainingMs / 60000);
        const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
        const sourceLabel = this.riskCooldownSource === 'INDICATOR' ? '📊' : '🐋';
        console.log(`%c⏳ 风控冷却中 ${sourceLabel}: ${remainingMinutes}分${remainingSeconds}秒`, "color: orange;");

        return true;
    }

    resetRiskCooldown() {
        this.riskCoolingDown = false;
        this.riskCoolDownEndTime = 0;
        this.riskTriggeredReason = '';
        this.riskCooldownSource = null;
        console.log(`%c✅ 风控冷却已手动重置`, "color: green; font-weight: bold;");
    }

    getRiskCooldownStatus() {
        if (!this.riskCoolingDown) {
            return { inCooldown: false, message: '风控冷却未激活' };
        }

        const remainingMs = this.riskCoolDownEndTime - Date.now();
        const remainingMinutes = Math.floor(remainingMs / 60000);
        const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
        const endTime = new Date(this.riskCoolDownEndTime).toLocaleTimeString();
        const sourceLabel = this.riskCooldownSource === 'INDICATOR' ? '图表指标' : '大单监控';
        const sniperBlocked = this.riskCooldownSource === 'WHALE';

        return {
            inCooldown: true,
            reason: this.riskTriggeredReason,
            source: this.riskCooldownSource,
            sourceLabel,
            sniperBlocked,  // 狙击是否被阻止
            remainingMinutes,
            remainingSeconds,
            endTime,
            message: `风控冷却中 [${sourceLabel}] - ${this.riskTriggeredReason}，剩余: ${remainingMinutes}分${remainingSeconds}秒` +
                     (sniperBlocked ? '' : '（狙击可用）')
        };
    }

    // ==================== 主控方法 ====================
    async startAutoTrading(interval = BTCAutoTrading.TRADING_CONFIG.MONITOR_INTERVAL) {
        if (this.isMonitoring) return console.log('已在运行');

        const ready = await this.prepareTradingEnvironment();
        if (!ready) return console.error('环境准备失败，无法启动');

        this.isMonitoring = true;
        this.tradingEnabled = true;
        this.cycleCount = 0;
        this.sessionStartTime = Date.now();
        this.clearLogs();

        console.log('%c========================================', 'color: #4CAF50; font-weight: bold;');
        console.log('%c  01交易所 网格自动交易已启动', 'color: #4CAF50; font-weight: bold; font-size: 16px;');
        console.log('%c  + 大单监控 & 插针狙击模块 v2.0', 'color: #9C27B0; font-weight: bold;');
        console.log('%c========================================', 'color: #4CAF50; font-weight: bold;');
        console.log('Post Only 模式已启用，节省手续费');
        console.log(`插针狙击模式: ${this.sniperModeEnabled ? '✅ 已启用' : '❌ 已禁用'}`);

        // 启动大单监控（独立的高频循环）
        this.startWhaleMonitor();

        // 请求桌面通知权限
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        const executeWithInterval = async () => {
            if (!this.isMonitoring) return;

            const startTime = Date.now();
            await this.executeTradingCycle();
            const executionTime = Date.now() - startTime;

            let nextDelay;
            if (this.riskCoolingDown) {
                nextDelay = Math.max(BTCAutoTrading.TRADING_CONFIG.CHECK_INTERVAL_RISK - executionTime, 1000);
            } else {
                nextDelay = Math.max(interval - executionTime, 1000);
            }

            if (this.isMonitoring) {
                setTimeout(executeWithInterval, nextDelay);
            }
        };

        executeWithInterval();
    }

    // ==================== 大单监控启动 ====================
    startWhaleMonitor() {
        if (this.whaleMonitorInterval) {
            clearInterval(this.whaleMonitorInterval);
        }

        console.log('%c🐋 大单监控已启动 (间隔: 1秒)', 'color: #2196F3;');

        this.whaleMonitorInterval = setInterval(async () => {
            if (!this.isMonitoring) return;

            try {
                const result = this.whaleMonitor.tick();

                // 检查是否有狙击信号 - 立即响应！
                if (this.sniperModeEnabled && result?.hasPendingSignal) {
                    // 使用锁防止并发执行
                    if (!this.isSniperExecuting) {
                        this.isSniperExecuting = true;
                        try {
                            await this.handleSniperSignal();
                        } finally {
                            this.isSniperExecuting = false;
                        }
                    }
                }

                // 同时管理现有狙击仓位
                if (this.sniperPosition && !this.isSniperExecuting) {
                    await this.manageSniperPosition();
                }
            } catch (e) {
                console.warn('大单监控周期出错:', e.message);
                this.isSniperExecuting = false;
            }
        }, WhaleMonitor.CONFIG.checkInterval);
    }

    stopWhaleMonitor() {
        if (this.whaleMonitorInterval) {
            clearInterval(this.whaleMonitorInterval);
            this.whaleMonitorInterval = null;
            console.log('%c🐋 大单监控已停止', 'color: #f44336;');
        }
    }

    // ==================== 狙击信号处理 ====================
    async handleSniperSignal() {
        const signal = this.whaleMonitor.getPendingSignal();
        if (!signal) return;

        // 避免重复处理同一信号
        if (this.lastSniperSignal &&
            this.lastSniperSignal.timestamp === signal.timestamp) {
            return;
        }

        this.lastSniperSignal = signal;

        // 只有大单监控触发的风控才阻止狙击
        // 图表指标风控（RSI/ATR/ADX）不阻止狙击，因为插针本身就是极端行情
        if (this.riskCoolingDown && this.riskCooldownSource === 'WHALE') {
            console.log('%c狙击信号被大单监控风控阻止', 'color: orange;');
            return;
        }

        // 如果是图表指标风控，记录但继续执行狙击
        if (this.riskCoolingDown && this.riskCooldownSource === 'INDICATOR') {
            console.log('%c📊 图表指标风控中，但狙击信号优先执行', 'color: #9C27B0; font-weight: bold;');
        }

        // 如果已有狙击仓位，不再开新仓
        if (this.sniperPosition) {
            console.log('%c已有狙击仓位，跳过新信号', 'color: orange;');
            return;
        }

        console.log('%c═══════════════════════════════════════════', 'color: #E91E63;');
        console.log('%c  🎯 执行狙击入场!', 'color: #E91E63; font-weight: bold; font-size: 16px;');
        console.log('%c═══════════════════════════════════════════', 'color: #E91E63;');

        // 根据信号类型执行下单
        if (signal.type === 'LONG_AFTER_DOWN' || signal.type === 'V_SHAPE_LONG') {
            // 做多信号 - 在当前价位下买单
            const currentPrice = await this.getCurrentPrice();
            if (currentPrice) {
                // 计算入场价（可以在信号价位稍下方挂单）
                const entryPrice = Math.floor(currentPrice - 5);

                console.log(`狙击做多: 入场价 $${entryPrice}`);
                console.log(`止损: $${signal.stopLoss} | 止盈: $${signal.takeProfit.join('/$')}`);

                // 执行买单
                const success = await this.orderManager.placeLimitBuy(entryPrice);

                if (success) {
                    this.sniperPosition = {
                        type: 'LONG',
                        entryPrice: entryPrice,
                        stopLoss: signal.stopLoss,
                        takeProfit: signal.takeProfit,
                        trailingStop: signal.trailingStop,
                        maxHoldTime: signal.maxHoldTime,
                        openTime: Date.now(),
                        signal: signal
                    };

                    this.logTrade('SNIPER_ENTRY', {
                        signalType: signal.type,
                        entryPrice: entryPrice,
                        stopLoss: signal.stopLoss,
                        takeProfit: signal.takeProfit
                    });

                    console.log('%c✅ 狙击买单已下', 'color: #4CAF50; font-weight: bold;');
                } else {
                    console.log('%c❌ 狙击买单失败', 'color: #f44336;');
                }
            }
        }

        // 清除已处理的信号
        this.whaleMonitor.clearPendingSignals();
    }

    // ==================== 狙击仓位管理 ====================
    async manageSniperPosition() {
        if (!this.sniperPosition) return;

        const currentPrice = await this.getCurrentPrice();
        if (!currentPrice) return;

        const pos = this.sniperPosition;
        const pnl = pos.type === 'LONG'
            ? currentPrice - pos.entryPrice
            : pos.entryPrice - currentPrice;

        // 检查止损
        if (pnl <= -pos.stopLoss) {
            console.log(`%c❌ 狙击止损触发: $${pnl.toFixed(1)}`, 'color: #F44336; font-weight: bold;');
            await this.closeSniperPosition('STOP_LOSS', pnl);
            return;
        }

        // 检查止盈
        for (const tp of pos.takeProfit) {
            if (pnl >= tp) {
                console.log(`%c✅ 狙击止盈触发: $${tp}`, 'color: #4CAF50; font-weight: bold;');
                await this.closeSniperPosition('TAKE_PROFIT', pnl);
                return;
            }
        }

        // 检查移动止损
        if (pos.trailingStop && pnl > pos.trailingStop) {
            const newStopLoss = pnl - pos.trailingStop;
            if (newStopLoss > -pos.stopLoss) {
                pos.stopLoss = -newStopLoss;
                console.log(`移动止损更新: $${pos.stopLoss.toFixed(1)}`);
            }
        }

        // 检查最大持仓时间
        if (pos.maxHoldTime && Date.now() - pos.openTime > pos.maxHoldTime) {
            console.log('%c⏱️ 狙击持仓超时，平仓', 'color: #FF9800;');
            await this.closeSniperPosition('TIMEOUT', pnl);
        }
    }

    async closeSniperPosition(reason, pnl) {
        console.log(`狙击平仓: ${reason}, PnL: $${pnl.toFixed(1)}`);

        this.logTrade('SNIPER_EXIT', {
            reason: reason,
            pnl: pnl,
            position: { ...this.sniperPosition }
        });

        // 这里可以添加实际的平仓逻辑
        // 简化处理：只清除状态，实际平仓依赖手动或其他机制
        this.sniperPosition = null;
    }

    // ==================== 狙击模式开关 ====================
    enableSniperMode() {
        this.sniperModeEnabled = true;
        console.log('%c🎯 插针狙击模式已启用', 'color: #4CAF50; font-weight: bold;');
    }

    disableSniperMode() {
        this.sniperModeEnabled = false;
        console.log('%c🎯 插针狙击模式已禁用', 'color: #f44336;');
    }

    stopAutoTrading() {
        this.isMonitoring = false;
        this.tradingEnabled = false;
        clearInterval(this.monitorInterval);
        this.monitorInterval = null;

        // 停止大单监控
        this.stopWhaleMonitor();

        // 导出大单监控数据
        const whaleData = this.whaleMonitor.exportData();
        console.log('%c大单监控数据:', 'color: #2196F3;', whaleData.stats);

        console.log('%c自动交易已停止', 'color: red; font-weight: bold;');
    }

    // ==================== 核心交易周期 ====================
    async executeTradingCycle() {
        if (!this.tradingEnabled) return;
        this.cycleCount++;

        // 获取大单监控状态
        const whaleStatus = this.whaleMonitor.getStatus();
        const alertEmoji = {
            'GREEN': '🟢',
            'YELLOW': '🟡',
            'ORANGE': '🟠',
            'RED': '🔴'
        }[whaleStatus.alertLevel] || '⚪';

        console.log(`\n[${new Date().toLocaleTimeString()}] 第${this.cycleCount}次循环 ${alertEmoji} ${whaleStatus.alertLevel}`);

        // 1. 检查风控冷却状态
        if (this.checkRiskCooldown()) {
            await this.cancelAllOrders();
            return;
        }

        // 1.5. 检查大单监控红色警报 - 暂停网格下单
        if (whaleStatus.alertLevel === 'RED') {
            console.log('%c⚠️ 红色警报：检测到即将插针，暂停网格下单', 'color: #F44336; font-weight: bold;');
            // 不取消订单，但暂停新下单，让狙击模块接管
            // 管理狙击仓位
            await this.manageSniperPosition();
            return;
        }

        // 1.6. 橙色警报时减少下单
        if (whaleStatus.alertLevel === 'ORANGE') {
            console.log('%c⚠️ 橙色警报：高风险状态，谨慎下单', 'color: #FF9800;');
        }

        // 管理狙击仓位（如果有）
        await this.manageSniperPosition();

        // 2. RSI/ATR/ADX 检查（如果有 TradingView iframe）
        try {
            const indicators = await this.getIndicatorsFromChart();

            if (indicators && typeof indicators.rsi === 'number') {
                const { rsi, atr, adx } = indicators;
                const {
                    RSI_MIN, RSI_MAX,
                    ATR_TREND_THRESHOLD, ATR_STRONG_TREND,
                    ADX_TREND_THRESHOLD, ADX_STRONG_TREND
                } = BTCAutoTrading.GRID_STRATEGY_CONFIG;

                // 保存当前指标（供趋势过滤使用）
                this.currentRsi = rsi;
                this.currentAtr = atr;
                this.currentAdx = adx;

                console.log(`%c当前指标 - RSI: ${rsi?.toFixed(2) || 'N/A'}, ATR: ${atr?.toFixed(2) || 'N/A'}, ADX: ${adx?.toFixed(2) || 'N/A'}`,
                    "color: #ff9800; font-weight: bold;");

                // ========== ATR 风控 ==========
                // ATR 过高表示波动剧烈
                if (atr && atr > ATR_STRONG_TREND) {
                    const reason = `高波动市场 (ATR: ${atr.toFixed(2)} > ${ATR_STRONG_TREND})`;
                    console.log(`%c[风控触发] ${reason}`, "color: red; font-weight: bold;");
                    this.triggerRiskCooldown(reason);
                    return;
                }

                // ========== ADX 风控 ==========
                // ADX > 30 表示强趋势，配合 RSI 超限时触发风控
                if (adx && adx > ADX_STRONG_TREND) {
                    if (rsi < RSI_MIN || rsi > RSI_MAX) {
                        const reason = `强趋势(ADX:${adx.toFixed(1)})中RSI(${rsi.toFixed(1)})超限`;
                        console.log(`%c[风控触发] ${reason}`, "color: red; font-weight: bold;");
                        this.triggerRiskCooldown(reason);
                        return;
                    }
                    // 强趋势但 RSI 正常，记录警告但不触发风控
                    console.log(`%c⚠️ 强趋势市场 (ADX: ${adx.toFixed(2)} > ${ADX_STRONG_TREND})，谨慎下单`, "color: #FF9800;");
                }

                // ========== RSI + ATR 组合风控 ==========
                // RSI 超限 + ATR 表示有趋势时，触发风控
                if (rsi < RSI_MIN || rsi > RSI_MAX) {
                    if (atr && atr > ATR_TREND_THRESHOLD) {
                        const reason = `波动市场(ATR:${atr.toFixed(1)})中RSI(${rsi.toFixed(1)})超限`;
                        console.log(`%c[风控触发] ${reason}`, "color: red; font-weight: bold;");
                        this.triggerRiskCooldown(reason);
                        return;
                    }
                    // ADX 确认趋势时也触发
                    if (adx && adx > ADX_TREND_THRESHOLD) {
                        const reason = `趋势市场(ADX:${adx.toFixed(1)})中RSI(${rsi.toFixed(1)})超限`;
                        console.log(`%c[风控触发] ${reason}`, "color: red; font-weight: bold;");
                        this.triggerRiskCooldown(reason);
                        return;
                    }
                }
            }
        } catch (e) {
            console.warn("读取图表指标失败（可选功能）:", e.message);
            // 指标读取失败不触发风控，继续执行
        }

        // 3. 环境准备
        const ready = await this.prepareTradingEnvironment();
        if (!ready) {
            console.error('环境异常');
            return;
        }

        try {
            // 4. 获取市场数据
            const marketData = await this.getCompleteMarketData();
            if (!marketData.askPrice || !marketData.bidPrice) {
                console.log('无法读取价格，跳过');
                return;
            }

            // 5. 计算目标价格
            const result = await this.calculateTargetPrices(marketData);
            console.log('计算订单结果：', result);

            // 6. 循环撤销远单（解决表格虚拟滚动只能看到部分订单的问题）
            // 每轮撤销可见的远单，然后重新读取，直到没有更多需要撤销的
            let cancelRound = 0;
            const maxCancelRounds = 5;  // 最多循环5轮

            while (cancelRound < maxCancelRounds) {
                cancelRound++;

                // 重新读取当前可见的订单
                const currentMarketData = await this.getCompleteMarketData();
                const currentResult = await this.calculateTargetPrices(currentMarketData);

                if (!currentResult.cancelOrders || currentResult.cancelOrders.length === 0) {
                    console.log(`撤单完成（第${cancelRound}轮），没有更多需要撤销的订单`);
                    break;
                }

                console.log(`第${cancelRound}轮撤单，需撤销 ${currentResult.cancelOrders.length} 个...`);

                let cancelledCount = 0;
                for (const order of currentResult.cancelOrders) {
                    if (!order || !order.price) continue;

                    // 检查是否需要跳过撤单（如果价格接近当前价格）
                    const currentPrice = await this.getCurrentPrice();
                    if (currentPrice) {
                        const targetNum = Number(String(order.price).replace(/[^0-9.]/g, ''));
                        if (targetNum) {
                            const cfg = BTCAutoTrading.GRID_STRATEGY_CONFIG;
                            const priceDiff = Math.abs(targetNum - currentPrice);
                            const safeDistance = cfg.BASE_PRICE_INTERVAL * (cfg.MAX_MULTIPLIER / 4);

                            if (priceDiff <= safeDistance) {
                                console.log(`跳过：$${targetNum} 接近当前价 (差值: ${priceDiff.toFixed(1)})`);
                                continue;
                            }
                        }
                    }

                    await this.orderManager.cancelByPrice(order.price);
                    cancelledCount++;
                    await this.delay(300);
                }

                if (cancelledCount === 0) {
                    console.log(`第${cancelRound}轮：所有订单都在安全范围内，停止撤单`);
                    break;
                }

                // 等待一下让表格更新
                await this.delay(500);
            }

            // 7. 重新获取市场数据
            await this.delay(500);
            const updatedMarketData = await this.getCompleteMarketData();
            const updatedResult = await this.calculateTargetPrices(updatedMarketData);

            // 8. 执行下单
            if (updatedResult.buyPrices.length > 0 || updatedResult.sellPrices.length > 0) {
                await this.executeSafeBatchOrders(
                    updatedResult.buyPrices,
                    updatedResult.sellPrices,
                    updatedMarketData
                );
            }

        } catch (err) {
            console.error('周期执行异常:', err);
        }
    }

    // ==================== 获取市场数据 ====================
    async getCompleteMarketData() {
        const prices = this.getBidAskPrices();
        const askPrice = prices.ask;
        const bidPrice = prices.bid;

        if (!askPrice || !bidPrice) {
            return { askPrice: null, bidPrice: null, existingSellOrders: [], existingBuyOrders: [] };
        }

        await this.delay(BTCAutoTrading.TRADING_CONFIG.PRICE_UPDATE_DELAY);

        // 获取现有订单
        const existingOrders = await this.getExistingOrders();

        return {
            askPrice,
            bidPrice,
            existingSellOrders: existingOrders.sellOrders,
            existingBuyOrders: existingOrders.buyOrders
        };
    }

    // 找到正确的 Open Orders 表格（包含 Cancel 按钮的表格）
    findOpenOrdersTable() {
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            const tbody = table.querySelector('tbody');
            if (!tbody) continue;

            const firstRow = tbody.querySelector('tr');
            if (!firstRow) continue;

            // 检查是否包含 BTC 和 Cancel 按钮
            const hasBTC = firstRow.textContent.includes('BTC');
            const hasCancel = Array.from(firstRow.querySelectorAll('button'))
                .some(btn => btn.textContent.trim() === 'Cancel');

            if (hasBTC && hasCancel) {
                return table;
            }
        }
        return null;
    }

    async getExistingOrders() {
        const sellOrders = [];
        const buyOrders = [];

        // 点击 Open Orders 标签
        const openOrdersTab = this.findButtonByText(BTCAutoTrading.TEXT_MATCH.OPEN_ORDERS);
        if (openOrdersTab) {
            openOrdersTab.click();
            await this.delay(300);
        }

        // 找到正确的 Open Orders 表格
        const orderTable = this.findOpenOrdersTable();
        if (!orderTable) {
            console.warn('未找到 Open Orders 表格');
            return { sellOrders, buyOrders };
        }

        // 滚动表格容器以加载更多订单（解决虚拟滚动问题）
        const scrollContainer = orderTable.closest('[class*="overflow"]') || orderTable.parentElement;
        if (scrollContainer) {
            // 滚动到顶部
            scrollContainer.scrollTop = 0;
            await this.delay(200);
            // 滚动到底部
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
            await this.delay(200);
            // 滚动回顶部
            scrollContainer.scrollTop = 0;
            await this.delay(200);
        }

        const tbody = orderTable.querySelector('tbody');
        if (!tbody) return { sellOrders, buyOrders };

        const rows = tbody.querySelectorAll('tr');
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 3) return;

            // 检查是否是 BTC/USD 订单
            const marketCell = cells[0]?.textContent || '';
            if (!marketCell.includes('BTC')) return;

            // 获取价格（td[2]）
            const priceText = cells[2]?.textContent?.trim() || '';
            const price = parseFloat(priceText.replace(/[$,]/g, ''));
            if (!price || price <= 0) return;

            // 通过市场列的 span class 判断买卖方向
            // text-01-pink = 卖单 (Sell/Short)
            // text-01-middle = 买单 (Buy/Long)
            const marketSpan = cells[0]?.querySelector('span');
            const marketClass = marketSpan?.className || '';

            // 或者通过进度条颜色判断
            const progressBar = row.querySelector('[class*="bg-01-"]');
            const progressClass = progressBar?.className || '';

            if (marketClass.includes('text-01-middle') || progressClass.includes('bg-01-middle')) {
                // 买单 (Buy/Long)
                buyOrders.push(price);
            } else if (marketClass.includes('text-01-pink') || progressClass.includes('bg-01-pink')) {
                // 卖单 (Sell/Short)
                sellOrders.push(price);
            } else {
                // 如果无法判断，根据价格与当前价格比较
                const currentPrice = this.getBidAskPrices();
                const midPrice = (currentPrice.ask + currentPrice.bid) / 2;
                if (price > midPrice) {
                    sellOrders.push(price);
                } else {
                    buyOrders.push(price);
                }
            }
        });

        return {
            sellOrders: sellOrders.sort((a, b) => a - b),
            buyOrders: buyOrders.sort((a, b) => b - a)
        };
    }

    // ==================== 计算目标价格 ====================
    async calculateTargetPrices(marketData) {
        const { askPrice, bidPrice, existingSellOrders = [], existingBuyOrders = [] } = marketData;
        const cfg = BTCAutoTrading.GRID_STRATEGY_CONFIG;

        const midPrice = (askPrice + bidPrice) / 2;
        const windowSize = midPrice * cfg.WINDOW_PERCENT;
        const halfWindow = windowSize / 2;
        const interval = cfg.BASE_PRICE_INTERVAL;

        const tradeInfo = await this.getTradeInfo();
        const positionBTC = tradeInfo.positionBTC || 0;
        const orderSize = tradeInfo.orderSize || 0;
        const MAX_MULTIPLIER = cfg.MAX_MULTIPLIER;

        const safeOrderSize = Math.max(orderSize, 0.000001);
        const positionMultiplier = Math.abs(positionBTC) / safeOrderSize;

        let finalSellRatio = cfg.SELL_RATIO;
        let finalBuyRatio = cfg.BUY_RATIO;
        let isAtLimit = false;

        // 动态调整买卖比例
        if (positionMultiplier >= MAX_MULTIPLIER) {
            isAtLimit = true;
            if (positionBTC > 0) {
                finalBuyRatio = 0;
                finalSellRatio = 1;
            } else if (positionBTC < 0) {
                finalBuyRatio = 1;
                finalSellRatio = 0;
            }
        } else if (positionMultiplier > 0) {
            const reductionRatio = positionMultiplier / MAX_MULTIPLIER;
            if (positionBTC > 0) {
                finalBuyRatio = Math.max(0, cfg.BUY_RATIO - reductionRatio * cfg.BUY_RATIO);
                finalSellRatio = 1 - finalBuyRatio;
            } else if (positionBTC < 0) {
                finalSellRatio = Math.max(0, cfg.SELL_RATIO - reductionRatio * cfg.SELL_RATIO);
                finalBuyRatio = 1 - finalSellRatio;
            }
        }

        if (!isAtLimit) {
            finalBuyRatio = Math.max(0.1, Math.min(0.9, finalBuyRatio));
            finalSellRatio = Math.max(0.1, Math.min(0.9, finalSellRatio));

            // ====== 方案 B：RSI 趋势过滤 ======
            // 根据 RSI 动态调整买卖比例
            if (this.currentRsi !== null) {
                const rsi = this.currentRsi;

                if (rsi > 55) {
                    // 上涨趋势：减少卖单比例，避免在上涨中开空单
                    const adjustFactor = Math.min((rsi - 55) / 30, 0.5);  // 最多减少 50%
                    finalSellRatio = Math.max(0.1, finalSellRatio * (1 - adjustFactor));
                    finalBuyRatio = 1 - finalSellRatio;
                    console.log(`%c[趋势过滤] RSI ${rsi.toFixed(1)} 偏高，卖单比例降至 ${(finalSellRatio * 100).toFixed(0)}%`,
                        "color: #2196F3;");
                } else if (rsi < 45) {
                    // 下跌趋势：减少买单比例，避免在下跌中开多单
                    const adjustFactor = Math.min((45 - rsi) / 30, 0.5);  // 最多减少 50%
                    finalBuyRatio = Math.max(0.1, finalBuyRatio * (1 - adjustFactor));
                    finalSellRatio = 1 - finalBuyRatio;
                    console.log(`%c[趋势过滤] RSI ${rsi.toFixed(1)} 偏低，买单比例降至 ${(finalBuyRatio * 100).toFixed(0)}%`,
                        "color: #2196F3;");
                }
            }
        }

        const sellCount = Math.round(cfg.TOTAL_ORDERS * finalSellRatio);
        const buyCount = cfg.TOTAL_ORDERS - sellCount;

        // 计算卖单价格
        const sellStart = Math.ceil((askPrice + cfg.SAFE_GAP) / interval) * interval;
        const idealSellPrices = [];
        for (let i = 0; i < sellCount; i++) {
            const p = sellStart + i * interval;
            if (p > midPrice + halfWindow + cfg.MAX_DRIFT_BUFFER) break;
            idealSellPrices.push(p);
        }

        // 计算买单价格
        const buyEnd = Math.floor((bidPrice - cfg.SAFE_GAP) / interval) * interval;
        const idealBuyPrices = [];
        for (let i = 0; i < buyCount; i++) {
            const p = buyEnd - i * interval;
            if (p < midPrice - halfWindow - cfg.MAX_DRIFT_BUFFER) break;
            if (p < cfg.MIN_VALID_PRICE) break;
            idealBuyPrices.push(p);
        }

        const idealPricesSet = new Set([...idealSellPrices, ...idealBuyPrices]);

        // 过滤已存在的订单
        const newSellPrices = idealSellPrices.filter(p => !existingSellOrders.includes(p));
        const newBuyPrices = idealBuyPrices.filter(p => !existingBuyOrders.includes(p));

        // 计算需要撤销的订单（撤销所有不在理想价格窗口内的可见订单）
        // 注意：由于表格虚拟滚动，只能读取到可见的订单，所以不再依赖订单总数判断
        const currentTotal = existingSellOrders.length + existingBuyOrders.length;
        const ordersToCancel = [];

        // 找出所有不在理想价格集合中的订单
        const farSellOrders = existingSellOrders
            .filter(p => !idealPricesSet.has(p))
            .sort((a, b) => b - a);  // 从高到低排序，优先撤远的

        const farBuyOrders = existingBuyOrders
            .filter(p => !idealPricesSet.has(p))
            .sort((a, b) => a - b);  // 从低到高排序，优先撤远的

        const allFar = [
            ...farSellOrders.map(p => ({ type: 'sell', price: p })),
            ...farBuyOrders.map(p => ({ type: 'buy', price: p }))
        ];

        // 按照距离中间价的远近排序（最远的优先撤销）
        allFar.sort((a, b) => Math.abs(b.price - midPrice) - Math.abs(a.price - midPrice));

        // 添加到撤销列表（每轮最多撤销 10 个，避免操作太频繁）
        for (let i = 0; i < Math.min(allFar.length, 10); i++) {
            if (allFar[i]) {
                ordersToCancel.push(allFar[i]);
            }
        }

        console.log(`中间价 $${midPrice.toFixed(1)} | 窗口 ±${halfWindow.toFixed(0)}`);
        console.log(`可见订单: ${existingSellOrders.length}卖 + ${existingBuyOrders.length}买 = ${currentTotal}`);
        console.log(`需下单: ${newSellPrices.length}卖 + ${newBuyPrices.length}买`);
        console.log(`需撤单: ${ordersToCancel.length} 个`, ordersToCancel.map(o => `${o?.type}@$${o?.price}`));

        return {
            sellPrices: newSellPrices,
            buyPrices: newBuyPrices,
            cancelOrders: ordersToCancel
        };
    }

    // ==================== 安全批量下单 ====================
    async executeSafeBatchOrders(buyPrices, sellPrices, marketData) {
        const orders = [
            ...buyPrices.map(p => ({ type: 'buy', price: p })),
            ...sellPrices.map(p => ({ type: 'sell', price: p }))
        ];

        console.log(`准备下单:`, orders);

        for (const order of orders) {
            const success = order.type === 'buy'
                ? await this.orderManager.placeLimitBuy(order.price)
                : await this.orderManager.placeLimitSell(order.price);

            // 记录下单日志
            this.logOrderPlaced(order.type, order.price, success);

            if (success) {
                this.lastOrderTime = Date.now();
                await this.delay(BTCAutoTrading.TRADING_CONFIG.ORDER_COOLDOWN);
            }
        }
        console.log('本轮下单完成');
    }

    // ==================== 取消所有订单 ====================
    async cancelAllOrders() {
        console.log('准备取消所有挂单...');

        const openOrdersTab = this.findButtonByText(BTCAutoTrading.TEXT_MATCH.OPEN_ORDERS);
        if (openOrdersTab) {
            openOrdersTab.click();
            await this.delay(500);
        }

        // 找到正确的 Open Orders 表格
        const orderTable = this.findOpenOrdersTable();
        if (!orderTable) {
            console.warn('未找到 Open Orders 表格');
            return;
        }

        const tbody = orderTable.querySelector('tbody');
        if (!tbody) return;

        const rows = tbody.querySelectorAll('tr');

        for (const row of rows) {
            const cancelBtn = Array.from(row.querySelectorAll('button'))
                .find(btn => btn.textContent.trim() === 'Cancel');

            if (cancelBtn) {
                cancelBtn.click();
                await this.delay(500);
            }
        }

        console.log('所有订单取消完成');
    }

    // ==================== 平仓 ====================
    async closeAllPositions() {
        console.log('准备平仓...');

        // 点击 Positions 标签
        const positionsTab = this.findButtonByText(BTCAutoTrading.TEXT_MATCH.POSITIONS);
        if (positionsTab) {
            positionsTab.click();
            await this.delay(500);
        }

        // 查找关闭按钮
        const closeButtons = Array.from(document.querySelectorAll('button'))
            .filter(btn => btn.textContent.toLowerCase().includes('close'));

        for (const btn of closeButtons) {
            btn.click();
            await this.delay(1000);
        }

        console.log('平仓操作完成');
    }

    // ==================== RSI/ATR/ADX 读取模块 ====================
    async getIndicatorsFromChart() {
        const iframe = document.querySelector('iframe');
        if (!iframe) return null;

        try {
            const doc = iframe.contentDocument;
            if (!doc) return null;

            const valueElements = doc.querySelectorAll('div[class*="valueValue"]');
            if (valueElements.length < 17) return null;

            // 根据实际测试：索引 13 是 RSI，索引 15 是 ATR，索引 16 是 ADX
            const rsiText = valueElements[13]?.textContent?.trim();
            const atrText = valueElements[15]?.textContent?.trim();
            const adxText = valueElements[16]?.textContent?.trim();

            const rsi = parseFloat(rsiText?.replace(/,/g, ''));
            const atr = parseFloat(atrText?.replace(/,/g, ''));
            const adx = parseFloat(adxText?.replace(/,/g, ''));

            return {
                rsi: isNaN(rsi) ? null : rsi,
                atr: isNaN(atr) ? null : atr,
                adx: isNaN(adx) ? null : adx
            };
        } catch (e) {
            return null;
        }
    }

    // ==================== 工具方法 ====================
    clearOrderHistory() {
        this.processedOrders.clear();
        this.lastOrderTime = 0;
        this.cycleCount = 0;
        console.log('订单记录已清空');
    }

    getStatus() {
        const riskStatus = this.getRiskCooldownStatus();
        const whaleStatus = this.whaleMonitor.getStatus();
        return {
            isMonitoring: this.isMonitoring,
            cycleCount: this.cycleCount,
            processedCount: this.processedOrders.size,
            lastOrderTime: this.lastOrderTime ? new Date(this.lastOrderTime).toLocaleTimeString() : '无',
            riskCooldown: riskStatus,
            // 大单监控状态
            whaleMonitor: {
                alertLevel: whaleStatus.alertLevel,
                vacuum: whaleStatus.metrics.vacuumDetected,
                removalVelocity: whaleStatus.metrics.removalVelocity.toFixed(2) + '/秒',
                imbalance: (whaleStatus.metrics.imbalanceRatio * 100).toFixed(1) + '%',
                stats: whaleStatus.stats
            },
            // 狙击状态
            sniperMode: this.sniperModeEnabled,
            sniperPosition: this.sniperPosition ? {
                type: this.sniperPosition.type,
                entryPrice: this.sniperPosition.entryPrice,
                holdTime: Math.floor((Date.now() - this.sniperPosition.openTime) / 1000) + '秒'
            } : null
        };
    }

    showWarningMessage(msg) {
        console.warn(`警告：${msg}`);
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ==================== 交易日志系统 ====================
    logTrade(action, data) {
        const log = {
            timestamp: new Date().toISOString(),
            time: new Date().toLocaleTimeString(),
            action: action,
            ...data
        };
        this.tradingLogs.push(log);
        if (this.tradingLogs.length > 1000) {
            this.tradingLogs = this.tradingLogs.slice(-1000);
        }
    }

    logOrderPlaced(type, price, success) {
        this.totalOrders++;
        if (success) this.successfulOrders++;
        this.logTrade('ORDER_PLACED', {
            type: type,
            price: price,
            success: success,
            marketPrice: this.getBidAskPrices()
        });
    }

    logOrderCancelled(price) {
        this.cancelledOrders++;
        this.logTrade('ORDER_CANCELLED', { price: price });
    }

    getLogsSummary() {
        const duration = this.sessionStartTime
            ? Math.floor((Date.now() - this.sessionStartTime) / 60000)
            : 0;
        return {
            sessionDuration: `${duration} 分钟`,
            totalCycles: this.cycleCount,
            totalOrders: this.totalOrders,
            successfulOrders: this.successfulOrders,
            cancelledOrders: this.cancelledOrders,
            successRate: this.totalOrders > 0
                ? `${(this.successfulOrders / this.totalOrders * 100).toFixed(1)}%`
                : 'N/A',
            logsCount: this.tradingLogs.length
        };
    }

    exportLogs() {
        const data = {
            exportTime: new Date().toISOString(),
            config: BTCAutoTrading.GRID_STRATEGY_CONFIG,
            summary: this.getLogsSummary(),
            logs: this.tradingLogs
        };
        const jsonStr = JSON.stringify(data, null, 2);
        console.log('%c========== 交易日志导出 ==========', 'color: #4CAF50; font-weight: bold;');
        console.log(jsonStr);
        if (navigator.clipboard) {
            navigator.clipboard.writeText(jsonStr).then(() => {
                console.log('%c✅ 日志已复制到剪贴板！', 'color: green;');
            });
        }
        return data;
    }

    // ==================== 完整日志导出（供AI分析优化）====================
    exportFullReport() {
        const whaleData = this.whaleMonitor.exportData();
        const tradingSummary = this.getLogsSummary();
        const riskStatus = this.getRiskCooldownStatus();

        const fullReport = {
            // 元信息
            meta: {
                exportTime: new Date().toISOString(),
                scriptVersion: '2.0',
                sessionStartTime: this.sessionStartTime ? new Date(this.sessionStartTime).toISOString() : null,
                sessionDuration: tradingSummary.sessionDuration,
            },

            // 配置快照
            config: {
                trading: BTCAutoTrading.TRADING_CONFIG,
                grid: BTCAutoTrading.GRID_STRATEGY_CONFIG,
                whaleMonitor: WhaleMonitor.CONFIG,
                sniperStrategy: WhaleMonitor.SNIPER_CONFIG,
            },

            // 交易统计
            tradingStats: {
                ...tradingSummary,
                riskCooldownTriggered: riskStatus.inCooldown,
                riskReason: riskStatus.reason || null,
            },

            // 大单监控统计
            whaleStats: whaleData.stats,

            // 插针事件（关键数据）
            spikeEvents: whaleData.spikeEvents,

            // 狙击交易记录
            sniperTrades: this.tradingLogs.filter(log =>
                log.action === 'SNIPER_ENTRY' || log.action === 'SNIPER_EXIT'
            ),

            // 当前大单快照
            currentWhales: whaleData.currentWhales,

            // 完整交易日志
            tradingLogs: this.tradingLogs,

            // 大单变化日志（最近500条）
            whaleLogs: whaleData.logs.slice(-500),

            // 分析建议提示
            analysisHints: {
                questions: [
                    '插针事件的时间间隔和幅度是否有规律？',
                    '大单出现/消失与插针的时间关系如何？',
                    '狙击信号的准确率如何？是否有误触发？',
                    '网格订单在插针前后的表现如何？',
                    '风控触发是否合理？阈值需要调整吗？',
                    '哪些参数需要优化？给出具体建议值。',
                ],
                dataPoints: {
                    totalSpikes: whaleData.stats.upSpikes + whaleData.stats.downSpikes,
                    sniperSignals: whaleData.stats.signalsGenerated,
                    whaleOrderTurnover: `${whaleData.stats.totalNewOrders} 新增 / ${whaleData.stats.totalRemovedOrders} 撤销`,
                    gridOrders: `${tradingSummary.successfulOrders}/${tradingSummary.totalOrders} 成功`,
                }
            }
        };

        // 导出为JSON文件
        const jsonStr = JSON.stringify(fullReport, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `01grid_full_report_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
        a.click();
        URL.revokeObjectURL(url);

        console.log('%c═══════════════════════════════════════════', 'color: #9C27B0;');
        console.log('%c  📊 完整报告已导出', 'color: #9C27B0; font-weight: bold; font-size: 16px;');
        console.log('%c═══════════════════════════════════════════', 'color: #9C27B0;');
        console.log('包含内容:');
        console.log(`  - 插针事件: ${fullReport.spikeEvents.length} 次`);
        console.log(`  - 狙击交易: ${fullReport.sniperTrades.length} 次`);
        console.log(`  - 交易日志: ${fullReport.tradingLogs.length} 条`);
        console.log(`  - 大单日志: ${fullReport.whaleLogs.length} 条`);
        console.log('');
        console.log('%c使用方法: 将导出的JSON文件发给AI进行分析优化', 'color: #607D8B;');

        return fullReport;
    }

    clearLogs() {
        this.tradingLogs = [];
        this.totalOrders = 0;
        this.successfulOrders = 0;
        this.cancelledOrders = 0;
        console.log('交易日志已清空');
    }
}

// ==================== 下单管理器（01交易所专用）====================
class OrderManager01 {
    static CONFIG = {
        UI_OPERATION_DELAY: 500,
        INPUT_DELAY: 300,
        ORDER_SUBMIT_DELAY: 1500
    };

    async placeLimitBuy(price) {
        return await this.placeOrder(price, 'buy');
    }

    async placeLimitSell(price) {
        return await this.placeOrder(price, 'sell');
    }

    async placeOrder(price, type) {
        console.log(`下单: ${type} @ $${price}`);

        try {
            // 1. 切换到对应的买/卖面板并验证
            const switchSuccess = await this.switchToPanel(type);
            if (!switchSuccess) {
                console.error(`❌ 无法切换到 ${type} 面板，放弃下单`);
                return false;
            }

            // 2. 再次验证当前面板是否正确（通过检查可见的提交按钮）
            const currentPanel = this.detectCurrentPanel();
            if (currentPanel !== type) {
                console.error(`❌ 面板验证失败: 期望 ${type}，实际 ${currentPanel}，放弃下单`);
                return false;
            }

            // 3. 确保 Post Only 已启用
            await this.ensurePostOnly();

            // 4. 找到可见的价格输入框并设置价格
            const priceInput = this.findVisiblePriceInput();
            if (!priceInput) {
                console.error('未找到可见的价格输入框');
                return false;
            }

            // 使用 React 兼容的方式设置输入值
            await this.setInputValue(priceInput, price.toString());
            await this.delay(OrderManager01.CONFIG.INPUT_DELAY);

            // 5. 查找并点击提交按钮（严格匹配）
            const submitBtn = this.findSubmitButtonStrict(type);
            if (!submitBtn) {
                console.error(`未找到 ${type} 提交按钮`);
                return false;
            }

            // 检查按钮是否可用
            if (submitBtn.disabled) {
                console.warn('提交按钮被禁用，可能价格无效');
                return false;
            }

            submitBtn.click();
            await this.delay(OrderManager01.CONFIG.ORDER_SUBMIT_DELAY);

            console.log(`✅ ${type} @ $${price} 下单成功`);
            return true;

        } catch (err) {
            console.error('下单异常:', err);
            return false;
        }
    }

    // 检测当前激活的面板（通过可见的提交按钮判断）
    detectCurrentPanel() {
        const buttons = Array.from(document.querySelectorAll('button'));

        for (const btn of buttons) {
            const text = btn.textContent.trim().toLowerCase();
            const rect = btn.getBoundingClientRect();

            // 只检查可见按钮
            if (rect.width > 0 && rect.height > 0) {
                if (text.includes('place') && text.includes('limit')) {
                    if (text.includes('buy')) {
                        console.log(`当前面板检测: Buy (按钮: "${btn.textContent.trim()}")`);
                        return 'buy';
                    }
                    if (text.includes('sell')) {
                        console.log(`当前面板检测: Sell (按钮: "${btn.textContent.trim()}")`);
                        return 'sell';
                    }
                }
            }
        }

        console.warn('无法检测当前面板');
        return null;
    }

    // 切换到指定面板并验证
    async switchToPanel(type) {
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`尝试切换到 ${type} 面板 (第${attempt}次)`);

            // 检查当前面板
            const currentPanel = this.detectCurrentPanel();
            if (currentPanel === type) {
                console.log(`已在 ${type} 面板`);
                return true;
            }

            // 查找并点击切换按钮
            const tabBtn = this.findTabButton(type);
            if (!tabBtn) {
                console.error(`未找到 ${type} 切换按钮`);
                return false;
            }

            // 使用多种方式尝试点击
            await this.clickElement(tabBtn);
            console.log(`已点击 ${type} 切换按钮，等待面板切换...`);

            // 等待面板切换
            await this.delay(1200);

            // 验证切换是否成功
            const newPanel = this.detectCurrentPanel();
            if (newPanel === type) {
                console.log(`✅ 成功切换到 ${type} 面板`);
                return true;
            }

            console.warn(`切换验证失败: 期望 ${type}，实际 ${newPanel}`);

            // 如果不是最后一次尝试，等待后重试
            if (attempt < maxRetries) {
                await this.delay(500);
            }
        }

        console.error(`❌ 多次尝试后仍无法切换到 ${type} 面板`);
        return false;
    }

    // 更可靠的点击方法
    async clickElement(element) {
        if (!element) return;

        // 方法1: 模拟完整的鼠标事件序列
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        const eventOptions = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y
        };

        // 触发鼠标事件序列
        element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        element.dispatchEvent(new MouseEvent('click', eventOptions));

        await this.delay(100);

        // 方法2: 如果上面没效果，尝试直接 click
        element.click();

        await this.delay(100);

        // 方法3: 尝试 focus 后点击
        element.focus();
        element.click();
    }

    // 查找买/卖 Tab 按钮（用于切换面板）
    findTabButton(type) {
        const isBuy = type === 'buy';

        const targetTexts = isBuy
            ? ['Buy | Long', 'Buy Long']
            : ['Sell | Short', 'Sell Short'];

        // 搜索策略：按优先级尝试不同选择器
        const selectors = [
            'button[role="tab"]',       // 标准 tab 按钮
            '[role="tab"]',             // 任何 tab 元素
            'button',                    // 所有按钮
            '[class*="tab"]',           // 包含 tab 类名的元素
            'div[class*="Buy"], div[class*="Sell"]'  // 可能的 div 按钮
        ];

        for (const selector of selectors) {
            const elements = Array.from(document.querySelectorAll(selector));

            for (const el of elements) {
                const text = el.textContent.trim();
                const rect = el.getBoundingClientRect();

                // 确保元素可见
                if (rect.width > 0 && rect.height > 0) {
                    // 检查文本匹配
                    const matches = targetTexts.some(t => text.includes(t));
                    if (matches) {
                        // 排除提交按钮（包含 Place 或 Order）
                        const lowerText = text.toLowerCase();
                        if (lowerText.includes('place') || lowerText.includes('order')) {
                            continue;
                        }

                        console.log(`找到 ${type} 切换按钮: "${text}" (选择器: ${selector})`);
                        console.log(`  - 标签名: ${el.tagName}, 类名: ${el.className}`);
                        return el;
                    }
                }
            }
        }

        console.warn(`未找到 ${type} 切换按钮`);
        return null;
    }

    // 查找可见的价格输入框
    findVisiblePriceInput() {
        const priceInputs = document.querySelectorAll('input#limitPrice');

        for (const input of priceInputs) {
            const rect = input.getBoundingClientRect();
            // 检查是否可见
            if (rect.width > 0 && rect.height > 0) {
                return input;
            }
        }
        return null;
    }

    // 使用 React 兼容的方式设置输入值
    async setInputValue(input, value) {
        // 聚焦输入框
        input.focus();

        // 选中所有文本
        input.select();

        // 方法1: 使用 execCommand（模拟用户输入）
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);

        // 如果 execCommand 不生效，使用备用方法
        if (input.value !== value) {
            // 方法2: 直接设置并触发原生事件
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(input, value);

            // 触发 React 能识别的事件
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        await this.delay(100);
    }

    // 查找提交按钮（严格匹配，确保不会误点）
    findSubmitButtonStrict(type) {
        const buttons = Array.from(document.querySelectorAll('button'));
        const isBuy = type === 'buy';
        const keyword = isBuy ? 'buy' : 'sell';
        const oppositeKeyword = isBuy ? 'sell' : 'buy';

        // 严格匹配：必须包含 place + limit + 正确方向，且不能包含相反方向
        for (const btn of buttons) {
            const text = btn.textContent.trim().toLowerCase();
            const rect = btn.getBoundingClientRect();

            // 确保按钮可见
            if (rect.width > 0 && rect.height > 0) {
                // 必须包含 place 和 limit 和正确的方向
                if (text.includes('place') && text.includes('limit') && text.includes(keyword)) {
                    // 确保不包含相反方向（防止误匹配）
                    if (!text.includes(oppositeKeyword)) {
                        console.log(`找到提交按钮(严格匹配): "${btn.textContent.trim()}"`);
                        return btn;
                    }
                }
            }
        }

        console.warn(`未找到 ${type} 提交按钮(严格匹配)`);
        return null;
    }

    // 查找提交按钮 "Place Limit Buy/Sell Order"（备用，宽松匹配）
    findSubmitButton(type) {
        const buttons = Array.from(document.querySelectorAll('button'));
        const isBuy = type === 'buy';

        // 支持多种可能的按钮文本格式
        const targetTexts = isBuy
            ? ['Place Limit Buy Order', 'Place Buy Order', 'Limit Buy', 'Buy']
            : ['Place Limit Sell Order', 'Place Sell Order', 'Limit Sell', 'Sell'];

        // 查找可见的提交按钮，优先匹配完整文本
        for (const targetText of targetTexts) {
            const btn = buttons.find(btn => {
                const text = btn.textContent.trim();
                const rect = btn.getBoundingClientRect();
                // 确保按钮可见
                if (rect.width > 0 && rect.height > 0) {
                    // 完整匹配或包含匹配
                    return text === targetText || text.includes(targetText);
                }
                return false;
            });

            if (btn) {
                console.log(`找到提交按钮: "${btn.textContent.trim()}"`);
                return btn;
            }
        }

        // 最后尝试模糊匹配：查找包含 "Place" 和 "Limit" 以及对应方向的按钮
        const keyword = isBuy ? 'buy' : 'sell';
        const fuzzyBtn = buttons.find(btn => {
            const text = btn.textContent.trim().toLowerCase();
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                return text.includes('place') && text.includes('limit') && text.includes(keyword);
            }
            return false;
        });

        if (fuzzyBtn) {
            console.log(`找到提交按钮(模糊匹配): "${fuzzyBtn.textContent.trim()}"`);
            return fuzzyBtn;
        }

        console.warn(`未找到 ${type} 提交按钮`);
        return null;
    }

    async ensurePostOnly() {
        const postOnlyBtns = document.querySelectorAll('button#post-only');

        for (const btn of postOnlyBtns) {
            // 检查按钮是否可见
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const isChecked = btn.getAttribute('data-state') === 'checked' ||
                btn.getAttribute('aria-checked') === 'true';

            if (!isChecked) {
                btn.click();
                console.log('已启用 Post Only');
                await this.delay(100);
            }
        }
    }

    async cancelByPrice(price) {
        console.log(`准备取消 $${price} 的订单`);

        const targetPrice = parseFloat(String(price).replace(/[^0-9.]/g, ''));
        if (!targetPrice) return;

        // 点击 Open Orders 标签
        const openOrdersTab = Array.from(document.querySelectorAll('button'))
            .find(btn => btn.textContent.includes('Open Orders'));
        if (openOrdersTab) {
            openOrdersTab.click();
            await this.delay(300);
        }

        // 找到正确的 Open Orders 表格（包含 Cancel 按钮的表格）
        const tables = document.querySelectorAll('table');
        let orderTable = null;
        for (const table of tables) {
            const tbody = table.querySelector('tbody');
            if (!tbody) continue;
            const firstRow = tbody.querySelector('tr');
            if (!firstRow) continue;
            const hasBTC = firstRow.textContent.includes('BTC');
            const hasCancel = Array.from(firstRow.querySelectorAll('button'))
                .some(btn => btn.textContent.trim() === 'Cancel');
            if (hasBTC && hasCancel) {
                orderTable = table;
                break;
            }
        }

        if (!orderTable) {
            console.warn('未找到 Open Orders 表格');
            return;
        }

        const tbody = orderTable.querySelector('tbody');
        if (!tbody) return;

        const rows = tbody.querySelectorAll('tr');

        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 3) continue;

            // 检查价格（td[2]）
            const priceText = cells[2]?.textContent?.trim() || '';
            const rowPrice = parseFloat(priceText.replace(/[$,]/g, ''));

            if (Math.abs(rowPrice - targetPrice) < 0.01) {
                // 找到匹配的订单，点击取消按钮
                const cancelBtn = Array.from(row.querySelectorAll('button'))
                    .find(btn => btn.textContent.trim() === 'Cancel');

                if (cancelBtn) {
                    cancelBtn.click();
                    console.log(`已取消 $${targetPrice} 的订单`);
                    await this.delay(500);
                    return;
                }
            }
        }

        console.warn(`未找到 $${targetPrice} 的订单`);
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

// ==================== 持仓止盈止损管理器 ====================
class PositionStopLossManager {
    static CONFIG = {
        checkInterval: 5000,          // 检查间隔 5秒
        takeProfitPercent: 1.0,       // 止盈百分比 1%
        stopLossPercent: 1.0,         // 止损百分比 1%
        priceBuffer: 0.5,             // 价格缓冲区（避免频繁更新）
    };

    constructor(orderManager) {
        this.orderManager = orderManager;
        this.isRunning = false;
        this.checkInterval = null;

        // 当前止盈止损单状态
        this.currentTPOrder = null;   // 止盈挂单
        this.currentSLOrder = null;   // 止损挂单

        // 上次检测到的持仓
        this.lastPosition = null;
        this.lastEntryPrice = null;

        // 日志
        this.logs = [];
    }

    // ========== 读取当前持仓信息 ==========
    getPositionInfo() {
        try {
            // 从 Positions 表格读取数据
            // 根据截图，表格结构：Market | Position | Position Value | Entry Price | Mark Price | ...
            const tables = document.querySelectorAll('table');

            for (const table of tables) {
                const tbody = table.querySelector('tbody');
                if (!tbody) continue;

                const rows = tbody.querySelectorAll('tr');
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 5) continue;

                    // 检查是否是 BTC 仓位行
                    const marketCell = cells[0]?.textContent?.trim() || '';
                    if (!marketCell.includes('BTC')) continue;

                    // 读取 Position (第2列)
                    const positionText = cells[1]?.textContent?.trim() || '';
                    const position = parseFloat(positionText.replace(/[^0-9.-]/g, ''));

                    // 读取 Entry Price (第4列)
                    const entryPriceText = cells[3]?.textContent?.trim() || '';
                    const entryPrice = parseFloat(entryPriceText.replace(/[$,]/g, ''));

                    // 读取 Mark Price (第5列)
                    const markPriceText = cells[4]?.textContent?.trim() || '';
                    const markPrice = parseFloat(markPriceText.replace(/[$,]/g, ''));

                    if (position && entryPrice) {
                        return {
                            market: marketCell,
                            position: position,           // 正数=多仓，负数=空仓
                            entryPrice: entryPrice,
                            markPrice: markPrice || entryPrice,
                            isLong: position > 0,
                            isShort: position < 0,
                            size: Math.abs(position)
                        };
                    }
                }
            }

            // 备用方法：通过 Close Position 按钮附近的元素读取
            const closeBtn = Array.from(document.querySelectorAll('button'))
                .find(btn => btn.textContent.includes('Close Position'));

            if (closeBtn) {
                const row = closeBtn.closest('tr');
                if (row) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 5) {
                        const positionText = cells[1]?.textContent?.trim() || '';
                        const position = parseFloat(positionText.replace(/[^0-9.-]/g, ''));
                        const entryPriceText = cells[3]?.textContent?.trim() || '';
                        const entryPrice = parseFloat(entryPriceText.replace(/[$,]/g, ''));

                        if (position && entryPrice) {
                            return {
                                market: 'BTC/USD',
                                position: position,
                                entryPrice: entryPrice,
                                isLong: position > 0,
                                isShort: position < 0,
                                size: Math.abs(position)
                            };
                        }
                    }
                }
            }

            return null;
        } catch (e) {
            console.warn('读取持仓信息失败:', e.message);
            return null;
        }
    }

    // ========== 计算止盈止损价格 ==========
    calculateTPSLPrices(entryPrice, isLong) {
        const tpPercent = PositionStopLossManager.CONFIG.takeProfitPercent / 100;
        const slPercent = PositionStopLossManager.CONFIG.stopLossPercent / 100;

        if (isLong) {
            // 多仓：止盈在上方，止损在下方
            return {
                takeProfit: Math.round(entryPrice * (1 + tpPercent) * 10) / 10,
                stopLoss: Math.round(entryPrice * (1 - slPercent) * 10) / 10
            };
        } else {
            // 空仓：止盈在下方，止损在上方
            return {
                takeProfit: Math.round(entryPrice * (1 - tpPercent) * 10) / 10,
                stopLoss: Math.round(entryPrice * (1 + slPercent) * 10) / 10
            };
        }
    }

    // ========== 启动止盈止损监控 ==========
    start() {
        if (this.isRunning) {
            console.log('止盈止损监控已在运行');
            return;
        }

        this.isRunning = true;
        console.log('%c═══════════════════════════════════════════', 'color: #FF5722;');
        console.log('%c  📊 持仓止盈止损监控已启动', 'color: #FF5722; font-weight: bold; font-size: 14px;');
        console.log('%c═══════════════════════════════════════════', 'color: #FF5722;');
        console.log(`止盈: ±${PositionStopLossManager.CONFIG.takeProfitPercent}%`);
        console.log(`止损: ±${PositionStopLossManager.CONFIG.stopLossPercent}%`);
        console.log(`检查间隔: ${PositionStopLossManager.CONFIG.checkInterval / 1000}秒`);

        // 立即执行一次
        this.checkAndUpdateOrders();

        // 设置定时检查
        this.checkInterval = setInterval(() => {
            this.checkAndUpdateOrders();
        }, PositionStopLossManager.CONFIG.checkInterval);
    }

    // ========== 停止监控 ==========
    stop() {
        if (!this.isRunning) return;

        this.isRunning = false;
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        console.log('%c📊 持仓止盈止损监控已停止', 'color: #f44336; font-weight: bold;');
    }

    // ========== 核心检查和更新逻辑 ==========
    async checkAndUpdateOrders() {
        if (!this.isRunning) return;

        try {
            const position = this.getPositionInfo();

            // 无持仓时清理
            if (!position || position.size === 0) {
                if (this.currentTPOrder || this.currentSLOrder) {
                    console.log('%c无持仓，清理止盈止损单状态', 'color: #9E9E9E;');
                    this.currentTPOrder = null;
                    this.currentSLOrder = null;
                    this.lastPosition = null;
                    this.lastEntryPrice = null;
                }
                return;
            }

            // 计算止盈止损价格
            const prices = this.calculateTPSLPrices(position.entryPrice, position.isLong);

            // 检查是否需要更新
            const needUpdate = this.shouldUpdateOrders(position, prices);

            if (needUpdate) {
                console.log('%c═══════════════════════════════════════════', 'color: #FF5722;');
                console.log('%c  🔄 更新止盈止损挂单', 'color: #FF5722; font-weight: bold;');
                console.log('%c═══════════════════════════════════════════', 'color: #FF5722;');
                console.log(`持仓: ${position.position} BTC (${position.isLong ? '多' : '空'})`);
                console.log(`入场价: $${position.entryPrice.toFixed(1)}`);
                console.log(`止盈价: $${prices.takeProfit.toFixed(1)} (${position.isLong ? '+' : '-'}${PositionStopLossManager.CONFIG.takeProfitPercent}%)`);
                console.log(`止损价: $${prices.stopLoss.toFixed(1)} (${position.isLong ? '-' : '+'}${PositionStopLossManager.CONFIG.stopLossPercent}%)`);

                await this.placeTPSLOrders(position, prices);

                // 更新状态
                this.lastPosition = position.position;
                this.lastEntryPrice = position.entryPrice;
                this.currentTPOrder = { price: prices.takeProfit, side: position.isLong ? 'sell' : 'buy' };
                this.currentSLOrder = { price: prices.stopLoss, side: position.isLong ? 'sell' : 'buy' };

                this.log('TPSL_UPDATED', {
                    position: position,
                    takeProfit: prices.takeProfit,
                    stopLoss: prices.stopLoss
                });
            }

        } catch (e) {
            console.warn('止盈止损检查出错:', e.message);
        }
    }

    // ========== 判断是否需要更新挂单 ==========
    shouldUpdateOrders(position, prices) {
        // 情况1: 首次设置
        if (!this.currentTPOrder || !this.currentSLOrder) {
            return true;
        }

        // 情况2: 持仓方向变化
        if (this.lastPosition &&
            ((this.lastPosition > 0 && position.position < 0) ||
             (this.lastPosition < 0 && position.position > 0))) {
            console.log('持仓方向变化，需要更新止盈止损');
            return true;
        }

        // 情况3: 入场价变化超过缓冲区
        const buffer = PositionStopLossManager.CONFIG.priceBuffer;
        if (this.lastEntryPrice &&
            Math.abs(position.entryPrice - this.lastEntryPrice) > buffer) {
            console.log(`入场价变化: $${this.lastEntryPrice} → $${position.entryPrice}`);
            return true;
        }

        // 情况4: 止盈止损价格变化较大
        if (Math.abs(prices.takeProfit - this.currentTPOrder.price) > buffer ||
            Math.abs(prices.stopLoss - this.currentSLOrder.price) > buffer) {
            return true;
        }

        return false;
    }

    // ========== 下止盈止损单 ==========
    async placeTPSLOrders(position, prices) {
        try {
            // 止盈止损单需要使用 Reduce-Only 模式
            // 多仓：止盈卖出(价高)，止损卖出(价低)
            // 空仓：止盈买入(价低)，止损买入(价高)

            const closeSide = position.isLong ? 'sell' : 'buy';

            // ⚠️ 重要：止盈止损单不能使用 Post-Only！
            // Post-Only 会导致订单在价格波动时被拒绝
            // 止盈止损单需要确保能成交，所以关闭 Post-Only
            await this.disablePostOnly();
            await this.delay(200);

            // 确保启用 Reduce-Only（只平仓不加仓）
            await this.ensureReduceOnly();
            await this.delay(200);

            // 下止盈单
            console.log(`下止盈单: ${closeSide.toUpperCase()} @ $${prices.takeProfit}`);
            const tpSuccess = await this.placeTPSLOrder(closeSide, prices.takeProfit);

            await this.delay(1000);

            // 下止损单
            console.log(`下止损单: ${closeSide.toUpperCase()} @ $${prices.stopLoss}`);
            const slSuccess = await this.placeTPSLOrder(closeSide, prices.stopLoss);

            // 恢复设置：关闭 Reduce-Only，启用 Post-Only
            await this.disableReduceOnly();
            await this.delay(200);
            await this.enablePostOnly();

            if (tpSuccess && slSuccess) {
                console.log('%c✅ 止盈止损单已更新', 'color: #4CAF50; font-weight: bold;');
            } else {
                console.warn(`%c⚠️ 止盈止损单部分失败: TP=${tpSuccess}, SL=${slSuccess}`, 'color: #FF9800;');
            }

        } catch (e) {
            console.error('下止盈止损单失败:', e.message);
            // 确保恢复 Post-Only
            await this.enablePostOnly();
        }
    }

    // ========== 下单辅助方法（用于止盈止损）==========
    async placeTPSLOrder(side, price) {
        try {
            if (side === 'sell') {
                return await this.orderManager.placeLimitSell(price);
            } else {
                return await this.orderManager.placeLimitBuy(price);
            }
        } catch (e) {
            console.error(`下单失败 ${side} @ $${price}:`, e.message);
            return false;
        }
    }

    // ========== Post-Only 控制（止盈止损单需要关闭）==========
    async disablePostOnly() {
        const postOnlyBtns = document.querySelectorAll('button#post-only');

        for (const btn of postOnlyBtns) {
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const isChecked = btn.getAttribute('data-state') === 'checked' ||
                btn.getAttribute('aria-checked') === 'true' ||
                btn.classList.contains('bg-01-green');

            if (isChecked) {
                btn.click();
                console.log('%c已关闭 Post-Only（止盈止损单需要）', 'color: #FF9800;');
                await this.delay(300);
            }
        }
    }

    async enablePostOnly() {
        const postOnlyBtns = document.querySelectorAll('button#post-only');

        for (const btn of postOnlyBtns) {
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const isChecked = btn.getAttribute('data-state') === 'checked' ||
                btn.getAttribute('aria-checked') === 'true' ||
                btn.classList.contains('bg-01-green');

            if (!isChecked) {
                btn.click();
                console.log('%c已恢复 Post-Only', 'color: #4CAF50;');
                await this.delay(300);
            }
        }
    }

    // ========== Reduce-Only 控制 ==========
    async ensureReduceOnly() {
        const reduceOnlyBtns = document.querySelectorAll('button#reduce-only');

        for (const btn of reduceOnlyBtns) {
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const isChecked = btn.getAttribute('data-state') === 'checked' ||
                btn.getAttribute('aria-checked') === 'true';

            if (!isChecked) {
                btn.click();
                console.log('已启用 Reduce-Only');
                await this.delay(300);
            }
        }
    }

    async disableReduceOnly() {
        const reduceOnlyBtns = document.querySelectorAll('button#reduce-only');

        for (const btn of reduceOnlyBtns) {
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const isChecked = btn.getAttribute('data-state') === 'checked' ||
                btn.getAttribute('aria-checked') === 'true';

            if (isChecked) {
                btn.click();
                console.log('已关闭 Reduce-Only');
                await this.delay(300);
            }
        }
    }

    // ========== 手动设置止盈止损百分比 ==========
    setTPPercent(percent) {
        PositionStopLossManager.CONFIG.takeProfitPercent = percent;
        console.log(`止盈百分比已设置为: ${percent}%`);
        this.currentTPOrder = null; // 强制下次更新
    }

    setSLPercent(percent) {
        PositionStopLossManager.CONFIG.stopLossPercent = percent;
        console.log(`止损百分比已设置为: ${percent}%`);
        this.currentSLOrder = null; // 强制下次更新
    }

    setTPSLPercent(tpPercent, slPercent) {
        PositionStopLossManager.CONFIG.takeProfitPercent = tpPercent;
        PositionStopLossManager.CONFIG.stopLossPercent = slPercent;
        console.log(`止盈止损已设置: TP=${tpPercent}%, SL=${slPercent}%`);
        this.currentTPOrder = null;
        this.currentSLOrder = null;
    }

    // ========== 状态查询 ==========
    getStatus() {
        const position = this.getPositionInfo();
        return {
            isRunning: this.isRunning,
            config: {
                takeProfitPercent: PositionStopLossManager.CONFIG.takeProfitPercent,
                stopLossPercent: PositionStopLossManager.CONFIG.stopLossPercent,
                checkInterval: PositionStopLossManager.CONFIG.checkInterval
            },
            currentPosition: position,
            currentTPOrder: this.currentTPOrder,
            currentSLOrder: this.currentSLOrder,
            lastUpdate: this.logs.length > 0 ? this.logs[this.logs.length - 1].timestamp : null
        };
    }

    // ========== 日志 ==========
    log(action, data) {
        this.logs.push({
            timestamp: new Date().toISOString(),
            action,
            ...data
        });
        if (this.logs.length > 500) this.logs = this.logs.slice(-500);
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

// ==================== 保证金保护管理器 ====================
class MarginProtectionManager {
    static CONFIG = {
        checkInterval: 10000,         // 检查间隔 10秒
        marginUsageThreshold: 0.5,    // 保证金使用率阈值 50%
        closePercent: 50,             // 默认平仓比例 50%
        priceOffsetPercent: 0.1,      // 平仓价格偏移 0.1%（接近市价但确保成交）
        maxCloseAttempts: 3,          // 最大平仓尝试次数
        cooldownAfterClose: 60000,    // 平仓后冷却时间 60秒
    };

    constructor(orderManager) {
        this.orderManager = orderManager;
        this.isRunning = false;
        this.checkInterval = null;
        this.lastCloseTime = 0;
        this.closeAttempts = 0;
        this.logs = [];

        // 当前状态
        this.marginStatus = {
            availableToTrade: 0,
            usedMargin: 0,
            totalMargin: 0,
            usagePercent: 0,
        };
    }

    // ========== 读取保证金信息 ==========
    getMarginInfo() {
        try {
            // 方法1: 从页面上读取 Available to Trade 和 Used Margin
            // 根据截图，这些信息可能在账户信息区域

            // 尝试从 Positions 表格的 Used Margin 列读取
            const tables = document.querySelectorAll('table');
            let usedMargin = 0;
            let positionValue = 0;

            for (const table of tables) {
                const tbody = table.querySelector('tbody');
                if (!tbody) continue;

                const rows = tbody.querySelectorAll('tr');
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 8) continue;

                    // 检查是否是 BTC 仓位行
                    const marketCell = cells[0]?.textContent?.trim() || '';
                    if (!marketCell.includes('BTC')) continue;

                    // Position Value (第3列) - 如截图 $0.93
                    const posValueText = cells[2]?.textContent?.trim() || '';
                    positionValue = parseFloat(posValueText.replace(/[$,]/g, '')) || 0;

                    // Used Margin (第8列) - 如截图 $0.04
                    const usedMarginText = cells[7]?.textContent?.trim() || '';
                    usedMargin = parseFloat(usedMarginText.replace(/[$,]/g, '')) || 0;

                    break;
                }
            }

            // 方法2: 尝试从账户信息区域读取 (通常在页面顶部或侧边栏)
            // 查找包含 "Available" 或 "Balance" 的元素
            let availableToTrade = 0;

            const allTextElements = document.querySelectorAll('span, div, p');
            for (const el of allTextElements) {
                const text = el.textContent?.trim() || '';

                // 查找 Available to Trade 或类似文本
                if (text.toLowerCase().includes('available') ||
                    text.toLowerCase().includes('balance') ||
                    text.toLowerCase().includes('free')) {
                    // 查找相邻的数值元素
                    const parent = el.parentElement;
                    if (parent) {
                        const valueEl = parent.querySelector('[class*="number"]') ||
                                       parent.nextElementSibling;
                        if (valueEl) {
                            const value = parseFloat(valueEl.textContent?.replace(/[$,]/g, ''));
                            if (value > 0 && value < 1000000) {
                                availableToTrade = value;
                                break;
                            }
                        }
                    }
                }
            }

            // 如果无法读取可用余额，使用 Position Value 作为参考
            // 假设总保证金 = 可用 + 已用
            const totalMargin = availableToTrade + usedMargin;
            const usagePercent = totalMargin > 0 ? usedMargin / totalMargin : 0;

            // 备用计算：如果无法获取可用余额，使用仓位价值估算
            // 25x 杠杆下，Used Margin ≈ Position Value / 25
            if (usedMargin === 0 && positionValue > 0) {
                // 从截图看 Position Value $0.93, Used Margin $0.04
                // 说明杠杆约 23x
                usedMargin = positionValue / 25;
            }

            this.marginStatus = {
                availableToTrade,
                usedMargin,
                positionValue,
                totalMargin: totalMargin || positionValue,
                usagePercent: usagePercent || (positionValue > 0 ? 0.5 : 0), // 默认估算
            };

            return this.marginStatus;

        } catch (e) {
            console.warn('读取保证金信息失败:', e.message);
            return null;
        }
    }

    // ========== 获取当前持仓详情 ==========
    getPositionDetails() {
        try {
            const tables = document.querySelectorAll('table');

            for (const table of tables) {
                const tbody = table.querySelector('tbody');
                if (!tbody) continue;

                const rows = tbody.querySelectorAll('tr');
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 5) continue;

                    const marketCell = cells[0]?.textContent?.trim() || '';
                    if (!marketCell.includes('BTC')) continue;

                    // Position (第2列)
                    const positionText = cells[1]?.textContent?.trim() || '';
                    const position = parseFloat(positionText.replace(/[^0-9.-]/g, ''));

                    // Entry Price (第4列)
                    const entryPriceText = cells[3]?.textContent?.trim() || '';
                    const entryPrice = parseFloat(entryPriceText.replace(/[$,]/g, ''));

                    // Mark Price (第5列)
                    const markPriceText = cells[4]?.textContent?.trim() || '';
                    const markPrice = parseFloat(markPriceText.replace(/[$,]/g, ''));

                    if (position && entryPrice) {
                        return {
                            position,
                            entryPrice,
                            markPrice: markPrice || entryPrice,
                            isLong: position > 0,
                            size: Math.abs(position),
                            row: row  // 保存行引用，用于找到 Close Position 按钮
                        };
                    }
                }
            }

            return null;
        } catch (e) {
            console.warn('读取持仓详情失败:', e.message);
            return null;
        }
    }

    // ========== 启动保证金保护监控 ==========
    start() {
        if (this.isRunning) {
            console.log('保证金保护监控已在运行');
            return;
        }

        this.isRunning = true;
        console.log('%c═══════════════════════════════════════════', 'color: #E91E63;');
        console.log('%c  🛡️ 保证金保护监控已启动', 'color: #E91E63; font-weight: bold; font-size: 14px;');
        console.log('%c═══════════════════════════════════════════', 'color: #E91E63;');
        console.log(`阈值: ${MarginProtectionManager.CONFIG.marginUsageThreshold * 100}%`);
        console.log(`平仓比例: ${MarginProtectionManager.CONFIG.closePercent}%`);
        console.log(`检查间隔: ${MarginProtectionManager.CONFIG.checkInterval / 1000}秒`);

        // 立即执行一次
        this.checkAndProtect();

        // 设置定时检查
        this.checkInterval = setInterval(() => {
            this.checkAndProtect();
        }, MarginProtectionManager.CONFIG.checkInterval);
    }

    // ========== 停止监控 ==========
    stop() {
        if (!this.isRunning) return;

        this.isRunning = false;
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        console.log('%c🛡️ 保证金保护监控已停止', 'color: #f44336; font-weight: bold;');
    }

    // ========== 核心检查和保护逻辑 ==========
    async checkAndProtect() {
        if (!this.isRunning) return;

        try {
            // 检查冷却时间
            if (Date.now() - this.lastCloseTime < MarginProtectionManager.CONFIG.cooldownAfterClose) {
                const remaining = Math.ceil((MarginProtectionManager.CONFIG.cooldownAfterClose - (Date.now() - this.lastCloseTime)) / 1000);
                console.log(`%c🛡️ 平仓冷却中，剩余 ${remaining} 秒`, 'color: #9E9E9E;');
                return;
            }

            // 获取保证金信息
            const marginInfo = this.getMarginInfo();
            if (!marginInfo) {
                console.warn('无法读取保证金信息');
                return;
            }

            // 获取持仓详情
            const position = this.getPositionDetails();
            if (!position || position.size === 0) {
                // 无持仓，重置状态
                this.closeAttempts = 0;
                return;
            }

            // 计算使用率（基于仓位价值与可用资金的比例）
            // 如果无法获取准确的可用余额，使用仓位价值作为参考
            let usageRatio = marginInfo.usagePercent;

            // 备用判断：如果 Used Margin > 某个阈值
            if (marginInfo.usedMargin > 0 && marginInfo.availableToTrade > 0) {
                usageRatio = marginInfo.usedMargin / (marginInfo.usedMargin + marginInfo.availableToTrade);
            }

            console.log(`%c🛡️ 保证金检查: 使用率 ${(usageRatio * 100).toFixed(1)}% (阈值: ${MarginProtectionManager.CONFIG.marginUsageThreshold * 100}%)`,
                usageRatio > MarginProtectionManager.CONFIG.marginUsageThreshold ? 'color: #F44336;' : 'color: #4CAF50;');

            // 检查是否超过阈值
            if (usageRatio > MarginProtectionManager.CONFIG.marginUsageThreshold) {
                console.log('%c⚠️ 保证金使用率超过阈值！启动平仓保护', 'color: #F44336; font-weight: bold; font-size: 14px;');

                // 尝试平仓
                await this.executeLimitClose(position);
            }

        } catch (e) {
            console.warn('保证金保护检查出错:', e.message);
        }
    }

    // ========== 执行限价平仓 ==========
    async executeLimitClose(position) {
        if (this.closeAttempts >= MarginProtectionManager.CONFIG.maxCloseAttempts) {
            console.warn('%c⚠️ 平仓尝试次数已达上限，请手动处理', 'color: #FF9800; font-weight: bold;');
            return;
        }

        this.closeAttempts++;
        console.log(`%c🛡️ 开始执行限价平仓 (尝试 ${this.closeAttempts}/${MarginProtectionManager.CONFIG.maxCloseAttempts})`,
            'color: #E91E63; font-weight: bold;');

        try {
            // 步骤1: 点击 Positions 标签确保在正确页面
            await this.clickPositionsTab();
            await this.delay(500);

            // 步骤2: 找到并点击 Close Position 按钮
            const closeBtn = await this.findClosePositionButton(position);
            if (!closeBtn) {
                console.error('未找到 Close Position 按钮');
                return;
            }

            closeBtn.click();
            console.log('已点击 Close Position 按钮');
            await this.delay(800);

            // 步骤3: 在弹出的对话框中选择 Limit 模式
            const limitTabClicked = await this.clickLimitTabInDialog();
            if (!limitTabClicked) {
                console.error('未能切换到 Limit 模式');
                await this.closeDialog();
                return;
            }
            await this.delay(500);

            // 步骤4: 设置平仓价格
            const closePrice = this.calculateClosePrice(position);
            const priceSet = await this.setClosePriceInDialog(closePrice);
            if (!priceSet) {
                console.warn('设置平仓价格失败，使用默认价格');
            }
            await this.delay(300);

            // 步骤5: 设置平仓比例
            const percentSet = await this.setClosePercentInDialog(MarginProtectionManager.CONFIG.closePercent);
            if (!percentSet) {
                console.warn('设置平仓比例失败，使用默认比例');
            }
            await this.delay(300);

            // 步骤6: 点击 Limit Close 按钮确认
            const confirmed = await this.clickLimitCloseButton();
            if (confirmed) {
                console.log('%c✅ 限价平仓单已提交', 'color: #4CAF50; font-weight: bold;');
                this.lastCloseTime = Date.now();
                this.closeAttempts = 0;

                this.log('MARGIN_PROTECTION_CLOSE', {
                    position: position.position,
                    closePrice,
                    closePercent: MarginProtectionManager.CONFIG.closePercent,
                    marginUsage: this.marginStatus.usagePercent
                });
            } else {
                console.error('确认平仓失败');
            }

        } catch (e) {
            console.error('执行限价平仓出错:', e.message);
        }
    }

    // ========== 点击 Positions 标签 ==========
    async clickPositionsTab() {
        const tabs = Array.from(document.querySelectorAll('button'));
        const positionsTab = tabs.find(btn =>
            btn.textContent.includes('Positions')
        );

        if (positionsTab) {
            positionsTab.click();
            return true;
        }
        return false;
    }

    // ========== 找到 Close Position 按钮 ==========
    async findClosePositionButton(position) {
        // 方法1: 从持仓行找按钮
        if (position.row) {
            const btn = position.row.querySelector('button');
            if (btn && btn.textContent.includes('Close')) {
                return btn;
            }
        }

        // 方法2: 查找所有 Close Position 按钮
        const buttons = Array.from(document.querySelectorAll('button, a, span'));
        const closeBtn = buttons.find(el => {
            const text = el.textContent?.trim() || '';
            return text === 'Close Position' || text === 'Close';
        });

        return closeBtn;
    }

    // ========== 在对话框中点击 Limit 标签 ==========
    async clickLimitTabInDialog() {
        // 等待对话框出现
        await this.delay(300);

        // 查找 Limit 标签/按钮（根据截图，对话框中有 Market 和 Limit 两个选项）
        const allElements = document.querySelectorAll('button, div[role="tab"], span');

        for (const el of allElements) {
            const text = el.textContent?.trim() || '';
            const rect = el.getBoundingClientRect();

            // 确保元素可见且在对话框范围内（通常在屏幕中央）
            if (rect.width > 0 && rect.height > 0 &&
                rect.top > 100 && rect.left > 100) {

                if (text === 'Limit') {
                    el.click();
                    console.log('已切换到 Limit 模式');
                    return true;
                }
            }
        }

        return false;
    }

    // ========== 计算平仓价格 ==========
    calculateClosePrice(position) {
        const offset = MarginProtectionManager.CONFIG.priceOffsetPercent / 100;

        if (position.isLong) {
            // 多仓平仓：卖出，价格稍低于市价以确保成交
            return Math.round((position.markPrice * (1 - offset)) * 10) / 10;
        } else {
            // 空仓平仓：买入，价格稍高于市价以确保成交
            return Math.round((position.markPrice * (1 + offset)) * 10) / 10;
        }
    }

    // ========== 在对话框中设置平仓价格 ==========
    async setClosePriceInDialog(price) {
        // 查找价格输入框（根据截图，显示 93172.95 的输入框）
        const inputs = document.querySelectorAll('input');

        for (const input of inputs) {
            const rect = input.getBoundingClientRect();
            // 确保在对话框范围内
            if (rect.width > 0 && rect.top > 100) {
                const value = parseFloat(input.value?.replace(/,/g, ''));
                // 检查是否是价格输入框（值应该在合理范围内）
                if (value > 80000 && value < 150000) {
                    await this.setInputValue(input, price.toString());
                    console.log(`已设置平仓价格: $${price}`);
                    return true;
                }
            }
        }

        return false;
    }

    // ========== 在对话框中设置平仓比例 ==========
    async setClosePercentInDialog(percent) {
        // 方法1: 查找百分比滑块或输入框
        const inputs = document.querySelectorAll('input');

        for (const input of inputs) {
            const rect = input.getBoundingClientRect();
            if (rect.width > 0 && rect.top > 100) {
                // 检查是否是百分比输入框
                const placeholder = input.placeholder || '';
                const type = input.type || '';

                if (type === 'range' || placeholder.includes('%')) {
                    input.value = percent;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    console.log(`已设置平仓比例: ${percent}%`);
                    return true;
                }
            }
        }

        // 方法2: 点击预设的百分比按钮（如 25%, 50%, 75%, 100%）
        const buttons = document.querySelectorAll('button, div, span');
        const targetPercent = `${percent}%`;

        for (const btn of buttons) {
            const text = btn.textContent?.trim() || '';
            const rect = btn.getBoundingClientRect();

            if (rect.width > 0 && rect.top > 100) {
                if (text === targetPercent || text === percent.toString()) {
                    btn.click();
                    console.log(`已点击 ${percent}% 按钮`);
                    return true;
                }
            }
        }

        // 方法3: 拖动滑块到指定位置
        const sliders = document.querySelectorAll('[role="slider"], input[type="range"]');
        for (const slider of sliders) {
            const rect = slider.getBoundingClientRect();
            if (rect.width > 0 && rect.top > 100) {
                // 计算滑块位置
                const min = parseFloat(slider.getAttribute('min') || '0');
                const max = parseFloat(slider.getAttribute('max') || '100');
                const value = min + (max - min) * (percent / 100);

                slider.value = value;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                slider.dispatchEvent(new Event('change', { bubbles: true }));
                console.log(`已设置滑块到 ${percent}%`);
                return true;
            }
        }

        return false;
    }

    // ========== 点击 Limit Close 按钮 ==========
    async clickLimitCloseButton() {
        const buttons = Array.from(document.querySelectorAll('button'));

        // 查找 "Limit Close" 按钮（根据截图）
        const limitCloseBtn = buttons.find(btn => {
            const text = btn.textContent?.trim() || '';
            const rect = btn.getBoundingClientRect();

            if (rect.width > 0 && rect.top > 100) {
                return text === 'Limit Close' ||
                       text.toLowerCase().includes('limit close') ||
                       text.toLowerCase().includes('close order');
            }
            return false;
        });

        if (limitCloseBtn) {
            limitCloseBtn.click();
            console.log('已点击 Limit Close 按钮');
            return true;
        }

        return false;
    }

    // ========== 关闭对话框 ==========
    async closeDialog() {
        // 查找关闭按钮 (X)
        const closeButtons = document.querySelectorAll('button, svg');

        for (const btn of closeButtons) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.top > 100) {
                // 查找 X 图标或 close 类
                const className = btn.className || '';
                const ariaLabel = btn.getAttribute('aria-label') || '';

                if (className.includes('close') ||
                    ariaLabel.toLowerCase().includes('close') ||
                    btn.innerHTML?.includes('×')) {
                    btn.click();
                    return true;
                }
            }
        }

        // 按 ESC 键关闭
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
        return false;
    }

    // ========== 设置输入框值（React 兼容）==========
    async setInputValue(input, value) {
        input.focus();
        input.select();

        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);

        if (input.value !== value) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(input, value);

            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        await this.delay(100);
    }

    // ========== 手动设置参数 ==========
    setThreshold(percent) {
        MarginProtectionManager.CONFIG.marginUsageThreshold = percent / 100;
        console.log(`保证金使用率阈值已设置为: ${percent}%`);
    }

    setClosePercent(percent) {
        MarginProtectionManager.CONFIG.closePercent = percent;
        console.log(`平仓比例已设置为: ${percent}%`);
    }

    // ========== 状态查询 ==========
    getStatus() {
        const marginInfo = this.getMarginInfo();
        const position = this.getPositionDetails();

        return {
            isRunning: this.isRunning,
            config: {
                marginUsageThreshold: MarginProtectionManager.CONFIG.marginUsageThreshold * 100 + '%',
                closePercent: MarginProtectionManager.CONFIG.closePercent + '%',
                checkInterval: MarginProtectionManager.CONFIG.checkInterval / 1000 + '秒'
            },
            marginStatus: marginInfo,
            position: position ? {
                size: position.position,
                entryPrice: position.entryPrice,
                markPrice: position.markPrice,
                isLong: position.isLong
            } : null,
            closeAttempts: this.closeAttempts,
            lastCloseTime: this.lastCloseTime ? new Date(this.lastCloseTime).toLocaleTimeString() : '无'
        };
    }

    // ========== 手动触发平仓 ==========
    async manualClose(percent = null) {
        const position = this.getPositionDetails();
        if (!position || position.size === 0) {
            console.log('无持仓可平');
            return;
        }

        if (percent) {
            MarginProtectionManager.CONFIG.closePercent = percent;
        }

        console.log(`%c手动触发平仓: ${MarginProtectionManager.CONFIG.closePercent}%`, 'color: #E91E63; font-weight: bold;');
        await this.executeLimitClose(position);
    }

    // ========== 日志 ==========
    log(action, data) {
        this.logs.push({
            timestamp: new Date().toISOString(),
            action,
            ...data
        });
        if (this.logs.length > 500) this.logs = this.logs.slice(-500);
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

// ==================== 日志持久化管理器 ====================
class LogPersistenceManager {
    static CONFIG = {
        storageKey: '01grid_logs',           // localStorage 键名
        autoSaveInterval: 60000,             // 自动保存间隔 60秒
        autoExportInterval: 300000,          // 自动导出间隔 5分钟
        maxStorageSize: 5000000,             // 最大存储大小 5MB
        keepHistoryDays: 7,                  // 保留历史天数
    };

    constructor() {
        this.isRunning = false;
        this.autoSaveTimer = null;
        this.autoExportTimer = null;
        this.sessionId = this.generateSessionId();
        this.lastExportTime = 0;

        // 尝试恢复上次的日志
        this.recoverLogs();

        // 注册页面关闭事件
        this.registerBeforeUnload();
    }

    // ========== 生成会话ID ==========
    generateSessionId() {
        const now = new Date();
        return `session_${now.toISOString().slice(0, 10)}_${now.getHours()}${now.getMinutes()}`;
    }

    // ========== 启动自动保存 ==========
    start() {
        if (this.isRunning) {
            console.log('日志持久化已在运行');
            return;
        }

        this.isRunning = true;
        console.log('%c═══════════════════════════════════════════', 'color: #795548;');
        console.log('%c  💾 日志持久化管理器已启动', 'color: #795548; font-weight: bold; font-size: 14px;');
        console.log('%c═══════════════════════════════════════════', 'color: #795548;');
        console.log(`会话ID: ${this.sessionId}`);
        console.log(`自动保存间隔: ${LogPersistenceManager.CONFIG.autoSaveInterval / 1000}秒`);
        console.log(`自动导出间隔: ${LogPersistenceManager.CONFIG.autoExportInterval / 60000}分钟`);

        // 启动自动保存到 localStorage
        this.autoSaveTimer = setInterval(() => {
            this.saveToLocalStorage();
        }, LogPersistenceManager.CONFIG.autoSaveInterval);

        // 启动自动导出到文件
        this.autoExportTimer = setInterval(() => {
            this.autoExportToFile();
        }, LogPersistenceManager.CONFIG.autoExportInterval);

        // 立即保存一次
        this.saveToLocalStorage();
    }

    // ========== 停止自动保存 ==========
    stop() {
        if (!this.isRunning) return;

        this.isRunning = false;

        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }

        if (this.autoExportTimer) {
            clearInterval(this.autoExportTimer);
            this.autoExportTimer = null;
        }

        // 最后保存一次
        this.saveToLocalStorage();

        console.log('%c💾 日志持久化管理器已停止', 'color: #795548; font-weight: bold;');
    }

    // ========== 收集所有日志 ==========
    collectAllLogs() {
        const logs = {
            sessionId: this.sessionId,
            timestamp: new Date().toISOString(),
            version: '2.3',

            // autoTrader 日志
            trading: {
                sessionStartTime: typeof autoTrader !== 'undefined' ? autoTrader.sessionStartTime : null,
                cycleCount: typeof autoTrader !== 'undefined' ? autoTrader.cycleCount : 0,
                totalOrders: typeof autoTrader !== 'undefined' ? autoTrader.totalOrders : 0,
                successfulOrders: typeof autoTrader !== 'undefined' ? autoTrader.successfulOrders : 0,
                tradingLogs: typeof autoTrader !== 'undefined' ? autoTrader.tradingLogs : [],
            },

            // 大单监控日志
            whale: typeof autoTrader !== 'undefined' && autoTrader.whaleMonitor ? {
                stats: autoTrader.whaleMonitor.stats,
                spikeEvents: autoTrader.whaleMonitor.spikeEvents,
                logs: autoTrader.whaleMonitor.logs.slice(-500),
            } : null,

            // 止盈止损日志
            tpsl: typeof tpslManager !== 'undefined' ? {
                logs: tpslManager.logs,
                lastPosition: tpslManager.lastPosition,
                lastEntryPrice: tpslManager.lastEntryPrice,
            } : null,

            // 保证金保护日志
            margin: typeof marginProtector !== 'undefined' ? {
                logs: marginProtector.logs,
                lastCloseTime: marginProtector.lastCloseTime,
            } : null,
        };

        return logs;
    }

    // ========== 保存到 localStorage ==========
    saveToLocalStorage() {
        try {
            const logs = this.collectAllLogs();
            const jsonStr = JSON.stringify(logs);

            // 检查大小限制
            if (jsonStr.length > LogPersistenceManager.CONFIG.maxStorageSize) {
                console.warn('日志过大，进行压缩...');
                // 压缩：只保留最近的日志
                if (logs.trading.tradingLogs.length > 500) {
                    logs.trading.tradingLogs = logs.trading.tradingLogs.slice(-500);
                }
                if (logs.whale && logs.whale.logs.length > 300) {
                    logs.whale.logs = logs.whale.logs.slice(-300);
                }
            }

            // 保存当前会话
            localStorage.setItem(LogPersistenceManager.CONFIG.storageKey, JSON.stringify(logs));

            // 保存历史记录索引
            this.updateHistoryIndex();

            console.log(`%c💾 日志已保存 (${(JSON.stringify(logs).length / 1024).toFixed(1)} KB)`, 'color: #795548;');

        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                console.warn('localStorage 已满，清理旧日志...');
                this.cleanOldLogs();
                this.saveToLocalStorage();  // 重试
            } else {
                console.error('保存日志失败:', e.message);
            }
        }
    }

    // ========== 更新历史索引 ==========
    updateHistoryIndex() {
        try {
            let history = JSON.parse(localStorage.getItem('01grid_history_index') || '[]');

            // 添加当前会话
            const existingIndex = history.findIndex(h => h.sessionId === this.sessionId);
            const sessionInfo = {
                sessionId: this.sessionId,
                startTime: typeof autoTrader !== 'undefined' && autoTrader.sessionStartTime
                    ? new Date(autoTrader.sessionStartTime).toISOString()
                    : new Date().toISOString(),
                lastUpdate: new Date().toISOString(),
                orders: typeof autoTrader !== 'undefined' ? autoTrader.totalOrders : 0,
            };

            if (existingIndex >= 0) {
                history[existingIndex] = sessionInfo;
            } else {
                history.push(sessionInfo);
            }

            // 清理过期记录
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - LogPersistenceManager.CONFIG.keepHistoryDays);
            history = history.filter(h => new Date(h.lastUpdate) > cutoffDate);

            localStorage.setItem('01grid_history_index', JSON.stringify(history));

        } catch (e) {
            console.warn('更新历史索引失败:', e.message);
        }
    }

    // ========== 清理旧日志 ==========
    cleanOldLogs() {
        try {
            const history = JSON.parse(localStorage.getItem('01grid_history_index') || '[]');

            // 删除最旧的会话
            if (history.length > 0) {
                const oldest = history.sort((a, b) => new Date(a.lastUpdate) - new Date(b.lastUpdate))[0];
                localStorage.removeItem(`01grid_logs_${oldest.sessionId}`);
                console.log(`已清理旧日志: ${oldest.sessionId}`);
            }

        } catch (e) {
            console.warn('清理旧日志失败:', e.message);
        }
    }

    // ========== 从 localStorage 恢复日志 ==========
    recoverLogs() {
        try {
            const savedLogs = localStorage.getItem(LogPersistenceManager.CONFIG.storageKey);
            if (!savedLogs) {
                console.log('%c💾 无历史日志可恢复', 'color: #9E9E9E;');
                return false;
            }

            const logs = JSON.parse(savedLogs);
            console.log('%c═══════════════════════════════════════════', 'color: #4CAF50;');
            console.log('%c  💾 发现历史日志！', 'color: #4CAF50; font-weight: bold;');
            console.log('%c═══════════════════════════════════════════', 'color: #4CAF50;');
            console.log(`会话ID: ${logs.sessionId}`);
            console.log(`保存时间: ${logs.timestamp}`);
            console.log(`订单数: ${logs.trading?.totalOrders || 0}`);
            console.log('');
            console.log('%c运行 logManager.restoreLogs() 恢复日志', 'color: #FF9800;');
            console.log('%c运行 logManager.exportRecoveredLogs() 导出恢复的日志', 'color: #FF9800;');

            this.recoveredLogs = logs;
            return true;

        } catch (e) {
            console.warn('恢复日志失败:', e.message);
            return false;
        }
    }

    // ========== 恢复日志到当前实例 ==========
    restoreLogs() {
        if (!this.recoveredLogs) {
            console.log('无日志可恢复');
            return false;
        }

        try {
            const logs = this.recoveredLogs;

            // 恢复交易日志
            if (logs.trading && typeof autoTrader !== 'undefined') {
                autoTrader.tradingLogs = logs.trading.tradingLogs || [];
                autoTrader.totalOrders = logs.trading.totalOrders || 0;
                autoTrader.successfulOrders = logs.trading.successfulOrders || 0;
                autoTrader.sessionStartTime = logs.trading.sessionStartTime;
                console.log(`✅ 已恢复 ${autoTrader.tradingLogs.length} 条交易日志`);
            }

            // 恢复大单监控日志
            if (logs.whale && typeof autoTrader !== 'undefined' && autoTrader.whaleMonitor) {
                autoTrader.whaleMonitor.stats = logs.whale.stats || autoTrader.whaleMonitor.stats;
                autoTrader.whaleMonitor.spikeEvents = logs.whale.spikeEvents || [];
                autoTrader.whaleMonitor.logs = logs.whale.logs || [];
                console.log(`✅ 已恢复 ${autoTrader.whaleMonitor.logs.length} 条大单日志`);
            }

            // 恢复止盈止损日志
            if (logs.tpsl && typeof tpslManager !== 'undefined') {
                tpslManager.logs = logs.tpsl.logs || [];
                console.log(`✅ 已恢复 ${tpslManager.logs.length} 条止盈止损日志`);
            }

            console.log('%c💾 日志恢复完成！', 'color: #4CAF50; font-weight: bold;');
            return true;

        } catch (e) {
            console.error('恢复日志失败:', e.message);
            return false;
        }
    }

    // ========== 导出恢复的日志 ==========
    exportRecoveredLogs() {
        if (!this.recoveredLogs) {
            console.log('无恢复的日志可导出');
            return;
        }

        const jsonStr = JSON.stringify(this.recoveredLogs, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `01grid_recovered_${this.recoveredLogs.sessionId}.json`;
        a.click();
        URL.revokeObjectURL(url);

        console.log('%c✅ 恢复的日志已导出', 'color: #4CAF50; font-weight: bold;');
    }

    // ========== 自动导出到文件 ==========
    autoExportToFile() {
        // 检查是否有足够新的数据需要导出
        const now = Date.now();
        if (now - this.lastExportTime < LogPersistenceManager.CONFIG.autoExportInterval) {
            return;
        }

        // 检查是否有订单活动
        if (typeof autoTrader !== 'undefined' && autoTrader.totalOrders > 0) {
            this.exportToFile();
            this.lastExportTime = now;
        }
    }

    // ========== 手动导出到文件 ==========
    exportToFile() {
        const logs = this.collectAllLogs();
        const jsonStr = JSON.stringify(logs, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `01grid_logs_${this.sessionId}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);

        console.log('%c✅ 日志已导出到文件', 'color: #4CAF50; font-weight: bold;');
    }

    // ========== 注册页面关闭事件 ==========
    registerBeforeUnload() {
        window.addEventListener('beforeunload', () => {
            // 页面关闭前保存日志
            this.saveToLocalStorage();
        });

        // 也监听 visibilitychange（标签页切换）
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.saveToLocalStorage();
            }
        });
    }

    // ========== 查看历史会话列表 ==========
    listHistory() {
        try {
            const history = JSON.parse(localStorage.getItem('01grid_history_index') || '[]');

            if (history.length === 0) {
                console.log('无历史会话');
                return [];
            }

            console.log('%c═══════════════════════════════════════════', 'color: #795548;');
            console.log('%c  📋 历史会话列表', 'color: #795548; font-weight: bold;');
            console.log('%c═══════════════════════════════════════════', 'color: #795548;');

            history.forEach((h, i) => {
                console.log(`${i + 1}. ${h.sessionId}`);
                console.log(`   开始: ${h.startTime}`);
                console.log(`   更新: ${h.lastUpdate}`);
                console.log(`   订单: ${h.orders}`);
            });

            return history;

        } catch (e) {
            console.warn('读取历史列表失败:', e.message);
            return [];
        }
    }

    // ========== 清除所有存储的日志 ==========
    clearAll() {
        try {
            localStorage.removeItem(LogPersistenceManager.CONFIG.storageKey);
            localStorage.removeItem('01grid_history_index');
            this.recoveredLogs = null;
            console.log('%c✅ 已清除所有存储的日志', 'color: #4CAF50;');
        } catch (e) {
            console.error('清除日志失败:', e.message);
        }
    }

    // ========== 状态查询 ==========
    getStatus() {
        let storageUsed = 0;
        try {
            const logs = localStorage.getItem(LogPersistenceManager.CONFIG.storageKey);
            storageUsed = logs ? logs.length : 0;
        } catch (e) {}

        return {
            isRunning: this.isRunning,
            sessionId: this.sessionId,
            storageUsed: `${(storageUsed / 1024).toFixed(1)} KB`,
            hasRecoveredLogs: !!this.recoveredLogs,
            lastExportTime: this.lastExportTime ? new Date(this.lastExportTime).toLocaleTimeString() : '无',
        };
    }
}

// ==================== 全局实例 ====================
const autoTrader = new BTCAutoTrading();
const tpslManager = new PositionStopLossManager(autoTrader.orderManager);
const marginProtector = new MarginProtectionManager(autoTrader.orderManager);
const logManager = new LogPersistenceManager();

// ==================== 快捷指令 ====================
console.log('%c═══════════════════════════════════════════════════════', 'color: #2196F3;');
console.log('%c  01交易所 网格交易 + 插针狙击 v2.1', 'color: #2196F3; font-weight: bold; font-size: 16px;');
console.log('%c═══════════════════════════════════════════════════════', 'color: #2196F3;');
console.log('');
console.log('%c基础命令:', 'color: #4CAF50; font-weight: bold;');
console.log('  autoTrader.startAutoTrading()  - 启动自动交易');
console.log('  autoTrader.stopAutoTrading()   - 停止自动交易');
console.log('  autoTrader.getStatus()         - 查看完整状态');
console.log('  autoTrader.cancelAllOrders()   - 取消所有订单');
console.log('  autoTrader.resetRiskCooldown() - 重置风控冷却');
console.log('');
console.log('%c插针狙击命令:', 'color: #9C27B0; font-weight: bold;');
console.log('  autoTrader.enableSniperMode()  - 启用狙击模式');
console.log('  autoTrader.disableSniperMode() - 禁用狙击模式');
console.log('  autoTrader.whaleMonitor.getStatus()   - 查看大单监控状态');
console.log('');
console.log('%c止盈止损命令:', 'color: #FF5722; font-weight: bold;');
console.log('  tpslManager.start()            - 启动止盈止损监控');
console.log('  tpslManager.stop()             - 停止止盈止损监控');
console.log('  tpslManager.getStatus()        - 查看止盈止损状态');
console.log('  tpslManager.setTPSLPercent(1, 1) - 设置止盈止损百分比');
console.log('  tpslManager.getPositionInfo()  - 查看当前持仓信息');
console.log('');
console.log('%c保证金保护命令:', 'color: #E91E63; font-weight: bold;');
console.log('  marginProtector.start()        - 启动保证金保护(仓位>50%自动平仓)');
console.log('  marginProtector.stop()         - 停止保证金保护');
console.log('  marginProtector.getStatus()    - 查看保证金状态');
console.log('  marginProtector.setThreshold(50) - 设置保证金阈值(%)');
console.log('  marginProtector.setClosePercent(50) - 设置平仓比例(%)');
console.log('  marginProtector.manualClose(50)    - 手动平仓指定比例');
console.log('');
console.log('%c日志持久化命令:', 'color: #795548; font-weight: bold;');
console.log('  logManager.start()             - 启动自动保存(每60秒+关闭前)');
console.log('  logManager.stop()              - 停止自动保存');
console.log('  logManager.exportToFile()      - 手动导出日志文件');
console.log('  logManager.restoreLogs()       - 恢复上次关闭前的日志');
console.log('  logManager.listHistory()       - 查看历史会话列表');
console.log('  logManager.getStatus()         - 查看日志管理状态');
console.log('');
console.log('%c完整报告导出:', 'color: #00BCD4; font-weight: bold;');
console.log('  autoTrader.exportFullReport()  - 导出完整报告(供AI分析)');
console.log('  autoTrader.exportLogs()        - 导出交易日志');
console.log('  autoTrader.whaleMonitor.exportData()  - 导出大单数据');
console.log('');
console.log('%c警报级别说明:', 'color: #FF9800; font-weight: bold;');
console.log('  🟢 GREEN  - 市场正常，正常网格交易');
console.log('  🟡 YELLOW - 注意观察，可能有波动');
console.log('  🟠 ORANGE - 高风险，谨慎下单');
console.log('  🔴 RED    - 即将插针！暂停网格，等待狙击信号');
console.log('');
console.log('%c使用说明:', 'color: #607D8B;');
console.log('  1. 先在页面上设置好 Size（开仓数量）');
console.log('  2. 运行 logManager.start() 启用日志持久化(防止关闭丢失)');
console.log('  3. 运行 autoTrader.startAutoTrading() 启动网格交易');
console.log('  4. 运行 marginProtector.start() 启用保证金保护');
console.log('  5. 系统会自动监控大单和插针');
console.log('  6. 关闭页面后重新打开，运行 logManager.restoreLogs() 恢复日志');
console.log('');

// 请求桌面通知权限
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

// 自动启动（可选，取消注释以自动启动）
// autoTrader.startAutoTrading();
