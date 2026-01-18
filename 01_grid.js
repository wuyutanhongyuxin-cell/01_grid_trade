// 01交易所 BTC 网格自动下单系统 - 带风控冷却机制
// 基于原版 var_grid.js 改写，适配 01.xyz 交易所
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
    static GRID_STRATEGY_CONFIG = {
        TOTAL_ORDERS: 10,              // 总订单数（剥头皮用更少）

        // 窗口宽度（核心参数）
        WINDOW_PERCENT: 0.005,         // 0.5% 窗口范围（剥头皮，约 ±$475）

        // 买卖单比例（总和必须为1）
        SELL_RATIO: 0.5,
        BUY_RATIO: 0.5,

        // 网格间距
        BASE_PRICE_INTERVAL: 10,       // 基础间距 $10
        SAFE_GAP: 3,                   // 安全间距（剥头皮，首单距盘口仅 $3）

        // 安全保护
        MAX_DRIFT_BUFFER: 500,         // 减小漂移缓冲（剥头皮更严格）
        MIN_VALID_PRICE: 10000,
        MAX_MULTIPLIER: 15,

        // 策略配置（RSI/ADX 风控）
        RSI_MIN: 30,
        RSI_MAX: 70,
        ADX_TREND_THRESHOLD: 25,
        ADX_STRONG_TREND: 30
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

        this.minOrderInterval = BTCAutoTrading.TRADING_CONFIG.MIN_ORDER_INTERVAL;
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
    async triggerRiskCooldown(reason) {
        this.riskCoolingDown = true;
        this.riskTriggeredReason = reason;

        const cooldownMs = BTCAutoTrading.TRADING_CONFIG.RISK_COOLDOWN_MINUTES * 60 * 1000;
        this.riskCoolDownEndTime = Date.now() + cooldownMs;

        const endTime = new Date(this.riskCoolDownEndTime).toLocaleTimeString();
        console.log(`%c⚠️ 触发风控冷却：${reason}`, "color: red; font-weight: bold; font-size: 14px;");
        console.log(`%c冷却时间：15分钟，恢复时间：${endTime}`, "color: orange;");

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
            console.log(`%c✅ 风控冷却已结束，恢复交易`, "color: green; font-weight: bold;");
            return false;
        }

        const remainingMs = this.riskCoolDownEndTime - now;
        const remainingMinutes = Math.floor(remainingMs / 60000);
        const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
        console.log(`%c⏳ 风控冷却中: ${remainingMinutes}分${remainingSeconds}秒`, "color: orange;");

        return true;
    }

    resetRiskCooldown() {
        this.riskCoolingDown = false;
        this.riskCoolDownEndTime = 0;
        this.riskTriggeredReason = '';
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

        return {
            inCooldown: true,
            reason: this.riskTriggeredReason,
            remainingMinutes,
            remainingSeconds,
            endTime,
            message: `风控冷却中 - ${this.riskTriggeredReason}，剩余: ${remainingMinutes}分${remainingSeconds}秒`
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

        console.log('%c========================================', 'color: #4CAF50; font-weight: bold;');
        console.log('%c  01交易所 网格自动交易已启动', 'color: #4CAF50; font-weight: bold; font-size: 16px;');
        console.log('%c========================================', 'color: #4CAF50; font-weight: bold;');
        console.log('Post Only 模式已启用，节省手续费');

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

    stopAutoTrading() {
        this.isMonitoring = false;
        this.tradingEnabled = false;
        clearInterval(this.monitorInterval);
        this.monitorInterval = null;
        console.log('%c自动交易已停止', 'color: red; font-weight: bold;');
    }

    // ==================== 核心交易周期 ====================
    async executeTradingCycle() {
        if (!this.tradingEnabled) return;
        this.cycleCount++;
        console.log(`\n[${new Date().toLocaleTimeString()}] 第${this.cycleCount}次循环`);

        // 1. 检查风控冷却状态
        if (this.checkRiskCooldown()) {
            await this.cancelAllOrders();
            return;
        }

        // 2. RSI/ADX 检查（如果有 TradingView iframe）
        try {
            const indicators = await this.getIndicatorsFromChart();

            if (indicators && typeof indicators.rsi === 'number' && typeof indicators.adx === 'number') {
                const { rsi, adx } = indicators;
                const { RSI_MIN, RSI_MAX, ADX_TREND_THRESHOLD, ADX_STRONG_TREND } = BTCAutoTrading.GRID_STRATEGY_CONFIG;

                console.log(`%c当前指标 - RSI: ${rsi.toFixed(2)}, ADX: ${adx.toFixed(2)}`,
                    "color: #ff9800; font-weight: bold;");

                // 强趋势触发风控
                if (adx > ADX_STRONG_TREND) {
                    const reason = `强趋势市场 (ADX: ${adx.toFixed(2)} > ${ADX_STRONG_TREND})`;
                    console.log(`%c[风控触发] ${reason}`, "color: red; font-weight: bold;");
                    this.triggerRiskCooldown(reason);
                    return;
                }

                // RSI 超限触发风控
                if (rsi < RSI_MIN || rsi > RSI_MAX) {
                    if (adx > ADX_TREND_THRESHOLD) {
                        const reason = `趋势市场中RSI(${rsi.toFixed(2)})超限`;
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

    // ==================== RSI 读取模块 ====================
    async getIndicatorsFromChart() {
        const iframe = document.querySelector('iframe');
        if (!iframe) return null;

        try {
            const doc = iframe.contentDocument;
            if (!doc) return null;

            const valueElements = doc.querySelectorAll('div[class*="valueValue"]');
            if (valueElements.length === 0) return null;

            let result = { rsi: null, adx: null };

            valueElements.forEach(element => {
                const valueText = element.textContent.trim();
                const color = window.getComputedStyle(element).color;
                const parent = element.parentElement;
                const titleEl = parent?.querySelector('div[class*="valueTitle"]');
                const title = titleEl ? titleEl.textContent.trim() : '';

                const val = parseFloat(valueText.replace(/,/g, ''));

                if (color.includes('126, 87, 194') || title === 'RSI') {
                    result.rsi = val;
                } else if (color.includes('255, 82, 82') || title === 'ADX') {
                    result.adx = val;
                }
            });

            return result;
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
        return {
            isMonitoring: this.isMonitoring,
            cycleCount: this.cycleCount,
            processedCount: this.processedOrders.size,
            lastOrderTime: this.lastOrderTime ? new Date(this.lastOrderTime).toLocaleTimeString() : '无',
            riskCooldown: riskStatus
        };
    }

    showWarningMessage(msg) {
        console.warn(`警告：${msg}`);
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
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

// ==================== 全局实例 ====================
const autoTrader = new BTCAutoTrading();

// ==================== 快捷指令 ====================
console.log('%c========================================', 'color: #2196F3;');
console.log('%c  01交易所网格交易脚本已加载', 'color: #2196F3; font-weight: bold;');
console.log('%c========================================', 'color: #2196F3;');
console.log('可用命令:');
console.log('  autoTrader.startAutoTrading()  - 启动自动交易');
console.log('  autoTrader.stopAutoTrading()   - 停止自动交易');
console.log('  autoTrader.getStatus()         - 查看状态');
console.log('  autoTrader.cancelAllOrders()   - 取消所有订单');
console.log('  autoTrader.resetRiskCooldown() - 重置风控冷却');
console.log('');
console.log('请先在页面上设置好 Size（开仓数量），然后运行:');
console.log('  autoTrader.startAutoTrading()');

// 自动启动（可选，取消注释以自动启动）
// autoTrader.startAutoTrading();
