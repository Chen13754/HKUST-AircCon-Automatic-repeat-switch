export function memoryStorage(data = {}) {
  return {
    get: async key => structuredClone(key === null ? data : Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, data[name]]))),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async keys => { for (const name of Array.isArray(keys) ? keys : [keys]) delete data[name]; }
  };
}
