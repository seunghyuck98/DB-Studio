import { notify } from '../state/store';

/**
 * 클립보드에 넣고 무엇을 넣었는지 알려 준다.
 *
 * 앱 전체가 `user-select: none` 이라 화면의 이름을 끌어서 복사할 수 없다.
 * 그래서 이름을 복사해야 하는 자리(브레드크럼 더블클릭, 트리 우클릭 메뉴 등)는 이걸 쓴다.
 */
export async function copyText(text: string, what = '복사했습니다'): Promise<boolean> {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    notify('success', `${what}: ${value.length > 60 ? `${value.slice(0, 60)}…` : value}`);
    return true;
  } catch (e) {
    notify('error', `복사하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
