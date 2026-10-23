import type { NodeType } from './index.js';

declare module '../model.js' {
  interface NodeKinds { model: true }
}

// ponytail: the model in use is the last model step the run passed (program order); a host without switchModel (the terminal) runs on its own model, the slice still applies.
const model: NodeType = {
  kind: 'model',
  attrs: ['usd', 'reasoning'],
  heading: {
    owns: ['model'],
    parse(arg, step, ctx) {
      // Lines are parsed before the heading, so a model: line is already in attrs.
      if (step.attrs.model !== undefined) ctx.push({ severity: 'error', message: 'A model block names its model in its heading (## model <id>), not in a model: line.', pos: { line: ctx.line, col: ctx.col } });
      step.attrs.model = arg;
      return false;
    },
    print(step) { return { text: step.attrs.model ? `model ${step.attrs.model}` : 'model', condInHeading: false }; },
  },
  validate: {
    early(step, ctx) {
      if (!step.attrs.model && !step.attrs.reasoning) {
        ctx.push({ severity: 'warning', pos: ctx.pos, message: step.attrs.usd === undefined
          ? `\`${step.id}\` names no model and has no USD budget: it does nothing.`
          : `\`${step.id}\` names no model, so it only opens its USD budget.` });
      }
      if (step.cards.length || step.prompt) ctx.push({ severity: 'warning', message: 'a model step sends no turn; its cards and prompt do nothing', pos: ctx.pos });
    },
  },
  compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'model', src: step }); },
  async exec(step, ctx) {
    const want = step.attrs.model;
    let kept = false;
    if (want) {
      const r = ctx.switchModel ? await ctx.switchModel(want, step.id) : undefined;
      if (r?.to === 'stop') { await ctx.stop(); return 'stay'; }
      if (r?.to === 'closed') { ctx.pause('the switch question was closed before it was answered; Resume asks it again'); return 'stay'; }
      ctx.log('model_switched', { step: step.id, model: want, ...(r ? { how: r.to, label: r.label } : { how: 'unsupported' }) });
      kept = r?.to === 'kept';
    }
    // A kept model keeps the block's reasoning out too: the user chose to stay as they were.
    if (step.attrs.reasoning && !kept) ctx.setReasoning?.(step.attrs.reasoning, step.id);
    ctx.slice(step.id, step.attrs.usd === undefined ? undefined : Number(step.attrs.usd));
    return 'next';
  },
  print: { model_switched: (d) => (d.how === 'unsupported' ? `· ${d.step}: this runner cannot switch models; the steps run on the CLI's model` : undefined) },
};
export default model;
