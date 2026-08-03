# Kraki 定时 Agent 唤醒：目标设计与 UX Demo

> 状态：产品与协议设计草案  
> 关联 Draft PR：[#219](https://github.com/corelli18512/kraki/pull/219)  
> 目的：定义正确的 Scheduled Wake 模型，并说明用户实际会看到和操作什么。

## 1. 一句话结论

用户可以在任意普通 Agent session 中说：

> 每天上午 9 点检查入境通行证是否开放；如果开放，继续帮我准备，但提交前必须问我。

当前 Agent 理解请求并提出一个结构化 Trigger。用户确认后，Tentacle 持久化计划。到点时，Kraki 创建一个来源明确的 Scheduled Run，恢复同一个 Agent 的工作上下文，执行结果自然回到原聊天。

**定时触发不是用户消息，也不能伪造成用户消息。**

---

## 2. 当前 PoC 证明了什么，哪里不是最终设计

Draft PR #219 已证明以下工程链路可行：

- Agent 可以通过 Tool 创建 durable trigger；
- Trigger 可以由 Tentacle 持久化；
- Tentacle 和 Agent 进程重启后，计划仍能恢复；
- 到点后可以 lazy-resume 原 Agent/session；
- Web 可以把触发显示成中性的系统分隔，而不是用户气泡；
- 结果可以回到原 Kraki session。

但 PoC 的 Agent 输入兼容层仍然调用：

```ts
adapter.sendMessage(sessionId, "[Kraki scheduled wake] ...")
```

因此在不支持 system event 的 Agent SDK 内部，这段输入可能被 provider transcript 记录为 user-role prompt。

这只能作为验证调度链路的 shim，不应该成为正式协议。

目标设计必须保证：

1. Kraki canonical transcript 中没有伪造的 `user_message`；
2. Trigger 来源和执行来源是结构化数据，不靠 prompt 文本声明；
3. 兼容 adapter 即使只能发送 prompt，也不能把该 prompt 写回用户消息历史；
4. Scheduled Run 不继承用户权限；
5. 模型看到的文字永远不能替代 capability policy 的授权判断。

---

## 3. 正确的产品模型

需要把以下四个概念分开：

### 3.1 Kraki Session

用户看到的长期聊天与工作空间。

它包含：

- 用户与 Agent 的对话；
- 工作目录、项目和设备绑定；
- Agent 类型和模型；
- Trigger 引用；
- Run 的可见结果；
- 审批、回执和审计记录。

Session 不等于某个永远存活的 SDK 进程，也不应等于 provider 的一条连续 user/assistant transcript。

### 3.2 Trigger

一个持久化的未来承诺。

Trigger 回答：

- 什么时候触发；
- 唤醒哪个 Agent；
- 关联哪个 Kraki session；
- 在哪台设备执行；
- 要做什么；
- 错过时间如何处理；
- 是否启用；
- 谁创建和确认了它。

Trigger 不代表一次具体执行，也不代表执行成功。

### 3.3 Trigger Occurrence

Trigger 的某一次计划发生时间。

例如每天 9 点的 Trigger 会产生：

- `2026-08-03T09:00:00+08:00`
- `2026-08-04T09:00:00+08:00`
- `2026-08-05T09:00:00+08:00`

每个 occurrence 必须有稳定、可重复计算的 ID，用于防止 daemon 重启、网络重试或多进程竞争造成重复执行。

### 3.4 Agent Run

由一次用户输入、定时触发、外部事件或重试启动的具体执行。

Run 回答：

- 为什么开始；
- 谁或什么触发了它；
- 使用哪个 Agent/runtime；
- 当前状态；
- 是否等待审批；
- 最终成功、失败、取消还是结果不确定；
- 产生了哪些消息、工具调用和 artifact。

**一次 Trigger occurrence 对应至多一个逻辑 Run。**

---

## 4. 目标协议：Trigger 与 Run 分离

### 4.1 Trigger

```ts
interface AgentTrigger {
  id: string;
  version: number;

  owner: {
    userId: string;
    deviceId: string;
    sessionId: string;
    adapter: "pi" | "claude" | "copilot" | "hermes";
  };

  schedule:
    | {
        type: "once";
        at: string; // 必须是带 Z 或 UTC offset 的绝对时间
      }
    | {
        type: "cron";
        expression: string;
        timezone: string; // 必须是显式 IANA timezone
      };

  instruction: string;
  label?: string;

  missedRunPolicy: "run_once_when_online" | "skip";
  overlapPolicy: "skip" | "queue_one";

  projectionPolicy: {
    chat: {
      publishOn: Array<
        | "every_run"
        | "change"
        | "match"
        | "action_required"
        | "failure"
        | "uncertain"
      >;
    };
    push: {
      notifyOn: Array<
        | "change"
        | "match"
        | "action_required"
        | "failure"
        | "uncertain"
      >;
    };
    digest: "off" | "daily" | "weekly";
  };

  status: "active" | "paused" | "completed" | "deleted";
  nextOccurrenceAt?: string;

  createdAt: string;
  createdBy: "user_confirmed_agent_proposal" | "user_direct";
  confirmedAt: string;
}
```

关键约束：

- `deviceId + adapter + sessionId` 在创建时固定；
- 用户以后更换默认 Agent，不会静默迁移已有 Trigger；
- 第一版不自动故障转移到其他设备；
- 涉及设备本地 Cookie、凭据和表单状态的任务不能静默迁移；
- 修改 Trigger 使用 optimistic version，避免多设备覆盖。

### 4.2 Occurrence

```ts
interface TriggerOccurrence {
  id: string; // deterministic(triggerId, scheduledAt)
  triggerId: string;
  scheduledAt: string;
  createdAt: string;
  status:
    | "pending"
    | "leased"
    | "started"
    | "completed"
    | "failed"
    | "skipped"
    | "uncertain";
  runId?: string;
}
```

建议：

```ts
occurrenceId = sha256(`${triggerId}\0${scheduledAt}`).slice(0, 32)
```

SQLite 中对 `occurrenceId` 建唯一索引，作为执行幂等性的第一道防线。

### 4.3 Run

```ts
interface AgentRun {
  id: string;
  sessionId: string;

  source:
    | {
        type: "user";
        userMessageId: string;
      }
    | {
        type: "scheduled_trigger";
        triggerId: string;
        occurrenceId: string;
        scheduledAt: string;
        firedAt: string;
      }
    | {
        type: "external_event";
        eventId: string;
      }
    | {
        type: "retry";
        priorRunId: string;
      };

  instruction: string;

  execution: {
    deviceId: string;
    adapter: string;
    runtimeSessionId?: string;
    contextStrategy: "resume" | "fork" | "fresh_with_context";
  };

  status:
    | "created"
    | "leased"
    | "starting"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "uncertain";

  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: RunError;
}

interface RunReport {
  runId: string;
  status: "succeeded" | "failed" | "cancelled" | "uncertain";

  classification:
    | "no_change"
    | "changed"
    | "matched"
    | "action_required";

  summary: string;
  stateFingerprint?: string;
  detailsRef?: ContentRef;
  suggestedAttention: "none" | "info" | "action_required" | "urgent";
  completedAt: string;
}
```

`RunReport` 是 Agent/adapter 提交给 Tentacle 的执行结果，不是聊天消息。Agent 可以建议 attention level，但不能直接决定是否向用户发言。

Tentacle 根据以下信息计算最终 projection signals：

- Run 的真实状态；
- 是否存在待审批 capability；
- 是否发生失败或结果不确定；
- 本次 `stateFingerprint` 与上次成功 observation 的差异；
- Trigger 的 `projectionPolicy`；
- 去重、失败抑制和通知频率规则。

例如“每天检查，没变化不用告诉我”会被确认成：

```ts
projectionPolicy: {
  chat: {
    publishOn: ["change", "match", "action_required", "failure", "uncertain"]
  },
  push: {
    notifyOn: ["match", "action_required", "uncertain"]
  },
  digest: "off"
}
```

这样每天仍然有完整 Run 和审计结果，但 `no_change` 不会自动产生聊天消息。

---

## 5. 不应把 wake 设计成 `user_message`

### 5.1 为什么不正确

如果到点后向原 transcript 添加一条 user-role message，会造成：

- 审计语义错误：历史看起来像用户在那个时间主动说了这句话；
- 授权混淆：模型可能把它理解为新的用户授权；
- prompt injection 风险：Trigger instruction 可能冒充高权限用户指令；
- 多设备争议：无法准确说明是谁、在哪台设备、依据哪个计划触发；
- 重试混淆：同一个 occurrence 的重复投递看起来像用户重复发送；
- 外部 Agent 兼容层泄漏到产品协议。

### 5.2 正确边界

Kraki 应该保存结构化来源：

```ts
source: {
  type: "scheduled_trigger",
  triggerId,
  occurrenceId,
  scheduledAt,
  firedAt
}
```

用户授权、执行来源和 runtime transport 必须彼此独立：

- **来源**：为什么 Run 被创建；
- **指令**：这次 Run 要完成什么；
- **权限**：它能否调用某项能力；
- **transport**：adapter 用什么方式把 Run 交给模型。

即使某个 adapter 最终只能用 user-role prompt 启动模型，那也只是 adapter transport 的降级实现，不能改变 Run 的真实来源。

---

## 6. Agent adapter 的正确接口

### 6.1 统一输入

```ts
interface AgentExecutionRequest {
  runId: string;
  sessionId: string;
  source: AgentRun["source"];
  instruction: string;
  context: AgentContextRef;

  authority: {
    userPresence: "present" | "absent";
    inheritedApprovals: [];
  };
}

interface AgentAdapter {
  capabilities(): AgentAdapterCapabilities;
  startRun(request: AgentExecutionRequest): Promise<AgentRunHandle>;
  resumeRun(runId: string): Promise<AgentRunHandle | null>;
}
```

`authority.inheritedApprovals` 对 Scheduled Run 默认必须为空。

### 6.2 Adapter capability discovery

```ts
interface AgentAdapterCapabilities {
  nativeSystemEventInput: boolean;
  resumableRuntime: boolean;
  forkableContext: boolean;
  durableRunIdentity: boolean;
}
```

### 6.3 三种执行策略

#### A. Native system event

最理想。

Agent SDK 支持 system/developer/event 输入时：

```ts
adapter.startRun({
  source: { type: "scheduled_trigger", ... },
  instruction,
  ...
});
```

模型 transcript 中保留正确来源，不产生伪造 user message。

#### B. Forked background runtime

SDK 不支持 system event，但支持 fork 时：

- 从原 Agent context fork 一个后台 runtime；
- 将 Kraki execution envelope 作为 bootstrap/control input；
- 该 input 不写入 Kraki canonical user transcript；
- 后台 runtime 的原始 provider transcript作为内部审计数据；
- 结果投影回原 Kraki session。

这是 Pi、Claude Code、Copilot 较现实的兼容方向。

#### C. Fresh runtime with context package

无法 resume/fork 时：

- 创建新 runtime；
- 注入经过选择的 context package；
- 明确声明 scheduled source；
- 将输出关联到原 Kraki session。

Context package 可以包含：

- session 摘要；
- 用户明确保存的约束；
- 最近相关 Run 的结果；
- 项目路径和工作树状态；
- 必要 artifact refs；
- Trigger instruction。

不应默认把整个历史聊天无限复制进去。

### 6.4 最低兼容模式

若 provider 只接受 user-role prompt：

- 允许 adapter 在隔离 runtime 内使用兼容 prompt；
- 必须标记 `inputMode: "compat_prompt"`；
- 不得写入 canonical `user_message`；
- 不得被 Policy Engine 当作用户授权；
- UI/审计页必须能看到这是兼容模式；
- 高风险 Scheduled Run 可以选择禁止在该 adapter 上执行。

---

## 7. Run ledger 与 Chat projection

### 7.1 所有 Run 进入独立 ledger

每一次 Scheduled Run 都必须进入 Tentacle 的 durable Run ledger，包括完全静默的检查。

Run ledger 保存：

- Run 来源；
- instruction snapshot；
- 实际执行设备与 adapter；
- 状态和耗时；
- RunReport；
- TRACE 和 artifact refs；
- 是否以及为什么投影到聊天、Push 或 Digest。

**Run ledger 是执行审计 authority；session spine 不是所有后台执行的流水账。**

因此不能默认让每次 Run 都向聊天写入：

```text
run_started
run_completed
```

否则“每天检查但没变化不要告诉我”仍会每天污染聊天。

### 7.2 Projection Policy

Run 完成后，Tentacle 计算 projection：

```ts
interface RunProjectionDecision {
  runId: string;
  chat: "silent" | "summary" | "action_card" | "error";
  push: "none" | "info" | "action_required" | "urgent";
  digest: "none" | "include";
  reason:
    | "policy_every_run"
    | "state_changed"
    | "condition_matched"
    | "approval_required"
    | "run_failed"
    | "result_uncertain"
    | "no_change_suppressed"
    | "duplicate_suppressed";
}
```

最终 decision 必须由 Tentacle/Policy Engine 产生，而不是由模型直接控制。

Agent 的 RunReport 可以表达：

```ts
classification: "no_change" | "changed" | "matched" | "action_required"
```

但 Tentacle 仍要用 deterministic signals 核验，例如：

- capability 是否真的进入 waiting approval；
- Run 是否真的 failed/uncertain；
- observation fingerprint 是否发生变化；
- 相同 `dedupeKey` 是否已发布过；
- Trigger policy 是否允许本次通知。

### 7.3 只有公开 projection 才进入 session spine

当 decision 为 `chat: "silent"`：

- 不写 `run_started`；
- 不写 agent bubble；
- 不改变聊天 preview；
- 不增加 unread；
- Run 只存在于 Run ledger 和“已安排事项”的运行历史中。

当 decision 需要公开时，spine 可以写一个原子、已完成的 projection：

```ts
interface RunProjectionMessage extends BaseEnvelope {
  type: "run_projection";
  payload: {
    runId: string;
    triggerId?: string;
    occurrenceId?: string;
    sourceType: "scheduled_trigger" | "external_event" | "retry";
    kind: "summary" | "action_required" | "failed" | "uncertain";
    summary: string;
    completedAt: string;
    detailsRef?: ContentRef;
  };
}
```

UI 根据 `kind` 渲染为：

- 普通 Agent 总结；
- 审批卡；
- 失败提示；
- 结果不确定提示。

如果用户当时正打开该 session，并且产品希望展示实时后台执行，可以订阅 transient Run activity；这些 live events 不属于 durable chat spine，Run 最终静默时可以无痕消失。

### 7.4 显式“每次都告诉我”

只有 Trigger policy 包含：

```ts
chat.publishOn = ["every_run", ...]
```

每次成功 Run 才会生成聊天总结。

### 7.5 迁移兼容

PoC 当前持久化 `scheduled_wake` turn anchor。正式实现有两个选择：

1. 将其限制为仅用于需要公开的 Run projection；或
2. 迁移为 `run_projection`，静默 Run 完全不进入 spine。

推荐第二种。

如果第一阶段暂时保留 `scheduled_wake`，payload 至少应改成：

```ts
interface ScheduledWakeMessage extends BaseEnvelope {
  type: "scheduled_wake";
  payload: {
    runId: string;
    triggerId: string;
    occurrenceId: string;
    scheduledAt: string;
    firedAt: string;
    label?: string;
  };
}
```

完整 instruction 保存在不可变 Run snapshot 中，不复制进长期 spine。

---

## 8. Durable scheduler 的正确存储

正式实现建议使用 Tentacle SQLite，而不是 JSON。

至少包含：

### `agent_triggers`

- `id`
- `version`
- `session_id`
- `device_id`
- `adapter`
- `schedule_type`
- `schedule_value`
- `timezone`
- `instruction_ciphertext` 或本地明文字段
- `label`
- `missed_run_policy`
- `overlap_policy`
- `status`
- `next_occurrence_at`
- `created_at`
- `confirmed_at`

### `trigger_occurrences`

- `id` UNIQUE
- `trigger_id`
- `scheduled_at`
- `status`
- `lease_owner`
- `lease_expires_at`
- `run_id`
- `created_at`
- `updated_at`

### `agent_runs`

- `id` UNIQUE
- `session_id`
- `source_type`
- `source_id`
- `instruction_snapshot`
- `adapter`
- `device_id`
- `runtime_session_id`
- `context_strategy`
- `status`
- `started_at`
- `finished_at`
- `error_code`
- `error_detail`

SQLite transaction should atomically perform：

1. claim due occurrence；
2. create Run；
3. bind occurrence to Run；
4. acquire lease。

---

## 9. Crash、重试与幂等

### 9.1 Scheduler 还未交给 adapter

状态：

```text
pending / leased
```

安全做法：lease 过期后可重试。

### 9.2 Adapter 明确拒绝或未接受

状态：

```text
failed_before_start
```

可以依据策略重试，不应产生重复业务动作。

### 9.3 Adapter 已接受，但 daemon 在完成前崩溃

状态：

```text
uncertain
```

默认不能盲目创建第二个 Run。

处理方式取决于 adapter capability：

- 能按 `runId` 恢复：恢复原 Run；
- 能证明原 runtime 已终止且尚未产生副作用：可重试；
- 无法证明：标记 `uncertain`，通知用户核验。

### 9.4 高风险动作的幂等

提交、付款、发送、删除等能力需要自己的 idempotency key：

```ts
capabilityOperationId = `${runId}:${toolCallId}`
```

Scheduler 的 occurrence 幂等不能代替 capability operation 幂等。

---

## 10. 权限模型

Scheduled Run 只代表：

> 用户同意在未来某个时间唤醒 Agent，并让它开始处理这条 instruction。

它不代表：

- 用户当时在线；
- 用户批准了某次具体提交；
- 用户批准付款；
- 用户批准法律声明；
- 用户批准发送邮件或消息；
- 用户批准读取所有凭据。

建议 capability policy：

```ts
type PolicyDecision =
  | "deny"
  | "notify"
  | "require_approval"
  | "allow";
```

每次工具调用基于以下信息判定：

```ts
interface PolicyContext {
  runId: string;
  sourceType: "user" | "scheduled_trigger" | "external_event" | "retry";
  userPresence: "present" | "absent";
  capability: string;
  risk: "low" | "medium" | "high";
  deviceId: string;
  sessionId: string;
}
```

第一版建议：

- 读取公开网页、读取项目状态、生成总结：可以自动执行；
- 登录、读取 Vault secret：按 capability 单独授权；
- 修改本地文件：依据 session mode 和 sandbox；
- 提交表单、发消息、付款、法律声明：始终 require approval；
- 生物识别、验证码：要求用户接管。

---

# Part II：UX Demo

## 11. UX 原则

1. 不新增特殊“自动化助手”session。
2. 用户在当前普通 Agent session 中自然表达未来任务。
3. Agent 负责理解，Tentacle 负责持久化和计时。
4. 创建 Trigger 必须有轻量确认。
5. 确认按钮直接提交结构化命令，不再让模型二次解释。
6. 到点后的每次执行都进入 Run history，但只有符合 projection policy 的结果才回到原聊天。
7. Scheduled Run 与用户消息视觉不同；静默 Run 不出现在聊天中。
8. 用户始终能看到执行 Agent、设备、下次时间和通知规则。
9. 低优先级结果不强制打扰；重要状态变化才 push。
10. 离线、错过、失败和结果不确定必须明确显示。

---

## 12. Demo 场景：每天检查入境通行证

### Step 1：用户自然发起

用户在现有 Pi session 中输入：

> 每天上午 9 点帮我检查入境通行证是不是开放了。如果开放，继续准备申请，但正式提交前一定要问我。

这仍然是普通用户消息。

### Step 2：Agent 提出 Trigger Proposal

Agent 回复简短解释，并展示结构化确认卡：

```text
我可以为这个聊天创建一个定时检查。

┌─────────────────────────────────────┐
│ 每日检查：入境通行证                │
│                                     │
│ 时间       每天 09:00               │
│ 时区       Asia/Shanghai             │
│ Agent      Pi                        │
│ 执行设备   家里的 Mac                │
│                                     │
│ 到点后：                            │
│ 检查通行证是否开放；开放后准备申请， │
│ 正式提交前询问你。                   │
│                                     │
│ 权限：可以自动检查和准备；           │
│ 不会自动提交、付款或发送。           │
│                                     │
│ 告诉我：状态变化、需要操作或失败时   │
│ 无变化：静默                         │
│                                     │
│ [取消]                     [确认安排]│
└─────────────────────────────────────┘
```

确认卡还应显示：

- 首次执行时间；
- 错过执行策略；
- 是否允许任务重叠；
- 当前设备离线时会发生什么；
- 什么情况下写入聊天、发 Push 或进入 Digest。

### Step 3：用户确认

用户点击“确认安排”。

客户端直接发送结构化 commit：

```ts
commitTriggerProposal({
  proposalId,
  expectedVersion: 1
})
```

**不把按钮点击转换成“请帮我创建这个计划”再发给模型。**

### Step 4：原聊天出现安排回执

聊天中显示中性系统行：

```text
✓ 已安排「每日检查：入境通行证」
  明天 09:00 · Pi · 家里的 Mac
```

下方提供：

```text
[查看] [暂停]
```

Session 顶部或详情菜单中增加轻量入口：

```text
已安排事项  1
```

不需要新增 Routine Dashboard 才能完成第一版。

---

## 13. 到点时的执行与聊天体验

### Step 5：后台创建 Scheduled Run

到 09:00 后，Tentacle 在 Run ledger 创建 Scheduled Run。默认情况下，聊天中**不会立即出现任何分隔或消息**。

如果用户此时打开“已安排事项 → 运行历史”，可以看到：

```text
每日检查：入境通行证
今天 09:00 · 运行中
```

如果产品需要在用户正查看该 session 时显示实时状态，可以临时显示：

```text
正在执行定时检查：每日检查：入境通行证
```

这只是 transient activity：

- 不是用户气泡；
- 不使用用户头像；
- 不写入 durable chat spine；
- 不增加未读；
- Run 最终静默时可以消失。

### Step 6：Agent 工作

Agent 在后台执行并生成 RunReport：

```ts
{
  classification: "no_change" | "changed" | "matched" | "action_required",
  summary,
  stateFingerprint,
  suggestedAttention
}
```

工具步骤和完整输出进入 Run ledger/TRACE，不自动进入聊天。

如果任务只需要低风险读取，Agent 可以自动继续。

### Step 7A：未开放，且没有变化

Agent RunReport：

```ts
{
  status: "succeeded",
  classification: "no_change",
  summary: "入境通行证目前仍未开放",
  suggestedAttention: "none"
}
```

由于 Trigger 的默认 policy 是“无变化静默”：

- 聊天不新增消息；
- sidebar preview 不变化；
- 不增加 unread；
- 不发送 Push；
- Run history 记录本次检查成功。

用户以后打开“运行历史”会看到：

```text
今天 09:00  检查完成 · 无变化
昨天 09:00  检查完成 · 无变化
```

### Step 7B：状态发生变化

如果昨天是“未开放”，今天变成“已开放”，fingerprint 变化，Tentacle 决定发布聊天 projection：

```text
入境通行证申请今天已开放。

我已经开始准备申请资料；正式提交前会询问你。
```

这条消息：

- 是 Agent Run 的公开结果；
- 关联 `runId`；
- 不是用户消息；
- 更新 sidebar preview；
- 可以依据 policy 发送 Push。

### Step 7C：已开放，需要审批

Agent 生成 `action_required` RunReport，并由受控 capability 创建审批卡：

```text
通行证申请已开放。我已经准备好以下内容：

- 申请人资料已填入
- 证件照片已选择
- 入境日期已填写

下一步会正式提交申请。

[查看填写内容]                  [批准提交]
```

`action_required` 默认覆盖静默设置，因为 Run 无法继续且需要用户决定。用户可以选择关闭普通变化通知，但不能让待审批或结果不确定永久无提示。

审批卡必须由受控 Browser/Capability Tool 产生，不能只靠模型承诺“提交前问你”。

### Step 8：用户批准

用户点击“批准提交”。

Capability layer 使用：

- `runId`
- `toolCallId`
- idempotency key
- approval record

执行一次受控提交。

### Step 9：回执

Agent 回复：

```text
申请已提交。

申请编号：HK-2026-001234
提交时间：09:14

[查看回执]
```

回执以 artifact 保存，并关联到 Run。

---

## 14. App 关闭或设备离线

### 场景 A：手机 App 关闭，执行 Mac 在线

任务照常执行。

如果出现需要用户处理的审批：

```text
需要你的批准：提交入境通行证申请
```

Arm 收到 push；Run 状态为 `waiting_approval`。

### 场景 B：执行 Mac 离线

到点时不能静默迁移到其他设备。

Trigger 显示：

```text
⏸ 等待「家里的 Mac」上线
   原计划时间：今天 09:00
```

若 policy 是 `run_once_when_online`：

- 设备上线后创建一次补跑 Run；
- UI 标明“错过后补跑”；
- 不补齐离线期间的每一个 cron occurrence。

若 policy 是 `skip`：

```text
已跳过今天 09:00 的检查，因为执行设备离线。
下次：明天 09:00
```

### 场景 C：Tentacle 重启

Trigger 和 occurrence 保存在 SQLite。

重启后：

- 尚未开始的 occurrence 正常恢复；
- 已 lease 但未 start 的 occurrence 可安全重领；
- 已 start 但状态未知的 Run 进入恢复或 `uncertain`，不能盲目重复。

---

## 15. 修改、暂停和删除

用户可以在原聊天中说：

> 改成每天下午 3 点。

Agent 显示 update proposal：

```text
将「每日检查：入境通行证」从每天 09:00 改为每天 15:00。
时区保持 Asia/Shanghai。

[取消] [确认修改]
```

用户也可以直接操作管理页：

```text
每日检查：入境通行证
每天 15:00 · Asia/Shanghai
Pi · 家里的 Mac
下次：今天 15:00

[暂停] [编辑] [删除]
```

暂停后的聊天回执：

```text
⏸ 已暂停「每日检查：入境通行证」
```

删除需要确认，但不经过模型二次解释。

---

## 16. 一次性提醒 Demo

用户：

> 20 分钟后提醒我检查 CI。

确认卡可以更轻：

```text
20 分钟后唤醒这个 Pi session，检查 CI。
执行设备：办公室 Mac

[取消] [确认]
```

到点后不是只发一个普通通知，而是：

```text
⏰ 定时任务开始 · 检查 CI
```

Pi 自动读取 CI 状态并回复：

```text
CI 已完成：4 个 job 全部通过。
```

如果用户只想要通知而不需要 Agent 执行，应使用独立 reminder/notification 能力，而不是创建 Agent Run。

---

## 17. 失败体验

### Agent 无法启动

```text
定时任务未能启动
Pi 当前不可用：模型认证失败

[重试] [暂停计划]
```

### 结果不确定

```text
需要核验
Kraki 在任务执行期间重启，无法确认操作是否已经完成。
为避免重复提交，任务没有自动重试。

[查看记录] [确认未执行并重试]
```

### Session 已结束

Trigger 应自动暂停或失败：

```text
计划已暂停
原 Pi session 已结束，无法继续执行。

[选择新的执行上下文] [删除计划]
```

第一版不应静默绑定到另一个 Agent。

---

## 18. Reporting 与通知策略

Agent 是否执行和是否向用户说话是两个不同决策：

```text
Trigger → Run → RunReport → Projection Policy
                               ├─ Chat
                               ├─ Push
                               ├─ Digest
                               └─ Silent
```

### 18.1 用户可选的三个预设

#### 默认：有变化或需要我时告诉我

```ts
chat.publishOn = ["change", "match", "action_required", "failure", "uncertain"]
push.notifyOn = ["match", "action_required", "uncertain"]
digest = "off"
```

适合周期检查。

#### 每次都告诉我

```ts
chat.publishOn = ["every_run", "action_required", "failure", "uncertain"]
push.notifyOn = ["action_required", "uncertain"]
```

适合用户需要逐次回执的任务。

#### 不要打扰，放进汇总

```ts
chat.publishOn = ["action_required", "failure", "uncertain"]
push.notifyOn = ["action_required", "uncertain"]
digest = "daily"
```

普通结果进入 Briefing；待审批和结果不确定仍即时提示。

### 18.2 强制可见事件

以下事件不能仅因 Agent 声称 `no_change` 而被静默：

- capability 正在等待用户审批；
- 需要验证码、人脸识别或用户接管；
- Run 失败且影响后续计划；
- 结果不确定，存在重复提交风险；
- Trigger 自动暂停或执行设备不可用；
- Policy Engine 判定为必须通知。

用户可以关闭 Push，但这些事件至少要进入 Inbox/badge 和 Run history。

### 18.3 可以完全静默

- 周期检查无变化；
- 低风险例行成功；
- 与已发布结果相同的重复状态；
- 用户明确选择仅进入 Digest 的普通结果。

完全静默表示：

- 不写聊天 spine；
- 不更新 sidebar preview；
- 不增加 session unread；
- 不发送 Push；
- 仍写 Run ledger。

### 18.4 状态变化判断

不能只问模型“有没有变化”。建议每个观察型 Trigger 保存：

```ts
lastPublishedFingerprint?: string
lastObservedFingerprint?: string
```

本次 RunReport 提供 `stateFingerprint`。Tentacle 比较 fingerprint 并结合 policy 决定：

- 第一次观察是否发布；
- 真正变化是否发布；
- 重复状态是否抑制；
- 变化后是否更新 baseline。

复杂任务可由 capability tool 返回结构化 observation 和 fingerprint，避免完全依赖模型自由文本。

### 18.5 聚合

```text
今天的 4 个定时检查
3 个无变化 · 1 个需要处理
```

Inbox/Briefing 是通知聚合层，不替代原 session 的结果 authority，也不替代 Run ledger。

---

## 19. MVP 建议

### Phase 1：可靠 Scheduled Run

支持：

- one-shot；
- cron + timezone；
- proposal + direct confirm；
- pause/resume/delete；
- 固定 device + adapter + session；
- `run_once_when_online | skip`；
- neutral transient Run activity；
- 独立 Run ledger 和运行历史；
- configurable projection policy；
- 符合策略的结果才回原 session；
- 静默 Run 不改变聊天、preview 或 unread；
- daemon restart recovery；
- session-bound MCP capability。

首批场景：

- 未来检查 CI；
- 定时检查网页状态；
- 周期性项目状态总结；
- 一次性 Agent follow-up。

### Phase 2：受控能力和审批

加入：

- Browser capability；
- Vault capability；
- approval policy；
- operation idempotency；
- `waiting_approval`；
- push notification。

### Phase 3：外部事件与复杂委派

加入：

- webhook/source event；
- Inbox/Briefing；
- device migration proposal；
- 多 Agent handoff；
- Hermes 等外部 proactive Agent adapter。

---

## 20. 对 Draft PR #219 的建议

PR #219 应继续保持 Draft，并被视为：

- scheduler 可行性证明；
- lazy resume 可行性证明；
- Web neutral turn anchor 可行性证明；
- MCP session capability 可行性证明。

在进入正式实现前建议重构：

1. Trigger 与 Run 分表；
2. 为 occurrence 引入 deterministic ID；
3. `scheduled_wake` 增加 `runId + occurrenceId`，移除完整 instruction；
4. 增加独立 Run ledger；静默 Run 不进入 session spine；
5. 引入 `RunReport + Projection Policy`，区分 Chat、Push、Digest 和 Silence；
6. adapter 从 `sendMessage` 转为 `startRun(AgentExecutionRequest)`；
7. compat prompt 只能存在于隔离 runtime，不写 canonical user transcript；
8. 增加 proposal/commit 协议，并让用户确认 reporting policy；
9. 明确 missed-run、overlap、retry 和 uncertain 语义；
10. 敏感工具依据 structured run source 做 policy 判断。

---

## 21. 最终用户心智

用户不需要理解 Trigger、Occurrence、Run 或 adapter。

用户只需要感受到：

1. 我可以在当前聊天里让这个 Agent 以后继续做事；
2. Kraki 会让我确认时间、设备和权限边界；
3. 关掉 App 或重启电脑后，计划不会被 Agent 自己“忘记”；
4. 到点后还是这个 Agent 和工作上下文，但无变化时可以完全不打扰我；
5. 需要发言时，我能看出这是定时执行结果，不是我刚刚说的话；
6. 我可以选择“有变化时告诉我”“每次都告诉我”或“只进入汇总”；
7. Agent 可以自动观察和准备，但敏感动作仍然必须问我；
8. 我随时可以查看完整运行历史、暂停、修改或删除。

这就是 Scheduled Agent Wake 应该提供的最终体验。
