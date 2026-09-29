import picomatch from 'picomatch';
import type { Workflow, Step, Cond } from './model.js';
import { compileProgram, compileTurn, type Instr, type Policy } from './compile.js';
import type { Engine, EngineSession, TurnResult } from './fake-engine.js';
import { relPath } from './policy.js';
import { repeatedAction, stagnation, editBeforePlan, sameError } from './drift.js';

export type RunStatus = 'running' | 'paused' | 'done' | 'stopped';

export interface PauseReason {
  type:
    | 'gate'
    | 'budget-used'
    | 'link-budget-used'
    | 'run-turn-budget-used'
    | 'agent-blocked'
    | 'step-deleted'
    | 'stop';
  stepId?: string;
  cond?: Cond;
  limit?: number;
  reason?: string;
  text?: string;
}

/** steer: slipped in mid-turn. now: interrupt, then sent as the next turn. stop: interrupt and pause. */
export type LiveCardKind = 'steer' | 'now' | 'stop';

export interface RunEventRecord {
  id: string;
  timestamp: number;
  type:
    | 'run_started'
    | 'run_paused'
    | 'run_resumed'
    | 'run_stopped'
    | 'run_finished'
    | 'turn_started'
    | 'turn_ended'
    | 'tool_call'
    | 'refusal'
    | 'card_queued'
    | 'card_delivered'
    | 'gate_paused'
    | 'gate_approved'
    | 'loop_iteration'
    | 'loop_budget_exceeded'
    | 'link_jump'
    | 'link_budget_exceeded'
    | 'verify_result'
    | 'recall'
    | 'store'
    | 'handoff'
    | 'budget_warning'
    | 'engine_cost'
    | 'hook'
    | 'judge';
  data: any;
}

export interface CommandResult {
  cmd: string;
  exitCode: number;
  output: string;
}

export interface RunOptions {
  workflow: Workflow;
  engine: Engine;
  resolveBlock?: (name: string) => Workflow | undefined;
  commandRunner?: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  now?: () => number;
  judge?: (cond: Cond, evidence: { lastText: string }) => Promise<boolean>;
  recall?: (topics: string[]) => Promise<string[]>;
  store?: (what: string, summary: string) => Promise<void>;
  diffLines?: () => Promise<number>;
  /** The project folder: passed to the engine, and guard paths are matched relative to it. */
  cwd?: string;
  /** Called for every event as it is logged (the store persists them). */
  onEvent?: (ev: RunEventRecord) => void;
}

export interface RunSnapshot {
  sessionId?: string;
  workflow: Workflow;
  programCounter: number;
  status: RunStatus;
  pauseReason?: PauseReason;
  loopCounters: Record<string, number>;
  linkCounters: Record<string, number>;
  turnOutputs: Record<string, string>;
  totalTurns: number;
  events: RunEventRecord[];
  pendingCards: string[];
  autoArmed: Record<string, boolean>;
  commandResults: CommandResult[];
  lastRecallContext: string[];
  lastTurnText?: string;
  loopLimitExtensions?: Record<string, number>;
}

export class Run {
  workflow: Workflow;
  engine: Engine;
  status: RunStatus = 'running';
  pauseReason?: PauseReason;

  private program: Instr[] = [];
  private programCounter = 0;
  private loopCounters = new Map<string, number>();
  private linkCounters = new Map<string, number>();
  private turnOutputs = new Map<string, string>();
  private totalTurns = 0;
  private events: RunEventRecord[] = [];
  private pendingCards: string[] = [];
  private autoArmed = new Map<string, boolean>();
  private commandResults: CommandResult[] = [];
  private lastRecallContext: string[] = [];
  private lastStepId?: string;
  private lastTurnText?: string;
  private loopLimitExtensions = new Map<string, number>();

  private engineSession?: EngineSession;
  private resolveBlock?: (name: string) => Workflow | undefined;
  private commandRunner: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  private now: () => number;
  private currentPolicy: Policy = { mode: 'write', guards: [], allowShell: true };
  private judge?: (cond: Cond, evidence: { lastText: string }) => Promise<boolean>;
  private recall?: (topics: string[]) => Promise<string[]>;
  private storeFn?: (what: string, summary: string) => Promise<void>;
  private diffLines?: () => Promise<number>;
  private cwd?: string;
  private onEvent?: (ev: RunEventRecord) => void;
  private resumeSessionId?: string;
  private turnInFlight = false;
  private interruptCard?: { text: string; kind: 'now' | 'stop' };

  constructor(opts: RunOptions) {
    this.workflow = opts.workflow;
    this.engine = opts.engine;
    this.resolveBlock = opts.resolveBlock;
    this.commandRunner =
      opts.commandRunner || (async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    this.now = opts.now || (() => Date.now());
    this.judge = opts.judge;
    this.recall = opts.recall;
    this.storeFn = opts.store;
    this.diffLines = opts.diffLines;
    this.cwd = opts.cwd;
    this.onEvent = opts.onEvent;

    this.program = compileProgram(this.workflow, this.resolveBlock);

    // Initialize auto cards as armed
    for (const auto of this.workflow.autos) {
      this.autoArmed.set(auto.id, true);
    }

    this.logEvent('run_started', { workflow: this.workflow.name });
  }

  private logEvent(type: RunEventRecord['type'], data: any) {
    const ev: RunEventRecord = {
      id: `ev-${this.events.length + 1}`,
      timestamp: this.now(),
      type,
      data,
    };
    this.events.push(ev);
    this.onEvent?.(ev);
  }

  getEvents(): RunEventRecord[] {
    return [...this.events];
  }

  private async ensureSession(): Promise<EngineSession> {
    if (!this.engineSession) {
      this.engineSession = await this.engine.open({
        ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
        ...(this.resumeSessionId ? { sessionId: this.resumeSessionId } : {}),
        policy: () => this.currentPolicy,
        pendingCards: () => {
          const cards = [...this.pendingCards];
          this.pendingCards = [];
          return cards;
        },
      });
    }
    return this.engineSession;
  }

  private handleTurnResult(result: TurnResult) {
    if (result.events) {
      for (const ev of result.events) {
        if (ev.type === 'refusal') {
          this.logEvent('refusal', { reason: ev.reason });
        } else if (ev.type === 'card_delivered') {
          this.logEvent('card_delivered', { card: ev.card, channel: ev.channel });
        } else if (ev.type === 'tool_call') {
          this.logEvent('tool_call', { tool: ev.tool, input: ev.input });
        } else if (ev.type === 'cost') {
          this.logEvent('engine_cost', { usd: ev.usd });
        } else if (ev.type === 'hook') {
          const { type: _t, ...data } = ev;
          this.logEvent('hook', data);
        }
      }
    }
    if (result.cost !== undefined && !result.events?.some((e) => e.type === 'cost')) {
      this.logEvent('engine_cost', { usd: result.cost });
    }
  }

  /**
   * Queue a card (plan 6.5). steer waits for the next delivery chance (mid-turn, else the next
   * turn's text). now and stop interrupt a running turn; with no turn running, now waits for the
   * next turn and stop pauses before the next step.
   */
  queueCard(cardText: string, kind: LiveCardKind = 'steer', source: 'live' | 'auto' = 'live') {
    this.logEvent('card_queued', { card: cardText, kind, source });
    if (kind === 'steer') {
      this.pendingCards.push(cardText);
    } else if (this.turnInFlight && this.engineSession) {
      this.interruptCard = { text: cardText, kind };
      this.engineSession.interrupt().catch(() => {});
    } else if (kind === 'now') {
      this.pendingCards.push(cardText);
    } else if (this.status === 'running') {
      this.pauseForStop(cardText);
    }
  }

  private pauseForStop(text: string) {
    this.status = 'paused';
    this.pauseReason = { type: 'stop', text };
    this.logEvent('run_paused', { reason: 'stop', text });
  }

  /**
   * "Request changes" at a gate (plan 7): send the note as a turn with every write locked
   * (Policy.pendingGate), then stay paused so the gate asks again.
   */
  async requestChanges(note: string) {
    if (this.status !== 'paused' || this.pauseReason?.type !== 'gate') return;
    const gate = this.pauseReason;
    const session = await this.ensureSession();
    this.currentPolicy = { ...this.currentPolicy, pendingGate: gate.stepId ?? 'gate' };
    this.logEvent('card_delivered', { card: note, channel: 'next-turn', source: 'gate-changes' });
    const result = await this.runTurn(
      session,
      gate.stepId ?? 'gate',
      `[Reins · workflow "${this.workflow.name}" · the user asked for changes before approving]\n\n${note}\n\n` +
        'When you finish this step, end your reply with exactly one line:\nREINS: done | blocked: <reason>\n'
    );
    // A stop card during the turn replaced the gate pause; otherwise the gate still waits.
    if (result) {
      // The revised reply replaces the step's output, so verify quotes the plan as approved.
      if (this.lastStepId) this.turnOutputs.set(this.lastStepId, result.text);
      this.status = 'paused';
      this.pauseReason = gate;
    }
  }

  /** Go on after a stop card or an agent's `REINS: blocked`: the paused step runs again. */
  resume() {
    if (this.status === 'paused' && (this.pauseReason?.type === 'stop' || this.pauseReason?.type === 'agent-blocked')) {
      this.status = 'running';
      this.pauseReason = undefined;
      this.logEvent('run_resumed', {});
    }
  }

  /**
   * Send one turn. A now card that interrupted it is sent as the next turn and the step goes
   * on; a stop card pauses the run and returns undefined.
   */
  private async runTurn(session: EngineSession, stepId: string, text: string): Promise<TurnResult | undefined> {
    let turnText = text;
    for (;;) {
      this.logEvent('turn_started', { step: stepId });
      this.turnInFlight = true;
      let result: TurnResult;
      try {
        result = await session.turn(turnText);
      } finally {
        this.turnInFlight = false;
      }
      this.totalTurns++;
      this.lastTurnText = result.text;
      this.handleTurnResult(result);
      this.logEvent('turn_ended', { step: stepId, text: result.text, cost: result.cost });

      const card = this.interruptCard;
      if (!card) return result;
      this.interruptCard = undefined;
      this.logEvent('card_delivered', { card: card.text, kind: card.kind, channel: 'interrupt' });
      if (card.kind === 'stop') {
        this.pauseForStop(card.text);
        return undefined;
      }
      const statusAt = text.lastIndexOf('When you finish this step');
      turnText =
        `[Reins · a card from the user, sent while you worked]\n\n${card.text}\n\n` +
        'Then carry on with the step you were on.\n\n' +
        (statusAt >= 0 ? text.slice(statusAt) : '');
    }
  }

  approve() {
    if (this.status === 'paused' && this.pauseReason?.type === 'gate') {
      this.status = 'running';
      this.pauseReason = undefined;
      this.logEvent('gate_approved', {});
      this.programCounter++;
    }
  }

  allowMore(n: number) {
    if (this.status === 'paused' && this.pauseReason?.type === 'budget-used') {
      const stepId = this.pauseReason.stepId!;
      const extra = this.loopLimitExtensions.get(stepId) || 0;
      this.loopLimitExtensions.set(stepId, extra + n);
      // The attempt that used up the budget is already counted: go straight back into the loop
      // body, or allowMore(1) would count it again and pause at once.
      const instr = this.program[this.programCounter];
      if (instr?.op === 'LOOP_BK') this.programCounter = instr.target;
      this.status = 'running';
      this.pauseReason = undefined;
      this.logEvent('run_resumed', { allowMore: n });
    } else if (this.status === 'paused' && this.pauseReason?.type === 'link-budget-used') {
      this.status = 'running';
      this.pauseReason = undefined;
      this.logEvent('run_resumed', { allowMore: n });
    }
  }

  recordCommandResult(cmd: string, exitCode: number, output: string) {
    this.commandResults.push({ cmd, exitCode, output });
  }

  checkAutoCards(): Promise<void> | void {
    const asyncTasks: Promise<void>[] = [];

    for (const auto of this.workflow.autos) {
      const syncRes = this.judgeAutoCondSync(auto.cond);
      const applyResult = (isCondTrue: boolean) => {
        const isArmed = this.autoArmed.get(auto.id) ?? true;
        if (isCondTrue && isArmed) {
          const k = auto.card.kind;
          this.queueCard(auto.card.text, k === 'now' || k === 'stop' ? k : 'steer', 'auto');
          this.autoArmed.set(auto.id, false);
        } else if (!isCondTrue) {
          this.autoArmed.set(auto.id, true);
        }
      };

      if (syncRes !== null) {
        applyResult(syncRes);
      } else {
        asyncTasks.push(
          this.judgeCond(auto.cond, true).then((res) => {
            applyResult(res);
          })
        );
      }
    }

    if (asyncTasks.length > 0) {
      return Promise.all(asyncTasks).then(() => {});
    }
  }

  private judgeAutoCondSync(c: Cond): boolean | null {
    switch (c.t) {
      case 'cmd':
      case 'tests':
      case 'approve':
      case 'llm':
      case 'review':
        return false;
      case 'done': {
        if (!this.lastTurnText) return false;
        const lastLine = this.lastTurnText.trim().split(/\r?\n/).pop()?.trim();
        return lastLine === 'REINS: done';
      }
      case 'same': {
        const len = this.commandResults.length;
        if (len < 2) return false;
        const last1 = this.commandResults[len - 1]!;
        const last2 = this.commandResults[len - 2]!;
        if (last1.exitCode === 0 || last2.exitCode === 0) return false;
        const norm = (s: string) => s.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
        return norm(last1.output) === norm(last2.output);
      }
      case 'attempts': {
        const loopCount = [...this.loopCounters.values()].reduce((a, b) => a + b, 0);
        return loopCount > c.n;
      }
      case 'diff':
        return null;
      case 'touches': {
        const isMatch = picomatch(c.glob);
        return this.events.some((ev) => {
          if (ev.type !== 'tool_call') return false;
          const p = ev.data?.input?.file_path || ev.data?.input?.path;
          return typeof p === 'string' && isMatch(relPath(p, this.cwd ?? ''));
        });
      }
      case 'drift': {
        return (
          repeatedAction(this.events) !== null ||
          stagnation(this.events) !== null ||
          editBeforePlan(this.events) !== null ||
          sameError(this.events) !== null
        );
      }
      case 'not': {
        const res = this.judgeAutoCondSync(c.a);
        return res === null ? null : !res;
      }
      case 'and': {
        const a = this.judgeAutoCondSync(c.a);
        if (a === false) return false;
        if (a === null) return null;
        const b = this.judgeAutoCondSync(c.b);
        return b === null ? null : b;
      }
      case 'or': {
        const a = this.judgeAutoCondSync(c.a);
        if (a === true) return true;
        if (a === null) return null;
        const b = this.judgeAutoCondSync(c.b);
        return b === null ? null : b;
      }
      default:
        return false;
    }
  }

  private async judgeCond(c: Cond, forAutoCard = false): Promise<boolean> {
    if (forAutoCard) {
      if (
        c.t === 'cmd' ||
        c.t === 'tests' ||
        c.t === 'approve' ||
        c.t === 'llm' ||
        c.t === 'review'
      ) {
        return false;
      }
    }

    switch (c.t) {
      case 'approve':
        return false;
      case 'tests': {
        const cmd = this.workflow.test ?? 'npm test';
        const last = this.commandResults[this.commandResults.length - 1];
        if (
          last &&
          last.cmd === cmd &&
          last.exitCode === 0 &&
          this.program[this.programCounter]?.op === 'RUN'
        ) {
          return true;
        }
        const res = await this.commandRunner(cmd);
        this.recordCommandResult(cmd, res.exitCode, res.stdout || res.stderr);
        return res.exitCode === 0;
      }
      case 'cmd': {
        const last = this.commandResults[this.commandResults.length - 1];
        if (
          last &&
          last.cmd === c.cmd &&
          last.exitCode === 0 &&
          this.program[this.programCounter]?.op === 'RUN'
        ) {
          return true;
        }
        const res = await this.commandRunner(c.cmd);
        this.recordCommandResult(c.cmd, res.exitCode, res.stdout || res.stderr);
        return res.exitCode === 0;
      }
      case 'llm':
      case 'review': {
        // Plan 7.3: no judge means "no", everywhere (gate, repeat, if). Never pass by default.
        if (!this.judge) return false;
        const answer = await this.judge(c, { lastText: this.lastTurnText ?? '' });
        this.logEvent('judge', { cond: c, answer });
        return answer;
      }
      case 'done': {
        if (!this.lastTurnText) return false;
        const lastLine = this.lastTurnText.trim().split(/\r?\n/).pop()?.trim();
        return lastLine === 'REINS: done';
      }
      case 'same': {
        const len = this.commandResults.length;
        if (len < 2) return false;
        const last1 = this.commandResults[len - 1]!;
        const last2 = this.commandResults[len - 2]!;
        if (last1.exitCode === 0 || last2.exitCode === 0) return false;
        const norm = (s: string) => s.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
        return norm(last1.output) === norm(last2.output);
      }
      case 'attempts': {
        const loopCount = [...this.loopCounters.values()].reduce((a, b) => a + b, 0);
        return loopCount > c.n;
      }
      case 'diff': {
        if (!this.diffLines) return false;
        const lines = await this.diffLines();
        return lines > c.n;
      }
      case 'touches': {
        const isMatch = picomatch(c.glob);
        return this.events.some((ev) => {
          if (ev.type !== 'tool_call') return false;
          const p = ev.data?.input?.file_path || ev.data?.input?.path;
          return typeof p === 'string' && isMatch(relPath(p, this.cwd ?? ''));
        });
      }
      case 'drift': {
        return (
          repeatedAction(this.events) !== null ||
          stagnation(this.events) !== null ||
          editBeforePlan(this.events) !== null ||
          sameError(this.events) !== null
        );
      }
      case 'not':
        return !(await this.judgeCond(c.a, forAutoCard));
      case 'and': {
        const a = await this.judgeCond(c.a, forAutoCard);
        if (!a) return false;
        return await this.judgeCond(c.b, forAutoCard);
      }
      case 'or': {
        const a = await this.judgeCond(c.a, forAutoCard);
        if (a) return true;
        return await this.judgeCond(c.b, forAutoCard);
      }
      default:
        return false;
    }
  }

  edit(newWorkflow: Workflow) {
    const currentInstr = this.program[this.programCounter];
    const isAtStep = !!(currentInstr && 'step' in currentInstr);
    const currentStepId = isAtStep ? (currentInstr as any).step : this.lastStepId;

    this.workflow = newWorkflow;
    this.program = compileProgram(newWorkflow, this.resolveBlock);

    if (currentStepId) {
      const stepExists = this.findStepById(newWorkflow.steps, currentStepId);
      if (stepExists) {
        const newIdx = this.program.findIndex(
          (i) => 'step' in i && i.step === currentStepId
        );
        if (newIdx !== -1) {
          this.programCounter = isAtStep ? newIdx : newIdx + 1;
        }
      } else {
        this.status = 'paused';
        this.pauseReason = { type: 'step-deleted' };
      }
    }
  }

  snapshot(): RunSnapshot {
    const sessionId = this.engineSession?.sessionId ?? this.resumeSessionId;
    return {
      ...(sessionId ? { sessionId } : {}),
      workflow: JSON.parse(JSON.stringify(this.workflow)),
      programCounter: this.programCounter,
      status: this.status,
      pauseReason: this.pauseReason,
      loopCounters: Object.fromEntries(this.loopCounters),
      linkCounters: Object.fromEntries(this.linkCounters),
      turnOutputs: Object.fromEntries(this.turnOutputs),
      totalTurns: this.totalTurns,
      events: [...this.events],
      pendingCards: [...this.pendingCards],
      autoArmed: Object.fromEntries(this.autoArmed),
      commandResults: [...this.commandResults],
      lastRecallContext: [...this.lastRecallContext],
      lastTurnText: this.lastTurnText,
      loopLimitExtensions: Object.fromEntries(this.loopLimitExtensions),
    };
  }

  static restore(snapshot: RunSnapshot, opts: Partial<RunOptions>): Run {
    const run = new Run({
      workflow: snapshot.workflow,
      engine: opts.engine!,
      resolveBlock: opts.resolveBlock,
      commandRunner: opts.commandRunner,
      now: opts.now,
      judge: opts.judge,
      recall: opts.recall,
      store: opts.store,
      diffLines: opts.diffLines,
      cwd: opts.cwd,
    });

    // Set after construction so the constructor's own run_started is not reported again.
    run.onEvent = opts.onEvent;
    run.resumeSessionId = snapshot.sessionId;
    run.programCounter = snapshot.programCounter;
    run.status = snapshot.status;
    run.pauseReason = snapshot.pauseReason;
    run.loopCounters = new Map(Object.entries(snapshot.loopCounters));
    run.linkCounters = new Map(Object.entries(snapshot.linkCounters));
    run.turnOutputs = new Map(Object.entries(snapshot.turnOutputs));
    run.totalTurns = snapshot.totalTurns;
    run.events = [...snapshot.events];
    run.pendingCards = [...snapshot.pendingCards];
    run.autoArmed = new Map(Object.entries(snapshot.autoArmed));
    run.commandResults = [...snapshot.commandResults];
    run.lastRecallContext = [...snapshot.lastRecallContext];
    if (snapshot.lastTurnText !== undefined) {
      run.lastTurnText = snapshot.lastTurnText;
    }
    if (snapshot.loopLimitExtensions) {
      run.loopLimitExtensions = new Map(Object.entries(snapshot.loopLimitExtensions));
    }

    return run;
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return;
    // Stopped before the interrupt is awaited, so a second stop() meanwhile is a no-op.
    this.status = 'stopped';
    this.logEvent('run_stopped', {});
    await this.engineSession?.interrupt();
  }

  /** End the engine session (the claude process). */
  async close(): Promise<void> {
    const s = this.engineSession;
    this.engineSession = undefined;
    // Keep the id: the snapshot needs it, and a later turn resumes this session.
    if (s) this.resumeSessionId = s.sessionId;
    await s?.close();
  }

  private findStepById(steps: Step[], id: string): Step | undefined {
    for (const s of steps) {
      if (s.id === id) return s;
      if (s.kids) {
        const k = this.findStepById(s.kids, id);
        if (k) return k;
      }
      if (s.else) {
        const e = this.findStepById(s.else, id);
        if (e) return e;
      }
    }
    return undefined;
  }

  async step(): Promise<RunStatus> {
    if (this.status !== 'running') {
      return this.status;
    }

    if (this.programCounter >= this.program.length) {
      this.status = 'done';
      this.logEvent('run_finished', {});
      return this.status;
    }

    const instr = this.program[this.programCounter]!;

    switch (instr.op) {
      case 'RECALL': {
        if (!this.recall) {
          this.lastRecallContext = [];
          this.logEvent('recall', { topics: instr.topics, skipped: 'no recall function' });
        } else {
          this.lastRecallContext = await this.recall(instr.topics);
          this.logEvent('recall', { topics: instr.topics, context: this.lastRecallContext });
        }
        this.programCounter++;
        return this.status;
      }

      case 'GATE': {
        if (instr.cond.t !== 'approve') {
          const passed = await this.judgeCond(instr.cond);
          if (passed) {
            this.programCounter++;
            return this.status;
          }
        }
        this.status = 'paused';
        this.pauseReason = { type: 'gate', stepId: instr.step, cond: instr.cond };
        this.logEvent('gate_paused', { step: instr.step, cond: instr.cond });
        return this.status;
      }

      case 'IF': {
        const passed = await this.judgeCond(instr.cond);
        if (passed) {
          this.programCounter++;
        } else {
          this.programCounter = instr.elseJump;
        }
        return this.status;
      }

      case 'TURN': {
        this.lastStepId = instr.step;
        // Check turn budget
        if (this.workflow.budget.turns && this.totalTurns >= this.workflow.budget.turns) {
          this.status = 'paused';
          this.pauseReason = { type: 'run-turn-budget-used' };
          return this.status;
        }

        this.currentPolicy = instr.policy;
        const session = await this.ensureSession();

        // Find step model
        const rawStep = instr.src ?? this.findStepById(this.workflow.steps, instr.step);
        const stepModel: Step = rawStep || {
          id: instr.step,
          kind: 'phase',
          attrs: {},
          cards: instr.policy.guards.map((g) => ({ kind: 'guard', text: g })),
          links: [],
        };

        // Plan 6.5: everything queued before the turn goes into its text, exactly once.
        // Cards queued while the turn runs are drained by the engine at its next tool event.
        const textCards = [...this.pendingCards];
        this.pendingCards = [];

        for (const card of textCards) {
          this.logEvent('card_delivered', { card, channel: 'next-turn' });
        }

        const stepToCompile: Step = {
          ...stepModel,
          cards: [
            ...stepModel.cards,
            ...textCards.map((c) => ({ kind: 'note' as const, text: c })),
          ],
        };

        const recallCtx = [...this.lastRecallContext];
        this.lastRecallContext = [];

        const turnText = compileTurn(stepToCompile, {
          workflowName: this.workflow.name,
          stepIndex: instr.top ?? 0,
          totalSteps: this.workflow.steps.length,
          always: this.workflow.always,
          recallContext: recallCtx.length > 0 ? recallCtx : undefined,
        });

        const result = await this.runTurn(session, instr.step, turnText);
        if (!result) return this.status;
        this.turnOutputs.set(instr.step, result.text);

        await this.checkAutoCards();

        // Check if agent said blocked
        if (result.text.includes('REINS: blocked:')) {
          const match = result.text.match(/REINS: blocked:\s*(.*)/);
          this.status = 'paused';
          this.pauseReason = {
            type: 'agent-blocked',
            reason: match ? match[1] : 'blocked',
          };
          return this.status;
        }

        this.programCounter++;

        // Check if turn limit reached right after turn
        if (this.workflow.budget.turns && this.totalTurns >= this.workflow.budget.turns) {
          this.status = 'paused';
          this.pauseReason = { type: 'run-turn-budget-used' };
          return this.status;
        }

        return this.status;
      }

      case 'LOOP_IN': {
        this.programCounter++;
        return this.status;
      }

      case 'RUN': {
        const cmdRes = await this.commandRunner(instr.cmd);
        this.recordCommandResult(instr.cmd, cmdRes.exitCode, cmdRes.stdout || cmdRes.stderr);

        if (cmdRes.exitCode === 0) {
          if (instr.repeatCond && instr.loopExit !== undefined) {
            const passed = await this.judgeCond(instr.repeatCond);
            if (passed) {
              this.programCounter = instr.loopExit;
              return this.status;
            }
          }
          if (instr.onPassJump !== undefined) {
            this.programCounter = instr.onPassJump;
          } else {
            this.programCounter++;
          }
        } else {
          if (instr.onFailJump !== undefined) {
            this.programCounter = instr.onFailJump;
          } else {
            this.programCounter++;
          }
        }
        return this.status;
      }

      case 'LOOP_BK': {
        if (instr.cond && (await this.judgeCond(instr.cond))) {
          this.programCounter++;
          return this.status;
        }

        const attempts = (this.loopCounters.get(instr.step) || 0) + 1;
        this.loopCounters.set(instr.step, attempts);
        this.logEvent('loop_iteration', { step: instr.step, attempts });

        // Find loop_in instruction for max
        const loopIn = this.program.find(
          (i) => i.op === 'LOOP_IN' && i.step === instr.step
        ) as { op: 'LOOP_IN'; max: number } | undefined;
        const baseMax = loopIn?.max || 5;
        const extra = this.loopLimitExtensions.get(instr.step) || 0;
        const max = baseMax + extra;

        if (attempts >= max) {
          this.status = 'paused';
          this.pauseReason = {
            type: 'budget-used',
            stepId: instr.step,
            limit: max,
          };
          this.logEvent('loop_budget_exceeded', { step: instr.step, attempts, max });
          return this.status;
        }

        this.programCounter = instr.target;
        return this.status;
      }

      case 'VERIFY': {
        const session = await this.ensureSession();
        const againstOutput = this.turnOutputs.get(instr.against) || '';

        const verifyStep: Step = {
          id: instr.step,
          kind: 'verify',
          title: 'verify',
          attrs: { against: instr.against },
          cards: [],
          links: [],
          prompt: `Compare what you built against step "${instr.against}":\n${againstOutput}\nList anything missing or extra.`,
        };

        const turnText = compileTurn(verifyStep, {
          workflowName: this.workflow.name,
          stepIndex: instr.top ?? 0,
          totalSteps: this.workflow.steps.length,
          always: this.workflow.always,
        });

        const result = await this.runTurn(session, instr.step, turnText);
        if (!result) return this.status;

        const isFail = result.text.includes('REINS: fail');
        this.logEvent('verify_result', { pass: !isFail });

        if (isFail && instr.onFailJump !== undefined) {
          const linkKey = `${instr.step}->${instr.onFailJump}`;
          const jumps = (this.linkCounters.get(linkKey) || 0) + 1;
          this.linkCounters.set(linkKey, jumps);

          if (instr.linkMax !== undefined && jumps > instr.linkMax) {
            this.status = 'paused';
            this.pauseReason = {
              type: 'link-budget-used',
              limit: instr.linkMax,
            };
            this.logEvent('link_budget_exceeded', { linkKey, jumps, max: instr.linkMax });
            return this.status;
          }

          this.programCounter = instr.onFailJump;
          return this.status;
        }

        this.programCounter++;
        return this.status;
      }

      case 'STORE': {
        const session = await this.ensureSession();
        const storeStep: Step = {
          id: instr.step,
          kind: 'store',
          title: 'store',
          attrs: { what: instr.what },
          cards: [],
          links: [],
          prompt: `Provide a one-paragraph decision summary for "${instr.what}".`,
        };

        const turnText = compileTurn(storeStep, {
          workflowName: this.workflow.name,
          stepIndex: instr.top ?? 0,
          totalSteps: this.workflow.steps.length,
          always: this.workflow.always,
        });

        const result = await this.runTurn(session, instr.step, turnText);
        if (!result) return this.status;

        const summary = result.text
          .split(/\r?\n/)
          .filter((line) => !/^\s*REINS:\s*/.test(line))
          .join('\n')
          .trim();

        if (this.storeFn) {
          await this.storeFn(instr.what, summary);
          this.logEvent('store', { what: instr.what, summary });
        } else {
          this.logEvent('store', { what: instr.what, skipped: 'no store function' });
        }

        this.programCounter++;
        return this.status;
      }

      case 'HANDOFF': {
        const session = await this.ensureSession();
        let prompt = 'Provide a hand-off summary: what changed, what is unverified.';
        if (instr.focus) {
          prompt += `\nFocus: ${instr.focus}`;
        }

        const handoffStep: Step = {
          id: instr.step,
          kind: 'handoff',
          title: 'handoff',
          attrs: { to: instr.to, ...(instr.focus ? { focus: instr.focus } : {}) },
          cards: [],
          links: [],
          prompt,
        };

        const turnText = compileTurn(handoffStep, {
          workflowName: this.workflow.name,
          stepIndex: instr.top ?? 0,
          totalSteps: this.workflow.steps.length,
          always: this.workflow.always,
        });

        const result = await this.runTurn(session, instr.step, turnText);
        if (!result) return this.status;

        const summary = result.text
          .split(/\r?\n/)
          .filter((line) => !/^\s*REINS:\s*/.test(line))
          .join('\n')
          .trim();

        this.logEvent('handoff', { to: instr.to, summary });
        this.programCounter++;
        return this.status;
      }

      case 'JUMP': {
        this.programCounter = instr.target;
        return this.status;
      }

      case 'END': {
        this.status = 'done';
        this.logEvent('run_finished', {});
        return this.status;
      }
    }
  }
}
