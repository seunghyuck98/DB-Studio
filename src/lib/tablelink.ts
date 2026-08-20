import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * ⌘/Ctrl 을 누른 채 SQL 안의 `스키마.테이블` 위에 마우스를 올리면 링크처럼 밑줄이 생기고,
 * 클릭하면 그 테이블을 연다 (IDE 의 "정의로 이동"과 같은 감각).
 *
 * 어느 이름이 진짜 테이블인지는 여기서 판단하지 않는다 — 클릭됐을 때 호출자가
 * 메타데이터로 확인한다. 여기서는 식별자 사슬을 찾아 밑줄만 긋는다.
 */

export interface LinkPart {
  name: string;
  /** 따옴표로 감싼 식별자였는지 (PostgreSQL 은 안 감싼 이름을 소문자로 접는다) */
  quoted: boolean;
}

/** 사슬 하나: `a.b.c` 전체 범위와 각 부분 */
interface Chain {
  from: number;
  to: number;
  parts: LinkPart[];
}

/** 식별자 하나 (따옴표·백틱 인용 포함), 점으로 이어진 사슬 */
const CHAIN_RE = /(?:"[^"\n]+"|`[^`\n]+`|[A-Za-z_$À-￿][\w$À-￿]*)(?:\s*\.\s*(?:"[^"\n]+"|`[^`\n]+`|[A-Za-z_$À-￿][\w$À-￿]*))*/g;

/** 혼자 있으면 링크로 만들 이유가 없는 예약어들 */
const KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'as', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'union', 'all', 'distinct',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'insert', 'into', 'values',
  'update', 'set', 'delete', 'create', 'alter', 'drop', 'table', 'view', 'index',
  'case', 'when', 'then', 'else', 'end', 'like', 'between', 'exists', 'asc', 'desc',
  'with', 'begin', 'commit', 'rollback', 'explain', 'analyze', 'true', 'false',
]);

function stripQuote(raw: string): LinkPart {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('`') && raw.endsWith('`'))) {
    return { name: raw.slice(1, -1), quoted: true };
  }
  return { name: raw, quoted: false };
}

/** 문서의 pos 위치를 포함하는 식별자 사슬을 찾는다. */
function chainAt(view: EditorView, pos: number): Chain | null {
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  CHAIN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHAIN_RE.exec(line.text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (col < start) break;
    if (col > end) continue;
    const parts = m[0].split(/\s*\.\s*/).map(stripQuote);
    if (parts.some((p) => !p.name)) return null;
    // 예약어 하나짜리나 숫자는 링크가 아니다.
    if (parts.length === 1 && (KEYWORDS.has(parts[0].name.toLowerCase()) || /^\d+$/.test(parts[0].name))) return null;
    return { from: line.from + start, to: line.from + end, parts };
  }
  return null;
}

const linkMark = Decoration.mark({ class: 'cm-table-link' });
const setLink = StateEffect.define<{ from: number; to: number } | null>();

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setLink)) deco = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 지금 밑줄이 그어진 범위 (같은 자리에 다시 dispatch 하지 않으려고 기억해 둔다) */
const shown = new WeakMap<EditorView, { from: number; to: number } | null>();

function show(view: EditorView, range: { from: number; to: number } | null): void {
  const prev = shown.get(view) ?? null;
  if (prev === range) return;
  if (prev && range && prev.from === range.from && prev.to === range.to) return;
  shown.set(view, range);
  view.dispatch({ effects: setLink.of(range) });
}

export function tableLink(onOpen: (parts: LinkPart[]) => void): Extension {
  return [
    linkField,
    EditorView.domEventHandlers({
      mousemove(e, view) {
        if (!(e.metaKey || e.ctrlKey)) {
          show(view, null);
          return false;
        }
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        show(view, pos == null ? null : chainAt(view, pos));
        return false;
      },
      mouseleave(_e, view) {
        show(view, null);
        return false;
      },
      keyup(e, view) {
        if (e.key === 'Meta' || e.key === 'Control') show(view, null);
        return false;
      },
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const chain = chainAt(view, pos);
        if (!chain) return false;
        show(view, null);
        onOpen(chain.parts);
        return true; // 클릭으로 커서가 옮겨가지 않게 삼킨다
      },
    }),
  ];
}
