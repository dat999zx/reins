// A question card is plain data: the buttons the run window shows when the run asks, and the word each one sends back. No code.
// The app reads the card from `GET /api/kinds`. Core owns them: no mod can add, cover or switch one (see `index.ts`).

/** A text box on a button. The typed text is trimmed; `check` judges it; `answer` has `{text}` where it goes. */
export interface QuestionField {
  placeholder: string;
  /** What the box holds when the card opens. */
  initial?: string;
  /** `usd`: an amount above 0 with at most two decimals. `count`: a whole number of 1 or more (sent without leading zeros). No check: any text. */
  check?: 'usd' | 'count';
  /** The answer when the box is empty. Without it an empty box sends nothing (the button is off). */
  empty?: string;
}

export interface QuestionAction {
  label: string;
  primary?: true;
  /** The word sent. With a field, `{text}` stands for the typed text. */
  answer: string;
  field?: QuestionField;
}

export interface QuestionCard {
  /** The kind of question the run asks (`Question.kind`). */
  kind: string;
  /** `json`: the question's detail is shown as indented JSON. */
  detail?: 'json';
  actions: QuestionAction[];
}
