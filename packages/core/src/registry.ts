export interface RegisterOpts {
  /** Where the entry sits in `entries`/`list`: lower first, ties by the order the ids first came. None: after every number. A shadow with none keeps the place of what it covers. */
  order?: number;
  shadow?: boolean;
}

interface Entry { value: unknown; order: number }
// `seq` is when the id first came; a shadow keeps it, so a tie between two ids does not depend on who was copied last.
interface Stack { seq: number; entries: Entry[] }

/** Things by kind and id. Maps, so an id like `toString` or `__proto__` is just an id. */
export class Registry {
  // Per id, a stack: the last entry is the one every lookup sees. Only a shadowing register ever makes it more than one deep.
  private byKind = new Map<string, Map<string, Stack>>();
  private seq = 0;

  /**
   * Throws on a taken id, unless `shadow` is set: then the entry goes on top of the taken one, which comes back into
   * view when this entry is removed. Returns a one-shot function that removes only this entry: a second call does
   * nothing, even after the id was registered again.
   */
  register(kind: string, id: string, value: unknown, opts?: RegisterOpts): () => void {
    if (opts?.order !== undefined && !Number.isFinite(opts.order)) throw new Error(`order must be a finite number, not ${String(opts.order)}`);
    let ids = this.byKind.get(kind);
    if (!ids) this.byKind.set(kind, (ids = new Map()));
    let stack = ids.get(id);
    if (stack?.entries.length && !opts?.shadow) throw new Error(`${kind} "${id}" is already registered`);
    if (!stack) ids.set(id, (stack = { seq: this.seq++, entries: [] }));
    const mine = stack.entries;
    const entry = { value, order: opts?.order ?? (opts?.shadow && mine.length ? mine[mine.length - 1].order : Infinity) };
    mine.push(entry);
    const own = stack;
    return () => {
      // The entry is found by identity, so a second call finds nothing and removes nothing.
      const at = mine.indexOf(entry);
      if (at >= 0) mine.splice(at, 1);
      if (!mine.length && ids.get(id) === own) ids.delete(id);
    };
  }

  has(kind: string, id: string): boolean {
    return (this.byKind.get(kind)?.get(id)?.entries.length ?? 0) > 0;
  }

  get<T = unknown>(kind: string, id: string): T | undefined {
    const e = this.byKind.get(kind)?.get(id)?.entries;
    return e?.length ? (e[e.length - 1].value as T) : undefined;
  }

  /** The ids of `kind`, alphabetical. */
  ids(kind: string): string[] {
    return [...(this.byKind.get(kind)?.keys() ?? [])].sort();
  }

  /** The visible entry of each id, in order. */
  entries<T = unknown>(kind: string): Array<[string, T]> {
    const tops = [...(this.byKind.get(kind) ?? [])].map(([id, s]) => ({ id, seq: s.seq, top: s.entries[s.entries.length - 1] }));
    tops.sort((a, b) => (a.top.order < b.top.order ? -1 : a.top.order > b.top.order ? 1 : a.seq - b.seq));
    return tops.map((t) => [t.id, t.top.value as T]);
  }

  list<T = unknown>(kind: string): T[] {
    return this.entries<T>(kind).map(([, v]) => v);
  }
}

/**
 * A Registry behind a plain Map, for the registries core code reads as Maps (`NODES`, `CONDS`, `CARDS`). `map` iterates in
 * the registry's order. A key put there with `map.set` stays until `map.delete`, after the registered ones.
 */
export function ordered<T>(label: string, idOf: (item: T) => string) {
  const reg = new Registry();
  const map = new Map<string, T>();
  let managed = new Set<string>();
  const sync = () => {
    const now = reg.entries<T>(label);
    const current = new Set(now.map(([id]) => id));
    for (const id of managed) if (!current.has(id)) map.delete(id);
    managed = current;
    const strays = [...map].filter(([id]) => !current.has(id));
    map.clear();
    for (const [id, item] of [...now, ...strays]) map.set(id, item);
  };
  return {
    map,
    /** Adds `item`, or covers a taken id with it when `opts.shadow`. The disposer is one-shot. */
    add(item: T, opts?: RegisterOpts): () => void {
      const dispose = reg.register(label, idOf(item), item, opts);
      sync();
      return () => { dispose(); sync(); };
    },
  };
}
