// BRO-6417 acceptance entrypoint: the voice tests (every caption builder ends with an open question) live in
// scripts/social-autopost.test.mjs, which CI collects. Importing it here runs the same suite.
import '../social-autopost.test.mjs';
