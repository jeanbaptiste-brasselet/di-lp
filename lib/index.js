import _ from 'lodash/fp.js';
import fg from 'fast-glob';
import { dirname, join as joinPath, extname } from 'path';

const getDirName = dirname;

/**
 * Returns an alias function of `fn`. When called, register `fn` returned value at cache-position defined by `resolve` returned value.
 * If `resolve` returned value already exists in cache, cache-value is returned, else execute `fn` and cache its result.
 * @const memoizeWithResolver {<F extends (...args: any[]) => any>(fn: F, resolve: (...args: Parameters<F>) => string) => F}
 */
const memoizeWithResolver = _.memoize.convert({ fixed: false });

/**
 * Deep-copy `source`, it and its children are extended by `mapping`.
 * Its properties and children properties function-type are transformed by their returned-value, by executing these with `source` and `mapping` as parameters.
 * @param source {S extends object} the object scanned
 * @param mapping {M} the extenion for `source` and all its children objects.
 * @returns {S & M} the object deep-copied
 */
const createDeepProxy = (source, mapping) => {
  const createProxy = (target, mapping = {}) => {
    const targetWithMapping = _.mergeAll([target, mapping]);
    return new Proxy(targetWithMapping, {
      get(target, key) {
        const value = _.get(key, target);
        if (_.isPlainObject(value)) {
          return createProxy(value, mapping);
        }
        if (!_.isFunction(value)) return value;
        return value(source, key);
      }
    });
  };
  return createProxy(source, mapping);
};

/**
 * Create a function returning a `ClassConstructor` instanciated with `registered` deep-copy extended by `options.mapping` recursively as single parameter.
 * @param ClassConstructor {class}
 * @param options {{ mapping: any })
 * @returns {(registered: object) => new ClassConstructor}
 */
const asClass = (ClassConstructor, options = {}) => {
  const {
    mapping = () => ({}),
  } = options;

  return (registered) => {
    const dependencies = createDeepProxy(registered, mapping);
    return new ClassConstructor(dependencies);
  };
};

/**
 * Create a function returning `value`
 * @param value {any}
 * @returns {() => any}
 */
const asValue = (value) => () => value;

/**
 * Creates a function returning `fn` output, executed with `registered` deep-copy extended by `options.mapping` recursively as single parameter.
 * @param fn {(mixed: object) => R}
 * @param options {{ mapping: any }}
 * @returns {(registered: object) => R}
 */
const asFunction = (fn, options = {}) => {
  const {
    mapping = () => ({}),
  } = options;

  const handleFunction = (registered) => fn(createDeepProxy(registered, mapping));

  return memoizeWithResolver(handleFunction, (registered, key) => key);
};

/**
 * Creates a function accessing `path` in `container`. If the value is a function, then it is executed with `container` as single parameter.
 * @param path {string} lodash-style accessing path
 * @returns {(container: object) => any}
 */
const getFromContainer = (path) => (container) => {
  const value = _.get(path, container);
  return _.isFunction(value) ? value(container) : value;
};

/**
 * Creates a shadow-copy of `container` filtered by `definition` keys. 
 * @param definition {object} a schema for filtering `container` keys.
 * @param container {object} the object scanned.
 * @returns {object} the object shadow-copied (its properties have same pointer reference).
 * @warn it recursively access properties of `container`, so its properties and their children properties getter-functions are triggered.
 */
const resolveContainer = (definition, container) => {
  const result = {};

  Object.keys(definition).forEach(key => {
    const item = container[key];
    if (typeof item === 'object' && item !== null) {
      resolveContainer(definition[key], container, result);
    }
    result[key] = item;
  });

  return result;
};

/**
 * @alias createDeepProxy
 */
const createContainer = (definition) => {
  const container = createDeepProxy(definition);
  return resolveContainer(definition, container);
}

const isJsFile = (filePath) => extname(filePath) === '.js';

/**
 * Scan `glob` as path in filesystem with glob-syntax, returns directories and js-files with descriptions.
 * @param glob {string | string[]}
 * @param options {import('fast-glob').SyncOptions}
 * returns {{ name: string, path: string, isJsFile: boolean, isDirectory: boolean, isIndex: boolean }[]}
 */
const listModules = (glob, options) => {
  const entries = _.map(entry => ({
    name: _.camelCase(entry.name.replace(/\.js$/, '')),
    path: entry.path,
    isJsFile: entry.dirent.isFile() && isJsFile(entry.path),
    isDirectory: entry.dirent.isDirectory(),
    isIndex: entry.name === 'index.js',
  }), fg.sync(glob, { onlyFiles: false, stats: true, ...options }));
  return _.filter(entry => entry.isDirectory || entry.isJsFile, entries);
};

/**
 * Transform `obj` in a new object. For each function-properties of `obj`, transform it into a new function, executed by `registered` deep-copy extended by `options.mapping` recursively as single parameter and returning same output.
 * @param obj {Record<string, (mixed: R & M) => T>}
 * @param options {{ mapping: any }}
 * @returns {Record<string, (registered: R) => T>}
 * @warn the `obj` properties should be functions
 */
const asObject = (obj, options) => _.mapValues(item => asFunction(item, options), obj);

/**
 * Transform `module` in a new object. For each property "p" of `module`, currify it following rule:
 * * If the property "p" is an object, then recursively transform "p" with this function,
 * * If the property "p" is a function, then returns an alias of it,
 * * Else returns a function for accessing "p".
 * @param module {object}
 * @returns {Record<string, ReturnType<asFunction> | ReturnType<asModule>>}
 */
const asModule = (module) =>  {
  return _.mapValues((value) => {
    if (_.isPlainObject(value)) {
      // Recursively process nested objects
      return asModule(value);
    } else if (_.isFunction(value)) {
      // Wrap functions with asFunction
      return asFunction(value);
    } else {
      // Wrap other values with asValue
      return asValue(value);
    }
  }, module);
};

/**
 * Read files in filesystem at `path` directory: if an index-file is found, then it is exported, else create an object mapping every files export by their filename.
 * @params path {string} is the filesystem path that should be recursively scanned
 * @params options {{ cwd?: string, mapping?: any }}
 * @returns {Promise<Record<string, ReturnType<asFunction> | ReturnType<asModule>>>}
 */
const asModuleAsync = async (path, options = {}) => {
  const cwd = options.cwd || getDirName(process.argv[1])
  const entries = listModules([`${path}/*`], { cwd });

  // Helper function to load and process a module
  const loadModule = async (entryPath) => {
    const module = await import(joinPath(cwd, entryPath));
    return module.default;
  };

  const index = _.find(item => item.isIndex, entries);
  if (index) {
    const moduleDefault = await loadModule(index.path);
    return _.isFunction(moduleDefault)
      ? asFunction(moduleDefault, options)
      : _.mapValues(item => asFunction(item, options), moduleDefault);
  }

  const processEntry = async (entry) => {
    if (entry.isDirectory) {
      return asModule(entry.path, { ...options, cwd });
    }

    const moduleDefault = await loadModule(entry.path);
    return _.isFunction(moduleDefault)
      ? asFunction(moduleDefault, options)
      : asValue(moduleDefault);
  };

  const results = await Promise.all(
    entries.map(async entry => ({
      name: entry.name,
      value: await processEntry(entry)
    }))
  );

  return results.reduce((acc, { name, value }) => ({
    ...acc,
    [name]: value
  }), {});
};

export {
  createContainer,
  asFunction,
  asObject,
  asValue,
  asModule,
  asModuleAsync,
  getFromContainer,
  listModules,
  asClass
};

export default {
  createContainer,
  asFunction,
  asObject,
  asValue,
  asModule,
  asModuleAsync,
  getFromContainer,
  listModules,
  asClass
};
