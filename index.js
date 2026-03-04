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

    // API 设置
    apiEndpoints: [
        { id: 'default', name: '默认 API', url: '', key: '', temp: 0.7, topP: 1.0, topK: 0, maxTokens: 4096, extraParams: '' }
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
// 标签提取
// ============================================

function parseTagInput(s) {
    if (!s || typeof s !== 'string') return [];
    return s.split(/[,;，；\s\n\r]+/).map(t => t.trim()).filter(t => t.length > 0);
}

function extractTagContents(text, tags, separator = '\n\n') {
    if (!text || !tags || tags.length === 0) return '';
    const parts = [];
    for (const tag of tags) {
        const t = tag.trim();
        if (!t) continue;
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`<\\s*${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*/\\s*${escaped}\\s*>`, 'gi');
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const content = match[1].trim();
            if (content) parts.push(content);
        }
    }
    return parts.join(separator);
}

// ============================================
// 章节获取
// ============================================

function getAllChapters() {
    const tags = parseTagInput(settings.extractTags);
    const useTags = settings.extractMode === 'tags' && tags.length > 0;
    const chapters = [];
    
    let startFloor = settings.exportAll ? 0 : settings.exportStartFloor;
    let endFloor = settings.exportAll ? getMaxFloorIndex() : settings.exportEndFloor;
    
    if (settings.useRawContent) {
        const rawMessages = getRawMessages(startFloor, endFloor, {
            includeUser: settings.exportIncludeUser,
            includeAI: settings.exportIncludeAI,
        });
        
        if (rawMessages?.length) {
            for (const msg of rawMessages) {
                let content = useTags ? extractTagContents(msg.content, tags, settings.tagSeparator) : msg.content;
                if (!content && useTags) continue;
                if (content?.length > 10) {
                    chapters.push({ floor: msg.floor, index: chapters.length + 1, isUser: msg.isUser, name: msg.name, content });
                }
            }
            return chapters;
        }
    }
    
    document.querySelectorAll('#chat .mes').forEach((msg, idx) => {
        if (idx < startFloor || idx > endFloor) return;
        const isUser = msg.getAttribute('is_user') === 'true';
        if (isUser && !settings.exportIncludeUser) return;
        if (!isUser && !settings.exportIncludeAI) return;
        const text = msg.querySelector('.mes_text')?.innerText?.trim();
        if (!text) return;
        let content = useTags ? extractTagContents(text, tags, settings.tagSeparator) : text;
        if (content?.length > 10) {
            chapters.push({ floor: idx, index: chapters.length + 1, isUser, content });
        }
    });
    return chapters;
}

// ============================================
// 帮助弹窗
// ============================================

function showHelp(topic) {
    const helps = {
        generate: {
            title: '📝 生成设置说明',
            content: `
<h4>📌 目标章节</h4>
<p>设置要自动生成的章节总数。</p>
<h4>📌 提示词</h4>
<p>每次自动发送给 AI 的消息内容。</p>
            `
        },
        export: {
            title: '📤 导出设置说明',
            content: `
<h4>📌 楼层范围</h4>
<p>楼层从 <b>0</b> 开始计数。</p>
<h4>📌 原始 (chat.mes)</h4>
<ul>
    <li><b>✅ 勾选</b>：读取原始内容</li>
    <li><b>❌ 不勾选</b>：读取显示内容（经过正则处理）</li>
</ul>
            `
        },
        extract: {
            title: '🏷️ 标签提取说明',
            content: `
<h4>📌 什么是标签提取？</h4>
<p>从 AI 回复的原始内容中，只提取指定 XML 标签内的文字。</p>
<h4>📌 使用场景</h4>
<p>当你使用正则美化输出时，原始回复可能包含：</p>
<pre><思考>AI的思考过程...</思考>
<content>这是正文内容...</content></pre>
<p>使用标签提取可以只导出 <content> 内的正文。</p>
<h4>📌 如何使用</h4>
<ol>
    <li>✅ 勾选「原始 (chat.mes)」</li>
    <li>模式选择「标签」</li>
    <li>填写要提取的标签名</li>
</ol>
<h4>📌 多标签</h4>
<p>用空格、逗号分隔：<code>content detail 正文</code></p>
<h4>📌 调试</h4>
<p>控制台输入 <code>nagDebug()</code></p>
            `
        },
        api: {
            title: '🌐 自定义 API 说明',
            content: `
<h4>📌 API 节点配置</h4>
<p>支持多 API 节点定义。每个节点可以有独立的 URL、Key 和参数。获取的模型列表将按节点合并展示。</p>
<h4>📌 模型获取</h4>
<p>点击 🔄 按钮获取所有节点可用的模型列表。模型将按节点分组显示。</p>
<h4>📌 参数设置</h4>
<ul>
    <li><b>温度 (Temp)</b>：控制随机性，越高越放飞。</li>
    <li><b>Top P</b>：核采样阈值。</li>
    <li><b>Top K</b>：采样候选集大小。</li>
</ul>
            `
        },
        msgopt: {
            title: '🪄 消息优化说明',
            content: `
<h4>📌 什么是消息优化？</h4>
<p>当酒馆的原生 AI 生成消息完成后，可以自动将该最新回复以及你开启的优化预设发送给“自定义 API”模型进行润色和优化。优化完成后，将自动替换酒馆中的最新消息。</p>
<h4>📌 如何工作</h4>
<ul>
    <li>酒馆 AI 完成生成后触发（包括手动生成和自动生成）。</li>
    <li>会先对获取的最新回复执行启用了“酒馆消息优化”范围的正则替换。</li>
    <li>通过自定义 API 生成最终消息，并替换回酒馆。</li>
</ul>
            `
        },
        presets: {
            title: '🎭 提示词预设说明',
            content: `
<h4>📌 什么是预设优化？</h4>
<p>在发送消息给酒馆 AI 之前，先将你开启的多个“预设条目”汇总，并发送给你配置的“自定义 API”进行转换。转换后的结果将作为最终提示词发送。</p>
<h4>📌 核心功能</h4>
<ul>
    <li><b>👁️ 隐藏开关</b>：点击眼睛图标可暂时隐藏条目，该条目内容将不会发送给 AI 转换。</li>
    <li><b>启用开关</b>：右侧绿色开关控制条目是否生效。</li>
    <li><b>🪄 立即转换</b>：手动触发 AI 优化，预览转换后的提示词结果。</li>
    <li><b>排序</b>：根据左侧的优先级数字决定条目汇总时的先后顺序。</li>
</ul>
<h4>📌 使用建议</h4>
<p>建议使用速度快、上下文理解能力较好的模型作为预设处理器（如 GPT-3.5/4o-mini 或国产高速模型）。</p>
            `
        },
        regex: {
            title: '🧩 正则替换说明',
            content: `
<h4>📌 功能说明</h4>
<p>在这里可以添加正则表达式，用于处理特定范围内的文本内容。</p>
<h4>📌 作用范围</h4>
<ul>
    <li><b>历史条目中的所有 system 条目</b>：在发送给自定义 API 进行“预设优化”时，对历史聊天记录中的系统(System)消息进行正则替换。</li>
    <li><b>自定义 AI 输出</b>：对自定义 API 返回的所有结果进行正则替换，包括直接生成的续写内容以及预设优化生成的提示词。</li>
    <li><b>酒馆消息优化</b>：在酒馆AI生成回复后，对回复进行消息优化前执行正则处理。</li>
</ul>
<h4>📌 编写规则</h4>
<p>可以使用 <code>/pattern/flags</code> 的格式（例如 <code>/\\n+/g</code>），如果直接填写文本则默认使用 <code>g</code> 全局替换。替换内容中的 <code>\\n</code> 和 <code>\\t</code> 会被解析为换行符和制表符。</p>
            `
        },
        advanced: {
            title: '⚙️ 高级设置说明',
            content: `
<h4>📤 发送阶段</h4>
<p>消息发送后，可能有其他插件（如剧情推进插件）需要处理消息。</p>
<ul>
    <li><b>弹窗检测</b>：检测到弹窗时等待其消失，确保其他插件处理完成</li>
    <li><b>等待超时</b>：最长等待弹窗消失的时间</li>
    <li><b>额外等待</b>：弹窗消失后再等待的时间</li>
</ul>

<h4>📥 回复阶段</h4>
<p>AI回复完成后，可能有总结插件需要处理内容。</p>
<ul>
    <li><b>回复后等待</b>：AI回复稳定后等待的时间，让总结插件有时间启动</li>
    <li><b>稳定检查间隔</b>：检查内容是否稳定的间隔</li>
    <li><b>稳定次数</b>：内容需要连续多少次不变才算稳定</li>
    <li><b>弹窗检测</b>：检测总结插件的弹窗，等待其完成</li>
</ul>

<h4>🔧 生成控制</h4>
<ul>
    <li><b>自动保存间隔</b>：每生成多少章自动导出一次</li>
    <li><b>最大重试</b>：单章生成失败的最大重试次数</li>
    <li><b>最小长度</b>：AI回复少于此字数视为失败</li>
</ul>
            `
        },
    };
    
    const helpData = helps[topic] || { title: '帮助', content: '<p>暂无帮助内容</p>' };
    
    // 移除已存在的弹窗
    const existingModal = document.getElementById('nag-help-modal');
    if (existingModal) {
        existingModal.remove();
    }
    
    // 创建弹窗容器
    const modalContainer = document.createElement('div');
    modalContainer.className = 'nag-modal-container';
    modalContainer.id = 'nag-help-modal';
    modalContainer.innerHTML = `
        <div class="nag-modal">
            <div class="nag-modal-header">
                <span class="nag-modal-title">${helpData.title}</span>
                <button class="nag-modal-close" type="button">✕</button>
            </div>
            <div class="nag-modal-body">${helpData.content}</div>
        </div>
    `;
    
    // 关闭弹窗函数
    const closeModal = (e) => {
        if (e) {
            e.stopPropagation();
            e.preventDefault();
        }
        modalContainer.remove();
        document.removeEventListener('keydown', escHandler, true);
    };
    
    // ESC 关闭 - 使用捕获阶段，优先处理
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            e.stopImmediatePropagation();
            closeModal();
        }
    };
    document.addEventListener('keydown', escHandler, true);
    
    // 关闭按钮点击
    modalContainer.querySelector('.nag-modal-close').addEventListener('click', (e) => {
        closeModal(e);
    }, false);
    
    // 阻止弹窗内部点击冒泡
    modalContainer.querySelector('.nag-modal').addEventListener('click', (e) => {
        e.stopPropagation();
    }, false);
    
    modalContainer.querySelector('.nag-modal').addEventListener('mousedown', (e) => {
        e.stopPropagation();
    }, false);
    
    modalContainer.querySelector('.nag-modal').addEventListener('touchstart', (e) => {
        e.stopPropagation();
    }, { passive: true });
    
    // 点击容器背景关闭
    modalContainer.addEventListener('click', (e) => {
        if (e.target === modalContainer) {
            closeModal(e);
        }
    }, false);
    
    modalContainer.addEventListener('mousedown', (e) => {
        if (e.target === modalContainer) {
            e.stopPropagation();
        }
    }, false);
    
    modalContainer.addEventListener('touchstart', (e) => {
        if (e.target === modalContainer) {
            e.stopPropagation();
        }
    }, { passive: true });
    
    // 添加到 body 最后，确保在最顶层
    document.body.appendChild(modalContainer);
    
    // 强制重新计算位置（修复某些浏览器的渲染问题）
    requestAnimationFrame(() => {
        modalContainer.style.opacity = '1';
    });
}

// ============================================
// 预览
// ============================================

function refreshPreview() {
    const stChat = getSTChat();
    const tags = parseTagInput(settings.extractTags);
    const useTags = settings.extractMode === 'tags' && tags.length > 0;
    
    if (!stChat || stChat.length === 0) {
        $('#nag-preview-content').html(`<div class="nag-preview-warning"><b>⚠️ 无法获取聊天数据</b></div>`);
        return;
    }
    
    let rawContent = '', floor = -1;
    for (let i = stChat.length - 1; i >= 0; i--) {
        const msg = stChat[i];
        if (msg && !msg.is_user && !msg.is_human && msg.mes) {
            rawContent = msg.mes;
            floor = i;
            break;
        }
    }
    
    if (!rawContent) {
        $('#nag-preview-content').html('<i style="opacity:0.6">没有 AI 消息</i>');
        return;
    }
    
    const rawPreview = rawContent.substring(0, 200).replace(/</g, '<').replace(/>/g, '>');
    let html = `
        <div class="nag-preview-source">楼层 ${floor} | 长度 ${rawContent.length} 字</div>
        <div class="nag-preview-raw">${rawPreview}${rawContent.length > 200 ? '...' : ''}</div>
    `;
    
    if (useTags) {
        const extracted = extractTagContents(rawContent, tags, settings.tagSeparator);
        if (extracted) {
            html += `<div class="nag-preview-success"><b>✅ 提取成功</b> (${extracted.length} 字)<div class="nag-preview-text">${escapeHtml(extracted.slice(0, 400))}</div></div>`;
        } else {
            html += `<div class="nag-preview-warning"><b>⚠️ 未找到标签</b> [${tags.join(', ')}]</div>`;
        }
    } else {
        html += `<div class="nag-preview-info"><b>📄 全部内容模式</b></div>`;
    }
    
    $('#nag-preview-content').html(html);
}

function debugRawContent(floorIndex) {
    const stChat = getSTChat();
    if (!stChat) { console.log('❌ 无法获取 chat'); return; }
    
    console.log(`✅ chat 获取成功，共 ${stChat.length} 条`);
    
    if (floorIndex === undefined) {
        for (let i = stChat.length - 1; i >= 0; i--) {
            if (stChat[i] && !stChat[i].is_user) { floorIndex = i; break; }
        }
    }
    
    const msg = stChat[floorIndex];
    if (!msg) { console.log(`楼层 ${floorIndex} 不存在`); return; }
    
    console.log(`\n----- 楼层 ${floorIndex} -----`);
    console.log('mes:', msg.mes?.substring(0, 500));
    
    const tags = parseTagInput(settings.extractTags);
    if (tags.length > 0) {
        console.log(`\n----- 标签测试 [${tags.join(', ')}] -----`);
        console.log('结果:', extractTagContents(msg.mes, tags, '\n---\n') || '(无匹配)');
    }
}

window.nagDebug = debugRawContent;

// ============================================
// 弹窗检测
// ============================================

function hasActiveToast() {
    const toastContainer = document.querySelector('#toast-container');
    if (toastContainer) {
        const toasts = toastContainer.querySelectorAll('.toast');
        if (toasts.length > 0) return true;
    }
    return false;
}

function getToastText() {
    const toastContainer = document.querySelector('#toast-container');
    if (toastContainer) {
        const toast = toastContainer.querySelector('.toast');
        if (toast) return toast.textContent?.trim().substring(0, 50) || '';
    }
    return '';
}

/**
 * 等待弹窗消失
 * @param {number} timeout - 超时时间
 * @param {number} postWaitTime - 弹窗消失后额外等待时间
 * @param {string} phase - 阶段名称（用于日志）
 */
async function waitForToastsClear(timeout, postWaitTime, phase = '') {
    if (!hasActiveToast()) {
        log(`${phase}无弹窗，跳过等待`, 'debug');
        return;
    }
    
    log(`${phase}检测到弹窗，等待消失...`, 'info');
    const startTime = Date.now();
    let lastLogTime = 0;
    
    while (hasActiveToast()) {
        await checkStatus();
        
        const elapsed = Date.now() - startTime;
        if (elapsed > timeout) {
            log(`${phase}弹窗等待超时，继续执行`, 'warning');
            return;
        }
        
        if (elapsed - lastLogTime >= 5000) {
            log(`${phase}等待弹窗... (${Math.round(elapsed/1000)}s) ${getToastText()}`, 'debug');
            lastLogTime = elapsed;
        }
        
        await sleep(500);
    }
    
    log(`${phase}弹窗已消失`, 'success');
    
    if (postWaitTime > 0) {
        log(`${phase}额外等待 ${postWaitTime}ms`, 'debug');
        await sleep(postWaitTime);
    }
}

// ============================================
// 正则条目管理与替换逻辑
// ============================================

function applyRegexes(text, scope) {
    if (!settings.enableRegexProcessing || !settings.regexItems || !settings.regexItems.length || !text) {
        return text;
    }

    let result = text;
    const activeRegexes = settings.regexItems
        .filter(r => r.isEnabled)
        .sort((a, b) => (a.priority || 0) - (b.priority || 0));

    for (const r of activeRegexes) {
        let applies = false;
        if (scope === 'system' && r.scopeSystem) applies = true;
        if (scope === 'ai' && r.scopeCustomAI) applies = true;
        if (scope === 'msgOpt' && r.scopeMsgOpt) applies = true;
        
        if (applies && r.regex) {
            try {
                let pattern = r.regex;
                let flags = 'g';
                if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                    const lastSlash = pattern.lastIndexOf('/');
                    flags = pattern.substring(lastSlash + 1);
                    pattern = pattern.substring(1, lastSlash);
                }
                const regex = new RegExp(pattern, flags);
                let rep = r.replacement || '';
                rep = rep.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                
                result = result.replace(regex, rep);
            } catch (e) {
                console.warn(`[NovelGen] 正则 [${r.name}] 执行失败:`, e);
            }
        }
    }
    return result;
}

function renderRegexItems() {
    const $list = $('#nag-regex-list');
    if (!$list.length) return;
    $list.empty();

    if (!Array.isArray(settings.regexItems)) settings.regexItems = [];
    settings.regexItems.sort((a, b) => (a.priority || 0) - (b.priority || 0));
    settings.regexItems.forEach((r, i) => r.priority = i + 1);

    settings.regexItems.forEach((r) => {
        let scopeBadges = '';
        if (r.scopeSystem) scopeBadges += '<span class="nag-preset-role-badge role-system" style="margin-right:2px;">System</span>';
        if (r.scopeCustomAI) scopeBadges += '<span class="nag-preset-role-badge role-assistant" style="margin-right:2px;">AI输出</span>';
        if (r.scopeMsgOpt) scopeBadges += '<span class="nag-preset-role-badge role-user">消息优化</span>';

        const html = `
            <div class="nag-preset-item" data-id="${r.id}">
                <div class="nag-preset-drag-handle" title="调整顺序">
                    <div class="nag-preset-order-btn move-up-regex" data-id="${r.id}">▲</div>
                    <div class="nag-preset-priority-num">${r.priority}</div>
                    <div class="nag-preset-order-btn move-down-regex" data-id="${r.id}">▼</div>
                </div>
                <div class="nag-preset-main">
                    <span class="nag-preset-icon">🧩</span>
                    <div class="nag-preset-info">
                        <span class="nag-preset-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
                        <div style="display:flex;gap:4px;margin-top:2px;">${scopeBadges}</div>
                    </div>
                </div>
                <div class="nag-preset-actions">
                    <div class="nag-preset-btn edit-regex" title="编辑" data-id="${r.id}">✏️</div>
                    <div class="nag-preset-btn delete-regex" title="删除" data-id="${r.id}">🗑️</div>
                    <label class="nag-switch" title="启用/禁用">
                        <input type="checkbox" class="toggle-regex-enabled" data-id="${r.id}" ${r.isEnabled ? 'checked' : ''}>
                        <span class="nag-slider"></span>
                    </label>
                </div>
            </div>
        `;
        $list.append(html);
    });

    $list.find('.move-up-regex').on('click', function() {
        const id = $(this).data('id');
        const idx = settings.regexItems.findIndex(x => x.id == id);
        if (idx > -1) {
            const current = settings.regexItems[idx];
            const targetIdx = settings.regexItems.findIndex(x => x.priority === current.priority - 1);
            if (targetIdx > -1) {
                settings.regexItems[targetIdx].priority++;
                current.priority--;
                saveSettings();
                renderRegexItems();
            }
        }
    });

    $list.find('.move-down-regex').on('click', function() {
        const id = $(this).data('id');
        const idx = settings.regexItems.findIndex(x => x.id == id);
        if (idx > -1) {
            const current = settings.regexItems[idx];
            const targetIdx = settings.regexItems.findIndex(x => x.priority === current.priority + 1);
            if (targetIdx > -1) {
                settings.regexItems[targetIdx].priority--;
                current.priority++;
                saveSettings();
                renderRegexItems();
            }
        }
    });

    $list.find('.toggle-regex-enabled').on('change', function() {
        const id = $(this).data('id');
        const item = settings.regexItems.find(x => x.id == id);
        if (item) {
            item.isEnabled = $(this).prop('checked');
            saveSettings();
        }
    });

    $list.find('.edit-regex').on('click', function() {
        const id = $(this).data('id');
        showRegexModal(id);
    });

    $list.find('.delete-regex').on('click', function() {
        const id = $(this).data('id');
        if (confirm('确定要删除这个正则条目吗？')) {
            settings.regexItems = settings.regexItems.filter(x => x.id != id);
            saveSettings();
            renderRegexItems();
        }
    });
}

function showRegexModal(id = null) {
    const isEdit = id !== null;
    const rItem = isEdit ? settings.regexItems.find(x => x.id == id) : {
        name: '',
        regex: '',
        replacement: '',
        scopeSystem: true,
        scopeCustomAI: true,
        scopeMsgOpt: true,
        isEnabled: true,
        priority: (settings.regexItems?.length || 0) + 1
    };

    const valName = rItem.name.replace(/"/g, '"');

    const modalHtml = `
        <div class="nag-modal-container" id="nag-regex-modal">
            <div class="nag-modal">
                <div class="nag-modal-header">
                    <span class="nag-modal-title">${isEdit ? '编辑正则' : '添加正则'}</span>
                    <button class="nag-modal-close">✕</button>
                </div>
                <div class="nag-modal-body">
                    <div class="nag-setting-item">
                        <label>条目名称</label>
                        <input type="text" id="modal-regex-name" value="${valName}" placeholder="例如：去除多余空行">
                    </div>
                    <div class="nag-setting-item">
                        <label>正则内容</label>
                        <textarea id="modal-regex-content" rows="3" placeholder="例如：\\\\n{3,}"></textarea>
                    </div>
                    <div class="nag-setting-item">
                        <label>替换成</label>
                        <textarea id="modal-regex-replacement" rows="3" placeholder="例如：\\\\n\\\\n"></textarea>
                    </div>
                    <div class="nag-setting-item">
                        <label>作用范围</label>
                        <div class="nag-checkbox-group">
                            <label class="nag-checkbox-label">
                                <input type="checkbox" id="modal-regex-scope-system" ${rItem.scopeSystem ? 'checked' : ''}>
                                <span>历史条目中的所有 system 条目</span>
                            </label>
                            <label class="nag-checkbox-label">
                                <input type="checkbox" id="modal-regex-scope-ai" ${rItem.scopeCustomAI ? 'checked' : ''}>
                                <span>自定义 AI 输出</span>
                            </label>
                            <label class="nag-checkbox-label">
                                <input type="checkbox" id="modal-regex-scope-msgopt" ${rItem.scopeMsgOpt ? 'checked' : ''}>
                                <span>酒馆消息优化</span>
                            </label>
                        </div>
                    </div>
                    <div class="nag-btn-row">
                        <button id="modal-regex-save" class="menu_button">${isEdit ? '保存' : '创建'}</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('body').append(modalHtml);
    const $modal = $('#nag-regex-modal');
    
    $('#modal-regex-content').val(rItem.regex);
    $('#modal-regex-replacement').val(rItem.replacement);

    $modal.find('.nag-modal-close').on('click', () => $modal.remove());
    $modal.find('#modal-regex-save').on('click', () => {
        const name = $('#modal-regex-name').val().trim();
        const regex = $('#modal-regex-content').val();
        const replacement = $('#modal-regex-replacement').val();
        const scopeSystem = $('#modal-regex-scope-system').prop('checked');
        const scopeCustomAI = $('#modal-regex-scope-ai').prop('checked');
        const scopeMsgOpt = $('#modal-regex-scope-msgopt').prop('checked');

        if (!name || !regex) {
            toastr.warning('名称和正则内容不能为空');
            return;
        }

        if (!scopeSystem && !scopeCustomAI && !scopeMsgOpt) {
            toastr.warning('至少选择一个作用范围');
            return;
        }

        try {
            let pattern = regex;
            let flags = '';
            if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                const lastSlash = pattern.lastIndexOf('/');
                flags = pattern.substring(lastSlash + 1);
                pattern = pattern.substring(1, lastSlash);
            }
            new RegExp(pattern, flags);
        } catch (e) {
            toastr.error('正则表达式语法错误: ' + e.message);
            return;
        }

        const newItem = {
            ...rItem,
            name,
            regex,
            replacement,
            scopeSystem,
            scopeCustomAI,
            scopeMsgOpt
        };

        if (!settings.regexItems) settings.regexItems = [];
        
        if (isEdit) {
            const idx = settings.regexItems.findIndex(x => x.id == id);
            settings.regexItems[idx] = newItem;
        } else {
            newItem.id = Date.now();
            settings.regexItems.push(newItem);
        }

        saveSettings();
        renderRegexItems();
        $modal.remove();
    });
}

// ============================================
// API 调用逻辑
// ============================================

async function fetchApiModels() {
    log('正在获取所有API的模型列表...', 'info');
    const selectors = [
        { id: '#nag-set-api-model', current: settings.apiModel },
        { id: '#nag-set-msgopt-model', current: settings.msgOptModel },
        { id: '#nag-set-preset-model', current: settings.presetModel }
    ];
    
    selectors.forEach(s => {
        const $el = $(s.id);
        $el.empty().append('<option value="">-- 请选择模型 --</option>');
    });
    
    let totalModels = 0;
    const allModelsByEndpoint = [];

    for (const api of settings.apiEndpoints) {
        if (!api.url) continue;
        try {
            const response = await fetch(`${api.url.replace(/\/+$/, '')}/models`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${api.key}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                const models = data.data || [];
                if (models.length > 0) {
                    allModelsByEndpoint.push({ api, models });
                    totalModels += models.length;
                }
            }
        } catch(e) {
            log(`获取 [${api.name}] 模型失败: ${e.message}`, 'warning');
        }
    }
    
    if (totalModels > 0) {
        selectors.forEach(s => {
            const $el = $(s.id);
            allModelsByEndpoint.forEach(item => {
                const group = $(`<optgroup label="${escapeHtml(item.api.name || 'API ' + item.api.id)}"></optgroup>`);
                item.models.forEach(m => {
                    const id = m.id || m;
                    const val = `${item.api.id}:::${id}`;
                    group.append(`<option value="${val}" ${val === s.current ? 'selected' : ''}>${id}</option>`);
                });
                $el.append(group);
            });
        });
        toastr.success(`成功获取 ${totalModels} 个模型`);
        log(`成功获取 ${totalModels} 个模型`, 'success');
    } else {
        toastr.error('未能获取到任何模型');
    }
}

async function testApiConnection() {
    const current = settings.apiEndpoints.find(e => e.id == settings.selectedApiEndpointId);
    if (!current || !current.url) {
        toastr.error('请先设置当前节点的 API URL');
        return;
    }
    
    try {
        log(`正在测试节点 ${current.name} 连接...`, 'info');
        const response = await fetch(`${current.url.replace(/\/+$/, '')}/models`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${current.key}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            toastr.success(`${current.name} 连接测试成功！`);
            log(`${current.name} 连接测试成功`, 'success');
        } else {
            const err = await response.text();
            throw new Error(`HTTP ${response.status}: ${err}`);
        }
    } catch (e) {
        log(`${current.name} 连接测试失败: ${e.message}`, 'error');
        toastr.error(`${current.name} 连接测试失败: ${e.message}`);
    }
}

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

async function callCustomApi(messages, options = {}) {
    // 允许通过 options 覆盖全局模型和参数
    const targetModel = options.model || settings.apiModel;
    if (!targetModel) {
        throw new Error('请先选择自定义 API 模型');
    }
    
    const parts = targetModel.split(':::');
    if (parts.length < 2) {
        throw new Error('API模型配置有误，请重新选择模型');
    }
    const apiId = parts[0];
    const modelId = parts.slice(1).join(':::');
    
    const apiConfig = settings.apiEndpoints.find(e => e.id == apiId) || settings.apiEndpoints[0];
    if (!apiConfig) throw new Error('找不到对应的 API 配置');

    const url = apiConfig.url;
    const key = apiConfig.key;

    if (!url || !modelId) {
        throw new Error('请确保 API URL 已设置并选择了模型');
    }

    const finalMessages = Array.isArray(messages) ? messages : [{ role: 'user', content: messages }];
    
    console.log(`[NovelGen] 发送给 API [${apiConfig.name}] 的消息数组:`, finalMessages);

    let extraParams = {};
    if (apiConfig.extraParams) {
        try {
            extraParams = JSON.parse(apiConfig.extraParams);
        } catch (e) {
            log('解析额外参数失败: ' + e.message, 'warning');
        }
    }

    const body = {
        model: modelId,
        messages: finalMessages,
        temperature: options.temperature ?? apiConfig.temp,
        top_p: options.topP ?? apiConfig.topP,
        max_tokens: options.maxTokens ?? apiConfig.maxTokens,
        ...extraParams
    };
    
    const topK = options.topK ?? apiConfig.topK;
    if (topK > 0) {
        body.top_k = topK;
    }

    const maxRetries = settings.maxRetries || 3;
    let retries = 0;

    while (retries <= maxRetries) {
        await checkStatus();

        try {
            const response = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: abortController?.signal
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`API 错误 (${response.status}): ${err}`);
            }

            const data = await response.json();
            let resultContent = data.choices?.[0]?.message?.content || '';
            
            if (resultContent && resultContent.trim()) {
                return applyRegexes(resultContent, 'ai');
            }

            if (retries >= maxRetries) {
                throw new Error('API 返回内容为空，已达到最大重试次数');
            }

            retries++;
            log(`API 返回为空，第 ${retries} 次重试...`, 'warning');
            await sleep(1000);
        } catch (e) {
            if (e.name === 'AbortError' || e.message === '用户中止') {
                throw new Error('用户中止');
            }
            if (retries >= maxRetries) {
                throw e;
            }
            retries++;
            log(`API 请求失败，第 ${retries} 次重试: ${e.message}`, 'warning');
            await sleep(1000);
        }
    }
}

// ============================================
// 核心生成逻辑
// ============================================

/**
 * 发送消息
 */
async function sendMessage(text) {
    const $ta = $('#send_textarea');
    const $btn = $('#send_but');
    
    if (!$ta.length || !$btn.length) {
        throw new Error('找不到输入框或发送按钮');
    }
    
    // 清空并填入文本
    $ta.val(text);
    $ta[0].value = text;
    $ta.trigger('input').trigger('change');
    
    await sleep(100);
    
    // 点击发送
    $btn.trigger('click');
    log('消息已发送', 'success');
    
    // 发送阶段弹窗检测
    if (settings.enableSendToastDetection) {
        await sleep(500); // 短暂等待让弹窗有时间出现
        await waitForToastsClear(
            settings.sendToastWaitTimeout,
            settings.sendPostToastWaitTime,
            '[发送阶段] '
        );
    }
    
    // 发送后检查一次状态，确保不会在暂停/停止时立即进入 waitForAIResponse
    await checkStatus();
}

/**
 * 获取AI消息数量（双重检测：DOM + chat数组）
 */
function getAIMessageCountRobust() {
    // 方法1: DOM 查询
    const domCount = document.querySelectorAll('#chat .mes[is_user="false"]').length;

    // 方法2: chat 数组查询
    let chatCount = 0;
    const stChat = getSTChat();
    if (stChat) {
        chatCount = stChat.filter(msg => msg && !msg.is_user && !msg.is_human).length;
    }

    // 返回较大的值，确保能检测到新消息
    return Math.max(domCount, chatCount);
}

/**
 * 等待AI回复完成
 */
async function waitForAIResponse(prevCount) {
    // 阶段1：等待AI消息数量增加（带超时）
    log('等待AI开始回复...', 'debug');
    const waitStartTime = Date.now();
    const maxWaitForStart = 120000; // 最多等待2分钟让AI开始回复

    while (getAIMessageCountRobust() <= prevCount) {
        await checkStatus();

        const elapsed = Date.now() - waitStartTime;
        if (elapsed > maxWaitForStart) {
            log(`等待AI开始回复超时 (${Math.round(elapsed/1000)}s)，可能AI已回复但未检测到`, 'warning');
            // 尝试用 chat 数组再检查一次
            const stChat = getSTChat();
            if (stChat && stChat.length > prevCount) {
                log('通过 chat 数组检测到新消息，继续处理', 'info');
                break;
            }
            throw new Error('等待AI开始回复超时');
        }

        // 每10秒输出一次等待日志
        if (elapsed > 0 && elapsed % 10000 < 500) {
            log(`仍在等待AI开始回复... (${Math.round(elapsed/1000)}s)`, 'debug');
        }

        await sleep(500);
    }
    log('检测到新的AI回复', 'success');
    
    // 阶段2：等待内容稳定（长度不再变化）
    log('等待AI回复完成...', 'debug');
    let lastLength = 0;
    let stableCount = 0;
    
    while (stableCount < settings.stabilityRequiredCount) {
        await checkStatus();
        
        await sleep(settings.stabilityCheckInterval);
        
        const currentLength = getLastAIMessageLength();
        if (currentLength === lastLength && currentLength > 0) {
            stableCount++;
        } else {
            stableCount = 0;
            lastLength = currentLength;
        }
    }
    log(`AI回复已稳定 (${lastLength} 字)`, 'success');
    
    // 阶段3：固定等待时间
    if (settings.replyWaitTime > 0) {
        log(`等待 ${settings.replyWaitTime}ms...`, 'debug');
        await sleep(settings.replyWaitTime);
    }
    
    // 阶段4：回复阶段弹窗检测
    if (settings.enableReplyToastDetection) {
        await waitForToastsClear(
            settings.replyToastWaitTimeout,
            settings.replyPostToastWaitTime,
            '[回复阶段] '
        );
    }
    
    // 阶段5：再次稳定性检查（确保总结注入完成）
    log('最终稳定性检查...', 'debug');
    lastLength = 0;
    stableCount = 0;
    
    while (stableCount < settings.stabilityRequiredCount) {
        await checkStatus();
        
        await sleep(settings.stabilityCheckInterval);
        
        const currentLength = getLastAIMessageLength();
        if (currentLength === lastLength && currentLength > 0) {
            stableCount++;
        } else {
            stableCount = 0;
            lastLength = currentLength;
        }
    }
    
    log('回复处理完成', 'success');
    return lastLength;
}

/**
 * 生成单章
 */
async function generateSingleChapter(num) {
    let textToSend = settings.prompt;

    // 发送给酒馆前，如果启用了 ai提示词生成，让 AI 根据预设生成提示词
    if (settings.enablePresetOptimization) {
        log(`正在使用自定义 API 生成提示词...`, 'info');
        const generatedPrompt = await optimizePromptWithAI();
        if (generatedPrompt) {
            textToSend = generatedPrompt;
            // 不再覆盖 settings.prompt，仅用于本次发送
        } else {
            throw new Error('自定义 API 生成提示词为空');
        }
    } else if (settings.apiEnabled) {
        // 未启用 ai提示词生成 但启用了自定义 API 时，直接使用提示词调用 API
        log(`正在使用自定义 API 生成发送内容...`, 'info');
        const reply = await callCustomApi(settings.prompt);
        if (reply && reply.trim()) {
            textToSend = reply.trim();
            // 不再覆盖 settings.prompt
        } else {
            throw new Error('自定义 API 返回内容为空');
        }
    }

    const prevCount = getAIMessageCountRobust();
    
    // 发送消息
    await sendMessage(textToSend);
    
    // 等待回复完成
    const length = await waitForAIResponse(prevCount);
    
    // 消息优化逻辑
    if (settings.enableMsgOptimization) {
        const stChat = getSTChat();
        let lastAiIndex = -1;
        let rawContent = '';
        if (stChat) {
            for (let i = stChat.length - 1; i >= 0; i--) {
                const msg = stChat[i];
                if (msg && !msg.is_user && !msg.is_human && msg.mes) {
                    rawContent = msg.mes;
                    lastAiIndex = i;
                    break;
                }
            }
        }
        
        if (lastAiIndex !== -1 && rawContent) {
            try {
                isOptimizing = true;
                await performMessageOptimization(lastAiIndex, rawContent);
                lastOptimizedId = lastAiIndex;
            } finally {
                isOptimizing = false;
            }
        }
    }
    
    const finalLength = settings.enableMsgOptimization ? getLastAIMessageLength() : length;

    // 检查长度
    if (finalLength < settings.minChapterLength) {
        throw new Error(`响应过短 (${finalLength} 字)`);
    }
    
    generationStats.chaptersGenerated++;
    generationStats.totalCharacters += finalLength;
    log(`第 ${num} 章完成 (${finalLength} 字)`, 'success');
    
    return finalLength;
}

async function performMessageOptimization(lastAiIndex, rawContent) {
    if (!settings.apiEndpoints || settings.apiEndpoints.length === 0 || !settings.apiEndpoints.some(e => e.url)) {
        log('未配置自定义API节点，跳过消息优化', 'warning');
        return;
    }

    const activePresets = settings.msgOptPresets
        .filter(p => p.isEnabled && !p.isHidden)
        .sort((a, b) => a.priority - b.priority);

    if (activePresets.length === 0) {
        log('没有启用的消息优化预设条目，跳过优化', 'info');
        return;
    }

    let optimizedInput = applyRegexes(rawContent, 'msgOpt');

    const messages = [
        { role: 'system', content: settings.msgOptSystemPrompt }
    ];

    for (const p of activePresets) {
        if (p.id === 'latest_ai') {
            messages.push({ 
                role: 'system', 
                content: `[LATEST_AI_MESSAGE]\n${optimizedInput}`
            });
        } else {
            messages.push({ 
                role: p.role || 'system', 
                content: `### ${p.name}\n${p.content}` 
            });
        }
    }

    console.log('[NovelGen] 发送给消息优化 API 的消息数组:', messages);

    try {
        log('正在通过 AI 进行消息优化...', 'info');
        const optimizedResult = await callCustomApi(messages, {
            model: settings.msgOptModel,
            temperature: settings.msgOptTemp,
            topP: settings.msgOptTopP,
            topK: settings.msgOptTopK,
            maxTokens: settings.msgOptMaxTokens
        });
        
        if (optimizedResult && optimizedResult.trim()) {
            log('消息优化完成，准备替换原文', 'success');
            
            let helper = window.TavernHelper;
            if (helper && typeof helper.setChatMessages === 'function') {
                await helper.setChatMessages([{
                    message_id: lastAiIndex,
                    message: optimizedResult.trim()
                }]);
                log('已成功替换消息(TavernHelper)', 'success');
            } else if (typeof setChatMessages === 'function') {
                await setChatMessages([{
                    message_id: lastAiIndex,
                    message: optimizedResult.trim()
                }]);
                log('已成功替换消息(Global)', 'success');
            } else {
                log('找不到 TavernHelper.setChatMessages 函数，无法替换消息', 'error');
                toastr.error('找不到酒馆助手函数，无法替换消息');
            }
        } else {
            log('消息优化返回内容为空', 'warning');
        }
    } catch (e) {
        if (e.message === '用户中止') throw e;
        log('消息优化失败: ' + e.message, 'error');
        toastr.error('消息优化失败: ' + e.message);
    }
}

/**
 * 开始生成
 */
async function startGeneration() {
    if (settings.isRunning) { 
        toastr.warning('已在运行'); 
        return; 
    }
    
    settings.isRunning = true; 
    settings.isPaused = false; 
    abortController = new AbortController();
    generationStats = { startTime: Date.now(), chaptersGenerated: 0, totalCharacters: 0, errors: [] };
    saveSettings(); 
    updateUI();
    toastr.info(`开始生成 ${settings.totalChapters - settings.currentChapter} 章`);
    
    try {
        while (settings.currentChapter < settings.totalChapters) {
            await checkStatus();
            
            let success = false;
            let retries = 0;
            const chapterNum = settings.currentChapter + 1;
            
            while (!success && retries < settings.maxRetries) {
                try {
                    await checkStatus();
                    await generateSingleChapter(chapterNum);
                    success = true;
                    settings.currentChapter++;
                    saveSettings(); 
                    updateUI();
                } catch(e) {
                    if (e.message === '用户中止') throw e;
                    
                    retries++;
                    log(`第 ${chapterNum} 章失败 (${retries}/${settings.maxRetries}): ${e.message}`, 'error');
                    generationStats.errors.push({ chapter: chapterNum, error: e.message });
                    
                    if (retries < settings.maxRetries) {
                        log(`等待5秒后重试...`, 'info');
                        // 重试前的等待也要能被中止
                        for (let j = 0; j < 10; j++) {
                            await checkStatus();
                            await sleep(500);
                        }
                    }
                }
            }
            
            if (!success) {
                log(`第 ${chapterNum} 章多次尝试后仍然失败，停止生成。`, 'error');
                toastr.error(`第 ${chapterNum} 章生成失败，请检查设置后重试`);
                break;
            }
        }
        
        if (!abortController.signal.aborted && settings.currentChapter >= settings.totalChapters) { 
            toastr.success('生成完成!'); 
        }
    } catch (e) {
        if (e.message === '用户中止') {
            log('生成已由用户停止', 'info');
        } else {
            log(`生成过程中出现严重错误: ${e.message}`, 'error');
        }
    } finally {
        settings.isRunning = false; 
        settings.isPaused = false;
        abortController = null;
        saveSettings(); 
        updateUI();
    }
}

function pauseGeneration() { 
    settings.isPaused = true; 
    updateUI(); 
    toastr.info('已暂停'); 
}

function resumeGeneration() { 
    settings.isPaused = false; 
    updateUI(); 
    toastr.info('已恢复'); 
}

function stopGeneration() { 
    if (abortController) {
        abortController.abort();
    }
    // settings.isRunning = false; // 不在这里直接设置，由 startGeneration 的 finally 处理
    toastr.warning('停止指令已发送'); 
}

function resetProgress() {
    if (settings.isRunning) { 
        toastr.warning('请先停止'); 
        return; 
    }
    settings.currentChapter = 0;
    generationStats = { startTime: null, chaptersGenerated: 0, totalCharacters: 0, errors: [] };
    lastOptimizedId = -1;
    saveSettings(); 
    updateUI(); 
    toastr.info('已重置');
}

// ============================================
// 导出
// ============================================

function downloadFile(content, filename, type = 'text/plain') {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); 
    a.click(); 
    document.body.removeChild(a);
}

async function exportNovel(silent = false) {
    const chapters = getAllChapters();
    if (!chapters.length) { 
        if (!silent) toastr.warning('没有内容'); 
        return; 
    }
    
    const totalChars = chapters.reduce((s, c) => s + c.content.length, 0);
    let text = `导出时间: ${new Date().toLocaleString()}\n总章节: ${chapters.length}\n总字数: ${totalChars}\n${'═'.repeat(40)}\n\n`;
    chapters.forEach(ch => {
        text += `══ [${ch.floor}楼] ${ch.isUser ? '用户' : 'AI'} ══\n\n${ch.content}\n\n`;
    });
    
    downloadFile(text, `novel_${chapters.length}ch_${Date.now()}.txt`);
    if (!silent) toastr.success(`已导出 ${chapters.length} 条`);
}

async function exportAsJSON(silent = false) {
    const chapters = getAllChapters();
    if (!chapters.length) { 
        if (!silent) toastr.warning('没有内容'); 
        return; 
    }
    downloadFile(JSON.stringify({ time: new Date().toISOString(), chapters }, null, 2), `novel_${Date.now()}.json`, 'application/json');
    if (!silent) toastr.success('已导出 JSON');
}

// ============================================
// 预设条目管理
// ============================================

function renderPresets() { renderGenericPresets('prompt'); }
function renderMsgOptPresets() { renderGenericPresets('msgOpt'); }

function renderGenericPresets(type) {
    const isPrompt = type === 'prompt';
    const arrName = isPrompt ? 'presets' : 'msgOptPresets';
    const containerId = isPrompt ? 'nag-preset-list' : 'nag-msgopt-preset-list';
    const $list = `#${containerId}`;
    $($list).empty();

    if (!Array.isArray(settings[arrName])) settings[arrName] = [];
    settings[arrName].sort((a, b) => (a.priority || 0) - (b.priority || 0));
    settings[arrName].forEach((p, i) => p.priority = i + 1);

    settings[arrName].forEach((p, index) => {
        const roleLabel = p.role ? `<span class="nag-preset-role-badge role-${p.role}">${p.role}</span>` : '';
        const isLocked = p.isLocked === true;
        const html = `
            <div class="nag-preset-item ${p.isHidden ? 'is-hidden' : ''} ${isLocked ? 'is-locked' : ''}" data-id="${p.id}">
                <div class="nag-preset-drag-handle" title="调整顺序">
                    <div class="nag-preset-order-btn move-up-${type}" data-id="${p.id}">▲</div>
                    <div class="nag-preset-priority-num">${p.priority}</div>
                    <div class="nag-preset-order-btn move-down-${type}" data-id="${p.id}">▼</div>
                </div>
                <div class="nag-preset-main">
                    <span class="nag-preset-icon">${p.icon || '📝'}</span>
                    <div class="nag-preset-info">
                        <span class="nag-preset-name" title="${p.name}${isLocked ? ' (内置不可编辑)' : ''}">${p.name}${isLocked ? ' 🔒' : ''}</span>
                        ${roleLabel}
                    </div>
                </div>
                <div class="nag-preset-actions">
                    <div class="nag-preset-btn toggle-hidden-${type} ${p.isHidden ? 'is-hidden' : ''}" title="${p.isHidden ? '隐藏中 (不发送给AI)' : '显示中'}" data-id="${p.id}">
                        ${p.isHidden ? '👁️‍🗨️' : '👁️'}
                    </div>
                    ${!isLocked ? `
                        <div class="nag-preset-btn edit-item-${type}" title="编辑" data-id="${p.id}">✏️</div>
                        <div class="nag-preset-btn delete-item-${type}" title="删除" data-id="${p.id}">🗑️</div>
                    ` : ''}
                    <label class="nag-switch" title="启用/禁用">
                        <input type="checkbox" class="toggle-enabled-${type}" data-id="${p.id}" ${p.isEnabled ? 'checked' : ''}>
                        <span class="nag-slider"></span>
                    </label>
                </div>
            </div>
        `;
        $($list).append(html);
    });

    $($list).find(`.move-up-${type}`).on('click', function() {
        const id = $(this).data('id');
        const idx = settings[arrName].findIndex(x => x.id == id);
        if (idx > -1) {
            const current = settings[arrName][idx];
            const targetIdx = settings[arrName].findIndex(x => x.priority === current.priority - 1);
            if (targetIdx > -1) {
                settings[arrName][targetIdx].priority++;
                current.priority--;
                saveSettings();
                renderGenericPresets(type);
            }
        }
    });

    $($list).find(`.move-down-${type}`).on('click', function() {
        const id = $(this).data('id');
        const idx = settings[arrName].findIndex(x => x.id == id);
        if (idx > -1) {
            const current = settings[arrName][idx];
            const targetIdx = settings[arrName].findIndex(x => x.priority === current.priority + 1);
            if (targetIdx > -1) {
                settings[arrName][targetIdx].priority--;
                current.priority++;
                saveSettings();
                renderGenericPresets(type);
            }
        }
    });

    $($list).find(`.toggle-hidden-${type}`).on('click', function() {
        const id = $(this).data('id');
        const preset = settings[arrName].find(x => x.id == id);
        if (preset) {
            preset.isHidden = !preset.isHidden;
            saveSettings();
            renderGenericPresets(type);
        }
    });

    $($list).find(`.toggle-enabled-${type}`).on('change', function() {
        const id = $(this).data('id');
        const preset = settings[arrName].find(x => x.id == id);
        if (preset) {
            preset.isEnabled = $(this).prop('checked');
            saveSettings();
        }
    });

    $($list).find(`.edit-item-${type}`).on('click', function() {
        const id = $(this).data('id');
        showGenericPresetModal(type, id);
    });

    $($list).find(`.delete-item-${type}`).on('click', function() {
        const id = $(this).data('id');
        if (confirm('确定要删除这个预设吗？')) {
            settings[arrName] = settings[arrName].filter(x => x.id != id);
            saveSettings();
            renderGenericPresets(type);
        }
    });
}

function showPresetModal(id = null) { showGenericPresetModal('prompt', id); }
function showMsgOptPresetModal(id = null) { showGenericPresetModal('msgOpt', id); }

function showGenericPresetModal(type, id = null) {
    const isPrompt = type === 'prompt';
    const arrName = isPrompt ? 'presets' : 'msgOptPresets';
    
    const isEdit = id !== null;
    const preset = id !== null ? settings[arrName].find(x => x.id == id) : {
        name: '',
        content: '',
        icon: '📝',
        priority: (settings[arrName]?.length || 0) + 1,
        isEnabled: true,
        isHidden: false,
        role: 'system'
    };

    if (preset.isLocked) {
        toastr.warning('该条目不可编辑');
        return;
    }

    const modalHtml = `
        <div class="nag-modal-container" id="nag-preset-modal">
            <div class="nag-modal">
                <div class="nag-modal-header">
                    <span class="nag-modal-title">${isEdit ? '编辑预设' : '添加预设'}</span>
                    <button class="nag-modal-close">✕</button>
                </div>
                <div class="nag-modal-body">
                    <div class="nag-setting-item">
                        <label>条目名称</label>
                        <input type="text" id="modal-preset-name" value="${preset.name}" placeholder="例如：文风控制">
                    </div>
                    <div class="nag-setting-item">
                        <label>内容 (指令)</label>
                        <textarea id="modal-preset-content" rows="5" placeholder="发送给自定义 AI 的具体指令内容...">${preset.content}</textarea>
                    </div>
                    <div class="nag-setting-row">
                        <div class="nag-setting-item">
                            <label>图标</label>
                            <input type="text" id="modal-preset-icon" value="${preset.icon}" placeholder="Emoji">
                        </div>
                        <div class="nag-setting-item">
                            <label>角色 (Role)</label>
                            <select id="modal-preset-role">
                                <option value="system" ${preset.role === 'system' ? 'selected' : ''}>System</option>
                                <option value="user" ${preset.role === 'user' ? 'selected' : ''}>User</option>
                                <option value="assistant" ${preset.role === 'assistant' ? 'selected' : ''}>Assistant</option>
                            </select>
                        </div>
                        <div class="nag-setting-item">
                            <label>排序/优先级</label>
                            <input type="number" id="modal-preset-priority" value="${preset.priority}">
                        </div>
                    </div>
                    <div class="nag-btn-row">
                        <button id="modal-preset-save" class="menu_button">${isEdit ? '保存' : '创建'}</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('body').append(modalHtml);
    const $modal = $('#nag-preset-modal');

    $modal.find('.nag-modal-close').on('click', () => $modal.remove());
    $modal.find('#modal-preset-save').on('click', () => {
        const name = $('#modal-preset-name').val().trim();
        const content = $('#modal-preset-content').val().trim();
        if (!name || !content) {
            toastr.warning('名称和内容不能为空');
            return;
        }

        const newPreset = {
            ...preset,
            name,
            content,
            icon: $('#modal-preset-icon').val() || '📝',
            role: $('#modal-preset-role').val(),
            priority: parseInt($('#modal-preset-priority').val()) || 0
        };

        if (isEdit) {
            const idx = settings[arrName].findIndex(x => x.id == id);
            settings[arrName][idx] = newPreset;
        } else {
            newPreset.id = Date.now();
            settings[arrName].push(newPreset);
        }

        saveSettings();
        renderGenericPresets(type);
        $modal.remove();
    });
}

/**
 * 使用 AI 优化提示词
 * 汇总启用的预设，发送给自定义 API，获取结果
 */
async function optimizePromptWithAI() {
    if (!settings.apiEndpoints || settings.apiEndpoints.length === 0 || !settings.apiEndpoints.some(e => e.url)) {
        toastr.error('请先在 [自定义 API] 模块配置接口');
        return null;
    }

    const activePresets = settings.presets
        .filter(p => p.isEnabled && !p.isHidden)
        .sort((a, b) => a.priority - b.priority);

    if (activePresets.length === 0) {
        log('没有启用的预设条目，跳过优化', 'info');
        return settings.prompt;
    }

    // 构建消息数组
    const messages = [
        { role: 'system', content: settings.presetSystemPrompt }
    ];

    // 处理预设条目
    for (const p of activePresets) {
        if (p.id === 'history') {
            try {
                // 获取酒馆历史记录
                if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                    const ctx = SillyTavern.getContext();
                    const chat = ctx.chat || [];
                    
                    // 将每一条历史消息都以 system 身份发送，但内容标注原始身份
                    chat.forEach((msg, idx) => {
                        const originalRole = msg.is_user ? 'User' : (msg.is_system ? 'System' : 'Assistant');
                        const name = msg.name || originalRole;
                        let content = msg.mes || '';
                        
                        if (originalRole === 'System') {
                            content = applyRegexes(content, 'system');
                        }

                        if (content) {
                            messages.push({ 
                                role: 'system', 
                                content: `[CHAT_HISTORY] #${idx} [${originalRole}] ${name}: ${content}`
                            });
                        }
                    });
                } else {
                    log('无法获取 SillyTavern 上下文，跳过历史记录', 'warning');
                }
            } catch (err) {
                log('获取历史记录失败: ' + err.message, 'error');
            }
        } else {
            // 普通预设
            messages.push({ 
                role: p.role || 'system', 
                content: `### ${p.name}\n${p.content}` 
            });
        }
    }

    try {
        log('正在通过 AI 生成提示词...', 'info');
        const optimized = await callCustomApi(messages, {
            model: settings.presetModel,
            temperature: settings.presetTemp,
            topP: settings.presetTopP,
            topK: settings.presetTopK,
            maxTokens: settings.presetMaxTokens
        });
        if (optimized && optimized.trim()) {
            log('提示词生成成功', 'success');
            return optimized.trim();
        }
        throw new Error('AI 返回内容为空');
    } catch (e) {
        if (e.message === '用户中止') throw e;
        log('提示词生成失败: ' + e.message, 'error');
        toastr.error('提示词生成失败: ' + e.message);
        return null;
    }
}

// ============================================
// 设置 & UI
// ============================================

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
    settings.panelCollapsed = Object.assign({}, defaultSettings.panelCollapsed, settings.panelCollapsed || {});
    
    if (!Array.isArray(settings.regexItems)) {
        settings.regexItems = [];
    }

    // API 配置迁移
    if (!settings.apiEndpoints || settings.apiEndpoints.length === 0) {
        settings.apiEndpoints = [{
            id: 'default',
            name: '默认 API',
            url: settings.apiUrl || '',
            key: settings.apiKey || '',
            temp: settings.apiTemp || 0.7,
            topP: settings.apiTopP || 1.0,
            topK: settings.apiTopK || 0,
            maxTokens: settings.apiMaxTokens || 4096,
            extraParams: settings.apiExtraParams || ''
        }];
        settings.selectedApiEndpointId = 'default';
        if (settings.apiModel && !settings.apiModel.includes(':::')) {
            settings.apiModel = `default:::${settings.apiModel}`;
        }
    }

    // 确保 msgOptPresets 存在
    if (!Array.isArray(settings.msgOptPresets)) {
        settings.msgOptPresets = defaultSettings.msgOptPresets;
    } else {
        const hasLatestAI = settings.msgOptPresets.some(p => p.id === 'latest_ai');
        if (!hasLatestAI) {
            settings.msgOptPresets.unshift({ 
                id: 'latest_ai', 
                name: "最新AI消息", 
                content: "[LATEST_AI_MESSAGE]", 
                isEnabled: true, 
                isHidden: false, 
                icon: "🤖", 
                priority: 0, 
                role: 'system', 
                isLocked: true 
            });
        }
    }

    // 确保 history 预设存在
    if (Array.isArray(settings.presets)) {
        const hasHistory = settings.presets.some(p => p.id === 'history');
        if (!hasHistory) {
            settings.presets.unshift({ 
                id: 'history', 
                name: "酒馆聊天历史", 
                content: "[CHAT_HISTORY]", 
                isEnabled: false, 
                isHidden: false, 
                icon: "📜", 
                priority: 0, 
                role: 'system', 
                isLocked: true 
            });
        }
    }

    settings.isRunning = false; 
    settings.isPaused = false;
}

function saveSettings() {
    Object.assign(extension_settings[extensionName], settings);
    saveSettingsDebounced();
}

function renderApiEndpointSelect() {
    const $select = $('#nag-api-endpoint-select');
    $select.empty();
    settings.apiEndpoints.forEach(e => {
        $select.append(`<option value="${e.id}" ${e.id == settings.selectedApiEndpointId ? 'selected' : ''}>${escapeHtml(e.name || 'API节点')}</option>`);
    });
}

function syncApiEndpointUI() {
    const current = settings.apiEndpoints.find(e => e.id == settings.selectedApiEndpointId) || settings.apiEndpoints[0];
    if (current) {
        $('#nag-set-api-name').val(current.name);
        $('#nag-set-api-url').val(current.url);
        $('#nag-set-api-key').val(current.key);
        $('#nag-set-api-temp').val(current.temp);
        $('#nag-set-api-topp').val(current.topP);
        $('#nag-set-api-topk').val(current.topK);
        $('#nag-set-api-max-tokens').val(current.maxTokens);
        $('#nag-set-api-extra').val(current.extraParams);
    }
}

function updateUI() {
    const pct = settings.totalChapters > 0 ? (settings.currentChapter / settings.totalChapters * 100).toFixed(1) : 0;
    $('#nag-progress-fill').css('width', `${pct}%`);
    $('#nag-progress-text').text(`${settings.currentChapter} / ${settings.totalChapters} (${pct}%)`);
    
    const [txt, cls] = settings.isRunning 
        ? (settings.isPaused ? ['⏸️ 已暂停', 'paused'] : ['▶️ 运行中', 'running']) 
        : ['⏹️ 已停止', 'stopped'];
    $('#nag-status').text(txt).removeClass('stopped paused running').addClass(cls);
    
    $('#nag-btn-start').prop('disabled', settings.isRunning);
    $('#nag-btn-pause').prop('disabled', !settings.isRunning || settings.isPaused);
    $('#nag-btn-resume').prop('disabled', !settings.isPaused);
    $('#nag-btn-stop').prop('disabled', !settings.isRunning);
    $('#nag-btn-reset').prop('disabled', settings.isRunning);
    
    if (settings.isRunning && generationStats.startTime && generationStats.chaptersGenerated > 0) {
        const elapsed = Date.now() - generationStats.startTime;
        const avg = elapsed / generationStats.chaptersGenerated;
        $('#nag-time-elapsed').text(formatDuration(elapsed));
        $('#nag-time-remaining').text(formatDuration(avg * (settings.totalChapters - settings.currentChapter)));
    } else {
        $('#nag-time-elapsed').text('--:--:--');
        $('#nag-time-remaining').text('--:--:--');
    }
    $('#nag-stat-errors').text(generationStats.errors.length);
    
    $('#nag-set-start-floor, #nag-set-end-floor').prop('disabled', settings.exportAll);
    $('#nag-floor-inputs').toggleClass('disabled', settings.exportAll);
    
    // 发送阶段弹窗检测
    $('#nag-send-toast-settings').toggleClass('disabled', !settings.enableSendToastDetection);
    $('#nag-set-send-toast-timeout, #nag-set-send-post-toast-wait').prop('disabled', !settings.enableSendToastDetection);
    
    // 回复阶段弹窗检测
    $('#nag-reply-toast-settings').toggleClass('disabled', !settings.enableReplyToastDetection);
    $('#nag-set-reply-toast-timeout, #nag-set-reply-post-toast-wait').prop('disabled', !settings.enableReplyToastDetection);
}

function toggleTagSettings() {
    $('#nag-tags-container, #nag-separator-container').toggle(settings.extractMode === 'tags');
}

function togglePanel(panelId) {
    const panel = $(`#nag-panel-${panelId}`);
    const isCollapsed = panel.hasClass('collapsed');
    
    if (isCollapsed) {
        panel.removeClass('collapsed');
        settings.panelCollapsed[panelId] = false;
    } else {
        panel.addClass('collapsed');
        settings.panelCollapsed[panelId] = true;
    }
    
    saveSettings();
}

function createUI() {
    const html = `
    <div id="nag-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📚 小说自动生成器</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
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
                    <div class="nag-btn-row"><button id="nag-btn-reset" class="menu_button">🔄 重置</button></div>
                </div>

                <!-- 🌐 自定义 API 模块 -->
                <div id="nag-panel-api" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="api">
                        <span class="nag-panel-title">🌐 自定义 API</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="api" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-checkbox-group">
                            <label class="nag-checkbox-label">
                                <input type="checkbox" id="nag-set-api-enabled">
                                <span>🚀 启用自定义 API (仅限自动生成)</span>
                            </label>
                        </div>
                        
                        <div class="nag-setting-item">
                            <label>API 节点配置</label>
                            <div class="nag-setting-row">
                                <select id="nag-api-endpoint-select" style="flex: 1;"></select>
                                <button id="nag-btn-add-api" class="menu_button_icon" title="添加新节点" style="width: 40px;">➕</button>
                                <button id="nag-btn-delete-api" class="menu_button_icon" title="删除当前节点" style="width: 40px;">🗑️</button>
                            </div>
                        </div>
                        
                        <div class="nag-setting-item"><label>节点名称</label><input type="text" id="nag-set-api-name" placeholder="例如：OpenAI"></div>
                        <div class="nag-setting-item"><label>API URL</label><input type="text" id="nag-set-api-url" placeholder="https://api.openai.com/v1"></div>
                        <div class="nag-setting-item"><label>API Key</label><input type="password" id="nag-set-api-key" placeholder="sk-..."></div>
                        
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>温度 (Temp)</label><input type="number" id="nag-set-api-temp" min="0" max="2" step="0.1"></div>
                            <div class="nag-setting-item"><label>Top P</label><input type="number" id="nag-set-api-topp" min="0" max="1" step="0.1"></div>
                        </div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>Top K</label><input type="number" id="nag-set-api-topk" min="0" step="1"></div>
                            <div class="nag-setting-item"><label>最大 Token</label><input type="number" id="nag-set-api-max-tokens" min="1" step="128"></div>
                        </div>
                        <div class="nag-setting-item">
                            <label>额外参数 (JSON)</label>
                            <textarea id="nag-set-api-extra" rows="2" placeholder='{"frequency_penalty": 0.5}'></textarea>
                        </div>
                        
                        <div class="nag-btn-row">
                            <button id="nag-btn-test-api" class="menu_button">🧪 测试当前节点连接</button>
                        </div>
                        
                        <hr style="opacity: 0.2; margin: 10px 0;">
                        
                        <div class="nag-setting-item">
                            <label>选择模型 (合并所有节点)</label>
                            <div class="nag-setting-row">
                                <select id="nag-set-api-model" style="flex: 1;"><option value="">-- 请先获取列表 --</option></select>
                                <button id="nag-btn-fetch-models" class="menu_button_icon" title="获取模型列表" style="width: 40px;">🔄</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 🪄 消息优化模块 -->
                <div id="nag-panel-msgopt" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="msgopt">
                        <span class="nag-panel-title">🪄 消息优化</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="msgopt" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-checkbox-group">
                            <label class="nag-checkbox-label">
                                <input type="checkbox" id="nag-set-msgopt-enabled">
                                <span>✨ 启用酒馆AI消息优化</span>
                            </label>
                        </div>

                        <div class="nag-setting-item">
                            <label>模型选择 (优化处理器)</label>
                            <div class="nag-setting-row">
                                <select id="nag-set-msgopt-model" style="flex: 1;"><option value="">-- 请先在 API 模块获取 --</option></select>
                            </div>
                        </div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>温度 (Temp)</label><input type="number" id="nag-set-msgopt-temp" min="0" max="2" step="0.1"></div>
                            <div class="nag-setting-item"><label>Top P</label><input type="number" id="nag-set-msgopt-topp" min="0" max="1" step="0.1"></div>
                        </div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>Top K</label><input type="number" id="nag-set-msgopt-topk" min="0" step="1"></div>
                            <div class="nag-setting-item"><label>最大 Token</label><input type="number" id="nag-set-msgopt-max-tokens" min="1" step="128"></div>
                        </div>

                        <div class="nag-setting-item">
                            <label>系统提示词 (优化处理器)</label>
                            <textarea id="nag-set-msgopt-system" rows="3"></textarea>
                        </div>
                        <div class="nag-preset-list-header">
                            <div class="nag-btn-row">
                                <button id="nag-btn-add-msgopt-preset" class="menu_button">➕ 添加预设</button>
                                <button id="nag-btn-msgopt-optimize-now" class="menu_button">🪄 立即测试优化最新回复</button>
                            </div>
                        </div>
                        <div id="nag-msgopt-preset-list" class="nag-preset-list">
                            <!-- 消息优化预设条目动态加载 -->
                        </div>
                    </div>
                </div>

                <!-- 🎭 提示词预设模块 -->
                <div id="nag-panel-presets" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="presets">
                        <span class="nag-panel-title">🎭 提示词预设</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="presets" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-checkbox-group">
                            <label class="nag-checkbox-label">
                                <input type="checkbox" id="nag-set-preset-enabled">
                                <span>🧠 启用预设优化 (发送前由 AI 转换)</span>
                            </label>
                        </div>

                        <div class="nag-setting-item">
                            <label>模型选择 (预设处理器)</label>
                            <div class="nag-setting-row">
                                <select id="nag-set-preset-model" style="flex: 1;"><option value="">-- 请先在 API 模块获取 --</option></select>
                            </div>
                        </div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>温度 (Temp)</label><input type="number" id="nag-set-preset-temp" min="0" max="2" step="0.1"></div>
                            <div class="nag-setting-item"><label>Top P</label><input type="number" id="nag-set-preset-topp" min="0" max="1" step="0.1"></div>
                        </div>
                        <div class="nag-setting-row">
                            <div class="nag-setting-item"><label>Top K</label><input type="number" id="nag-set-preset-topk" min="0" step="1"></div>
                            <div class="nag-setting-item"><label>最大 Token</label><input type="number" id="nag-set-preset-max-tokens" min="1" step="128"></div>
                        </div>

                        <div class="nag-setting-item">
                            <label>系统提示词 (预设处理器)</label>
                            <textarea id="nag-set-preset-system" rows="3"></textarea>
                        </div>
                        <div class="nag-preset-list-header">
                            <div class="nag-btn-row">
                                <button id="nag-btn-add-preset" class="menu_button">➕ 添加预设</button>
                                <button id="nag-btn-optimize-now" class="menu_button">🪄 立即测试优化</button>
                            </div>
                        </div>
                        <div id="nag-preset-list" class="nag-preset-list">
                            <!-- 预设条目动态加载 -->
                        </div>
                    </div>
                </div>

                <!-- 🧩 正则替换模块 -->
                <div id="nag-panel-regex" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="regex">
                        <span class="nag-panel-title">🧩 正则替换</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="regex" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-checkbox-group">
                            <label class="nag-checkbox-label">
                                <input type="checkbox" id="nag-set-regex-enabled">
                                <span>✨ 启用正则替换</span>
                            </label>
                        </div>
                        <div class="nag-preset-list-header">
                            <div class="nag-btn-row">
                                <button id="nag-btn-add-regex" class="menu_button">➕ 添加正则</button>
                            </div>
                        </div>
                        <div id="nag-regex-list" class="nag-preset-list">
                            <!-- 正则条目动态加载 -->
                        </div>
                    </div>
                </div>

                <!--  生成设置模块 -->
                <div id="nag-panel-generate" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="generate">
                        <span class="nag-panel-title">📝 生成设置</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="generate" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-setting-item"><label>目标章节</label><input type="number" id="nag-set-total" min="1"></div>
                        <div class="nag-setting-item"><label>提示词</label><textarea id="nag-set-prompt" rows="2"></textarea></div>
                    </div>
                </div>

                <!-- 📤 导出设置模块 -->
                <div id="nag-panel-export" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="export">
                        <span class="nag-panel-title">📤 导出设置</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="export" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-floor-info">共 <span id="nag-total-floors">${getTotalFloors()}</span> 条 <button id="nag-btn-refresh-floors" class="menu_button_icon">🔄</button></div>
                        <div class="nag-checkbox-group"><label class="nag-checkbox-label"><input type="checkbox" id="nag-set-export-all"><span>📑 导出全部</span></label></div>
                        <div id="nag-floor-inputs" class="nag-setting-row">
                            <div class="nag-setting-item"><label>起始楼层</label><input type="number" id="nag-set-start-floor" min="0"></div>
                            <div class="nag-setting-item"><label>结束楼层</label><input type="number" id="nag-set-end-floor" min="0"></div>
                        </div>
                        <div class="nag-checkbox-group">
                            <label class="nag-checkbox-label"><input type="checkbox" id="nag-set-include-user"><span>👤 用户消息</span></label>
                            <label class="nag-checkbox-label"><input type="checkbox" id="nag-set-include-ai"><span>🤖 AI 回复</span></label>
                            <label class="nag-checkbox-label"><input type="checkbox" id="nag-set-use-raw"><span>📄 原始 (chat.mes)</span></label>
                        </div>
                        <div class="nag-btn-row">
                            <button id="nag-btn-export-txt" class="menu_button">📄 TXT</button>
                            <button id="nag-btn-export-json" class="menu_button">📦 JSON</button>
                        </div>
                    </div>
                </div>

                <!-- 🏷️ 标签提取模块 -->
                <div id="nag-panel-extract" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="extract">
                        <span class="nag-panel-title">🏷️ 标签提取</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="extract" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        <div class="nag-setting-item">
                            <label>提取模式</label>
                            <select id="nag-set-extract-mode">
                                <option value="all">全部内容</option>
                                <option value="tags">只提取指定标签</option>
                            </select>
                        </div>
                        <div class="nag-setting-item" id="nag-tags-container">
                            <label>标签名称 <span class="nag-hint">(空格/逗号分隔)</span></label>
                            <textarea id="nag-set-tags" rows="1" placeholder="content detail 正文"></textarea>
                        </div>
                        <div class="nag-setting-item" id="nag-separator-container">
                            <label>分隔符</label>
                            <select id="nag-set-separator">
                                <option value="\\n\\n">空行</option>
                                <option value="\\n">换行</option>
                                <option value="">无</option>
                            </select>
                        </div>
                        <div class="nag-extract-preview">
                            <div class="nag-preview-header">
                                <span>📋 预览</span>
                                <button id="nag-btn-refresh-preview" class="menu_button_icon">🔄</button>
                            </div>
                            <div id="nag-preview-content" class="nag-preview-box"><i>点击刷新</i></div>
                        </div>
                    </div>
                </div>

                <!-- ⚙️ 高级设置模块 -->
                <div id="nag-panel-advanced" class="nag-section nag-settings nag-collapsible">
                    <div class="nag-panel-header" data-panel="advanced">
                        <span class="nag-panel-title">⚙️ 高级设置</span>
                        <div class="nag-panel-actions">
                            <span class="nag-help-btn" data-help="advanced" title="帮助">❓</span>
                            <span class="nag-collapse-icon">▼</span>
                        </div>
                    </div>
                    <div class="nag-panel-content">
                        
                        <!-- 发送阶段模块 -->
                        <div class="nag-module nag-module-send">
                            <div class="nag-module-header">
                                <span class="nag-module-icon">📤</span>
                                <span class="nag-module-title">发送阶段</span>
                            </div>
                            <div class="nag-module-body">
                                <div class="nag-module-desc">消息发送后，等待剧情推进等插件处理完成</div>
                                <div class="nag-checkbox-group">
                                    <label class="nag-checkbox-label">
                                        <input type="checkbox" id="nag-set-send-toast-detection">
                                        <span>💬 启用弹窗检测</span>
                                    </label>
                                </div>
                                <div id="nag-send-toast-settings">
                                    <div class="nag-setting-row">
                                        <div class="nag-setting-item">
                                            <label>等待超时 (ms)</label>
                                            <input type="number" id="nag-set-send-toast-timeout" min="5000" step="5000">
                                        </div>
                                        <div class="nag-setting-item">
                                            <label>额外等待 (ms)</label>
                                            <input type="number" id="nag-set-send-post-toast-wait" min="0" step="500">
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 回复阶段模块 -->
                        <div class="nag-module nag-module-reply">
                            <div class="nag-module-header">
                                <span class="nag-module-icon">📥</span>
                                <span class="nag-module-title">回复阶段</span>
                            </div>
                            <div class="nag-module-body">
                                <div class="nag-module-desc">AI回复完成后，等待总结等插件处理完成</div>
                                <div class="nag-setting-row">
                                    <div class="nag-setting-item">
                                        <label>回复后等待 (ms)</label>
                                        <input type="number" id="nag-set-reply-wait" min="0" step="1000">
                                    </div>
                                    <div class="nag-setting-item">
                                        <label>稳定检查间隔 (ms)</label>
                                        <input type="number" id="nag-set-stability-interval" min="500" step="500">
                                    </div>
                                </div>
                                <div class="nag-setting-item">
                                    <label>稳定次数</label>
                                    <input type="number" id="nag-set-stability-count" min="1" style="width: 100px;">
                                </div>
                                <div class="nag-checkbox-group">
                                    <label class="nag-checkbox-label">
                                        <input type="checkbox" id="nag-set-reply-toast-detection">
                                        <span>💬 启用弹窗检测</span>
                                    </label>
                                </div>
                                <div id="nag-reply-toast-settings">
                                    <div class="nag-setting-row">
                                        <div class="nag-setting-item">
                                            <label>等待超时 (ms)</label>
                                            <input type="number" id="nag-set-reply-toast-timeout" min="10000" step="10000">
                                        </div>
                                        <div class="nag-setting-item">
                                            <label>额外等待 (ms)</label>
                                            <input type="number" id="nag-set-reply-post-toast-wait" min="0" step="500">
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 生成控制模块 -->
                        <div class="nag-module nag-module-control">
                            <div class="nag-module-header">
                                <span class="nag-module-icon">🔧</span>
                                <span class="nag-module-title">生成控制</span>
                            </div>
                            <div class="nag-module-body">
                                <div class="nag-module-desc">控制自动生成的行为参数</div>
                                <div class="nag-setting-row">
                                    <div class="nag-setting-item">
                                        <label>自动保存间隔</label>
                                        <input type="number" id="nag-set-autosave" min="1">
                                    </div>
                                    <div class="nag-setting-item">
                                        <label>最大重试</label>
                                        <input type="number" id="nag-set-retries" min="1">
                                    </div>
                                </div>
                                <div class="nag-setting-item">
                                    <label>最小章节长度</label>
                                    <input type="number" id="nag-set-minlen" min="0" style="width: 100px;">
                                </div>
                            </div>
                        </div>
                        
                        <div class="nag-debug-hint">控制台调试: <code>nagDebug()</code></div>
                    </div>
                </div>

                <!-- 📚 TXT转世界书模块 -->
                <div class="nag-section">
                    <div class="nag-btn-row">
                        <button id="nag-btn-txt-to-worldbook" class="menu_button" style="background: linear-gradient(135deg, #e67e22, #d35400);">
                            📚 TXT转世界书
                        </button>
                    </div>
                </div>

            </div>
        </div>
    </div>`;
    
    $('#extensions_settings').append(html);
    bindEvents();
    syncUI();
    applyPanelStates();
}

function applyPanelStates() {
    Object.entries(settings.panelCollapsed).forEach(([panelId, isCollapsed]) => {
        if (isCollapsed) {
            $(`#nag-panel-${panelId}`).addClass('collapsed');
        }
    });
}

async function onGenerationEnded(messageId) {
    if (!settings.enableMsgOptimization || isOptimizing || messageId === lastOptimizedId) return;
    
    const stChat = getSTChat();
    if (!stChat || !stChat[messageId]) return;
    const msg = stChat[messageId];
    if (msg.is_user || msg.is_human) return;
    
    try {
        isOptimizing = true;
        await performMessageOptimization(messageId, msg.mes);
        lastOptimizedId = messageId;
    } finally {
        isOptimizing = false;
    }
}

function bindEvents() {
    $('#nag-btn-start').on('click', startGeneration);
    $('#nag-btn-pause').on('click', pauseGeneration);
    $('#nag-btn-resume').on('click', resumeGeneration);
    $('#nag-btn-stop').on('click', stopGeneration);
    $('#nag-btn-reset').on('click', resetProgress);
    $('#nag-btn-export-txt').on('click', () => exportNovel(false));
    $('#nag-btn-export-json').on('click', () => exportAsJSON(false));
    $('#nag-btn-refresh-floors').on('click', () => $('#nag-total-floors').text(getTotalFloors()));
    $('#nag-btn-refresh-preview').on('click', refreshPreview);

    // 消息优化事件
    $('#nag-set-msgopt-enabled').on('change', function() { settings.enableMsgOptimization = $(this).prop('checked'); saveSettings(); });
    $('#nag-set-msgopt-model').on('change', function() { settings.msgOptModel = $(this).val(); saveSettings(); });
    $('#nag-set-msgopt-temp').on('change', function() { settings.msgOptTemp = +$(this).val(); saveSettings(); });
    $('#nag-set-msgopt-topp').on('change', function() { settings.msgOptTopP = +$(this).val(); saveSettings(); });
    $('#nag-set-msgopt-topk').on('change', function() { settings.msgOptTopK = +$(this).val(); saveSettings(); });
    $('#nag-set-msgopt-max-tokens').on('change', function() { settings.msgOptMaxTokens = +$(this).val(); saveSettings(); });
    $('#nag-set-msgopt-system').on('change', function() { settings.msgOptSystemPrompt = $(this).val(); saveSettings(); });
    $('#nag-btn-add-msgopt-preset').on('click', () => showMsgOptPresetModal());
    $('#nag-btn-msgopt-optimize-now').on('click', async () => {
        const stChat = getSTChat();
        let lastAiIndex = -1;
        let rawContent = '';
        if (stChat) {
            for (let i = stChat.length - 1; i >= 0; i--) {
                const msg = stChat[i];
                if (msg && !msg.is_user && !msg.is_human && msg.mes) {
                    rawContent = msg.mes;
                    lastAiIndex = i;
                    break;
                }
            }
        }
        if (lastAiIndex !== -1 && rawContent) {
            await performMessageOptimization(lastAiIndex, rawContent);
            toastr.success('消息优化已完成并替换');
        } else {
            toastr.warning('未找到 AI 消息');
        }
    });

    // 预设相关事件
    $('#nag-set-preset-enabled').on('change', function() { settings.enablePresetOptimization = $(this).prop('checked'); saveSettings(); });
    $('#nag-set-preset-model').on('change', function() { settings.presetModel = $(this).val(); saveSettings(); });
    $('#nag-set-preset-temp').on('change', function() { settings.presetTemp = +$(this).val(); saveSettings(); });
    $('#nag-set-preset-topp').on('change', function() { settings.presetTopP = +$(this).val(); saveSettings(); });
    $('#nag-set-preset-topk').on('change', function() { settings.presetTopK = +$(this).val(); saveSettings(); });
    $('#nag-set-preset-max-tokens').on('change', function() { settings.presetMaxTokens = +$(this).val(); saveSettings(); });
    $('#nag-set-preset-system').on('change', function() { settings.presetSystemPrompt = $(this).val(); saveSettings(); });
    $('#nag-btn-add-preset').on('click', () => showPresetModal());
    $('#nag-btn-optimize-now').on('click', async () => {
        const optimized = await optimizePromptWithAI();
        if (optimized) {
            settings.prompt = optimized;
            $('#nag-set-prompt').val(optimized);
            saveSettings();
            toastr.success('提示词已根据预设完成优化');
        }
    });

    // 正则替换事件
    $('#nag-set-regex-enabled').on('change', function() { settings.enableRegexProcessing = $(this).prop('checked'); saveSettings(); });
    $('#nag-btn-add-regex').on('click', () => showRegexModal());
    
    // API 设置事件
    $('#nag-set-api-enabled').on('change', function() { settings.apiEnabled = $(this).prop('checked'); saveSettings(); });
    $('#nag-api-endpoint-select').on('change', function() { 
        settings.selectedApiEndpointId = $(this).val(); 
        syncApiEndpointUI(); 
        saveSettings(); 
    });
    $('#nag-btn-add-api').on('click', function() {
        const id = Date.now().toString();
        settings.apiEndpoints.push({
            id, name: `API节点 ${settings.apiEndpoints.length + 1}`, url: '', key: '',
            temp: 0.7, topP: 1.0, topK: 0, maxTokens: 4096, extraParams: ''
        });
        settings.selectedApiEndpointId = id;
        saveSettings();
        renderApiEndpointSelect();
        syncApiEndpointUI();
    });
    $('#nag-btn-delete-api').on('click', function() {
        if (settings.apiEndpoints.length <= 1) {
            toastr.warning('必须保留至少一个 API 节点');
            return;
        }
        if (confirm('确定要删除当前选择的 API 节点吗？')) {
            settings.apiEndpoints = settings.apiEndpoints.filter(e => e.id != settings.selectedApiEndpointId);
            settings.selectedApiEndpointId = settings.apiEndpoints[0].id;
            saveSettings();
            renderApiEndpointSelect();
            syncApiEndpointUI();
        }
    });

    const updateCurrentEndpoint = (key, val) => {
        const current = settings.apiEndpoints.find(e => e.id == settings.selectedApiEndpointId);
        if (current) { current[key] = val; saveSettings(); }
    };
    $('#nag-set-api-name').on('change', function() { updateCurrentEndpoint('name', $(this).val()); renderApiEndpointSelect(); });
    $('#nag-set-api-url').on('change', function() { updateCurrentEndpoint('url', $(this).val()); });
    $('#nag-set-api-key').on('change', function() { updateCurrentEndpoint('key', $(this).val()); });
    $('#nag-set-api-temp').on('change', function() { updateCurrentEndpoint('temp', +$(this).val()); });
    $('#nag-set-api-topp').on('change', function() { updateCurrentEndpoint('topP', +$(this).val()); });
    $('#nag-set-api-topk').on('change', function() { updateCurrentEndpoint('topK', +$(this).val()); });
    $('#nag-set-api-max-tokens').on('change', function() { updateCurrentEndpoint('maxTokens', +$(this).val()); });
    $('#nag-set-api-extra').on('change', function() { updateCurrentEndpoint('extraParams', $(this).val()); });
    
    $('#nag-set-api-model').on('change', function() { settings.apiModel = $(this).val(); saveSettings(); });
    $('#nag-btn-fetch-models').on('click', fetchApiModels);
    $('#nag-btn-test-api').on('click', testApiConnection);

    // TXT转世界书入口
    $('#nag-btn-txt-to-worldbook').on('click', () => {
        if (typeof window.TxtToWorldbook !== 'undefined') {
            window.TxtToWorldbook.open();
        } else {
            toastr.error('TXT转世界书模块未加载');
        }
    });

    // 面板折叠 - 排除帮助按钮
    $('.nag-panel-header').on('click', function(e) {
        // 如果点击的是帮助按钮区域，不处理折叠
        if ($(e.target).closest('.nag-help-btn').length > 0) {
            return;
        }
        const panelId = $(this).data('panel');
        togglePanel(panelId);
    });
    
    // 帮助按钮 - 使用原生事件绑定
    document.querySelectorAll('.nag-help-btn').forEach(btn => {
        const topic = btn.getAttribute('data-help');
        
        // 阻止事件冒泡（不使用 preventDefault，否则会阻止 click）
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        }, false);
        
        btn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
        }, { passive: true }); // passive: true 表示不会调用 preventDefault
        
        btn.addEventListener('touchend', (e) => {
            e.stopPropagation();
        }, { passive: true });
        
        // 点击打开帮助
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            showHelp(topic);
        }, false);
    });
    
    // 导出设置
    $('#nag-set-export-all').on('change', function() { 
        settings.exportAll = $(this).prop('checked'); 
        updateUI(); 
        saveSettings(); 
    });
    $('#nag-set-start-floor').on('change', function() { 
        settings.exportStartFloor = +$(this).val() || 0; 
        saveSettings(); 
    });
    $('#nag-set-end-floor').on('change', function() { 
        settings.exportEndFloor = +$(this).val() || 99999; 
        saveSettings(); 
    });
    $('#nag-set-include-user').on('change', function() { 
        settings.exportIncludeUser = $(this).prop('checked'); 
        saveSettings(); 
    });
    $('#nag-set-include-ai').on('change', function() { 
        settings.exportIncludeAI = $(this).prop('checked'); 
        saveSettings(); 
    });
    $('#nag-set-use-raw').on('change', function() { 
        settings.useRawContent = $(this).prop('checked'); 
        saveSettings(); 
        refreshPreview(); 
    });
    
    // 标签提取
    $('#nag-set-extract-mode').on('change', function() { 
        settings.extractMode = $(this).val(); 
        toggleTagSettings(); 
        saveSettings(); 
        refreshPreview(); 
    });
    $('#nag-set-tags').on('change', function() { 
        settings.extractTags = $(this).val(); 
        saveSettings(); 
        refreshPreview(); 
    });
    $('#nag-set-separator').on('change', function() { 
        settings.tagSeparator = $(this).val().replace(/\\\\n/g, '\n'); 
        saveSettings(); 
    });
    
    // 发送阶段弹窗检测
    $('#nag-set-send-toast-detection').on('change', function() { 
        settings.enableSendToastDetection = $(this).prop('checked'); 
        updateUI();
        saveSettings(); 
    });
    $('#nag-set-send-toast-timeout').on('change', function() { 
        settings.sendToastWaitTimeout = +$(this).val() || 60000; 
        saveSettings(); 
    });
    $('#nag-set-send-post-toast-wait').on('change', function() { 
        settings.sendPostToastWaitTime = +$(this).val() || 1000; 
        saveSettings(); 
    });
    
    // 回复阶段设置
    $('#nag-set-reply-wait').on('change', function() { settings.replyWaitTime = +$(this).val() || 5000; saveSettings(); });
    $('#nag-set-stability-interval').on('change', function() { settings.stabilityCheckInterval = +$(this).val() || 1000; saveSettings(); });
    $('#nag-set-stability-count').on('change', function() { settings.stabilityRequiredCount = +$(this).val() || 3; saveSettings(); });
    $('#nag-set-reply-toast-detection').on('change', function() { 
        settings.enableReplyToastDetection = $(this).prop('checked'); 
        updateUI();
        saveSettings(); 
    });
    $('#nag-set-reply-toast-timeout').on('change', function() { 
        settings.replyToastWaitTimeout = +$(this).val() || 300000; 
        saveSettings(); 
    });
    $('#nag-set-reply-post-toast-wait').on('change', function() { 
        settings.replyPostToastWaitTime = +$(this).val() || 2000; 
        saveSettings(); 
    });
    
    // 生成控制
    $('#nag-set-total').on('change', function() { 
        settings.totalChapters = +$(this).val() || 1000; 
        saveSettings(); 
        updateUI(); 
    });
    $('#nag-set-prompt').on('change', function() { 
        settings.prompt = $(this).val(); 
        saveSettings(); 
    });
    $('#nag-set-autosave').on('change', function() { 
        settings.autoSaveInterval = +$(this).val() || 50; 
        saveSettings(); 
    });
    $('#nag-set-retries').on('change', function() { 
        settings.maxRetries = +$(this).val() || 3; 
        saveSettings(); 
    });
    $('#nag-set-minlen').on('change', function() { 
        settings.minChapterLength = +$(this).val() || 100; 
        saveSettings(); 
    });
}

function syncUI() {
    // 消息优化同步
    $('#nag-set-msgopt-enabled').prop('checked', settings.enableMsgOptimization);
    $('#nag-set-msgopt-model').val(settings.msgOptModel);
    $('#nag-set-msgopt-temp').val(settings.msgOptTemp);
    $('#nag-set-msgopt-topp').val(settings.msgOptTopP);
    $('#nag-set-msgopt-topk').val(settings.msgOptTopK);
    $('#nag-set-msgopt-max-tokens').val(settings.msgOptMaxTokens);
    $('#nag-set-msgopt-system').val(settings.msgOptSystemPrompt);
    renderMsgOptPresets();

    // 预设同步
    $('#nag-set-preset-enabled').prop('checked', settings.enablePresetOptimization);
    $('#nag-set-preset-model').val(settings.presetModel);
    $('#nag-set-preset-temp').val(settings.presetTemp);
    $('#nag-set-preset-topp').val(settings.presetTopP);
    $('#nag-set-preset-topk').val(settings.presetTopK);
    $('#nag-set-preset-max-tokens').val(settings.presetMaxTokens);
    $('#nag-set-preset-system').val(settings.presetSystemPrompt);
    renderPresets();

    // 正则同步
    $('#nag-set-regex-enabled').prop('checked', settings.enableRegexProcessing);
    renderRegexItems();

    // API 设置
    $('#nag-set-api-enabled').prop('checked', settings.apiEnabled);
    renderApiEndpointSelect();
    syncApiEndpointUI();
    
    const $selectModel = $('#nag-set-api-model');
    const $selectMsgOptModel = $('#nag-set-msgopt-model');
    const $selectPresetModel = $('#nag-set-preset-model');
    
    if (settings.apiModel) {
        const parts = settings.apiModel.split(':::');
        const modelName = parts.length > 1 ? parts.slice(1).join(':::') : settings.apiModel;
        $selectModel.empty().append(`<option value="${settings.apiModel}" selected>${modelName}</option>`);
    }
    
    if (settings.msgOptModel) {
        const parts = settings.msgOptModel.split(':::');
        const modelName = parts.length > 1 ? parts.slice(1).join(':::') : settings.msgOptModel;
        $selectMsgOptModel.empty().append(`<option value="${settings.msgOptModel}" selected>${modelName}</option>`);
    }

    if (settings.presetModel) {
        const parts = settings.presetModel.split(':::');
        const modelName = parts.length > 1 ? parts.slice(1).join(':::') : settings.presetModel;
        $selectPresetModel.empty().append(`<option value="${settings.presetModel}" selected>${modelName}</option>`);
    }

    // 生成设置
    $('#nag-set-total').val(settings.totalChapters);
    $('#nag-set-prompt').val(settings.prompt);
    
    // 导出设置
    $('#nag-set-export-all').prop('checked', settings.exportAll);
    $('#nag-set-start-floor').val(settings.exportStartFloor);
    $('#nag-set-end-floor').val(settings.exportEndFloor);
    $('#nag-set-include-user').prop('checked', settings.exportIncludeUser);
    $('#nag-set-include-ai').prop('checked', settings.exportIncludeAI);
    $('#nag-set-use-raw').prop('checked', settings.useRawContent);
    
    // 标签提取
    $('#nag-set-extract-mode').val(settings.extractMode);
    $('#nag-set-tags').val(settings.extractTags);
    $('#nag-set-separator').val(settings.tagSeparator.replace(/\n/g, '\\\\n'));
    
    // 发送阶段弹窗检测
    $('#nag-set-send-toast-detection').prop('checked', settings.enableSendToastDetection);
    $('#nag-set-send-toast-timeout').val(settings.sendToastWaitTimeout);
    $('#nag-set-send-post-toast-wait').val(settings.sendPostToastWaitTime);
    
    // 回复阶段设置
    $('#nag-set-reply-wait').val(settings.replyWaitTime);
    $('#nag-set-stability-interval').val(settings.stabilityCheckInterval);
    $('#nag-set-stability-count').val(settings.stabilityRequiredCount);
    $('#nag-set-reply-toast-detection').prop('checked', settings.enableReplyToastDetection);
    $('#nag-set-reply-toast-timeout').val(settings.replyToastWaitTimeout);
    $('#nag-set-reply-post-toast-wait').val(settings.replyPostToastWaitTime);
    
    // 生成控制
    $('#nag-set-autosave').val(settings.autoSaveInterval);
    $('#nag-set-retries').val(settings.maxRetries);
    $('#nag-set-minlen').val(settings.minChapterLength);
    
    toggleTagSettings();
    updateUI();
}

// ============================================
// 初始化
// ============================================

jQuery(async () => {
    loadSettings();
    createUI();
    
    try {
        if (typeof SillyTavern !== 'undefined' && typeof eventOn === 'function') {
            const ctx = SillyTavern.getContext();
            const tavern_events = ctx.tavern_events;
            if (tavern_events && tavern_events.GENERATION_ENDED) {
                eventOn(tavern_events.GENERATION_ENDED, onGenerationEnded);
            }
        }
    } catch(e) {
        log('注册生成结束监听失败: ' + e.message, 'warning');
    }

    setInterval(() => { if (settings.isRunning) updateUI(); }, 1000);
    log('扩展已加载', 'success');
});
