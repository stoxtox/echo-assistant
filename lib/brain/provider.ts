// Talking to a model, behind one interface (Stage 3, "A3" in ECHO_EXECUTION_PLAN.md). The
// conversation (lib/dispatcher.js) starts a session with a provider and reads its messages; it
// never calls a model library itself. Two providers:
//
//   AgentSdkProvider     the Claude Agent SDK, as Echo has always used it (the default; it works
//                        with a Claude subscription sign-in)
//   MessagesApiProvider  the Messages API directly, with Echo running its own tool loop (needs an
//                        API key; off unless the `messages` flag is on). Faster to first word and
//                        cheaper per turn: the path for quick replies (Stage 8) and, behind the same
//                        interface, for other providers later (Stage 9)
//
// A session is an async stream of messages shaped like the Agent SDK's (system init, stream
// events, assistant and user messages, a result per turn), so the dispatcher reads both the same
// way. Coding workers stay on the Agent SDK: they need its built-in file tools.
import { query, createSdkMcpServer, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** One of Echo's own tools, as made with the Agent SDK's tool(). */
export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: any, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>;
};

/** What a session needs, whichever provider runs it. */
export type SessionRequest = {
  /** The user's messages as they come (lib/queue.js InputQueue): { type: 'user', message: { role, content } }. */
  prompt: AsyncIterable<any>;
  /** The system prompt in two parts: the rules (the same every session, so they stay cached), then the context. */
  rules: string;
  context: string;
  model?: string;
  effort?: string;
  /** A saved session to carry on (only the Agent SDK can). */
  resume?: string;
  cwd: string;
  additionalDirectories: string[];
  /** Echo's own tools. */
  tools: ToolDef[];
  /** Built-in tools by Agent SDK name (Read, Glob, Grep, WebSearch). */
  builtinTools: string[];
};

/** A running session: its messages, and the controls the dispatcher uses. */
export interface ModelSession extends AsyncIterable<any> {
  setModel?(model?: string): Promise<unknown>;
  setMaxThinkingTokens?(tokens: number | null): Promise<unknown>;
  interrupt?(): Promise<unknown>;
  close?(): void;
}

export interface Provider {
  readonly name: string;
  start(req: SessionRequest): ModelSession;
}

/* ---------- the Agent SDK (today's behavior) ---------- */

/** Tools the conversation must never have (it hands real work to workers instead). */
export const DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch'];

export class AgentSdkProvider implements Provider {
  readonly name = 'agent-sdk';
  queryFn: (o: { prompt: AsyncIterable<any>; options: Record<string, unknown> }) => ModelSession;

  /** @param o queryFn: the SDK's query(), swappable for tests */
  constructor({ queryFn = query as any }: { queryFn?: AgentSdkProvider['queryFn'] } = {}) {
    this.queryFn = queryFn;
  }

  start(req: SessionRequest): ModelSession {
    return this.queryFn({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        additionalDirectories: req.additionalDirectories,
        model: req.model || undefined,
        effort: req.effort,
        resume: req.resume,
        // Only the built-in tools it uses, and only Echo's own MCP server: no claude.ai
        // connectors (Gmail, Drive…) that the account has. It could never call those (they're
        // not in allowedTools), yet their definitions were about 16K tokens of every call.
        tools: req.builtinTools,
        strictMcpConfig: true,
        settings: { disableClaudeAiConnectors: true },
        // The rules first, so the prompt cache holds them across sessions; then projects and memory.
        systemPrompt: [req.rules, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, req.context],
        includePartialMessages: true,
        // Always in the prompt, so the model never spends a round-trip searching for its own tools.
        mcpServers: { ops: createSdkMcpServer({ name: 'ops', version: '2.0.0', alwaysLoad: true, tools: req.tools as any }) },
        allowedTools: [...req.builtinTools, ...req.tools.map((t) => `mcp__ops__${t.name}`)],
        disallowedTools: DISALLOWED_TOOLS,
        permissionMode: 'dontAsk',
        settingSources: [],
      },
    });
  }
}

/* ---------- the Messages API, with Echo's own tool loop ---------- */

/** Dollars per million tokens, for the per-turn cost (models not listed count as $0 until added). */
export type Prices = Record<string, { input: number; output: number; cacheWrite?: number; cacheRead?: number }>;

/** The few calls the provider makes, so tests can stand in for the API. */
export type MessagesClient = {
  stream(params: Record<string, unknown>, opts: { signal: AbortSignal }): AsyncIterable<any> & { finalMessage(): Promise<any> };
};

const MAX_TOKENS = 4096;
/** A turn never runs more model calls than this (each tool round is one). */
const MAX_ROUNDS = 25;

/** A tool's JSON schema for the API, from its zod shape. */
export function toolSchema(t: ToolDef): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(t.inputSchema)) as Record<string, unknown>;
  return schema;
}

/** A tool's answer (MCP content) as tool_result content for the API. */
export function toolResultContent(content: Awaited<ReturnType<ToolDef['handler']>>['content']): any[] {
  const out: any[] = [];
  for (const c of content || []) {
    if (c.type === 'text') out.push({ type: 'text', text: c.text ?? '' });
    else if (c.type === 'image' && c.data) out.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType || 'image/png', data: c.data } });
  }
  return out.length ? out : [{ type: 'text', text: '(no output)' }];
}

/** Models already reported as having no price. */
const unpriced = new Set<string>();

/** What a turn's usage cost, by the price table. */
export function costOf(model: string, u: any, prices: Prices): number {
  const p = Object.entries(prices).find(([k]) => model.startsWith(k))?.[1];
  if (!p && u && !unpriced.has(model)) {
    unpriced.add(model);
    console.log(`[provider] no price for ${model}: its usage is logged but not counted in costs`);
  }
  if (!p || !u) return 0;
  const m = 1e6;
  return ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output + (u.cache_creation_input_tokens || 0) * (p.cacheWrite ?? p.input * 1.25) + (u.cache_read_input_tokens || 0) * (p.cacheRead ?? p.input * 0.1)) / m;
}

export class MessagesApiProvider implements Provider {
  readonly name = 'messages-api';
  client: MessagesClient | null;
  apiKey: string | undefined;
  prices: Prices;
  defaultModel: string;

  /**
   * @param o client: stands in for the API (tests); otherwise one is made from apiKey
   *   defaultModel: used when the session asks for none
   */
  constructor({ client = null, apiKey = process.env.ANTHROPIC_API_KEY, prices = {}, defaultModel = 'claude-sonnet-5-5' }: { client?: MessagesClient | null; apiKey?: string; prices?: Prices; defaultModel?: string } = {}) {
    this.client = client;
    this.apiKey = apiKey;
    this.prices = prices;
    this.defaultModel = defaultModel;
  }

  async makeClient(): Promise<MessagesClient> {
    if (this.client) return this.client;
    if (!this.apiKey) throw new Error('The Messages API needs an API key (ANTHROPIC_API_KEY in the .env file). Turn the messages flag off to use your Claude sign-in.');
    // Loaded only when this provider is used: it comes with the Agent SDK.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const api = new Anthropic({ apiKey: this.apiKey });
    this.client = { stream: (params, opts) => api.messages.stream(params as any, opts) as any };
    return this.client;
  }

  start(req: SessionRequest): ModelSession {
    const self = this;
    const sessionId = randomUUID();
    let model = req.model || this.defaultModel;
    let thinking: number | null = null;
    let abort: AbortController | null = null;
    let closed = false;
    const history: any[] = [];
    const byName = new Map(req.tools.map((t) => [t.name, t]));
    const tools: any[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: toolSchema(t) }));
    if (req.builtinTools.includes('WebSearch')) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    // The tools and the rules are the same every session: cached.
    if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
    const system = [
      { type: 'text', text: req.rules, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: req.context },
    ];

    async function* turn(client: MessagesClient): AsyncGenerator<any> {
      const started = Date.now();
      let cost = 0;
      const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      let interrupted = false;
      for (let round = 0; round < MAX_ROUNDS && !closed; round++) {
        abort = new AbortController();
        const params: Record<string, unknown> = { model, max_tokens: MAX_TOKENS, system, messages: history, tools };
        if (thinking) params.thinking = { type: 'enabled', budget_tokens: thinking };
        let final: any;
        try {
          const stream = client.stream(params, { signal: abort.signal });
          for await (const event of stream) yield { type: 'stream_event', parent_tool_use_id: null, session_id: sessionId, event };
          final = await stream.finalMessage();
        } catch (e) {
          if (abort.signal.aborted) {
            interrupted = true;
            break;
          }
          throw e;
        }
        for (const k of Object.keys(usage) as Array<keyof typeof usage>) usage[k] += final.usage?.[k] || 0;
        cost += costOf(model, final.usage, self.prices);
        history.push({ role: 'assistant', content: final.content });
        yield { type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: final };
        if (final.stop_reason !== 'tool_use') break;
        const results: any[] = [];
        for (const block of final.content) {
          if (block.type !== 'tool_use') continue;
          const t = byName.get(block.name);
          try {
            if (!t) throw new Error(`No tool named ${block.name}`);
            const out = await t.handler(block.input || {}, {});
            results.push({ type: 'tool_result', tool_use_id: block.id, content: toolResultContent(out.content), ...(out.isError ? { is_error: true } : {}) });
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], is_error: true });
          }
        }
        const user = { role: 'user', content: results };
        history.push(user);
        yield { type: 'user', parent_tool_use_id: null, session_id: sessionId, message: user };
      }
      yield { type: 'result', subtype: 'success', is_error: false, ...(interrupted ? { interrupted: true } : {}), session_id: sessionId, duration_ms: Date.now() - started, total_cost_usd: cost, usage, model };
    }

    const messages = (async function* () {
      if (req.resume) throw new Error('The Messages API session cannot resume a saved session');
      const client = await self.makeClient();
      yield { type: 'system', subtype: 'init', session_id: sessionId, model };
      for await (const m of req.prompt) {
        if (closed) break;
        history.push({ role: 'user', content: m?.message?.content ?? '' });
        yield* turn(client);
      }
    })();

    return Object.assign(messages, {
      async setModel(next?: string) {
        model = next || req.model || self.defaultModel;
      },
      async setMaxThinkingTokens(tokens: number | null) {
        thinking = tokens && tokens >= 1024 ? tokens : null;
      },
      async interrupt() {
        abort?.abort();
      },
      close() {
        closed = true;
        abort?.abort();
      },
    });
  }
}
