/**
 * extract_purpose — OpenClaw Plugin (V2: Hook 拦截方案)
 *
 * 通过 before_tool_call / after_tool_call 钩子拦截工具调用，
 * 从工具参数中提取简短的意图摘要（purpose），并注入到结果的 channelData 中，
 * 供前端渲染为任务卡片上的意图徽章。
 *
 * 意图提取采用两层逻辑：
 *   第 1 层：若模型提供了 params.purpose → 直接沿用，不做压缩
 *   第 2 层：若未提供 purpose → 综合参数按优先级推导，拼接为"动作+目标"格式
 *
 * 与 V1（代理工具方案）相比，V2 通过 Hook 机制在工具调用层面拦截，
 * 无论 LLM 调用哪个工具均会触发，彻底解决了 V1 中代理工具可能被绕过的问题。
 */

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 插件配置：maxPurposeLength（意图最大长度，最小5，默认20）、targetTools（目标工具列表） */
type PluginConfig = {
  maxPurposeLength: number;
  targetTools: string[];
};

/** 插件日志接口，warn/info 均可选，通过可选链安全调用 */
type PluginLogger = {
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
};

/** before_tool_call 事件：工具即将执行时触发，包含工具名和调用参数 */
type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

/** after_tool_call 事件：工具执行完毕后触发，包含结果、错误和耗时 */
type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

/**
 * Hook 事件上下文，包含会话、渠道、代理等标识信息。
 * 其中 runId 是关联 before_tool_call 和 after_tool_call 的关键字段。
 */
type PluginHookContext = {
  channelId?: string;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  conversationId?: string;
  from?: string;
  to?: string;
  sessionId?: string;
  runId?: string;
  [key: string]: unknown;
};

/** 暂存的 purpose 记录，在 before/after hook 之间传递 */
type PendingPurpose = {
  toolName: string;
  purpose: string;
  runId?: string;
};

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 意图摘要的默认最大字符长度 */
const DEFAULT_MAX_PURPOSE_LENGTH = 20;

/**
 * 默认需要拦截的目标工具列表
 *
 * 这些工具是 Agent 在执行任务时最常用的操作类工具，
 * 拦截它们可以覆盖绝大多数需要意图追踪的场景。
 * 可通过配置项 targetTools 自定义覆盖。
 */
const DEFAULT_TARGET_TOOLS = [
  'read', 'write', 'edit', 'exec', 'process',
  'agents_list', 'nodes', 'canvas', 'tts', 'cron',
];

// ─── 状态 ─────────────────────────────────────────────────────────────────────

/**
 * 暂存 purpose 的 Map（runId → PendingPurpose）
 *
 * 作用：在 before_tool_call 和 after_tool_call 之间传递 purpose 数据。
 *
 * 生命周期：
 *   1. before_tool_call 中：提取 purpose → 以 runId 为键存入 Map
 *   2. after_tool_call 中：以 runId 为键取出 purpose → 注入 channelData → 删除条目
 *
 * 设计考量：
 *   - 使用 Map 而非普通对象，因 runId 为动态生成的字符串，Map 的键查找性能更优
 *   - after_tool_call 中立即删除条目，避免内存泄漏
 *   - 若 after_tool_call 未触发（异常情况），条目将残留于 Map 中，
 *     但由于 runId 具有唯一性，不会影响后续调用
 */
const pendingPurposes = new Map<string, PendingPurpose>();

// ─── 配置规范化 ───────────────────────────────────────────────────────────────

/**
 * 类型守卫：判断值是否为普通对象（Record）
 *
 * 排除 null、数组等特殊情况，确保值可以安全地作为 Record<string, unknown> 使用。
 * 在整个插件中用于对未知来源的参数和配置进行类型安全检查。
 *
 * @param value - 待检查的值
 * @returns 如果是普通对象返回 true，否则返回 false
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 规范化插件配置
 *
 * 从 api.pluginConfig 中提取并验证配置项，确保配置值在合法范围内。
 * 对于缺失或非法的配置项，使用默认值兜底。
 *
 * 处理逻辑：
 *   - maxPurposeLength：必须是 ≥5 的有限数字，否则使用默认值 20
 *   - targetTools：必须是非空字符串数组，否则使用 DEFAULT_TARGET_TOOLS
 *     数组中的空字符串和空白字符串会被过滤
 *
 * @param raw - 原始配置对象（来自 api.pluginConfig，类型未知）
 * @returns 规范化后的插件配置
 */
function normalizeConfig(raw: unknown): PluginConfig {
  const cfg = isRecord(raw) ? raw : {};

  const maxPurposeLength = typeof cfg.maxPurposeLength === 'number' && Number.isFinite(cfg.maxPurposeLength) && cfg.maxPurposeLength >= 5
    ? Math.floor(cfg.maxPurposeLength)
    : DEFAULT_MAX_PURPOSE_LENGTH;

  let targetTools: string[] = DEFAULT_TARGET_TOOLS;
  if (Array.isArray(cfg.targetTools)) {
    // 过滤掉非字符串和空白字符串，确保每个工具名都是有效的
    const valid = cfg.targetTools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    if (valid.length > 0) targetTools = valid;
  }

  return { maxPurposeLength, targetTools };
}

// ─── 意图提取辅助函数 ─────────────────────────────────────────────────────────

/**
 * 从完整路径中提取人类可读的短描述
 *
 * 策略：优先展示文件名；若文件名本身太短或不具辨识度，追加父目录增强语义。
 * 当整体长度超出预算（budget）时，保留扩展名并截断文件名主体，中间用 … 连接。
 *
 * 示例：
 *   ~/.openclaw/openclaw.json       → "openclaw.json"
 *   /etc/nginx/nginx.conf           → "nginx/nginx.conf"
 *   C:\Users\x\project\src\index.ts → "src/index.ts"
 *   /very/long/path/config.json     → "config.json"（若 budget 足够）
 *   /very/long/path/verylongname.ts → "veryl…name.ts"（若 budget 不足）
 *
 * @param filePath - 完整文件路径
 * @param budget   - 允许的最大字符长度
 * @returns 人类可读的短路径描述
 */
function humanizePath(filePath: string, budget: number): string {
  // 将 ~ 展开为 $HOME，增强可读性
  const expanded = filePath.replace(/^~/, '$HOME');
  // 按路径分隔符拆分（兼容 Unix / 和 Windows \）
  const parts = expanded.split(/[\\/]/).filter(Boolean);
  const fileName = parts[parts.length - 1] || expanded;

  // 尝试追加父目录，如 "src/index.ts"，比单独 "index.ts" 更具辨识度
  if (parts.length >= 2) {
    const withParent = parts[parts.length - 2] + '/' + fileName;
    if (withParent.length <= budget) return withParent;
  }

  // 仅文件名即可满足预算
  if (fileName.length <= budget) return fileName;

  // 文件名过长，保留扩展名，截断主体部分
  const extMatch = fileName.match(/(\.[\w]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  const baseName = fileName.slice(0, fileName.length - ext.length);
  // 至少保留 4 个字符的主体，避免截断后无意义
  const keepBase = Math.max(budget - ext.length - 1, 4);
  return baseName.slice(0, keepBase) + '…' + ext;
}

/**
 * 将过长的 purpose 文本压缩至 maxLen 以内
 *
 * 采用三步渐进式压缩策略，优先保留语义完整性：
 *
 *   Step 1: 去除中文冗余词
 *     - "进行（一次/一个）" → 删除
 *     - 末尾"操作" → 删除
 *     - 连续助词"的了呢吧啊吗"前的"的/地/得" → 删除
 *     - 连接词"然后/接着/之后/最后" → 删除
 *     - 并列词"并且/同时/而且" → 替换为逗号
 *
 *   Step 2: 多动作截断
 *     - 若文本包含逗号/分号分隔的多个动作，仅保留第一个核心动作
 *
 *   Step 3: 首尾省略
 *     - 仍超长则保留前 60% 和后 40% 的关键信息，中间用 … 连接
 *
 * @param text   - 待压缩的 purpose 文本
 * @param maxLen - 最大字符长度
 * @returns 压缩后的 purpose 文本
 */
function compressPurpose(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  // Step 1: 去除常见冗余词
  let compressed = text
    .replace(/进行(一(?:次|个))?/g, '')
    .replace(/操作$/g, '')
    .replace(/(?:的|地|得)(?=[的了呢吧啊吗])/g, '')
    .replace(/(?:然后|接着|之后|最后)、?/g, '')
    .replace(/(?:并且|同时|而且)、?/g, ',')
    .replace(/,+/g, ',')
    .replace(/^,|,$/g, '')
    .trim();

  if (compressed.length <= maxLen) return compressed;

  // Step 2: 如果包含逗号/分号分隔的多个动作，只保留第一个核心动作
  const clauses = compressed.split(/[,;，；]/);
  if (clauses.length > 1) {
    const first = clauses[0].trim();
    if (first.length <= maxLen) return first;
    compressed = first;
  }

  if (compressed.length <= maxLen) return compressed;

  // Step 3: 首尾保留，中间用…连接
  const headLen = Math.ceil(maxLen * 0.6) - 1;
  const tailLen = Math.floor(maxLen * 0.4) - 1;
  return compressed.slice(0, headLen) + '…' + compressed.slice(-tailLen);
}

/**
 * 从工具参数中综合推导 purpose
 *
 * 当模型未提供 purpose 字段时，根据工具类型和参数内容自动推导意图摘要。
 * 策略：按优先级收集各字段的摘要片段，拼接为"动作+目标"格式。
 *
 * 推导优先级（从高到低）：
 *   1. 路径类参数 → 提取人类可读的短路径（如 "src/index.ts"）
 *   2. 命令类参数 → 提取命令主体及首个参数（如 "npm install"）
 *   3. 内容类参数 → 截取前 7 字加省略号（如 "修复登录…"）
 *   4. 动作类参数 → 直接取值（如 "create"）
 *   5. cron 表达式 → 直接取值（如 "0 9 * * *"）
 *
 * 每个优先级只取第一个匹配的字段，避免信息冗余。
 * 最终拼接结果若超出 maxLen，则通过 compressPurpose 压缩。
 *
 * @param toolName - 工具名称
 * @param params   - 工具调用参数
 * @param maxLen   - 最大字符长度
 * @returns 推导出的 purpose 字符串
 */
function inferPurposeFromAllParams(toolName: string, params: Record<string, unknown>, maxLen: number): string {
  // 工具名 → 中文动作词的映射表
  const actionMap: Record<string, string> = {
    read: '读',
    write: '写',
    edit: '改',
    exec: '执行',
    process: '处理',
    agents_list: '列出智能体',
    nodes: '查看节点',
    canvas: '操作画布',
    tts: '语音合成',
    cron: '定时任务',
  };
  const action = actionMap[toolName] || toolName;

  // 对固定用途工具（如 agents_list）直接返回动作词，无需推导目标
  if (['agents_list'].includes(toolName)) return action;

  // 按优先级收集各字段的摘要片段
  const snippets: string[] = [];

  // 1. 路径类参数 → 提取文件/目录名
  const pathKeys = ['path', 'file_path', 'filePath', 'url', 'directory', 'dest', 'destination'];
  for (const key of pathKeys) {
    const val = typeof params[key] === 'string' ? (params[key] as string).trim() : '';
    if (val) {
      snippets.push(humanizePath(val, maxLen));
      break; // 只取第一个匹配的路径参数
    }
  }

  // 2. 命令类参数 → 提取命令主体
  const cmdKeys = ['command', 'cmd', 'script'];
  for (const key of cmdKeys) {
    const val = typeof params[key] === 'string' ? (params[key] as string).trim() : '';
    if (val) {
      const parts = val.split(/\s+/);
      // 提取命令基础名（去除路径前缀，如 /usr/bin/npm → npm）
      const cmdBase = parts[0].split(/[\\/]/).pop() || parts[0];
      if (parts.length > 1) {
        // 带首个参数，如 "npm install"，但限制总长度不超过 15 字符
        const withArg = cmdBase + ' ' + parts[1];
        snippets.push(withArg.length <= 15 ? withArg : cmdBase);
      } else {
        snippets.push(cmdBase);
      }
      break; // 只取第一个匹配的命令参数
    }
  }

  // 3. 内容/查询类参数 → 取前几个字
  const contentKeys = ['query', 'text', 'content', 'message', 'prompt', 'description', 'old_string', 'new_string', 'value'];
  for (const key of contentKeys) {
    const val = typeof params[key] === 'string' ? (params[key] as string).trim() : '';
    if (val) {
      // 超过 8 字符时截取前 7 字加省略号
      const snippet = val.length > 8 ? val.slice(0, 7) + '…' : val;
      snippets.push(snippet);
      break; // 只取第一个匹配的内容参数
    }
  }

  // 4. 动作/类型类参数
  const actionKeys = ['action', 'type', 'method', 'mode'];
  for (const key of actionKeys) {
    const val = typeof params[key] === 'string' ? (params[key] as string).trim() : '';
    if (val) {
      snippets.push(val);
      break; // 只取第一个匹配的动作参数
    }
  }

  // 5. cron 表达式（特殊处理，不归入动作类参数）
  if (typeof params.cron === 'string' && (params.cron as string).trim()) {
    snippets.push((params.cron as string).trim());
  }

  // 拼接：若未收集到任何摘要片段，仅返回动作词
  if (snippets.length === 0) return action;

  // 拼接为"动作+目标"格式，如 "读 src/index.ts"、"执行 npm install"
  const target = snippets.join(' ');
  const raw = `${action}${target}`;

  // 压缩至最大长度
  return compressPurpose(raw, maxLen);
}

// ─── 意图提取（两层逻辑） ─────────────────────────────────────────────────────

/**
 * 从工具参数中提取 purpose
 *
 * 采用两层逻辑，优先保证语义完整性，宁可超字数也不压缩至语义模糊：
 *
 *   第 1 层：模型显式声明意图
 *     若模型在调用参数中提供了 params.purpose 字段，则直接沿用，不做任何压缩。
 *     这保证了模型自主声明的意图不会被截断或失真。
 *
 *   第 2 层：从参数推导意图
 *     若未提供 purpose 字段，则综合工具参数按优先级推导，
 *     拼接为"动作+目标"格式，并通过 compressPurpose 压缩至最大长度。
 *
 * @param toolName - 工具名称
 * @param params   - 工具调用参数
 * @param maxLen   - 最大字符长度（仅影响第 2 层推导结果的压缩）
 * @returns 提取的 purpose 字符串
 */
function extractPurposeFromParams(toolName: string, params: Record<string, unknown>, maxLen: number): string {
  const modelPurpose = typeof params.purpose === 'string' ? (params.purpose as string).trim() : '';

  // 第1层：模型提供了 purpose，直接沿用，保证语义完整
  if (modelPurpose) {
    return modelPurpose;
  }

  // 第2层：无 purpose 参数，综合所有 params 推导
  return inferPurposeFromAllParams(toolName, params, maxLen);
}

// ─── 插件入口 ─────────────────────────────────────────────────────────────────

/**
 * 插件注册入口函数
 *
 * 由 OpenClaw 框架在加载插件时调用，传入 api 对象。
 * 注册 before_tool_call 和 after_tool_call 两个钩子，
 * 实现工具调用的意图拦截与注入。
 *
 * 注册流程：
 *   1. 规范化插件配置（normalizeConfig）
 *   2. 检查 api.on() 是否可用（Hook 机制是否支持）
 *   3. 注册 before_tool_call 钩子：拦截目标工具调用，提取 purpose
 *   4. 注册 after_tool_call 钩子：将 purpose 注入到结果的 channelData
 *
 * @param api - OpenClaw 插件 API 对象
 *   - pluginConfig: 插件配置（来自 openclaw.plugin.json 中的 configSchema）
 *   - logger: 日志实例
 *   - registerTool: 工具注册函数（V2 未使用，仅 V1 使用）
 *   - registerHook: Hook 注册函数（V2 未使用，使用 api.on() 替代）
 */
export default function register(api: {
  pluginConfig?: unknown;
  logger?: PluginLogger;
  registerTool: (tool: unknown) => void;
  registerHook?: (name: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
}) {
  // 规范化插件配置，确保所有配置项在合法范围内
  const config = normalizeConfig(api.pluginConfig);
  // 将目标工具列表转为 Set，提升查找性能（O(1) vs O(n)）
  const targetToolSet = new Set(config.targetTools);
  const maxLen = config.maxPurposeLength;

  const log = api.logger;

  // ── 检查 Hook 机制是否可用 ──
  // api.on() 是 OpenClaw 框架提供的 Hook 注册方法，
  // 若当前运行环境不支持 Hook 机制，则插件无法工作，记录警告后直接返回
  const apiAny = api as Record<string, unknown>;
  if (typeof apiAny.on !== 'function') {
    if (log?.warn) log.warn('[ExtractPurpose] api.on is not available — hook mechanism not supported, plugin will be inactive.');
    return;
  }

  // 将 api.on() 转为类型安全的函数引用
  const on = apiAny.on as <T = unknown>(
    hookName: string,
    handler: (event: T, ctx: PluginHookContext) => Promise<void> | void,
    options?: { priority?: number },
  ) => void;

  // ─── before_tool_call: 拦截工具调用并提取 purpose ────────────────────────

  /**
   * before_tool_call 钩子处理器
   *
   * 在工具正式执行前触发。若工具名匹配目标列表，则从参数中提取 purpose，
   * 并以 runId 为键暂存于 pendingPurposes Map，等待 after_tool_call 取出。
   *
   * 处理流程：
   *   1. 校验事件对象有效性
   *   2. 检查工具名是否在目标列表中
   *   3. 提取工具参数
   *   4. 调用 extractPurposeFromParams 提取 purpose
   *   5. 以 runId 为键存入 pendingPurposes Map
   *
   * 注意：此钩子不阻断工具执行，不修改工具参数，仅做旁路观察和提取
   */
  on<BeforeToolCallEvent>('before_tool_call', (event, hookCtx) => {
    // 校验事件对象
    if (!event || typeof event !== 'object') return;

    const toolName = event.toolName;
    // 非目标工具，跳过处理
    if (!toolName || !targetToolSet.has(toolName)) return;

    // 安全提取参数对象
    const params = event.params && typeof event.params === 'object' ? event.params as Record<string, unknown> : {};

    // [DEBUG] 打印完整 params，确认网关传递的参数结构
    // 使用 warn 级别确保在日志中可见，生产环境可移除
    if (log?.warn) log.warn(`[ExtractPurpose] DEBUG before_tool_call: tool=${toolName} params=${JSON.stringify(params)} runId=${hookCtx.runId || ''}`);

    // 提取 purpose（两层逻辑：优先取模型提供的，否则从参数推导）
    const purpose = extractPurposeFromParams(toolName, params, maxLen);

    // 以 runId 为键暂存 purpose，供 after_tool_call 取用
    const runId = hookCtx.runId || '';
    if (runId) {
      pendingPurposes.set(runId, { toolName, purpose, runId });
    }

    if (log?.info) log.info(`[ExtractPurpose] before_tool_call: tool=${toolName} purpose="${purpose}" runId=${runId}`);
  });

  // ─── after_tool_call: 将 purpose 注入 channelData ─────────────────────────

  /**
   * after_tool_call 钩子处理器
   *
   * 在工具执行完毕后触发。从 pendingPurposes Map 中取出 purpose，
   * 注入到工具执行结果的 channelData 中，供前端读取并渲染意图徽章。
   *
   * 处理流程：
   *   1. 校验事件对象和 runId
   *   2. 从 pendingPurposes Map 中取出 purpose 记录
   *   3. 删除 Map 中的条目（避免内存泄漏）
   *   4. 将 purpose 和 purposeToolName 注入 result.channelData
   *
   * 注意：
   *   - result 对象在 hook 生命周期中是可变的，可以直接修改其 channelData
   *   - 注入时保留已有的 channelData 字段，仅追加 purpose 相关字段
   *   - 若 result 不存在或非对象，则跳过注入（工具可能执行失败未返回结果）
   */
  on<AfterToolCallEvent>('after_tool_call', (event, hookCtx) => {
    // 校验事件对象
    if (!event || typeof event !== 'object') return;

    // 必须有 runId 才能关联 before_tool_call 中的 purpose
    const runId = hookCtx.runId || '';
    if (!runId) return;

    // 从 Map 中取出 purpose 记录
    const pending = pendingPurposes.get(runId);
    if (!pending) return;

    // 清理 Map 条目，避免内存泄漏
    pendingPurposes.delete(runId);

    // 将 purpose 注入到结果的 channelData 中
    // result 对象在 after_tool_call 阶段是可变的，可以安全修改
    if (event.result && typeof event.result === 'object') {
      const result = event.result as Record<string, unknown>;
      // 保留已有的 channelData 字段，仅追加 purpose 相关信息
      const existingChannelData = isRecord(result.channelData) ? result.channelData as Record<string, unknown> : {};
      result.channelData = {
        ...existingChannelData,
        purpose: pending.purpose,           // 意图摘要，前端渲染为徽章文本
        purposeToolName: pending.toolName,  // 工具名称，前端可据此区分不同工具的意图
      };
      if (log?.info) log.info(`[ExtractPurpose] after_tool_call: injected purpose="${pending.purpose}" into channelData for tool=${pending.toolName}`);
    }
  });

  // 插件激活完成，记录配置信息
  if (log?.info) log.info(`[ExtractPurpose] Plugin activated. targetTools=[${config.targetTools.join(',')}] maxPurposeLength=${maxLen}`);
}
