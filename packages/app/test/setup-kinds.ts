// The app project's setup: the default pack is loaded (`app-pack.ts`, the way the server loads it), so the kinds are in core's registry, and the kinds,
// conditions, cards and question cards are filled the way the app fills them from `GET /api/kinds`, from the same builder the route uses. A test that needs a
// mod's block adds its view with `registerView` or `setKinds`. Core's project registers the pack with its own setup (`setup-pack.ts`); the server's tests use
// `pack-helper.ts`. This setup runs once per test file and the registrations die with the file's module registry.
import { served } from './app-pack.js';
import { setCards, setKinds } from '../src/canvasKinds.js';
import { setConds } from '../src/condKinds.js';
import { setQuestions } from '../src/questions.js';

const reply = served();
setKinds(reply.kinds);
setConds(reply.conds);
setCards(reply.cards);
setQuestions(reply.questions);
