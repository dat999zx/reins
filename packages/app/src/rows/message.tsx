import type { LogRow } from '@reins/server/store.js';
import type { Tag } from '@reins/server/tags.js';

export const type = 'message';
export const render = (row: LogRow) => {
  const d = row.data as { text: string; tags?: Tag[]; fromCards?: boolean };
  return (
    <div className="msg user">
      {d.fromCards && <span className="chip">from your cards</span>}
      {d.tags?.map((t, i) => <span className="chip tag" key={i}>#{t.tag}{t.arg ? ` ${t.arg}` : ''}</span>)}
      <div className="txt">{d.text}</div>
    </div>
  );
};
