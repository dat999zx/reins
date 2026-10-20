import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostSend, startMods } from '../src/engines.js';
import type { Mods } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

const KEY1 = 'sk-first-0123456789abcdef';
const KEY2 = 'sk-second-0123456789abcdef';

let home: ReturnType<typeof tempHome>;
let mods: Mods;
const env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  delete env.P_API_KEY;
  home = tempHome();
  home.writeMod('p', {
    reins: 1, id: 'p', kind: 'provider', version: '1', label: 'P', protocol: 'openai-chat', baseUrl: 'https://api.example.com/v1',
    auth: { style: 'bearer', keyEnv: ['P_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }],
  });
  mods = await startMods({ dir: home.home, env });
});
afterEach(() => {
  mods.dispose();
  home.cleanup();
});

describe('the production host redacts what the env holds now', () => {
  it('a key set in the env after the host was made is hidden, a changed value follows, and a replaced or removed one stays hidden', () => {
    const h = hostSend(mods, { env, home: home.home });
    expect(mods.problems).toEqual([]);
    expect(h.redact!(`say ${KEY1}`)).toBe(`say ${KEY1}`); // not set yet, and the redactor is built now
    env.P_API_KEY = KEY1;
    expect(h.redact!(`say ${KEY1}`)).toBe('say [key P_API_KEY]');
    env.P_API_KEY = KEY2;
    expect(h.redact!(`${KEY1} ${KEY2}`)).toBe('[key P_API_KEY] [key P_API_KEY]'); // a replaced value stays hidden (Task 21 fix round)
    delete env.P_API_KEY;
    expect(h.redact!(`${KEY2} x`)).toBe('[key P_API_KEY] x');                     // and so does a removed one
  });

  it('the send of that host hides it in an error too', async () => {
    const h = hostSend(mods, { env, home: home.home });
    env.P_API_KEY = KEY1;
    const m = (mods.registry.get<{ manifest: never }>('provider', 'p') as { manifest: never }).manifest;
    const e = await h.send!(m, 'https://other.example.net/v1', { method: 'POST' }).then(() => undefined, (x: Error) => x);
    expect(e?.message).not.toContain(KEY1);
  });
});