/**
 * Pure helpers that turn parsed Python files plus module manifests into the
 * method-explorer data model. No filesystem access here: the Host feeds parsed
 * files in, so the rules stay testable.
 */

/**
 * Compute an approximate module load order from manifest `depends` lists.
 * Dependencies always come before dependents; undiscovered dependencies are
 * ignored and cycles fall back to alphabetical order.
 * @param {Map<string, string[]>} manifests - module name -> direct dependencies.
 * @returns {Map<string, number>} module name -> order index.
 */
export function computeModuleOrder(manifests) {
  const names = [...manifests.keys()].sort((left, right) => left.localeCompare(right));
  const known = new Set(names);
  const dependents = new Map(names.map((name) => [name, []]));
  const indegree = new Map(names.map((name) => [name, 0]));
  for (const name of names) {
    for (const dependency of manifests.get(name) ?? []) {
      if (!known.has(dependency) || dependency === name) continue;
      dependents.get(dependency).push(name);
      indegree.set(name, (indegree.get(name) ?? 0) + 1);
    }
  }
  const ready = names.filter((name) => (indegree.get(name) ?? 0) === 0).sort((left, right) => left.localeCompare(right));
  const order = new Map();
  let position = 0;
  while (ready.length > 0) {
    const name = ready.shift();
    order.set(name, position);
    position += 1;
    for (const dependent of dependents.get(name).sort((left, right) => left.localeCompare(right))) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }
  for (const name of names) {
    if (!order.has(name)) {
      order.set(name, position);
      position += 1;
    }
  }
  return order;
}

/**
 * Build the searchable Python index from parsed files.
 * @param {Array<{ rootPath: string, module: string, file: string, parsed: object }>} entries - parsed files.
 * @param {Map<string, { depends: string[], name?: string }>} manifests - module metadata.
 * @returns {object} python index data.
 */
export function buildPythonIndex(entries, manifests) {
  const moduleOrder = computeModuleOrder(new Map([...manifests].map(([name, meta]) => [name, meta.depends ?? []])));
  const classes = [];
  const methods = [];
  const byMethod = new Map();
  const byModel = new Map();
  const byModule = new Map();
  const modelFields = new Map();
  const models = new Map();

  const moduleRank = (module) => moduleOrder.get(module) ?? Number.MAX_SAFE_INTEGER;

  for (const entry of entries) {
    const parsed = entry.parsed;
    if (parsed === null || parsed === undefined) continue;
    const module = entry.module;
    for (const cls of parsed.classes ?? []) {
      const record = {
        rootPath: entry.rootPath,
        module,
        moduleRank: moduleRank(module),
        file: entry.file,
        name: cls.name,
        bases: cls.bases,
        line: cls.line,
        model: cls.model,
        nameModel: cls.nameModel,
        inherits: cls.inherits,
        inheritedMap: cls.inheritedMap,
        decorators: cls.decorators,
        description: cls.description ?? '',
        order: cls.order ?? '',
        recName: cls.recName ?? '',
        table: cls.table ?? '',
        parentName: cls.parentName ?? '',
        fields: Array.isArray(cls.fields) ? cls.fields : [],
        methodCount: cls.methods.length,
      };
      classes.push(record);
      if (record.model.length > 0) {
        let bucket = byModel.get(record.model);
        if (bucket === undefined) {
          bucket = [];
          byModel.set(record.model, bucket);
        }
        bucket.push(record);
        let modelInfo = models.get(record.model);
        if (modelInfo === undefined) {
          modelInfo = {
            name: record.model,
            classes: 0,
            modules: new Set(),
            methods: new Set(),
            fields: new Set(),
            mixins: new Set(),
            description: '',
            order: '',
            recName: '',
            table: '',
            parentName: '',
          };
          models.set(record.model, modelInfo);
        }
        modelInfo.classes += 1;
        modelInfo.modules.add(module);
        if (modelInfo.description.length === 0 && record.description.length > 0) modelInfo.description = record.description;
        if (modelInfo.order.length === 0 && record.order.length > 0) modelInfo.order = record.order;
        if (modelInfo.recName.length === 0 && record.recName.length > 0) modelInfo.recName = record.recName;
        if (modelInfo.table.length === 0 && record.table.length > 0) modelInfo.table = record.table;
        if (modelInfo.parentName.length === 0 && record.parentName.length > 0) modelInfo.parentName = record.parentName;
        for (const mixin of record.inherits) {
          if (mixin !== record.model) modelInfo.mixins.add(mixin);
        }
        let fieldBucket = modelFields.get(record.model);
        if (fieldBucket === undefined) {
          fieldBucket = new Map();
          modelFields.set(record.model, fieldBucket);
        }
        for (const field of record.fields) {
          if (typeof field.name !== 'string' || field.name.length === 0) continue;
          modelInfo.fields.add(field.name);
          const existing = fieldBucket.get(field.name);
          const candidate = {
            name: field.name,
            fieldType: field.fieldType,
            line: field.line,
            comodel: field.comodel ?? '',
            string: field.string ?? '',
            attrs: field.attrs ?? {},
            module,
            moduleRank: record.moduleRank,
            className: record.name,
            file: entry.file,
            // D5: every module that defines the field, not just the last one. The
            // builder needs this to tell whether a field is reachable from a
            // module's `depends` closure (email on res.partner lives in `mail`).
            modules: [module],
            definitions: 1,
          };
          if (existing === undefined) {
            fieldBucket.set(field.name, candidate);
          } else {
            const definitions = existing.definitions + 1;
            const definers = [...new Set([...existing.modules, module])];
            if (candidate.moduleRank >= existing.moduleRank) {
              fieldBucket.set(field.name, { ...candidate, definitions, modules: definers });
            } else {
              existing.definitions = definitions;
              existing.modules = definers;
            }
          }
        }
      }
      for (const method of cls.methods) {
        const methodRecord = {
          rootPath: entry.rootPath,
          module,
          moduleRank: record.moduleRank,
          file: entry.file,
          name: method.name,
          className: cls.name,
          model: cls.model,
          line: method.line,
          endLine: method.endLine,
          args: method.args,
          decorators: method.decorators,
          superCalls: method.superCalls,
          calls: method.calls,
          kind: 'method',
          searchText: `${method.name} ${cls.model} ${cls.name} ${module} ${entry.file} ${method.decorators.join(' ')}`,
        };
        methods.push(methodRecord);
        let bucket = byMethod.get(methodRecord.name);
        if (bucket === undefined) {
          bucket = [];
          byMethod.set(methodRecord.name, bucket);
        }
        bucket.push(methodRecord);
        const modelInfo = methodRecord.model.length > 0 ? models.get(methodRecord.model) : undefined;
        if (modelInfo !== undefined) modelInfo.methods.add(methodRecord.name);
      }
      const moduleInfo = byModule.get(module) ?? { classes: 0, methods: 0 };
      moduleInfo.classes += 1;
      moduleInfo.methods += cls.methods.length;
      byModule.set(module, moduleInfo);
    }
    for (const fn of parsed.functions ?? []) {
      const methodRecord = {
        rootPath: entry.rootPath,
        module,
        moduleRank: moduleRank(module),
        file: entry.file,
        name: fn.name,
        className: '',
        model: '',
        line: fn.line,
        endLine: fn.endLine,
        args: '',
        decorators: fn.decorators,
        superCalls: fn.superCalls,
        calls: fn.calls,
        kind: 'function',
        searchText: `${fn.name} ${module} ${entry.file} ${fn.decorators.join(' ')}`,
      };
      methods.push(methodRecord);
      let bucket = byMethod.get(methodRecord.name);
      if (bucket === undefined) {
        bucket = [];
        byMethod.set(methodRecord.name, bucket);
      }
      bucket.push(methodRecord);
      const moduleInfo = byModule.get(module) ?? { classes: 0, methods: 0 };
      moduleInfo.methods += 1;
      byModule.set(module, moduleInfo);
    }
  }

  const modelList = [...models.values()]
    .map((info) => ({
      name: info.name,
      classes: info.classes,
      modules: [...info.modules],
      methods: [...info.methods],
      description: info.description,
      order: info.order,
      recName: info.recName,
      table: info.table,
      parentName: info.parentName,
      mixins: [...info.mixins],
      fieldCount: info.fields.size,
      searchText: `${info.name} ${info.description} ${[...info.modules].join(' ')} ${[...info.fields].join(' ')}`,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    files: entries.length,
    classes,
    methods,
    models: modelList,
    byMethod,
    byModel,
    byModule,
    modelFields,
    manifests,
    moduleOrder,
    stats: {
      files: entries.length,
      modules: manifests.size,
      classes: classes.length,
      methods: methods.length,
      models: modelList.length,
    },
  };
}

/** Compare two python records by approximate module order, then file and line. */
function compareRecords(left, right) {
  return left.moduleRank - right.moduleRank
    || left.module.localeCompare(right.module)
    || left.file.localeCompare(right.file)
    || left.line - right.line;
}

/**
 * Resolve the approximate override chain for one model method.
 * @param {object} data - python index.
 * @param {string} model - model name (for example `sale.order`).
 * @param {string} name - method name.
 * @param {{ file?: string, line?: number }} [hint] - optional definition hint.
 * @returns {Array<object>} ordered chain steps.
 */
export function resolveMethodChain(data, model, name, hint = {}) {
  const candidates = data.methods.filter((method) => method.name === name && method.kind === 'method' && method.model === model);
  candidates.sort(compareRecords);
  let steps = candidates;
  if (candidates.length > 0 && typeof hint.file === 'string' && hint.file.length > 0) {
    const hinted = candidates.findIndex((method) => method.file === hint.file && (hint.line === undefined || method.line === hint.line));
    if (hinted > 0) {
      steps = [...candidates.slice(hinted), ...candidates.slice(0, hinted)];
    }
  }
  return steps.map((method, index) => {
    const next = steps[index + 1] ?? null;
    const supers = method.superCalls.filter((call) => call.name === name);
    const hasSuper = supers.length > 0;
    return {
      ...method,
      step: index + 1,
      total: steps.length,
      next: next === null ? null : { model: next.model, module: next.module, class: next.className, file: next.file, line: next.line },
      hasSuper,
      // A base definition has no super() to call; only an override that skips
      // super() actually stops the chain.
      brokenChain: !hasSuper && index > 0,
      isBase: index === 0,
      isLast: next === null,
    };
  });
}

/**
 * Find textual call sites of one method name.
 * @param {object} data - python index.
 * @param {string} name - method name.
 * @param {number} [limit] - maximum results.
 * @returns {Array<object>} callers.
 */
export function findCallers(data, name, limit = 80) {
  const out = [];
  for (const method of data.methods) {
    for (const call of method.calls) {
      if (call.name !== name) continue;
      if (method.name === name && call.line >= method.line && call.line <= method.endLine) continue;
      out.push({
        method: method.name,
        className: method.className,
        model: method.model,
        module: method.module,
        file: method.file,
        line: call.line,
        text: call.text ?? '',
        kind: method.kind,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Resolve the definitions referenced by one method body.
 * @param {object} data - python index.
 * @param {Array<{ name: string }>} calls - textual calls.
 * @param {number} [limit] - maximum callees.
 * @returns {Array<object>} callee definitions.
 */
export function findCallees(data, calls, limit = 60) {
  const seen = new Set();
  const out = [];
  for (const call of calls) {
    if (seen.has(call.name)) continue;
    seen.add(call.name);
    const definitions = (data.byMethod.get(call.name) ?? []).slice(0, 6).map((method) => ({
      module: method.module,
      className: method.className,
      model: method.model,
      file: method.file,
      line: method.line,
      kind: method.kind,
    }));
    out.push({
      name: call.name,
      line: call.line,
      definitions,
      ambiguous: (data.byMethod.get(call.name) ?? []).length > 1,
      count: (data.byMethod.get(call.name) ?? []).length,
    });
    if (out.length >= limit) return out;
  }
  return out;
}

/**
 * Find definitions of the same method on models mixed into the selected model
 * (declared through `_inherit` or `_inherits`). These are not part of the
 * override chain but help explain inherited behaviour.
 * @param {object} data - python index.
 * @param {string} model - selected model.
 * @param {string} name - method name.
 * @returns {Array<object>} related definitions, ordered by module.
 */
export function findRelatedDefinitions(data, model, name) {
  const relatedModels = new Map();
  for (const cls of data.byModel.get(model) ?? []) {
    for (const inherited of cls.inherits ?? []) {
      if (inherited.length > 0 && inherited !== model) relatedModels.set(inherited, 'mixin');
    }
    for (const delegated of Object.values(cls.inheritedMap ?? {})) {
      if (delegated.length > 0 && delegated !== model) relatedModels.set(delegated, 'delegation');
    }
  }
  const out = [];
  for (const [relatedModel, relation] of relatedModels) {
    const definitions = (data.byMethod.get(name) ?? [])
      .filter((method) => method.kind === 'method' && method.model === relatedModel)
      .sort(compareRecords);
    for (const definition of definitions) {
      out.push({
        model: relatedModel,
        module: definition.module,
        className: definition.className,
        file: definition.file,
        line: definition.line,
        args: definition.args,
        decorators: definition.decorators,
        relation,
      });
    }
  }
  out.sort(compareRecords);
  return out.slice(0, 20);
}

/** Score one search hit: exact names first, then prefixes, then substrings. */
function searchScore(haystack, tokens, name, model, query) {
  let score = 0;
  const lowered = query.toLowerCase();
  if (name.toLowerCase() === lowered || model.toLowerCase() === lowered) score += 120;
  else if (name.toLowerCase().startsWith(lowered) || model.toLowerCase().startsWith(lowered)) score += 60;
  for (const token of tokens) {
    if (name.toLowerCase().includes(token)) score += 10;
    if (model.toLowerCase().includes(token)) score += 6;
  }
  return score + Math.min(haystack.length, 200) / 1000;
}

/**
 * Search methods, functions and models.
 * @param {object} data - python index.
 * @param {string} query - search text.
 * @param {'all' | 'method' | 'function' | 'model'} type - result filter.
 * @param {number} [limit] - maximum results.
 * @returns {{ items: Array<object>, total: number, truncated: boolean }} results.
 */
export function searchPython(data, query, type = 'all', limit = 200) {
  const tokens = query
    .toLowerCase()
    .replace(/\bdef\b/g, ' ')
    .replace(/\bclass\b/g, ' ')
    .split(/[\s.]+/)
    .map((token) => token.replace(/[()`'",;:]+/g, '').trim())
    .filter(Boolean);
  if (tokens.length === 0) return { items: [], total: 0, truncated: false };
  const items = [];
  if (type === 'all' || type === 'model') {
    for (const model of data.models) {
      const haystack = (model.searchText ?? `${model.name} ${model.modules.join(' ')}`).toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      items.push({
        kind: 'model',
        name: model.name,
        model: model.name,
        module: model.modules[0] ?? '',
        classes: model.classes,
        methodCount: model.methods.length,
        modules: model.modules,
        file: '',
        line: 0,
        score: searchScore(haystack, tokens, model.name, model.name, query) + 40,
      });
    }
  }
  if (type === 'all' || type === 'method' || type === 'function') {
    for (const method of data.methods) {
      if (type === 'method' && method.kind !== 'method') continue;
      if (type === 'function' && method.kind !== 'function') continue;
      const haystack = (method.searchText ?? `${method.name} ${method.model} ${method.className} ${method.module} ${method.file} ${method.decorators.join(' ')}`).toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      items.push({
        kind: method.kind,
        name: method.name,
        model: method.model,
        className: method.className,
        module: method.module,
        file: method.file,
        line: method.line,
        decorators: method.decorators,
        score: searchScore(haystack, tokens, method.name, method.model, query),
      });
    }
  }
  items.sort((left, right) => right.score - left.score || left.module.localeCompare(right.module) || left.name.localeCompare(right.name));
  const total = items.length;
  return { items: items.slice(0, limit), total, truncated: total > limit };
}

/**
 * Build the model explorer payload.
 * @param {object} data - python index.
 * @param {string} model - model name.
 * @returns {object | null} model payload, or null when the model is unknown.
 */
export function resolveModel(data, model) {
  const classes = (data.byModel.get(model) ?? []).slice().sort(compareRecords);
  if (classes.length === 0) return null;
  const info = data.models.find((entry) => entry.name === model);
  const methods = new Map();
  for (const cls of classes) {
    const definitions = data.methods.filter((method) => method.className === cls.name && method.module === cls.module && method.file === cls.file && method.model === model);
    for (const definition of definitions) {
      const bucket = methods.get(definition.name) ?? [];
      bucket.push({ module: definition.module, className: cls.name, file: definition.file, line: definition.line, decorators: definition.decorators });
      methods.set(definition.name, bucket);
    }
  }
  const fields = [...(data.modelFields.get(model)?.values() ?? [])]
    .map((field) => ({
      name: field.name,
      fieldType: field.fieldType,
      comodel: field.comodel,
      string: field.string,
      attrs: field.attrs,
      module: field.module,
      className: field.className,
      file: field.file,
      line: field.line,
      modules: Array.isArray(field.modules) ? field.modules : [field.module],
      definitions: field.definitions,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    model,
    description: info?.description ?? '',
    order: info?.order ?? '',
    recName: info?.recName ?? '',
    table: info?.table ?? '',
    parentName: info?.parentName ?? '',
    mixins: info?.mixins ?? [],
    classCount: classes.length,
    fieldCount: fields.length,
    fields,
    methods: [...methods.entries()]
      .map(([name, definitions]) => ({ name, definitions, count: definitions.length }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    modules: [...new Set(classes.map((cls) => cls.module))],
  };
}

export default {
  buildPythonIndex,
  computeModuleOrder,
  resolveMethodChain,
  findCallers,
  findCallees,
  findRelatedDefinitions,
  searchPython,
  resolveModel,
};
