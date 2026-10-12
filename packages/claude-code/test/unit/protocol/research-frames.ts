// Inbound frames quoted in the research reports, as test fixtures. Every
// entry names its provenance:
//
// - `observed`: the frame as quoted in 05 or 07 (CLI 2.1.296, pinned), with
//   the report's own trimming ("…" placeholders kept as strings, long lists
//   shortened). Only the routing envelope and the fields hudhud reads matter
//   for these tests.
// - `reconstructed`: the report names the frame type and the quoted fields
//   only (for example "system/task_started {task_type, is_backgrounded}");
//   the envelope is built from that listing and nothing else.
// - `protocol`: part of the control protocol, never observed in a 05/07 run
//   (05 §12: zero keep_alive frames); the envelope is the one 02 §4.1 lists.
//
// Nothing here comes from the proprietary TypeScript SDK (ADR-0015).

import type { JsonObject } from '../../../../core/src/protocol/json.js';

export type Provenance = 'observed' | 'reconstructed' | 'protocol';

export interface ResearchFrame {
  readonly name: string;
  readonly source: string;
  readonly provenance: Provenance;
  readonly frame: JsonObject;
}

const SID = 'd6e7fffb-0000-4000-8000-000000000000';

export const RESEARCH_FRAMES: readonly ResearchFrame[] = [
  // ---- 05 §5 handshake ----------------------------------------------------
  {
    name: 'initialize response',
    source: '05 §5',
    provenance: 'observed',
    frame: {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'init_1',
        pending_permission_requests: [],
        pending_user_dialog_requests: [],
        response: {
          commands: [
            { name: 'deep-research', description: '…', argumentHint: '', builtin: true },
            '…(44)',
          ],
          agents: ['…(5)'],
          output_style: 'default',
          available_output_styles: ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning'],
          user_output_styles_dir: '<run>\\cfg\\output-styles',
          models: [
            {
              value: 'default',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Default (recommended)',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsAdaptiveThinking: true,
              supportsFastMode: true,
              supportsAutoMode: true,
            },
            '…opus, fable, sonnet, haiku',
          ],
          account: {
            tokenSource: 'none',
            apiKeySource: 'ANTHROPIC_API_KEY',
            apiProvider: 'firstParty',
          },
          pid: 37148,
          claude_code_version: '2.1.296',
          current_permission_mode: 'default',
          feedback_mode: { kind: 'disabled' },
          analytics_disabled: true,
          remote_control_auto_enable: false,
          remote_control_auto_connect_default: false,
          remote_control_available: false,
          remote_control_auto_on_by_default: false,
          ide_rc_auto_enable_gate: false,
          fast_mode_state: 'off',
          fast_mode_disabled_reason: 'sdk_opt_in_required',
          session_state: 'idle',
          capabilities: ['ui_surface_v1'],
        },
      },
    },
  },
  {
    name: 'background_tasks_changed after initialize',
    source: '05 §5',
    provenance: 'observed',
    frame: { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  },
  {
    name: 'system/init (Windows)',
    source: '05 §5',
    provenance: 'observed',
    frame: {
      type: 'system',
      subtype: 'init',
      cwd: '<run>\\work',
      session_id: SID,
      tools: ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write'],
      mcp_servers: [],
      model: 'claude-opus-5-5',
      permissionMode: 'auto',
      slash_commands: ['…'],
      terminal_slash_commands: ['doctor', 'color', 'focus', 'reload-plugins'],
      apiKeySource: 'ANTHROPIC_API_KEY',
      claude_code_version: '2.1.296',
      output_style: 'default',
      agents: ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'],
      skills: ['…'],
      plugins: [
        { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' },
      ],
      capabilities: [
        'interrupt_receipt_v1',
        'interrupt_cancel_queued_v1',
        'interrupt_send_now_v1',
        'msg_lifecycle_v1',
        'request_marker_lists_v1',
        'sdk_mcp_tools_list_changed',
        'sdk_mcp_manifests',
        'mcp_read_resource_v1',
        'mcp_tool_ui_meta_v1',
        'ui_surface_v1',
      ],
      analytics_disabled: true,
      product_feedback_disabled: true,
      uuid: '…',
      memory_paths: { auto: '<run>\\cfg\\projects\\<proj>\\memory\\' },
      messaging_socket_path: '\\\\.\\pipe\\LOCAL\\cc-msg-d7b08732db699f1fdbbee445b4819b90',
      fast_mode_state: 'off',
      fast_mode_disabled_reason: 'sdk_opt_in_required',
      per_turn_effort_active: true,
      view_mode: 'default',
      powershell_path: '<C>/\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    },
  },
  {
    name: 'command_lifecycle queued',
    source: '05 §5',
    provenance: 'observed',
    frame: { type: 'command_lifecycle', command_uuid: '…', state: 'queued' },
  },
  {
    name: 'command_lifecycle started',
    source: '05 §5',
    provenance: 'observed',
    frame: { type: 'command_lifecycle', command_uuid: '…', state: 'started' },
  },
  {
    name: 'system/informational (classifier billing notice)',
    source: '05 §4',
    provenance: 'reconstructed',
    frame: { type: 'system', subtype: 'informational' },
  },
  {
    name: 'assistant text',
    source: '05 §4',
    provenance: 'reconstructed',
    frame: {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello from mock.' }] },
      parent_tool_use_id: null,
      session_id: SID,
    },
  },
  {
    name: 'result/success',
    source: '05 §4',
    provenance: 'reconstructed',
    frame: { type: 'result', subtype: 'success', is_error: false, session_id: SID },
  },

  // ---- 05 §6 permissions --------------------------------------------------
  {
    name: 'can_use_tool (Windows)',
    source: '05 §6',
    provenance: 'observed',
    frame: {
      type: 'control_request',
      request_id: '96faf3d7-4d77-4311-839f-a6ddaaec5323',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        display_name: 'Bash',
        input: { command: 'echo hi && touch marker.txt', description: 'mock command' },
        description: 'mock command',
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'echo hi *' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
          { type: 'addDirectories', directories: ['<run>\\work'], destination: 'session' },
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
        blocked_path: '<run>\\work\\marker.txt',
        tool_use_id: 'toolu_mock_0002',
      },
    },
  },
  {
    name: 'can_use_tool (Linux)',
    source: '05 §6, §14',
    provenance: 'reconstructed',
    frame: {
      type: 'control_request',
      request_id: '96faf3d7-4d77-4311-839f-a6ddaaec5324',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        display_name: 'Bash',
        input: { command: 'echo hi && touch marker.txt', description: 'mock command' },
        description: 'mock command',
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'touch marker.txt' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
        decision_reason_type: 'subcommandResults',
        tool_use_id: 'toolu_mock_0002',
      },
    },
  },
  {
    name: 'tool_result after deny',
    source: '05 §6',
    provenance: 'reconstructed',
    frame: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_mock_0002',
            content: 'host says no',
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: SID,
    },
  },
  {
    name: 'result/success with permission_denials',
    source: '05 §6',
    provenance: 'reconstructed',
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'toolu_mock_0002', tool_input: { command: 'echo hi' } },
      ],
      session_id: SID,
    },
  },
  {
    name: 'control_cancel_request after interrupt',
    source: '05 §6',
    provenance: 'observed',
    frame: { type: 'control_cancel_request', request_id: '548e5f58-…' },
  },
  {
    name: 'system/permission_denied (default mode, no prompt tool)',
    source: '05 §6',
    provenance: 'observed',
    frame: {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_mock_0007',
      message: "touch in '<run>\\work\\marker.txt' needs approval. …",
      uuid: '…',
      session_id: '…',
    },
  },
  {
    name: 'system/permission_denied (auto-mode classifier)',
    source: '05 §6',
    provenance: 'reconstructed',
    frame: {
      type: 'system',
      subtype: 'permission_denied',
      decision_reason_type: 'classifier',
      message: 'Auto mode could not evaluate this action and is blocking it for safety — …',
    },
  },

  // ---- 05 §7 interrupt ----------------------------------------------------
  {
    name: 'interrupt response, nothing queued',
    source: '05 §6, §7',
    provenance: 'observed',
    frame: {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'int_1', response: { still_queued: [] } },
    },
  },
  {
    name: 'interrupt response, still queued',
    source: '05 §7',
    provenance: 'observed',
    frame: {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'int_2',
        response: { still_queued: ['00000000-0000-4000-8000-000000000002'] },
      },
    },
  },
  {
    name: 'interrupt response, cancel_queued',
    source: '05 §7',
    provenance: 'observed',
    frame: {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'int_1',
        response: { still_queued: [], cancelled: ['00000000-0000-4000-8000-000000000002'] },
      },
    },
  },
  {
    name: 'assistant aborted partial text',
    source: '05 §7',
    provenance: 'reconstructed',
    frame: {
      type: 'assistant',
      aborted: true,
      message: { content: [{ type: 'text', text: 'chunk0 chunk1 chunk2 chu' }] },
    },
  },
  {
    name: 'user [Request interrupted by user]',
    source: '05 §7',
    provenance: 'observed',
    frame: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    },
  },
  ...['content_block_stop', 'message_delta', 'message_stop'].map((event): ResearchFrame => ({
    name: `stream_event ${event}`,
    source: '05 §7',
    provenance: 'reconstructed',
    frame: { type: 'stream_event', event: { type: event } },
  })),
  {
    name: 'result/error_during_execution aborted_streaming',
    source: '05 §7',
    provenance: 'observed',
    frame: {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    },
  },
  {
    name: 'result/error_during_execution aborted_tools',
    source: '05 §6',
    provenance: 'reconstructed',
    frame: {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_tools',
    },
  },
  {
    name: 'result/success completed',
    source: '05 §7',
    provenance: 'reconstructed',
    frame: { type: 'result', subtype: 'success', terminal_reason: 'completed' },
  },

  // ---- 05 §8 stdin EOF ----------------------------------------------------
  {
    name: 'system/task_started',
    source: '05 §8',
    provenance: 'reconstructed',
    frame: {
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_bash',
      is_backgrounded: false,
    },
  },
  {
    name: 'system/task_notification completed',
    source: '05 §8',
    provenance: 'reconstructed',
    frame: { type: 'system', subtype: 'task_notification', status: 'completed' },
  },

  // ---- 05 §9 exit codes and errors -----------------------------------------
  {
    name: 'result/error_max_turns',
    source: '05 §9',
    provenance: 'observed',
    frame: {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      terminal_reason: 'max_turns',
      errors: ['Reached maximum number of turns (1)'],
      num_turns: 2,
    },
  },
  {
    name: 'assistant authentication_failed',
    source: '05 §9',
    provenance: 'observed',
    frame: {
      type: 'assistant',
      error: 'authentication_failed',
      message: {
        content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 mock 401' }],
      },
    },
  },
  {
    name: 'result/success is_error 401',
    source: '05 §9',
    provenance: 'observed',
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      terminal_reason: 'api_error',
    },
  },
  {
    name: 'system/api_retry 401',
    source: '05 §9',
    provenance: 'observed',
    frame: {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 612.5,
      error_status: 401,
      error: 'authentication_failed',
    },
  },
  {
    name: 'system/api_retry rate_limit',
    source: '05 §9',
    provenance: 'observed',
    frame: { type: 'system', subtype: 'api_retry', error: 'rate_limit', retry_delay_ms: 550 },
  },
  {
    name: 'result 529 overloaded',
    source: '05 §9',
    provenance: 'reconstructed',
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 529,
      result: 'API Error: Repeated 529 Overloaded errors…',
    },
  },
  {
    name: 'result prompt too long',
    source: '05 §11',
    provenance: 'reconstructed',
    frame: { type: 'result', is_error: true, result: 'Prompt is too long' },
  },

  // ---- 05 §12 session state ------------------------------------------------
  {
    name: 'session_state_changed running',
    source: '05 §12',
    provenance: 'observed',
    frame: { type: 'system', subtype: 'session_state_changed', state: 'running' },
  },
  {
    name: 'session_state_changed idle',
    source: '05 §12',
    provenance: 'observed',
    frame: { type: 'system', subtype: 'session_state_changed', state: 'idle' },
  },
  {
    name: 'session_state_changed idle sdk_host_only',
    source: '05 §12',
    provenance: 'observed',
    frame: {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      sdk_host_only: true,
    },
  },

  // ---- 07 ------------------------------------------------------------------
  {
    name: 'result before any control_response (resume not found)',
    source: '07 §1 a11',
    provenance: 'observed',
    frame: {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 0,
      session_id: '00000000-0000-4000-8000-00000000000a',
      errors: ['No conversation found with session ID: 00000000-0000-4000-8000-00000000000a'],
    },
  },
  {
    name: 'system/task_updated',
    source: '07 §7',
    provenance: 'reconstructed',
    frame: { type: 'system', subtype: 'task_updated' },
  },
  {
    name: 'system/task_notification stopped',
    source: '07 §7',
    provenance: 'reconstructed',
    frame: { type: 'system', subtype: 'task_notification', status: 'stopped' },
  },
  {
    name: 'initialize response with workspace_trust_recorded (spike only)',
    source: '07 §10',
    provenance: 'reconstructed',
    frame: {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'init_1',
        response: { workspace_trust_recorded: true, pid: 1420 },
      },
    },
  },

  // ---- control protocol, never observed ------------------------------------
  {
    name: 'keep_alive',
    source: '02 §4.1 (05 §12: never sent by 2.1.296)',
    provenance: 'protocol',
    frame: { type: 'keep_alive' },
  },
];
