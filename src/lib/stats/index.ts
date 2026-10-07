/**
 * Show Stats reducers — pure functions, no I/O, no React, no classes.
 *
 * These are written once here and consumed by the web stats view directly and
 * by the iOS app via the vendoring + checksum-drift pattern. Every reducer
 * takes its data as arguments; nothing in this directory reads the filesystem
 * or the network.
 *
 * Deliberately NOT named "engine" — engine.ts already means critic scoring.
 */

export * from './types';
export * from './parse';
export * from './venue-match';
export * from './season-windows';
export * from './diary-stats';
export * from './align-critics';
export * from './theater-completion';
export * from './canon-progress';
export * from './ratings-histogram';
