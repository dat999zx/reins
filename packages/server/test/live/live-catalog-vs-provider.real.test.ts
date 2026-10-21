// Row 10 of the live checks (read-only): Reins's own live model list (live-models.ts, through the host's send) against the catalog manifest of each
// provider. A report, not a pass or fail on the catalog: the only assertion is that the call works. In dry mode the fake answers with a scripted list
// so the comparison itself is proved.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hostSend, liveListSource } from '../../src/engines.js';
import { createLiveModels } from '../../src/live-models.js';
import { LONG, catalogIds, liveSuite, startWorld, type Provider, type World } from './live-harness.js';

const SHOWN = 60;
const EXTRA = 'extra-live-model-1';

for (const provider of ['anthropic', 'gemini', 'openrouter'] as Provider[]) {
  const catalog = catalogIds(provider);
  liveSuite(`row 10: ${provider}, the catalog against the provider's own model list`, { key: provider }, () => {
    let w: World;
    beforeAll(async () => {
      // Dry: the list is the catalog without its last model, plus one the catalog does not have.
      w = await startWorld({ provider, model: catalog[0]!, list: [...catalog.slice(0, -1), EXTRA] });
      await w.consent();
    }, LONG);
    afterAll(async () => { await w?.close(); }, LONG);

    it('fetches the list through Reins\'s own path and reports the differences', async () => {
      const host = { env: w.env, home: w.dir };
      const sender = hostSend(w.mods, host, (id, origin) => w.store.hasConsent(id, origin), w.redactor);
      const live = createLiveModels({
        ...liveListSource(w.mods, { ...host, send: sender.send!, redact: sender.redact! }),
        consented: (id) => w.store.hasConsent(id, new URL(w.manifest.baseUrl).origin),
        holdsSecret: (t) => w.redactor.has(t),
      });
      await live.refresh(provider);
      const ids = [...live.ids(provider)];
      expect(ids.length, 'the provider answered with no model list: the call did not work').toBeGreaterThan(0);

      const missing = catalog.filter((id) => !ids.includes(id));
      const extra = ids.filter((id) => !catalog.includes(id));
      if (w.fake) {
        expect(missing).toEqual([catalog.at(-1)]);
        expect(extra).toEqual([EXTRA]);
        expect(w.fake.listRequests()).toHaveLength(1);
      }
      expect(w.sweepAll().hits).toEqual([]);
      w.evidence({
        row: `10 ${provider}`, pass: true,
        counts: { catalogModels: catalog.length, providerModels: ids.length, inCatalogNotInProviderList: missing.length, inProviderListNotInCatalog: extra.length },
        notes: [
          `in the catalog but NOT in the provider's list: ${missing.length ? missing.join(', ') : 'none'}`,
          `in the provider's list but not in the catalog (first ${SHOWN} of ${extra.length}): ${extra.slice(0, SHOWN).join(', ') || 'none'}`,
          'read-only: one GET of the model list; no model was called',
        ],
      });
    }, LONG);
  });
}
