// The app project's setup: the kinds, conditions, cards and question cards are filled the way the app fills them from `GET /api/kinds`, from the same
// builder the route uses (core's data). A test that needs a mod's block adds its view with `registerView` or `setKinds`. Core and server tests have no
// such setup (vitest.config.ts).
import { servedKinds } from '../../server/src/mods/kinds-view.js';
import { setCards, setKinds } from '../src/canvasKinds.js';
import { setConds } from '../src/condKinds.js';
import { setQuestions } from '../src/questions.js';

const served = servedKinds();
setKinds(served.kinds);
setConds(served.conds);
setCards(served.cards);
setQuestions(served.questions);
