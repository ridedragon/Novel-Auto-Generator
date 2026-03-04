import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import './txtToWorldbook.js';

const extensionName = "novel-auto-generator";

const defaultSettings = {
    totalChapters: 1000,
    currentChapter: 0,
    prompt: "继续推进剧情，保证剧情流畅自然，注意人物性格一致性",
    isRunning: false,
    isPaused: false,
    
    // 发送检测设置
    enableSendToastDetection: true,
    sendToastWaitTimeout: 60000,
    sendPostToastWaitTime: 1000,
    
    // 回复等待设置
    replyWaitTime: 5000,
    stabilityCheckInterval: 1000,
    stabilityRequiredCount: 3,
    enableReplyToastDetection: true,
    replyToastWaitTimeout: 300000,
    replyPostToastWaitTime: 2000,
    
    // 生成设置
    autoSaveInterval: 50,
    maxRetries: 3,
    minChapterLength: 100,
    
    // 导出设置
    exportAll: true,
    exportStartFloor: 0,
    exportEndFloor: 99999,
    exportIncludeUser: false,
    exportIncludeAI: true,
    useRawContent: true,
    extractTags: '',
    extractMode: 'all',
    tagSeparator: '\n\n',
    
    panelCollapsed: {
        api: false,
        msgopt: false,
        presets: false,
        generate: false,
        export: false,
        extract: true,
        advanced: true,
    },

    // API 设置 (移除冗余生成参数)
    apiEndpoints: [
        { id: 'default', name: '默认 API', url: '', key: '', maxTokens: 4096 }
    ],
    selectedApiEndpointId: 'default',
    apiModel: '',
    apiEnabled: false,

    // 消息优化设置
    enableMsgOptimization: false,
    msgOptModel: '',
    msgOptTemp: 0.7,
    msgOptTopP: 1.0,
    msgOptTopK: 0,
    msgOptMaxTokens: 4096,
    msgOptSystemPrompt: "请根据以下预设条目和最新的AI回复，对AI回复进行润色优化。要求：1. 保持人物性格一致 2. 润色文笔 3. 修复逻辑漏洞 4. 仅输出最终正文，不输出其他多余内容。",
    msgOptPresets: [
        { id: 'latest_ai', name: "最新AI消息", content: "[LATEST_AI_MESSAGE]", isEnabled: true, isHidden: false, icon: "🤖", priority: 0, role: 'system', isLocked: true },
        { id: 'msg_opt_1', name: "润色文笔", content: "使语言更加优美生动，符合小说体裁。", isEnabled: true, isHidden: false, icon: "✍️", priority: 1, role: 'system' }
    ],

    // 提示词预设
    enablePresetOptimization: false,
    presetModel: '',
    presetTemp: 0.7,
    presetTopP: 1.0,
    presetTopK: 0,
    presetMaxTokens: 4096,
    presetSystemPrompt: "请根据以下预设条目和当前的续写需求，生成一段具体的、发给小说续写AI的指令（Prompt）。要求：1. 只有正文 2. 包含具体的剧情走向建议 3. 保持文风一致性。",
    presets: [
        { id: 'history', name: "酒馆聊天历史", content: "[CHAT_HISTORY]", isEnabled: false, isHidden: false, icon: "📜", priority: 0, role: 'system', isLocked: true },
        { id: 1, name: "剧情连贯性", content: "注意前文伏笔，确保逻辑严密。", isEnabled: true, isHidden: false, icon: "🧩", priority: 1, role: 'system' },
        { id: 2, name: "人物性格", content: "保持角色性格鲜明，说话语气符合人设。", isEnabled: true, isHidden: false, icon: "👤", priority: 2, role: 'system' }
    ],

    // 正则替换设置
    enableRegexProcessing: false,
    regexItems: [],
};

let settings = {};
let abortController = null;
let generationStats = { startTime: null, chaptersGenerated: 0, totalCharacters: 0, errors: [] };
let isOptimizing = false;
let lastOptimizedId = -1;

// ============================================
// 工具函数
// ============================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg, type = 'info') {
    const p = { info: '📘', success: '✅', warning: '⚠️', error: '❌', debug: '🔍' }[type] || 'ℹ️';
    console.log(`[NovelGen] ${p} ${msg}`);
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '--:--:--';
    const s = Math.floor(ms/1000)%60, m = Math.floor(ms/60000)%60, h = Math.floor(ms/3600000);
    return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
}

// ============================================
// SillyTavern 数据访问
// ============================================

function getSTChat() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            if (ctx?.chat && Array.isArray(ctx.chat)) return ctx.chat;
        }
    } catch(e) {}
    
    try {
        if (typeof getContext === 'function') {
            const ctx = getContext();
            if (ctx?.chat && Array.isArray(ctx.chat)) return ctx.chat;
        }
    } catch(e) {}
    
    if (window.chat && Array.isArray(window.chat)) return window.chat;
    if (typeof chat !== 'undefined' && Array.isArray(chat)) return chat;
    
    return null;
}

function getTotalFloors() {
    const c = getSTChat();
    return c ? c.length : document.querySelectorAll('#chat .mes').length;
}

function getMaxFloorIndex() {
    const total = getTotalFloors();
    return total > 0 ? total - 1 : 0;
}

function getRawMessages(startFloor, endFloor, opts = {}) {
    const { includeUser = false, includeAI = true } = opts;
    const stChat = getSTChat();
    if (!stChat) return null;
    
    const messages = [];
    const start = Math.max(0, startFloor);
    const end = Math.min(stChat.length - 1, endFloor);
    
    for (let i = start; i <= end; i++) {
        const msg = stChat[i];
        if (!msg) continue;
        const isUser = msg.is_user || msg.is_human || false;
        if (isUser && !includeUser) continue;
        if (!isUser && !includeAI) continue;
        const rawContent = msg.mes || '';
        if (rawContent) {
            messages.push({ floor: i, isUser, name: msg.name || (isUser ? 'User' : 'AI'), content: rawContent });
        }
    }
    return messages;
}

function getAIMessageCount() {
    return document.querySelectorAll('#chat .mes[is_user="false"]').length;
}

function getLastAIMessageLength() {
    const msgs = document.querySelectorAll('#chat .mes[is_user="false"]');
    if (!msgs.length) return 0;
    const last = msgs[msgs.length - 1].querySelector('.mes_text');
    return last?.innerText?.trim()?.length || 0;
}

// ============================================
// 状态检查与控制逻辑
// ============================================

/**
 * 检查暂停和停止状态
 */
async function checkStatus() {
    if (abortController?.signal.aborted) {
        throw new Error('用户中止');
    }
    while (settings.isPaused) {
        if (abortController?.signal.aborted) {
            throw new Error('用户中止');
        }
        await sleep(500);
    }
}

/**
 * 同步终止酒馆的生成状态
 */
function triggerSillyTavernStop() {
    const selectors = ['#stop_generation', '.stop_generation', 'button[title*="Stop"]', 'button[title*="停止"]'];
    for (const selector of selectors) {
        const $btn = $(selector);
        if ($btn.length && ($btn.is(':visible') || $btn.css('display') !== 'none')) {
            $btn.trigger('click');
            log('已触发酒馆原生中止按钮: ' + selector, 'success');
            return true;
        }
    }
    return false;
}

function pauseGeneration() { 
    settings.isPaused = true; 
    // 暂停时立即尝试中止当前的 AI 请求
    if (abortController) abortController.abort();
    triggerSillyTavernStop();
    updateUI(); 
    toastr.info('生成已暂停'); 
}

function resumeGeneration() { 
    settings.isPaused = false; 
    updateUI(); 
    toastr.info('生成已恢复'); 
}

function stopGeneration() { 
    if (abortController) abortController.abort();
    triggerSillyTavernStop();
    toastr.warning('已发送停止指令'); 
}

function resetProgress() {
    if (settings.isRunning) { 
        toastr.warning('请先停止后再重置'); 
        return; 
    }
    settings.currentChapter = 0;
    generationStats = { startTime: null, chaptersGenerated: 0, totalCharacters: 0, errors: [] };
    lastOptimizedId = -1;
    saveSettings(); 
    updateUI(); 
    toastr.info('进度已重置');
}

// ============================================
// API 调用 (支持 AbortSignal)
// ============================================

async function callCustomApi(messages, options = {}) {
    const targetModel = options.model || settings.apiModel;
    if (!targetModel) throw new Error('请先选择自定义 API 模型');
    
    const parts = targetModel.split(':::');
    if (parts.length < 2) throw new Error('API模型配置有误');
    const apiId = parts[0], modelId = parts.slice(1).join(':::');
    
    const apiConfig = settings.apiEndpoints.find(e => e.id == apiId) || settings.apiEndpoints[0];
    const url = apiConfig.url, key = apiConfig.key;
    if (!url || !modelId) throw new Error('API URL 或模型未设置');

    const body = {
        model: modelId,
        messages: Array.isArray(messages) ? messages : [{ role: 'user', content: messages }],
        temperature: options.temperature ?? 0.7,
        top_p: options.topP ?? 1.0,
        max_tokens: options.maxTokens ?? apiConfig.maxTokens
    };
    if (options.topK > 0) body.top_k = options.topK;

    const maxRetries = settings.maxRetries || 3;
    let retries = 0;

    while (retries <= maxRetries) {
        await checkStatus();
        try {
            const response = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: abortController?.signal
            });

            if (!response.ok) throw new Error(`API 错误 ${response.status}`);
            const data = await response.json();
            let content = data.choices?.[0]?.message?.content || '';
            if (content.trim()) return applyRegexes(content, 'ai');
            
            if (retries >= maxRetries) throw new Error('API 返回内容为空');
            retries++; await sleep(1000);
        } catch (e) {
            if (e.name === 'AbortError' || e.message === '用户中止') throw new Error('用户中止');
            if (retries >= maxRetries) throw e;
            retries++; await sleep(1000);
        }
    }
}

// ============================================
// 生成逻辑核心
// ============================================

async function sendMessage(text) {
    const $ta = $('#send_textarea'), $btn = $('#send_but');
    if (!$ta.length || !$btn.length) throw new Error('找不到酒馆发送组件');
    $ta.val(text).trigger('input').trigger('change');
    await sleep(100);
    $btn.trigger('click');
    
    if (settings.enableSendToastDetection) {
        await sleep(500);
        await waitForToastsClear(settings.sendToastWaitTimeout, settings.sendPostToastWaitTime, '[发送阶段] ');
    }
    await checkStatus();
}

async function waitForAIResponse(prevCount) {
    const startTime = Date.now();
    while (getAIMessageCountRobust() <= prevCount) {
        await checkStatus();
        if (Date.now() - startTime > 120000) throw new Error('等待 AI 回复超时');
        await sleep(500);
    }
    
    let lastLen = 0, stableCount = 0;
    while (stableCount < settings.stabilityRequiredCount) {
        await checkStatus();
        await sleep(settings.stabilityCheckInterval);
        const curLen = getLastAIMessageLength();
        if (curLen === lastLen && curLen > 0) stableCount++; else { stableCount = 0; lastLen = curLen; }
    }
    
    if (settings.replyWaitTime > 0) await sleep(settings.replyWaitTime);
    if (settings.enableReplyToastDetection) {
        await waitForToastsClear(settings.replyToastWaitTimeout, settings.replyPostToastWaitTime, '[回复阶段] ');
    }
}

function getAIMessageCountRobust() {
    const domCount = document.querySelectorAll('#chat .mes[is_user="false"]').length;
    const stChat = getSTChat();
    const chatCount = stChat ? stChat.filter(msg => msg && !msg.is_user && !msg.is_human).length : 0;
    return Math.max(domCount, chatCount);
}

async function generateSingleChapter(num) {
    let textToSend = settings.prompt;
    if (settings.enablePresetOptimization) {
        const generated = await optimizePromptWithAI();
        if (generated) textToSend = generated; else throw new Error('预设优化失败');
    } else if (settings.apiEnabled) {
        const reply = await callCustomApi(settings.prompt);
        if (reply?.trim()) textToSend = reply.trim(); else throw new Error('API 返回内容为空');
    }

    const prevCount = getAIMessageCountRobust();
    await sendMessage(textToSend);
    await waitForAIResponse(prevCount);
    
    if (settings.enableMsgOptimization) {
        const stChat = getSTChat();
        let lastIdx = -1, content = '';
        if (stChat) {
            for (let i = stChat.length - 1; i >= 0; i--) {
                if (stChat[i] && !stChat[i].is_user && !stChat[i].is_human && stChat[i].mes) {
                    content = stChat[i].mes; lastIdx = i; break;
                }
            }
        }
        if (lastIdx !== -1 && content) {
            try { isOptimizing = true; await performMessageOptimization(lastIdx, content); lastOptimizedId = lastIdx; }
            finally { isOptimizing = false; }
        }
    }
    
    const finalLen = getLastAIMessageLength();
    if (finalLen < settings.minChapterLength) throw new Error(`字数不足 (${finalLen})`);
    generationStats.chaptersGenerated++;
    generationStats.totalCharacters += finalLen;
    log(`第 ${num} 章完成`, 'success');
}

async function performMessageOptimization(idx, raw) {
    const active = settings.msgOptPresets.filter(p => p.isEnabled && !p.isHidden).sort((a,b) => a.priority - b.priority);
    if (!active.length) return;
    const messages = [{ role: 'system', content: settings.msgOptSystemPrompt }];
    const optimizedInput = applyRegexes(raw, 'msgOpt');
    for (const p of active) {
        if (p.id === 'latest_ai') messages.push({ role: 'system', content: `[LATEST_AI_MESSAGE]\n${optimizedInput}` });
        else messages.push({ role: p.role || 'system', content: `### ${p.name}\n${p.content}` });
    }
    const result = await callCustomApi(messages, {
        model: settings.msgOptModel, temperature: settings.msgOptTemp,
        topP: settings.msgOptTopP, topK: settings.msgOptTopK, maxTokens: settings.msgOptMaxTokens
    });
    if (result?.trim()) {
        const helper = window.TavernHelper || window;
        if (typeof helper.setChatMessages === 'function') {
            await helper.setChatMessages([{ message_id: idx, message: result.trim() }]);
        }
    }
}

async function startGeneration() {
    if (settings.isRunning) return toastr.warning('任务已在运行');
    settings.isRunning = true; settings.isPaused = false;
    abortController = new AbortController();
    generationStats = { startTime: Date.now(), chaptersGenerated: 0, totalCharacters: 0, errors: [] };
    updateUI();
    
    try {
        while (settings.currentChapter < settings.totalChapters) {
            await checkStatus();
            let success = false, retries = 0, chapterNum = settings.currentChapter + 1;
            while (!success && retries < settings.maxRetries) {
                try {
                    await checkStatus();
                    await generateSingleChapter(chapterNum);
                    success = true; settings.currentChapter++; saveSettings(); updateUI();
                } catch(e) {
                    if (e.message === '用户中止') {
                        if (settings.isPaused) {
                            log('已暂停，等待恢复...', 'info');
                            abortController = new AbortController(); // 为恢复后的请求重置
                            await checkStatus();
                            continue;
                        }
                        throw e;
                    }
                    retries++;
                    log(`第 ${chapterNum} 章失败: ${e.message}`, 'warning');
                    if (retries < settings.maxRetries) await sleep(5000);
                }
            }
            if (!success) { toastr.error(`第 ${chapterNum} 章多次失败，已中止`); break; }
        }
        if (settings.currentChapter >= settings.totalChapters) toastr.success('任务全部完成');
    } catch (e) {
        log(e.message === '用户中止' ? '任务已由用户停止' : '严重错误: ' + e.message, 'info');
    } finally {
        settings.isRunning = false; settings.isPaused = false; abortController = null;
        saveSettings(); updateUI();
    }
}

// ============================================
// UI 创建与逻辑处理
// ============================================

function createUI() {
    const html = `
    <div id="nag-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>📚 小说自动生成器</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <div class="nag-section nag-status-panel">
                    <span id="nag-status" class="nag-status-badge stopped">⏹️ 已停止</span>
                    <div class="nag-progress-container">
                        <div class="nag-progress-bar"><div id="nag-progress-fill" class="nag-progress-fill"></div></div>
                        <div id="nag-progress-text">0 / 1000 (0%)</div>
                    </div>
                    <div class="nag-stats-row">
                        <span>⏱️ <span id="nag-time-elapsed">--:--:--</span></span>
                        <span>⏳ <span id="nag-time-remaining">--:--:--</span></span>
                        <span>❌ <span id="nag-stat-errors">0</span></span>
                    </div>
                </div>
                <div class="nag-section nag-controls">
                    <div class="nag-btn-row">
                        <button id="nag-btn-start" class="menu_button">▶️ 开始</button>
                        <button id="nag-btn-pause" class="menu_button" disabled>⏸️ 暂停</button>
                        <button id="nag-btn-resume" class="menu_button" disabled>⏯️ 恢复</button>
                        <button id="nag-btn-stop" class="menu_button" disabled>⏹️ 停止</button>
                    </div>
                    <div class="nag-btn-row"><button id="nag-btn-reset" class="menu_button">🔄 重置进度</button></div>
                </div>
                <!-- 🌐 自定义 API -->
                <div id="nag-panel-api" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="api"><span class="nag-panel-title">🌐 自定义 API</span><div class="nag-panel-actions"><span class="nag-help-btn" data-help="api">❓</span><span class="nag-collapse-icon">▼</span></div></div>
                    <div class="nag-panel-content">
                        <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-api-enabled"><span>🚀 启用自定义 API (自动生成模式)</span></label></div>
                        <div class="nag-setting-item">
                            <label>API 节点</label>
                            <div class="nag-setting-row"><select id="nag-api-endpoint-select" style="flex: 1;"></select><button id="nag-btn-add-api" class="menu_button_icon">➕</button><button id="nag-btn-delete-api" class="menu_button_icon">🗑️</button></div>
                        </div>
                        <div class="nag-setting-item"><label>节点名称</label><input type="text" id="nag-set-api-name"></div>
                        <div class="nag-setting-item"><label>API URL</label><input type="text" id="nag-set-api-url"></div>
                        <div class="nag-setting-item"><label>API Key</label><input type="password" id="nag-set-api-key"></div>
                        <div class="nag-setting-row"><div class="nag-setting-item"><label>最大 Token</label><input type="number" id="nag-set-api-max-tokens"></div></div>
                        <div class="nag-btn-row"><button id="nag-btn-test-api" class="menu_button">🧪 测试连接</button></div>
                        <hr style="opacity: 0.2; margin: 10px 0;">
                        <div class="nag-setting-item"><label>选择模型</label><div class="nag-setting-row"><select id="nag-set-api-model" style="flex: 1;"></select><button id="nag-btn-fetch-models" class="menu_button_icon">🔄</button></div></div>
                    </div>
                </div>
                <!-- 🪄 消息优化 -->
                <div id="nag-panel-msgopt" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="msgopt"><span class="nag-panel-title">🪄 消息优化</span><div class="nag-panel-actions"><span class="nag-collapse-icon">▼</span></div></div>
                    <div class="nag-panel-content">
                        <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-msgopt-enabled"><span>✨ 启用 AI 回复润色</span></label></div>
                        <div class="nag-setting-item"><label>模型</label><select id="nag-set-msgopt-model"></select></div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>温度</label><input type="number" id="nag-set-msgopt-temp" step="0.1"></div>
                            <div class="nag-setting-item"><label>Top P</label><input type="number" id="nag-set-msgopt-topp" step="0.1"></div>
                        </div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>Top K</label><input type="number" id="nag-set-msgopt-topk"></div>
                            <div class="nag-setting-item"><label>最大 Token</label><input type="number" id="nag-set-msgopt-max-tokens"></div>
                        </div>
                        <div class="nag-btn-row"><button id="nag-btn-add-msgopt-preset" class="menu_button">➕ 添加预设</button><button id="nag-btn-msgopt-optimize-now" class="menu_button">🪄 立即测试</button></div>
                        <div id="nag-msgopt-preset-list" class="nag-preset-list"></div>
                    </div>
                </div>
                <!-- 🎭 提示词预设 -->
                <div id="nag-panel-presets" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="presets"><span class="nag-panel-title">🎭 提示词预设</span><div class="nag-panel-actions"><span class="nag-collapse-icon">▼</span></div></div>
                    <div class="nag-panel-content">
                        <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-preset-enabled"><span>🧠 启用指令转换</span></label></div>
                        <div class="nag-setting-item"><label>模型</label><select id="nag-set-preset-model"></select></div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>温度</label><input type="number" id="nag-set-preset-temp" step="0.1"></div>
                            <div class="nag-setting-item"><label>Top P</label><input type="number" id="nag-set-preset-topp" step="0.1"></div>
                        </div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>Top K</label><input type="number" id="nag-set-preset-topk"></div>
                            <div class="nag-setting-item"><label>最大 Token</label><input type="number" id="nag-set-preset-max-tokens"></div>
                        </div>
                        <div class="nag-btn-row"><button id="nag-btn-add-preset" class="menu_button">➕ 添加预设</button><button id="nag-btn-optimize-now" class="menu_button">🪄 立即测试</button></div>
                        <div id="nag-preset-list" class="nag-preset-list"></div>
                    </div>
                </div>
                <!-- 🧩 正则替换 -->
                <div id="nag-panel-regex" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="regex"><span class="nag-panel-title">🧩 正则替换</span><div class="nag-panel-actions"><span class="nag-collapse-icon">▼</span></div></div>
                    <div class="nag-panel-content">
                        <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-regex-enabled"><span>✨ 启用正则</span></label></div>
                        <div class="nag-btn-row"><button id="nag-btn-add-regex" class="menu_button">➕ 添加正则</button></div>
                        <div id="nag-regex-list" class="nag-preset-list"></div>
                    </div>
                </div>
                <!-- 📝 生成设置 -->
                <div id="nag-panel-generate" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="generate"><span class="nag-panel-title">📝 生成设置</span><div class="nag-panel-actions"><span class="nag-collapse-icon">▼</span></div></div>
                    <div class="nag-panel-content">
                        <div class="nag-setting-item"><label>目标总章节</label><input type="number" id="nag-set-total"></div>
                        <div class="nag-setting-item"><label>提示词模板</label><textarea id="nag-set-prompt" rows="2"></textarea></div>
                    </div>
                </div>
                <!-- ⚙️ 高级设置 -->
                <div id="nag-panel-advanced" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="advanced"><span class="nag-panel-title">⚙️ 高级设置</span><div class="nag-panel-actions"><span class="nag-collapse-icon">▼</span></div></div>
                    <div class="nag-panel-content">
                        <div class="nag-module">
                            <div class="nag-module-header">📤 发送阶段 (推进插件兼容)</div>
                            <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-send-toast-detection"><span>启用弹窗检测</span></label></div>
                            <div class="nag-setting-row" id="nag-send-toast-settings">
                                <div class="nag-setting-item"><label>超时(ms)</label><input type="number" id="nag-set-send-toast-timeout"></div>
                                <div class="nag-setting-item"><label>额外(ms)</label><input type="number" id="nag-set-send-post-toast-wait"></div>
                            </div>
                        </div>
                        <div class="nag-module">
                            <div class="nag-module-header">📥 回复阶段 (稳定性/总结检查)</div>
                            <div class="nag-setting-row">
                                <div class="nag-setting-item"><label>等待(ms)</label><input type="number" id="nag-set-reply-wait"></div>
                                <div class="nag-setting-item"><label>检测(ms)</label><input type="number" id="nag-set-stability-interval"></div>
                            </div>
                            <div class="nag-setting-item"><label>稳定次数</label><input type="number" id="nag-set-stability-count"></div>
                            <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-reply-toast-detection"><span>总结弹窗检测</span></label></div>
                            <div class="nag-setting-row" id="nag-reply-toast-settings">
                                <div class="nag-setting-item"><label>超时(ms)</label><input type="number" id="nag-set-reply-toast-timeout"></div>
                                <div class="nag-setting-item"><label>额外(ms)</label><input type="number" id="nag-set-reply-post-toast-wait"></div>
                            </div>
                        </div>
                        <div class="nag-module">
                            <div class="nag-module-header">🔧 控制参数</div>
                            <div class="nag-setting-row">
                                <div class="nag-setting-item"><label>最大重试</label><input type="number" id="nag-set-retries"></div>
                                <div class="nag-setting-item"><label>最小字数</label><input type="number" id="nag-set-minlen"></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="nag-section"><div class="nag-btn-row"><button id="nag-btn-txt-to-worldbook" class="menu_button" style="background: linear-gradient(135deg, #e67e22, #d35400);">📚 TXT转世界书工具</button></div></div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings').append(html);
    bindEvents(); syncUI(); applyPanelStates();
}

function bindEvents() {
    $('#nag-btn-start').on('click', startGeneration);
    $('#nag-btn-pause').on('click', pauseGeneration);
    $('#nag-btn-resume').on('click', resumeGeneration);
    $('#nag-btn-stop').on('click', stopGeneration);
    $('#nag-btn-reset').on('click', resetProgress);
    
    $('#nag-set-msgopt-enabled').on('change', function() { settings.enableMsgOptimization = $(this).prop('checked'); saveSettings(); });
    $('#nag-set-msgopt-model').on('change', function() { settings.msgOptModel = $(this).val(); saveSettings(); });
    $('#nag-set-msgopt-temp').on('change', function() { settings.msgOptTemp = +$(this).val(); saveSettings(); });
    $('#nag-set-msgopt-topp').on('change', function() { settings.msgOptTopP = +$(this).val(); saveSettings(); });
    $('#nag-set-msgopt-topk').on('change', function() { settings.msgOptTopK = +$(this).val(); saveSettings(); });
    $('#nag-set-msgopt-max-tokens').on('change', function() { settings.msgOptMaxTokens = +$(this).val(); saveSettings(); });
    $('#nag-btn-add-msgopt-preset').on('click', () => showMsgOptPresetModal());

    $('#nag-set-preset-enabled').on('change', function() { settings.enablePresetOptimization = $(this).prop('checked'); saveSettings(); });
    $('#nag-set-preset-model').on('change', function() { settings.presetModel = $(this).val(); saveSettings(); });
    $('#nag-set-preset-temp').on('change', function() { settings.presetTemp = +$(this).val(); saveSettings(); });
    $('#nag-set-preset-topp').on('change', function() { settings.presetTopP = +$(this).val(); saveSettings(); });
    $('#nag-set-preset-topk').on('change', function() { settings.presetTopK = +$(this).val(); saveSettings(); });
    $('#nag-set-preset-max-tokens').on('change', function() { settings.presetMaxTokens = +$(this).val(); saveSettings(); });
    $('#nag-btn-add-preset').on('click', () => showPresetModal());
    $('#nag-btn-optimize-now').on('click', async () => {
        const opt = await optimizePromptWithAI();
        if (opt) { settings.prompt = opt; $('#nag-set-prompt').val(opt); saveSettings(); toastr.success('优化结果已填入'); }
    });

    $('#nag-api-endpoint-select').on('change', function() { settings.selectedApiEndpointId = $(this).val(); syncApiEndpointUI(); saveSettings(); });
    $('#nag-set-api-name').on('change', function() { updateCurrentEndpoint('name', $(this).val()); renderApiEndpointSelect(); });
    $('#nag-set-api-url').on('change', function() { updateCurrentEndpoint('url', $(this).val()); });
    $('#nag-set-api-key').on('change', function() { updateCurrentEndpoint('key', $(this).val()); });
    $('#nag-set-api-max-tokens').on('change', function() { updateCurrentEndpoint('maxTokens', +$(this).val()); });
    $('#nag-btn-fetch-models').on('click', fetchApiModels);
    $('#nag-btn-test-api').on('click', testApiConnection);

    const updateCurrentEndpoint = (key, val) => {
        const cur = settings.apiEndpoints.find(e => e.id == settings.selectedApiEndpointId);
        if (cur) { cur[key] = val; saveSettings(); }
    };

    $('.nag-panel-header').on('click', function(e) {
        if ($(e.target).closest('.nag-help-btn').length > 0) return;
        togglePanel($(this).data('panel'));
    });
    document.querySelectorAll('.nag-help-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); showHelp(btn.getAttribute('data-help')); });
    });
}

function syncUI() {
    $('#nag-set-msgopt-enabled').prop('checked', settings.enableMsgOptimization);
    $('#nag-set-msgopt-model').val(settings.msgOptModel);
    $('#nag-set-msgopt-temp').val(settings.msgOptTemp);
    $('#nag-set-msgopt-topp').val(settings.msgOptTopP);
    $('#nag-set-msgopt-topk').val(settings.msgOptTopK);
    $('#nag-set-msgopt-max-tokens').val(settings.msgOptMaxTokens);
    renderMsgOptPresets();

    $('#nag-set-preset-enabled').prop('checked', settings.enablePresetOptimization);
    $('#nag-set-preset-model').val(settings.presetModel);
    $('#nag-set-preset-temp').val(settings.presetTemp);
    $('#nag-set-preset-topp').val(settings.presetTopP);
    $('#nag-set-preset-topk').val(settings.presetTopK);
    $('#nag-set-preset-max-tokens').val(settings.presetMaxTokens);
    renderPresets();

    renderApiEndpointSelect(); syncApiEndpointUI();
    $('#nag-set-total').val(settings.totalChapters);
    $('#nag-set-prompt').val(settings.prompt);
    $('#nag-set-send-toast-detection').prop('checked', settings.enableSendToastDetection);
    $('#nag-set-send-toast-timeout').val(settings.sendToastWaitTimeout);
    $('#nag-set-send-post-toast-wait').val(settings.sendPostToastWaitTime);
    $('#nag-set-reply-wait').val(settings.replyWaitTime);
    $('#nag-set-stability-interval').val(settings.stabilityCheckInterval);
    $('#nag-set-stability-count').val(settings.stabilityRequiredCount);
    $('#nag-set-reply-toast-detection').prop('checked', settings.enableReplyToastDetection);
    $('#nag-set-reply-toast-timeout').val(settings.replyToastWaitTimeout);
    $('#nag-set-reply-post-toast-wait').val(settings.replyPostToastWaitTime);
    $('#nag-set-retries').val(settings.maxRetries);
    $('#nag-set-minlen').val(settings.minChapterLength);
    updateUI();
}

function applyPanelStates() { Object.entries(settings.panelCollapsed).forEach(([id, c]) => { if (id && c) $(`#nag-panel-${id}`).addClass('collapsed'); }); }

jQuery(async () => {
    loadSettings(); createUI();
    try {
        if (typeof SillyTavern !== 'undefined' && typeof eventOn === 'function') {
            const ctx = SillyTavern.getContext();
            if (ctx?.tavern_events?.GENERATION_ENDED) eventOn(ctx.tavern_events.GENERATION_ENDED, onGenerationEnded);
        }
    } catch(e) {}
    setInterval(() => { if (settings.isRunning) updateUI(); }, 1000);
});
