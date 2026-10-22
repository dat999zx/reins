// The app project's setup: KINDS is filled the way the app fills it from `GET /api/kinds`, from the same builder the route uses (core's views).
// A test that needs a mod's block adds its view with `registerView` or `setKinds`. Core and server tests have no such setup (vitest.config.ts).
import { servedKinds } from '../../server/src/mods/kinds-view.js';
import { setKinds } from '../src/canvasKinds.js';

setKinds(servedKinds().kinds);
