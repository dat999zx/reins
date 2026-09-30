import type { LogRow } from '@reins/server/store.js';
import { chip } from './engine.js';

export const type = 'card_delivered';
export const render = (row: LogRow) => chip(row.data as { channel: string });
