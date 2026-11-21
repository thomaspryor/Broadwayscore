// LIVE-DATA-LANE: reads data/shows.json (read by the test); data/tour-schedules.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-4776 acceptance entry point. The live-data workflow already runs this suite.
import './tour-runtime-coverage.test.mjs';
