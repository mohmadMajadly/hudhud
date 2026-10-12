// Frame fixtures for the event normalizer. Each one is built from a frame
// quoted or described in research 05 / 07; the label says which, and where a
// field is reconstructed from the Messages API shape rather than quoted. No
// recorded CLI output is used here (recorded fixtures land with W6).

import type { JsonObject } from '../../../../core/src/protocol/json.js';

export interface FrameFixture {
  readonly name: string;
  /** Where the shape comes from. */
  readonly provenance: string;
  readonly frame: JsonObject;
}

const SESSION = 'd6e7fffb-0000-4000-8000-000000000001';

export const FRAMES = {
  init: {
    name: 'system/init',
    provenance: '05 §5 "system/init" (trimmed; ids replaced)',
    frame: {
      type: 'system',
      subtype: 'init',
      session_id: SESSION,
      model: 'claude-opus-5-5',
      permissionMode: 'auto',
      apiKeySource: 'ANTHROPIC_API_KEY',
      claude_code_version: '2.1.296',
      capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1', 'ui_surface_v1'],
      uuid: 'u-init',
    },
  },
  apiRetry: {
    name: 'system/api_retry',
    provenance: '05 §9 row 58 (401, default retries)',
    frame: {
      type: 'system',
      subtype: 'api_retry',
      session_id: SESSION,
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 600,
      error_status: 401,
      error: 'authentication_failed',
    },
  },
  apiRetryNullStatus: {
    name: 'system/api_retry with null status',
    provenance: 'wire/types.ts ApiRetryFrame (error_status may be null)',
    frame: { type: 'system', subtype: 'api_retry', attempt: 2, error_status: null },
  },
  sessionState: {
    name: 'system/session_state_changed',
    provenance: '05 §12 (CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1)',
    frame: { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SESSION },
  },
  permissionDenied: {
    name: 'system/permission_denied',
    provenance: '05 §6 (quoted, message shortened)',
    frame: {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_mock_0007',
      message: 'touch in marker.txt needs approval.',
      decision_reason_type: 'rule',
      uuid: 'u-denied',
      session_id: SESSION,
    },
  },
  backgroundTasks: {
    name: 'system/background_tasks_changed',
    provenance: '05 §5 "Initialize x3" (quoted)',
    frame: { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  },
  taskStarted: {
    name: 'system/task_started',
    provenance: '05 §8 row 41',
    frame: {
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_bash',
      is_backgrounded: false,
    },
  },
  taskNotification: {
    name: 'system/task_notification',
    provenance: '05 §8 row 41',
    frame: { type: 'system', subtype: 'task_notification', status: 'completed' },
  },
  hookStarted: {
    name: 'system/hook_started',
    provenance: '07 hook spike (subtype named)',
    frame: { type: 'system', subtype: 'hook_started' },
  },
  hookResponse: {
    name: 'system/hook_response',
    provenance: '07 hook spike {outcome, exit_code}',
    frame: { type: 'system', subtype: 'hook_response', outcome: 'cancelled', exit_code: 1 },
  },
  assistantText: {
    name: 'assistant text',
    provenance: '05 §3 mock "echo" scenario shape (Messages API message)',
    frame: {
      type: 'assistant',
      session_id: SESSION,
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hm' },
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      },
    },
  },
  assistantStringContent: {
    name: 'assistant string content',
    provenance: 'Messages API allows a string content',
    frame: { type: 'assistant', message: { role: 'assistant', content: 'plain' } },
  },
  assistantToolUse: {
    name: 'assistant tool_use',
    provenance: '05 §6 Bash tool call (toolu_mock_0002; input reconstructed)',
    frame: {
      type: 'assistant',
      session_id: SESSION,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running' },
          { type: 'tool_use', id: 'toolu_mock_0002', name: 'Bash', input: { command: 'echo hi' } },
          { type: 'tool_use', id: 'toolu_mock_0003', name: 'mcp__srv__lookup', input: null },
          { type: 'tool_use', id: 'toolu_mock_0004', name: 'Read' },
        ],
      },
    },
  },
  assistantAborted: {
    name: 'assistant aborted',
    provenance: '05 §7 interrupt mid-stream (aborted:true, partial text)',
    frame: {
      type: 'assistant',
      aborted: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'chunk0 chunk1 chunk2 chu' }] },
    },
  },
  assistantAuthError: {
    name: 'assistant synthetic auth error',
    provenance: '05 §9 row 57',
    frame: {
      type: 'assistant',
      error: 'authentication_failed',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 mock 401' }],
      },
    },
  },
  userToolResultOk: {
    name: 'user tool_result',
    provenance: '05 §6 allow row (tool_result "hi")',
    frame: {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_mock_0002', content: 'hi' }],
      },
    },
  },
  userToolResultDenied: {
    name: 'user tool_result is_error',
    provenance: '05 §6 deny row {content, is_error:true}',
    frame: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_mock_0003',
            content: 'host says no',
            is_error: true,
          },
          { type: 'tool_result', content: 'no id' },
          { type: 'text', text: 'ignored sibling' },
        ],
      },
    },
  },
  userInterrupt: {
    name: 'user interrupt text',
    provenance: '05 §7 line "user [{type:text,text:[Request interrupted by user]}]"',
    frame: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    },
  },
  userStringContent: {
    name: 'user string content',
    provenance: '05 §5 "content may be a plain string"',
    frame: { type: 'user', message: { role: 'user', content: 'hello' } },
  },
  deltaText: {
    name: 'stream_event text_delta',
    provenance: '05 §3 SSE names (content_block_delta); delta shape from the Messages API',
    frame: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'chunk0 ' },
      },
    },
  },
  deltaThinking: {
    name: 'stream_event thinking_delta',
    provenance: 'Messages API streaming',
    frame: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'hm' },
      },
    },
  },
  deltaJson: {
    name: 'stream_event input_json_delta',
    provenance: '05 §3 (input_json_delta named)',
    frame: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"command":' },
      },
    },
  },
  deltaSignature: {
    name: 'stream_event signature_delta',
    provenance: 'Messages API streaming (kind not carried by hudhud)',
    frame: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
    },
  },
  messageStart: {
    name: 'stream_event message_start',
    provenance: '05 §3 SSE names',
    frame: {
      type: 'stream_event',
      event: { type: 'message_start', message: { role: 'assistant' } },
    },
  },
  messageStop: {
    name: 'stream_event message_stop',
    provenance: '05 §7 synthetic closers',
    frame: { type: 'stream_event', event: { type: 'message_stop' } },
  },
  resultSuccess: {
    name: 'result/success',
    provenance: '05 §9 normal row; usage field names from the Messages API',
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      terminal_reason: 'completed',
      session_id: SESSION,
      num_turns: 1,
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'toolu_mock_0003', tool_input: { command: 'touch x' } },
        { tool_name: 'Bash' },
        'junk',
      ],
    },
  },
  resultMaxTurns: {
    name: 'result/error_max_turns',
    provenance: '05 §9 row 46',
    frame: {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      terminal_reason: 'max_turns',
      errors: ['Reached maximum number of turns (1)', 7],
      num_turns: 2,
    },
  },
  resultAuth: {
    name: 'result/success is_error 401',
    provenance: '05 §9 row 57',
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      terminal_reason: 'api_error',
      result: 'Failed to authenticate. API Error: 401 mock 401',
    },
  },
  resultAbortedStreaming: {
    name: 'result/error_during_execution aborted_streaming',
    provenance: '05 §7 (no result key, errors diagnostic)',
    frame: {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    },
  },
  resultBudget: {
    name: 'result/error_max_budget_usd',
    provenance: 'Python SDK result subtype (MIT); not observed in 05',
    frame: {
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      stop_reason: 'max_tokens',
    },
  },
  resultNotFound: {
    name: 'result before control_response (resume not found)',
    provenance: '07 a11 (quoted)',
    frame: {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 0,
      session_id: 'cccccccc-0000-4000-8000-000000000003',
      errors: ['No conversation found with session ID: cccccccc-0000-4000-8000-000000000003'],
    },
  },
  resultBare: {
    name: 'result with no fields',
    provenance: 'defensive: every typed result field is optional (wire/types.ts)',
    frame: { type: 'result' },
  },
  resultOther: {
    name: 'result with an unknown subtype',
    provenance: 'defensive',
    frame: { type: 'result', subtype: 'something_new', terminal_reason: 'novel' },
  },
  commandLifecycle: {
    name: 'command_lifecycle',
    provenance: '05 §5 (quoted)',
    frame: { type: 'command_lifecycle', command_uuid: 'abc', state: 'queued' },
  },
  canUseTool: {
    name: 'control_request can_use_tool',
    provenance: '05 §6 (quoted, suggestions shortened)',
    frame: {
      type: 'control_request',
      request_id: '96faf3d7-4d77-4311-839f-a6ddaaec5323',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        display_name: 'Bash',
        input: { command: 'touch marker.txt' },
        permission_suggestions: [{ type: 'addRules', destination: 'localSettings' }],
        tool_use_id: 'toolu_mock_0002',
      },
    },
  },
  hookCallback: {
    name: 'control_request hook_callback',
    provenance: '07 hook spike',
    frame: {
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'hook_callback', callback_id: 'hk1' },
    },
  },
  controlResponse: {
    name: 'control_response init success',
    provenance: '05 §5 (trimmed)',
    frame: {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'init_1', response: { pid: 37148 } },
    },
  },
  controlCancel: {
    name: 'control_cancel_request',
    provenance: '05 §6 never-answered row',
    frame: { type: 'control_cancel_request', request_id: '548e5f58' },
  },
  keepAlive: {
    name: 'keep_alive',
    provenance: 'wire/types.ts KeepAliveFrame',
    frame: { type: 'keep_alive' },
  },
  rateLimit: {
    name: 'unknown top-level type',
    provenance: 'defensive: a future frame type',
    frame: { type: 'rate_limit_event', info: { status: 'allowed' } },
  },
} satisfies Record<string, FrameFixture>;
