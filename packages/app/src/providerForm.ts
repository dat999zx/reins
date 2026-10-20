// The custom endpoint form (spec 7.5) as plain data: form <-> manifest fields, and the server's words mapped to the field they are about.
// The key is a form field only: it goes to the key route (or the `key` of the add request), never into the manifest.
export type AuthStyle = 'bearer' | 'header' | 'none';
export interface ModelRow {
  id: string; context: string; maxOutput: string; tools: '' | 'yes' | 'no'; priceIn: string; priceOut: string;
  /** Model fields the form does not show (label, efforts, body), kept so an edit does not drop them. */
  extra: Record<string, unknown>;
  /** Price fields the form does not show (cacheRead, cacheWrite). */
  priceExtra: Record<string, unknown>;
}
export interface EffortRow { id: string; label: string; body: string }
export interface ProviderForm {
  label: string; id: string; protocol: string; baseUrl: string; modelsUrl: string;
  auth: AuthStyle; header: string; keyEnv: string; key: string;
  models: ModelRow[]; defaultModel: string; priceIn: string; priceOut: string;
  efforts: EffortRow[]; defaultEffort: string;
}
type Obj = Record<string, unknown>;

export const emptyModel = (): ModelRow => ({ id: '', context: '', maxOutput: '', tools: '', priceIn: '', priceOut: '', extra: {}, priceExtra: {} });
export const emptyForm = (protocol = ''): ProviderForm => ({
  label: '', id: '', protocol, baseUrl: '', modelsUrl: '', auth: 'bearer', header: '', keyEnv: '', key: '',
  models: [emptyModel()], defaultModel: '', priceIn: '', priceOut: '', efforts: [], defaultEffort: '',
});

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const numText = (v: unknown) => (typeof v === 'number' ? String(v) : '');
const names = (s: string) => s.split(/[\s,]+/).filter(Boolean);

export function manifestToForm(m: unknown): ProviderForm {
  const raw: Obj = isObj(m) ? m : {};
  const auth = isObj(raw.auth) ? raw.auth : {};
  const price = isObj(raw.price) ? raw.price : {};
  const models = (Array.isArray(raw.models) ? raw.models : []).filter(isObj).map((x): ModelRow => {
    const p = isObj(x.price) ? x.price : {};
    const { id, context, maxOutput, tools, price: _p, ...extra } = x;
    const { input, output, ...priceExtra } = p;
    return {
      id: str(id), context: numText(context), maxOutput: numText(maxOutput), tools: tools === true ? 'yes' : tools === false ? 'no' : '',
      priceIn: numText(input), priceOut: numText(output), extra, priceExtra,
    };
  });
  const efforts = (Array.isArray(raw.efforts) ? raw.efforts : []).filter(isObj).map((e): EffortRow => ({
    id: str(e.id), label: str(e.label), body: e.body === undefined ? '' : JSON.stringify(e.body),
  }));
  return {
    label: str(raw.label), id: str(raw.id), protocol: str(raw.protocol), baseUrl: str(raw.baseUrl), modelsUrl: str(raw.modelsUrl),
    auth: auth.style === 'header' || auth.style === 'none' ? auth.style : 'bearer', header: str(auth.header),
    keyEnv: (Array.isArray(auth.keyEnv) ? auth.keyEnv.filter((n): n is string => typeof n === 'string') : []).join(', '), key: '',
    models, defaultModel: str(raw.defaultModel), priceIn: numText(price.input), priceOut: numText(price.output),
    efforts, defaultEffort: str(raw.defaultEffort),
  };
}

/** The manifest fields a custom endpoint is added with (the shape `POST /api/mods/custom` takes, minus `key`), and a plain line per field the form text cannot make. */
export function formToManifest(f: ProviderForm): { manifest: Obj; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const num = (text: string, field: string, what: string): number | undefined => {
    const t = text.trim();
    if (t === '') return undefined;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    errors[field] ??= `${what} must be a number (got "${t.slice(0, 20)}").`;
    return undefined;
  };
  const m: Obj = { id: f.id.trim(), label: f.label.trim(), protocol: f.protocol, baseUrl: f.baseUrl.trim() };
  if (f.modelsUrl.trim()) m.modelsUrl = f.modelsUrl.trim();
  m.auth = { style: f.auth, keyEnv: f.auth === 'none' ? [] : names(f.keyEnv), ...(f.auth === 'header' ? { header: f.header.trim() } : {}) };
  m.defaultModel = f.defaultModel.trim();  m.models = f.models.filter((r) => r.id.trim() || r.context || r.maxOutput || r.priceIn || r.priceOut).map((r) => {
    const o: Obj = { id: r.id.trim(), ...r.extra };
    const context = num(r.context, 'models', 'A window');
    const maxOutput = num(r.maxOutput, 'models', 'A max output');
    if (context !== undefined) o.context = context;
    if (maxOutput !== undefined) o.maxOutput = maxOutput;
    if (r.tools) o.tools = r.tools === 'yes';
    const input = num(r.priceIn, 'models', 'A price');
    const output = num(r.priceOut, 'models', 'A price');
    if (input !== undefined || output !== undefined || Object.keys(r.priceExtra).length) {
      o.price = { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}), ...r.priceExtra };
    }
    return o;
  });
  const input = num(f.priceIn, 'price', 'The price');
  const output = num(f.priceOut, 'price', 'The price');
  if (input !== undefined || output !== undefined) m.price = { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
  const efforts = f.efforts.filter((e) => e.id.trim() || e.label.trim() || e.body.trim()).map((e) => {
    const o: Obj = { id: e.id.trim(), label: e.label.trim() };
    if (e.body.trim()) {
      try {
        const body: unknown = JSON.parse(e.body);
        if (isObj(body)) o.body = body;
        else errors.efforts ??= `The body of effort "${e.id.trim()}" must be a JSON object, like {"reasoning_effort": "high"}.`;
      } catch (err) {
        errors.efforts ??= `The body of effort "${e.id.trim()}" is not valid JSON (${(err as Error).message.slice(0, 80)}).`;
      }
    }
    return o;
  });
  if (efforts.length) m.efforts = efforts;
  if (f.defaultEffort.trim()) m.defaultEffort = f.defaultEffort.trim();
  return { manifest: m, errors };
}

const EDIT_KEYS = ['label', 'baseUrl', 'modelsUrl', 'auth', 'defaultModel', 'models', 'price', 'efforts', 'defaultEffort'] as const;
/** The body of `PUT /api/mods/:id`: the fields the form owns, with `null` for one the user emptied. `id` and `protocol` cannot change, so they are left out. */
export function editBody(f: ProviderForm, original: unknown): { body: Obj; errors: Record<string, string> } {
  const { manifest, errors } = formToManifest(f);
  const was: Obj = isObj(original) ? original : {};
  const body: Obj = {};
  for (const k of EDIT_KEYS) {
    if (manifest[k] !== undefined) body[k] = manifest[k];
    else if (was[k] !== undefined) body[k] = null;
  }
  return { body, errors };
}

/** The form field a plain server word is about. A `models.<id>.price` word belongs to `models`. */
const FIELD_OF: Record<string, string> = {
  label: 'label', id: 'id', protocol: 'protocol', baseUrl: 'baseUrl', modelsUrl: 'modelsUrl', auth: 'auth', 'auth.style': 'auth',
  'auth.keyEnv': 'keyEnv', 'auth.header': 'header', defaultModel: 'defaultModel', models: 'models', price: 'price',
  efforts: 'efforts', defaultEffort: 'defaultEffort', key: 'key',
};
const BY_SENTENCE: Array<[RegExp, string]> = [[/^The id must/, 'id'], [/^(The key |A key was given)/, 'key']];

export function errorsByField(problems: string[]): { byField: Record<string, string[]>; general: string[] } {
  const byField: Record<string, string[]> = {};
  const general: string[] = [];
  for (const p of problems) {
    const text = p.replace(/^`[^`]*`: /, '');
    const token = /`([A-Za-z][\w.[\]-]*)`/.exec(text)?.[1];
    const head = token && (FIELD_OF[token] ?? FIELD_OF[token.split('.').slice(0, 2).join('.')] ?? FIELD_OF[token.split('.')[0]!]);
    const field = BY_SENTENCE.find(([re]) => re.test(text))?.[1] ?? head;
    if (field) (byField[field] ??= []).push(text);
    else general.push(text);
  }
  return { byField, general };
}
