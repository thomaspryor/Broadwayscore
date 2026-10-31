import nextVitals from 'eslint-config-next/core-web-vitals';

// Keep the existing Hooks checks during the framework upgrade. React Compiler
// is not enabled in this app; adopting its additional rules is a separate change.
const existingHooksRules = new Set(['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps']);
const compilerRules = Object.fromEntries(nextVitals.flatMap(config =>
  Object.keys(config.rules || {})
    .filter(rule => rule.startsWith('react-hooks/') && !existingHooksRules.has(rule))
    .map(rule => [rule, 'off'])
));

export default [...nextVitals, {
  rules: {
    ...compilerRules,
    // Next 16 adds this navigation preference; retain the existing lint policy.
    '@next/next/no-location-assign-relative-destination': 'off',
  },
  linterOptions: { reportUnusedDisableDirectives: false },
}];
