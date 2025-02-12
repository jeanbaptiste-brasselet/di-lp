import _ from 'lodash/fp.js';
import fg from 'fast-glob';
import { dirname, join as joinPath, extname } from 'path';

const getDirName = dirname;

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

const asClass = (ClassConstructor, options = {}) => {
  const {
    mapping = () => ({}),
  } = options;

  return (registered) => {
    const dependencies = createDeepProxy(registered, mapping);
    return new ClassConstructor(dependencies);
  };
};

const asValue = (value) => () => value;

const asFunction = (fn, options = {}) => {
  const {
    mapping = () => ({}),
  } = options;
  return (registered) => fn(createDeepProxy(registered, mapping));;
};


const getFromContainer = (path) => (container) => {
  const value = _.get(path, container);
  return _.isFunction(value) ? value(container) : value;
};

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

const createContainer = (definition) => {
  const container = createDeepProxy(definition);
  return resolveContainer(definition, container);
}

const isJsFile = (filePath) => extname(filePath) === '.js';

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

const asObject = (obj, options) => _.mapValues(item => asFunction(item, options), obj);

const asModule = (module) =>  {
  return _.mapValues((value) => {
    console.log('value', value)
    if (_.isPlainObject(value)) {
      // Recursively process nested objects
      return processModules(value);
    } else if (_.isFunction(value)) {
      // Wrap functions with asFunction
      return asFunction(value);
    } else {
      // Wrap other values with asValue
      return asValue(value);
    }
  }, obj);
};

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
