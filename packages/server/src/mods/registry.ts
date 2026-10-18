/** Things by kind and id. Maps, so an id like `toString` or `__proto__` is just an id. */
export class Registry {
  // Per id, a stack: the last entry is the one every lookup sees. Only a shadowing register ever makes it more than one deep.
  private byKind = new Map<string, Map<string, Array<{ value: unknown }>>>();

  /**
   * Throws on a taken id, unless `shadow` is set: then the entry goes on top of the taken one, which comes back into
   * view when this entry is removed. Returns a one-shot function that removes only this entry: a second call does
   * nothing, even after the id was registered again.
   */
  register(kind: string, id: string, value: unknown, opts?: { shadow?: boolean }): () => void {
    let ids = this.byKind.get(kind);
    if (!ids) this.byKind.set(kind, (ids = new Map()));
    let stack = ids.get(id);
    if (stack?.length && !opts?.shadow) throw new Error(`${kind} "${id}" is already registered`);
    if (!stack) ids.set(id, (stack = []));
    const entry = { value };
    stack.push(entry);
    const mine = stack;
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const at = mine.indexOf(entry);
      if (at >= 0) mine.splice(at, 1);
      if (!mine.length && ids.get(id) === mine) ids.delete(id);
    };
  }

  has(kind: string, id: string): boolean {
    return (this.byKind.get(kind)?.get(id)?.length ?? 0) > 0;
  }

  get<T = unknown>(kind: string, id: string): T | undefined {
    const stack = this.byKind.get(kind)?.get(id);
    return stack?.length ? (stack[stack.length - 1].value as T) : undefined;
  }

  ids(kind: string): string[] {
    return [...(this.byKind.get(kind)?.keys() ?? [])].sort();
  }

  list<T = unknown>(kind: string): T[] {
    return [...(this.byKind.get(kind)?.values() ?? [])].map((s) => s[s.length - 1].value as T);
  }
}
