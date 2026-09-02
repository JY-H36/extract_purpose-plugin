/**
 * ============================================================================
 * Extract Purpose V1 Plugin — 代理工具方案
 * ============================================================================
 *
 * 【方案概述】
 * 为指定工具注入必填的 purpose 参数，并在代理工具内转发调用原始工具。
 * 模型调用 EP-Read-v1 等代理工具时必须填写 purpose，
 * 插件提取 purpose 生成 task_card，同时执行原始操作返回真正的内容。
 *
 * 【工作原理】
 *   1. 通过 registerTool 注册代理工具（EP-Read-v1 / EP-Write-v1 / ...）
 *   2. 每个代理工具的 parameters 中包含必填的 purpose 字段
 *   3. execute 时：提取 purpose → 生成 task_card → 转发调用原始工具 → 返回内容
 *
 * 【核心机制】
 *   - 代理工具通过 TOOL_MAPPINGS 声明式数组统一描述
 *   - 每个代理工具的 parameters 定义中强制包含 purpose（required: ['purpose']）
 *   - 模型在调用代理工具时，必须提供 purpose 参数，否则返回错误提示
 *   - 插件从参数中剔除 purpose 后，调用 executeOriginal 执行原始操作
 *   - 最终返回原始内容 + channelData（task_card）+ details
 *
 * 【方案缺陷】
 *   - LLM 可能直接调用原生工具名（如 read），跳过代理工具，导致 purpose 提取被绕过
 *   - 每个代理工具需要自行实现原生操作逻辑（executeOriginal），
 *     与平台原生工具的行为可能存在差异
 *   - 该方案已在 V2 中被 Hook 拦截方案替代
 */

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 通用 JSON 对象类型，用于工具参数的 JSON Schema 定义 */
type JsonObject = Record<string, unknown>;

/** 插件配置：maxPurposeLength（意图最大长度，范围 10-100，默认 20） */
type PluginConfig = {
  maxPurposeLength: number;
};

/**
 * 插件日志接口
 * warn/info 均为可选方法，插件内部通过可选链（?.）安全调用。
 * 日志实例由 OpenClaw 框架在注册插件时通过 api.logger 注入。
 */
type PluginLogger = {
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
};

// ─── 代理工具映射表 ───────────────────────────────────────────────────────────

/**
 * 代理工具映射表（V1 核心数据结构）
 *
 * 声明式设计，每个条目描述一个原生工具到代理工具的映射关系。
 * purpose 字段由注册逻辑自动注入为必填参数，无需在此声明。
 * executeOriginal 接收已剔除 purpose 的原始参数，确保与原生工具接口一致。
 * 对于需与网关交互的工具（如 agents_list），executeOriginal 仅返回占位文本。
 */
const TOOL_MAPPINGS: Array<{
  /** 原生工具名，如 'read'、'write'、'exec' */
  originalName: string;
  /** 代理工具名，统一 'EP-' 前缀 + '-v1' 后缀，如 'EP-Read-v1' */
  proxyName: string;
  /** 中文标签，用于前端展示 */
  label: string;
  /** 工具描述，提示 LLM 必须填写 purpose 参数 */
  description: string;
  /** 原生工具的参数定义（JSON Schema 格式） */
  paramFields: Record<string, JsonObject>;
  /** 执行原始操作的异步函数，接收已剔除 purpose 的参数 */
  executeOriginal: (
    params: Record<string, unknown>,
    logger?: PluginLogger,
  ) => Promise<{ content: Array<Record<string, unknown>>; details?: unknown }>;
}> = [

  // ─── 文件读取 ─────────────────────────────────────────────────────────────
  // 使用 node:fs/promises 的 readFile 异步读取文件，超 8000 字截断
  // 注意：与平台原生 read 工具可能存在差异（如编码检测、行号显示等）

  {
    originalName: 'read',
    proxyName: 'EP-Read-v1',
    label: '读取（含意图）',
    description: '读取文件内容。调用时必须填写 purpose 参数，简述本次读取意图（≤20字）。',
    paramFields: {
      file_path: { type: 'string', description: '要读取的文件路径' },
    },
    async executeOriginal(params, logger) {
      const filePath = typeof params.file_path === 'string' ? params.file_path : '';
      if (!filePath) return { content: [{ type: 'text', text: 'Error: file_path is required' }] };
      try {
        const fs = await import('node:fs/promises');
        const text = await fs.readFile(filePath, 'utf8');
        // 截断超长内容，防止返回过大文本影响性能
        const maxLen = 8000;
        const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n...(truncated)' : text;
        return { content: [{ type: 'text', text: truncated }] };
      } catch (err: unknown) {
        // 捕获异常并返回错误信息，不抛出，保证代理工具不会因 I/O 错误而中断
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`[ExtractPurposeV1] read failed: ${msg}`);
        return { content: [{ type: 'text', text: `Error reading file: ${msg}` }] };
      }
    },
  },

  // ─── 文件写入 ─────────────────────────────────────────────────────────────
  // 使用 node:fs/promises 的 writeFile 异步写入，自动创建父目录
  // 注意：始终以 UTF-8 编码写入，与平台原生 write 工具的编码处理可能不同

  {
    originalName: 'write',
    proxyName: 'EP-Write-v1',
    label: '写入（含意图）',
    description: '写入文件内容。调用时必须填写 purpose 参数，简述本次写入意图（≤20字）。',
    paramFields: {
      file_path: { type: 'string', description: '要写入的文件路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    async executeOriginal(params, logger) {
      const filePath = typeof params.file_path === 'string' ? params.file_path : '';
      const content = typeof params.content === 'string' ? params.content : '';
      if (!filePath) return { content: [{ type: 'text', text: 'Error: file_path is required' }] };
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        // 自动创建父目录（recursive: true），避免因目录不存在导致写入失败
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        return { content: [{ type: 'text', text: `Successfully wrote to ${filePath}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`[ExtractPurposeV1] write failed: ${msg}`);
        return { content: [{ type: 'text', text: `Error writing file: ${msg}` }] };
      }
    },
  },

  // ─── 文件编辑 ─────────────────────────────────────────────────────────────
  // 读取全文 → indexOf 查找 → 替换首个匹配 → 写回
  // 注意：仅替换第一个匹配项，不支持全局替换（原生工具可能支持 replace_all）

  {
    originalName: 'edit',
    proxyName: 'EP-Edit-v1',
    label: '编辑（含意图）',
    description: '编辑文件内容。调用时必须填写 purpose 参数，简述本次编辑意图（≤20字）。',
    paramFields: {
      file_path: { type: 'string', description: '要编辑的文件路径' },
      old_string: { type: 'string', description: '要替换的原始文本' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    async executeOriginal(params, logger) {
      const filePath = typeof params.file_path === 'string' ? params.file_path : '';
      const oldStr = typeof params.old_string === 'string' ? params.old_string : '';
      const newStr = typeof params.new_string === 'string' ? params.new_string : '';
      if (!filePath) return { content: [{ type: 'text', text: 'Error: file_path is required' }] };
      try {
        const fs = await import('node:fs/promises');
        let text = await fs.readFile(filePath, 'utf8');
        // 查找 old_string 首次出现的位置
        const idx = text.indexOf(oldStr);
        if (idx === -1) return { content: [{ type: 'text', text: `Error: old_string not found in ${filePath}` }] };
        // 仅替换第一个匹配项
        text = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
        await fs.writeFile(filePath, text, 'utf8');
        return { content: [{ type: 'text', text: `Successfully edited ${filePath}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`[ExtractPurposeV1] edit failed: ${msg}`);
        return { content: [{ type: 'text', text: `Error editing file: ${msg}` }] };
      }
    },
  },

  // ─── 命令执行 ─────────────────────────────────────────────────────────────
  // 使用 node:child_process.exec，30 秒超时，1MB 缓冲区上限，超 8000 字截断
  // 注意：原生工具可能使用 spawn 替代 exec，支持流式输出和更多参数

  {
    originalName: 'exec',
    proxyName: 'EP-Exec-v1',
    label: '执行命令（含意图）',
    description: '执行命令。调用时必须填写 purpose 参数，简述本次执行意图（≤20字）。',
    paramFields: {
      command: { type: 'string', description: '要执行的命令' },
    },
    async executeOriginal(params, logger) {
      const command = typeof params.command === 'string' ? params.command : '';
      if (!command) return { content: [{ type: 'text', text: 'Error: command is required' }] };
      try {
        const { exec } = await import('node:child_process');
        const output = await new Promise<string>((resolve, reject) => {
          exec(command, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve(stdout + (stderr ? '\n' + stderr : ''));
          });
        });
        const maxLen = 8000;
        const truncated = output.length > maxLen ? output.slice(0, maxLen) + '\n...(truncated)' : output;
        // 无输出时返回占位提示
        return { content: [{ type: 'text', text: truncated || '(no output)' }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`[ExtractPurposeV1] exec failed: ${msg}`);
        return { content: [{ type: 'text', text: `Error executing command: ${msg}` }] };
      }
    },
  },

  // ─── 以下工具均为占位实现，实际操作由网关 Gateway 转发 ──────────────────────
  // 这些工具的 executeOriginal 仅返回操作类型描述文本，
  // 真正的业务逻辑由平台原生工具在 Gateway 层处理。

  {
    originalName: 'process',
    proxyName: 'EP-Process-v1',
    label: '进程操作（含意图）',
    description: '进程管理操作。调用时必须填写 purpose 参数，简述本次操作意图（≤20字）。',
    paramFields: {
      action: { type: 'string', description: '进程操作类型' },
    },
    async executeOriginal(params) {
      return { content: [{ type: 'text', text: `process action: ${params.action ?? '(none)'}` }] };
    },
  },
  {
    originalName: 'agents_list',
    proxyName: 'EP-AgentsList-v1',
    label: '代理列表（含意图）',
    description: '列出代理。调用时必须填写 purpose 参数，简述本次查询意图（≤20字）。',
    paramFields: {},
    async executeOriginal() {
      // 该工具无额外参数，标注 "forwarded via gateway" 表明由网关转发执行
      return { content: [{ type: 'text', text: '(agents_list: forwarded via gateway)' }] };
    },
  },
  {
    originalName: 'nodes',
    proxyName: 'EP-Nodes-v1',
    label: '节点操作（含意图）',
    description: '节点操作。调用时必须填写 purpose 参数，简述本次操作意图（≤20字）。',
    paramFields: {
      action: { type: 'string', description: '节点操作类型' },
    },
    async executeOriginal(params) {
      return { content: [{ type: 'text', text: `nodes action: ${params.action ?? '(none)'}` }] };
    },
  },
  {
    originalName: 'canvas',
    proxyName: 'EP-Canvas-v1',
    label: '画布操作（含意图）',
    description: '画布操作。调用时必须填写 purpose 参数，简述本次操作意图（≤20字）。',
    paramFields: {
      action: { type: 'string', description: '画布操作类型' },
    },
    async executeOriginal(params) {
      return { content: [{ type: 'text', text: `canvas action: ${params.action ?? '(none)'}` }] };
    },
  },
  {
    originalName: 'tts',
    proxyName: 'EP-TTS-v1',
    label: '语音合成（含意图）',
    description: '语音合成。调用时必须填写 purpose 参数，简述本次合成意图（≤20字）。',
    paramFields: {
      text: { type: 'string', description: '要合成的文本' },
    },
    async executeOriginal(params) {
      return { content: [{ type: 'text', text: `tts: ${params.text ?? '(none)'}` }] };
    },
  },
  {
    originalName: 'cron',
    proxyName: 'EP-Cron-v1',
    label: '定时任务（含意图）',
    description: '定时任务管理。调用时必须填写 purpose 参数，简述本次操作意图（≤20字）。',
    paramFields: {
      action: { type: 'string', description: 'cron 操作类型（create/delete/list）' },
    },
    async executeOriginal(params) {
      return { content: [{ type: 'text', text: `cron action: ${params.action ?? '(none)'}` }] };
    },
  },
];

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 类型守卫：判断值是否为普通对象（Record）
 * 排除 null 和数组，确保值可以安全地作为 Record<string, unknown> 使用。
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
 * maxPurposeLength 处理逻辑：
 *   - 必须是有限数字，否则使用默认值 20
 *   - 小于 10 的值提升至 10（过短会导致 purpose 无法表达完整语义）
 *   - 大于 100 的值降低至 100（过长会导致前端展示溢出）
 *
 * @param raw - 原始配置对象（来自 api.pluginConfig，类型未知）
 * @returns 规范化后的插件配置
 */
function normalizeConfig(raw: unknown): PluginConfig {
  const cfg = isRecord(raw) ? raw : {};
  const maxPurposeLength =
    typeof cfg.maxPurposeLength === 'number' && Number.isFinite(cfg.maxPurposeLength)
      ? Math.min(Math.max(10, Math.floor(cfg.maxPurposeLength)), 100)
      : 20;
  return { maxPurposeLength };
}

/**
 * 截断文本至指定最大长度
 * 超长时保留前 maxLen-1 个字符并在末尾追加 '…'（省略号占 1 个字符位）
 *
 * 示例：truncate('读取配置文件中的数据库连接信息', 10) → '读取配置文件中的数据库连…'
 *
 * @param text   - 待截断的文本
 * @param maxLen - 最大字符长度
 * @returns 截断后的文本（可能带省略号）
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

// ─── 插件入口 ─────────────────────────────────────────────────────────────────

/**
 * 插件注册入口函数
 *
 * 由 OpenClaw 框架在加载插件时调用，传入 api 对象。
 * 遍历 TOOL_MAPPINGS，为每个映射注册一个代理工具。
 *
 * 注册流程：
 *   1. 规范化插件配置（normalizeConfig）
 *   2. 遍历 TOOL_MAPPINGS 中的每个映射条目
 *   3. 为每个映射构建参数定义：purpose（必填）+ 原生工具参数
 *   4. 调用 api.registerTool() 注册代理工具
 *
 * 代理工具 execute 执行流程：
 *   1. 校验 purpose 参数是否为空 → 空则拒绝并返回错误提示
 *   2. 截断 purpose 至 maxPurposeLength 字符
 *   3. 从参数中剔除 purpose，收集原始工具参数
 *   4. 调用 mapping.executeOriginal() 执行原始操作
 *   5. 返回原始内容 + channelData（task_card）+ details
 *
 * @param api - OpenClaw 插件 API 对象
 *   - pluginConfig: 插件配置（来自 openclaw.plugin.json 中的 configSchema）
 *   - logger: 日志实例
 *   - registerTool: 工具注册函数
 */
export default function register(api: {
  pluginConfig?: unknown;
  logger?: PluginLogger;
  registerTool: (tool: {
    name: string;
    label?: string;
    description: string;
    parameters: JsonObject;
    execute: (id: string, params: Record<string, unknown>) => Promise<{
      content: Array<Record<string, unknown>>;
      channelData?: Record<string, unknown>;
      details?: unknown;
    }>;
  }) => void;
}) {
  const config = normalizeConfig(api.pluginConfig);

  // 遍历映射表，为每个原生工具注册对应的代理工具
  for (const mapping of TOOL_MAPPINGS) {
    /**
     * 构建代理工具的参数定义（JSON Schema properties）
     *
     * 将 purpose 作为第一个参数注入（必填），然后展开原生工具的参数。
     * purpose 的 description 会根据工具类型动态生成，如：
     *   - 读取工具 → "必填。简述本次读取的意图，不超过20字。"
     *   - 写入工具 → "必填。简述本次写入的意图，不超过20字。"
     *
     * 参数顺序：purpose 在前，原生参数在后，便于 LLM 优先填写意图
     */
    const properties: Record<string, JsonObject> = {
      purpose: {
        type: 'string',
        description: `必填。简述本次${mapping.label.replace('（含意图）', '')}的意图，不超过${config.maxPurposeLength}字。`,
      },
      ...mapping.paramFields,
    };

    // 调用 OpenClaw API 注册代理工具
    api.registerTool({
      name: mapping.proxyName,
      label: mapping.label,
      description: mapping.description,
      parameters: {
        type: 'object',
        // 禁止传入未声明的参数，确保 LLM 不会传入额外字段
        additionalProperties: false,
        properties,
        // purpose 为必填参数，确保 LLM 每次调用都提供意图
        required: ['purpose'],
      },

      /**
       * 代理工具的执行函数
       *
       * 当 LLM 调用代理工具（如 EP-Read-v1）时，该函数被触发。
       * 执行流程：校验 purpose → 截断 → 剔除 purpose → 执行原始操作 → 返回结果
       *
       * @param _toolCallId - 工具调用 ID（由框架生成，当前未使用）
       * @param params      - 工具调用参数，包含 purpose 及原生工具参数
       */
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        // Step 1: 提取并校验 purpose 参数
        const purpose = typeof params.purpose === 'string' ? params.purpose.trim() : '';

        // purpose 为空时，拒绝执行并返回错误提示
        // 错误信息中包含工具类型和字数限制，引导 LLM 重新填写
        if (!purpose) {
          const error = `purpose 参数为必填项，请简述本次${mapping.label.replace('（含意图）', '')}的意图（≤${config.maxPurposeLength}字）。`;
          api.logger?.warn?.(`[ExtractPurposeV1] ${mapping.proxyName} rejected empty purpose`);
          return {
            content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }],
            details: { source: mapping.proxyName, error },
          };
        }

        // Step 2: 截断 purpose 至最大长度
        const truncatedPurpose = truncate(purpose, config.maxPurposeLength);
        api.logger?.info?.(`[ExtractPurposeV1] ${mapping.proxyName} purpose: ${truncatedPurpose}`);

        // Step 3: 收集原始工具参数（排除 purpose）
        // purpose 仅用于意图展示，不应传递给原始工具
        const originalParams: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(params)) {
          if (key !== 'purpose') {
            originalParams[key] = value;
          }
        }

        // Step 4: 转发调用原始工具
        const originalResult = await mapping.executeOriginal(originalParams, api.logger);

        // Step 5: 返回原始内容 + task_card channelData + details
        //
        // 返回结构说明：
        //   content      - 原始工具的执行结果（如文件内容、命令输出等）
        //   channelData  - 附加数据，包含 extractPurpose 对象供前端渲染意图卡片
        //   details      - 调试信息，包含来源、意图、原始工具名、原始参数等
        //
        // channelData.extractPurpose 字段说明：
        //   type           - 固定为 'task_card'，前端据此渲染任务卡片
        //   purpose        - 截断后的意图摘要
        //   originalTool   - 原始工具名（如 'read'）
        //   proxyTool      - 代理工具名（如 'EP-Read-v1'）
        //   originalParams - 传递给原始工具的参数
        //   status         - 任务状态，固定为 'completed'
        //   timestamp      - 时间戳（毫秒）
        return {
          content: originalResult.content,
          channelData: {
            extractPurpose: {
              type: 'task_card',
              purpose: truncatedPurpose,
              originalTool: mapping.originalName,
              proxyTool: mapping.proxyName,
              originalParams,
              status: 'completed',
              timestamp: Date.now(),
            },
          },
          details: {
            source: mapping.proxyName,
            purpose: truncatedPurpose,
            originalTool: mapping.originalName,
            originalParams,
            ...originalResult.details,
          },
        };
      },
    });
  }
}
