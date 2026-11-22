'use strict';

const fs = require('node:fs');
const path = require('node:path');

// BRO-5783: scripts/ also contains the worker fleet and landing tools. They
// cannot affect a site build unless a build entry point loads them. Trace the
// merged tree, including prebuild, instead of maintaining an exclusion list.
// An unreadable file, unresolved local import, or dynamic code load leaves the
// graph unknown (null), preserving land's broad scripts/ classification.
function collectBuildScriptDependencies(root) {
  try {
    const ts = require('typescript');
    root = path.resolve(root);
    const pending = [];
    const seen = new Set();
    const scripts = new Set();
    const code = /\.(?:[cm]?js|jsx|ts|tsx|sh)$/;
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== '__tests__') walk(f);
        else if (e.isFile() && code.test(f) && !/\.test\.[^.]+$/.test(f)) pending.push(f);
      }
    };
    walk(path.join(root, 'src'));
    for (const f of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'tailwind.config.ts', 'tailwind.config.js', 'scripts/prebuild.sh']) {
      if (fs.existsSync(path.join(root, f))) pending.push(path.join(root, f));
    }
    const commands = fs.existsSync(path.join(root, 'package.json'))
      ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {} : {};
    const add = (file, specifier) => {
      if (specifier.endsWith('.json')) return; // Includes gitignored build manifests.
      let base;
      if (specifier.startsWith('.')) base = path.resolve(path.dirname(file), specifier);
      else if (specifier.startsWith('@/')) base = path.join(root, 'src', specifier.slice(2));
      else if (specifier.startsWith('scripts/')) base = path.join(root, specifier);
      else return; // Package changes still arm the build via package-lock.json.
      const resolved = [base, ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '/index.js', '/index.ts', '/index.tsx'].map(s => base + s)]
        .find(f => fs.existsSync(f) && fs.statSync(f).isFile());
      if (!resolved) throw new Error(`unresolved build import: ${specifier}`);
      if (/\.test\.[^.]+$/.test(resolved)) return; // Tests never run in a site build (the root walk skips them too).
      pending.push(resolved);
    };
    const commandSeen = new Set();
    const addCommand = command => {
      if (!command || commandSeen.has(command)) return;
      commandSeen.add(command);
      if (/\b(?:node|bash|source)\s+["']?\$/.test(command)) throw new Error('dynamic build command');
      for (const m of command.matchAll(/\bscripts\/[\w./-]+\.(?:[cm]?js|sh)\b/g)) add(path.join(root, 'package.json'), m[0]);
      for (const m of command.matchAll(/\bnpm\s+run(?:-script)?\s+([\w:-]+)/g)) {
        if (!commands[m[1]]) throw new Error('unknown build command');
        addCommand(commands[m[1]]);
      }
    };
    for (const name of ['prebuild', 'build', 'postbuild']) addCommand(commands[name]);
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel.startsWith('scripts/')) scripts.add(rel);
      if (!code.test(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (file.endsWith('.sh')) {
        // `# build-deps-file: none | scripts/a.js, scripts/b.sh` declares what this
        // script's computed `node "$var"` / `source "$var"` invocations can run.
        const declared = /^\s*#\s*build-deps-file:\s*(.+)$/m.exec(source);
        if (declared) declared[1].split(',').map(x => x.trim()).filter(x => x && x !== 'none').forEach(spec => add(file, spec));
        for (const line of source.split('\n')) {
          if (line.trim().startsWith('#')) continue;
          if (declared && /\b(?:node|bash|source)\s+["']?\$/.test(line)) { commandSeen.add(line); }
          addCommand(line);
        }
        continue;
      }
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      if (ast.parseDiagnostics.length) throw new Error('unparseable build source');
      const loaders = new Set(['require']);
      const factories = new Set(['createRequire']);
      const findFactories = n => {
        if (ts.isImportSpecifier(n) && (n.propertyName || n.name).text === 'createRequire') factories.add(n.name.text);
        ts.forEachChild(n, findFactories);
      };
      findFactories(ast);
      const findLoaders = n => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          if (ts.isCallExpression(n.initializer) && (factories.has(n.initializer.expression.getText(ast)) ||
            ts.isPropertyAccessExpression(n.initializer.expression) && n.initializer.expression.name.text === 'createRequire')) {
            if (n.initializer.arguments.length !== 1 || n.initializer.arguments[0].getText(ast) !== 'import.meta.url') throw new Error('unknown require base');
            loaders.add(n.name.text);
          }
          else if (ts.isIdentifier(n.initializer) && loaders.has(n.initializer.text)) loaders.add(n.name.text);
        }
        ts.forEachChild(n, findLoaders);
      };
      findLoaders(ast);
      const isBarePackageResolve = a => ts.isCallExpression(a) && ts.isPropertyAccessExpression(a.expression) &&
        a.expression.name.text === 'resolve' && loaders.has(a.expression.expression.getText(ast)) &&
        a.arguments.length >= 1 && ts.isStringLiteralLike(a.arguments[0]) && !/^(?:\.|\/|@\/|scripts\/)/.test(a.arguments[0].text);
      // const wrap = (name) => require(name): a computed load is safe to trace when
      // wrap is a local const and every call site passes a string literal.
      const wrapperLoads = a => {
        if (!ts.isIdentifier(a)) return null;
        let fn = a.parent;
        while (fn && !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) fn = fn.parent;
        if (!fn || fn.parameters.length !== 1 || fn.parameters[0].name.getText(ast) !== a.text) return null;
        const decl = fn.parent;
        if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null;
        const calls = [];
        let ok = true;
        const find = c => {
          if (ts.isIdentifier(c) && c.text === decl.name.text && c !== decl.name) {
            const call = c.parent;
            if (ts.isCallExpression(call) && call.expression === c && call.arguments.length === 1 && ts.isStringLiteralLike(call.arguments[0])) calls.push(call.arguments[0].text);
            else ok = false;
          }
          ts.forEachChild(c, find);
        };
        find(ast);
        return ok ? calls : null;
      };
      // `// build-deps: scripts/a.js, scripts/b.js` on the load's line (or the line
      // above), or `build-deps-file:` anywhere in the file, declares the targets of a computed load the scanner cannot see.
      // `build-deps: none` declares a load of code from another tree (not this repo's).
      const declaredDeps = n => {
        const whole = /build-deps-file:\s*([^\n]+)/.exec(source);
        if (whole) return whole[1].split(',').map(x => x.trim()).filter(Boolean);
        const lines = source.split('\n');
        const at = ast.getLineAndCharacterOfPosition(n.getStart(ast)).line;
        for (const l of [lines[at], lines[at - 1]]) {
          const m = /build-deps:\s*([^\n]+)/.exec(l || '');
          if (m) return m[1].split(',').map(x => x.trim()).filter(Boolean);
        }
        return null;
      };
      // require(SHOWS_PATH) where SHOWS_PATH is a same-file const ending in .json.
      const isJsonConst = a => {
        if (!ts.isIdentifier(a)) return false;
        let found = null;
        const find = c => {
          if (ts.isVariableDeclaration(c) && ts.isIdentifier(c.name) && c.name.text === a.text && c.initializer) found = c.initializer;
          ts.forEachChild(c, find);
        };
        find(ast);
        if (!found) return false;
        if (ts.isStringLiteralLike(found)) return found.text.endsWith('.json');
        return ts.isCallExpression(found) && found.expression.getText(ast) === 'path.join' && found.arguments.length > 0 &&
          ts.isStringLiteralLike(found.arguments.at(-1)) && found.arguments.at(-1).text.endsWith('.json');
      };
      const visit = n => {
        if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && ['eval', 'Function'].includes(n.expression.getText(ast)) && !declaredDeps(n)) throw new Error('computed build code');
        // createRequire(import.meta.url)('./x.js'): a one-shot load with a literal target.
        if (ts.isCallExpression(n) && ts.isCallExpression(n.expression) && factories.has(n.expression.expression.getText(ast)) &&
          n.expression.arguments.length === 1 && n.expression.arguments[0].getText(ast) === 'import.meta.url' &&
          n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])) add(file, n.arguments[0].text);
        else if (ts.isCallExpression(n) && (ts.isCallExpression(n.expression) && factories.has(n.expression.expression.getText(ast)) ||
          ts.isElementAccessExpression(n.expression) && /require/i.test(n.expression.argumentExpression.getText(ast)))) throw new Error('indirect build loader');
        // A bare 'scripts/' (or any trailing-slash directory prefix) names no file;
        // only file-like literals can be dependencies.
        if (ts.isStringLiteralLike(n) && /^scripts\/[^\s*]*\.(?:[cm]?js|ts|tsx|sh)$/.test(n.text)) add(file, n.text);
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) add(file, n.moduleSpecifier.text);
        if (ts.isExternalModuleReference(n) && n.expression && ts.isStringLiteralLike(n.expression)) add(file, n.expression.text);
        if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(n.expression) && loaders.has(n.expression.text) ||
          ts.isPropertyAccessExpression(n.expression) && ['require', 'resolve'].includes(n.expression.name.text) &&
          (n.expression.expression.getText(ast) === 'module' || loaders.has(n.expression.expression.getText(ast))))) {
          if (n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]) && (n.arguments.length === 1 || ts.isPropertyAccessExpression(n.expression))) add(file, n.arguments[0].text);
          // Existing prebuild helpers use require(path.join(dataDir, 'x.json')).
          // JSON inputs cannot load script code. Any other computed load fails
          // closed rather than silently omitting a possible script dependency.
          // require(require.resolve('<package>', { paths })) loads an installed
          // package (a bare specifier), never repo script code; lockfile changes
          // already arm the build for packages.
          // require(path.join(ROOT, 'scripts/lib/x')): the literal tail is repo-root relative.
          else if (n.arguments.length === 1 && ts.isCallExpression(n.arguments[0]) && n.arguments[0].expression.getText(ast) === 'path.join' &&
            n.arguments[0].arguments.length >= 2 && ts.isStringLiteralLike(n.arguments[0].arguments.at(-1)) &&
            n.arguments[0].arguments.at(-1).text.startsWith('scripts/')) add(file, n.arguments[0].arguments.at(-1).text);
          else if (n.arguments.length === 1 && isJsonConst(n.arguments[0])) { /* JSON data cannot load script code. */ }
          else if (declaredDeps(n)) declaredDeps(n).filter(spec => spec !== 'none').forEach(spec => add(file, spec));
          else if (n.arguments.length === 1 && wrapperLoads(n.arguments[0])) wrapperLoads(n.arguments[0]).forEach(spec => add(file, spec));
          else if (!(n.arguments.length === 1 && isBarePackageResolve(n.arguments[0])) &&
            !(n.arguments.length === 1 && ts.isCallExpression(n.arguments[0]) &&
            n.arguments[0].expression.getText(ast) === 'path.join' &&
            ts.isStringLiteralLike(n.arguments[0].arguments.at(-1)) &&
            n.arguments[0].arguments.at(-1).text.endsWith('.json'))) throw new Error('dynamic build import');
        }
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }
    return scripts;
  } catch {
    return null;
  }
}

module.exports = { collectBuildScriptDependencies };
