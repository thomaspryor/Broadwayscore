// shows-json-empty-fixture.mjs (BRO-8123): side-effect import for tests whose only
// live read is data/shows.json through the shared guards. Import it FIRST so the
// empty fixture is in place before any module under test loads shows.json.
// Restores SHOWS_JSON_PATH and deletes the temp file when the process exits.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.on('exit', require('./shows-json-fixture.js').useShowsFixture([]));
